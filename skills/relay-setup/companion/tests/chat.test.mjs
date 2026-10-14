import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Runner} from '../src/runner.mjs';
import {createApp} from '../src/server.mjs';
const native=['codex','kimi','hermes'];
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');};

test('chat persists one user post and replies in mention order, with Codex as lead',()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-chat-'));let s=new Store(join(dir,'state.db'));
 try{const p=s.addProject({name:'Room',path:dir});s.addChat(p.id,{text:'Hello'},native);
 assert.deepEqual(s.messages(p.id).map(m=>m.author),['you','codex']);
 s.addChat(p.id,{text:'@kimi @hermes @kimi compare that'},native);
 assert.deepEqual(s.messages(p.id).slice(-3).map(m=>m.author),['you','kimi','hermes']);
 const task=s.task(s.messages(p.id).at(-1).taskId);assert.equal(task.intent,'review');assert.equal(task.isolate,false);
 s.close();s=new Store(join(dir,'state.db'));assert.equal(s.messages(p.id).length,5);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('team excludes manual Grok; invalid/unavailable recipients leave no partial turn',()=>{
 const s=new Store(':memory:');try{const p=s.addProject({name:'P',path:'/tmp'});
 s.addChat(p.id,{text:'@team hello'},native);assert.deepEqual(s.messages(p.id).map(m=>m.author),['you',...native]);
 for(const input of [{text:'@kimi hello'},{text:'  '},{text:'hello',recipient:'nobody'},{text:'hello',intent:'unknown'}])assert.throws(()=>s.addChat(p.id,input,['codex']));
 assert.equal(s.messages(p.id).length,4);assert.equal(s.tasks().length,3);
 s.addChat(p.id,{text:'@grok a question'},native);assert.equal(s.messages(p.id).at(-1).author,'grok');
 }finally{s.close();}
});
test('failed chat transaction rolls back messages, tasks and events',()=>{
 const s=new Store(':memory:');try{const p=s.addProject({name:'P',path:'/tmp'});const add=s.addTask.bind(s);let n=0;s.addTask=(input)=>{if(++n===2)throw Error('disk problem');return add(input);};
 assert.throws(()=>s.addChat(p.id,{text:'@team hi'},native),/disk/);assert.equal(s.messages(p.id).length,0);assert.equal(s.tasks().length,0);
 }finally{s.close();}
});
test('each speaker sees prior peer replies but no later posts or other room history',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-chat-run-'));const s=new Store(':memory:');const p=s.addProject({name:'P',path:dir});const other=s.addProject({name:'Other',path:dir+'/other'});const prompts=[];
 class Fake{constructor(id){this.id=id;}async run(prompt){prompts.push(prompt);return `reply-from-${this.id}`;}stop(){}}
 const r=new Runner(s,dir,{AgentClass:Fake});
 try{s.addChat(p.id,{text:'@kimi @hermes FIRST_TURN'},native);s.addChat(p.id,{text:'FUTURE_POST'},native);s.addChat(other.id,{text:'OTHER_ROOM_SECRET'},native);
 r.tick();await until(()=>!r.active);r.tick();await until(()=>!r.active);
 assert.equal(prompts.length,2);assert.match(prompts[1],/reply-from-kimi/);assert.match(prompts[1],/FIRST_TURN/);assert.doesNotMatch(prompts[0],/reply-from-kimi/);
 for(const prompt of prompts)assert.doesNotMatch(prompt,/FUTURE_POST|OTHER_ROOM_SECRET/);
 r.tick();await until(()=>!r.active);assert.match(prompts[2],/reply-from-hermes/);
 }finally{r.close();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('chat endpoint requires authentication and returns live task output',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-chat-api-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{const p=app.store.projects()[0];const url=app.url+'/api/chat/'+p.id;const headers={'X-Relay-Token':app.token,'Content-Type':'application/json'};
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({text:'@grok question'})})).status,200);
 const t=app.store.tasks()[0];app.store.update(t.id,{output:'Grok response'});
 const result=await(await fetch(url,{headers})).json();assert.equal(result.messages.length,2);assert.equal(result.messages[1].text,'Grok response');assert.equal(result.messages[1].task.id,t.id);
 app.runner.cancel(t.id);
 const retried=await(await fetch(app.url+`/api/tasks/${t.id}/resume`,{method:'POST',headers,body:'{}'})).json();
 const afterRetry=await(await fetch(url,{headers})).json();assert.equal(afterRetry.messages.length,3);assert.equal(afterRetry.messages[2].taskId,retried.id);assert.ok(retried.chatMessageId);
 const followup=app.store.addChatReply({projectId:p.id,agent:'kimi',title:'Review',prompt:'Check that reply',intent:'review',parentTaskId:t.id});
 assert.equal(app.store.messages(p.id).at(-1).taskId,followup.id);assert.ok(followup.chatMessageId);
 assert.equal((await fetch(app.url+'/api/chat/missing',{headers})).status,400);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('chat work shares one isolated workspace and prevents applying before queued teammates finish',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-chat-git-'));const repo=join(dir,'repo');execFileSync('git',['init',repo],{stdio:'ignore'});
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{env:{...process.env,GIT_AUTHOR_NAME:'Relay Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Relay Test',GIT_COMMITTER_EMAIL:'test@example.invalid'},encoding:'utf8'});
 writeFileSync(join(repo,'file.txt'),'base');git('add','.');git('commit','-m','base');const s=new Store(':memory:');const p=s.addProject({name:'Git room',path:repo});
 class Fake{constructor(id,cwd){this.id=id;this.cwd=cwd;}async run(){if(this.id==='codex')writeFileSync(join(this.cwd,'file.txt'),'changed');else assert.equal(readFileSync(join(this.cwd,'file.txt'),'utf8'),'changed');return 'done';}stop(){}}
 const r=new Runner(s,dir,{AgentClass:Fake});
 try{s.addChat(p.id,{text:'@codex @kimi work together',intent:'work'},native);const [first,second]=s.tasks().reverse();
 r.tick();await until(()=>!r.active);await r.verify(first.id);await assert.rejects(r.apply(first.id),/Finish related/);
 r.tick();await until(()=>!r.active);assert.equal(s.task(first.id).workspace,s.task(second.id).workspace);assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'base');
 await r.verify(second.id);await r.apply(second.id);assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'changed');
 s.addChat(p.id,{text:'Discuss next step'},native);const next=s.tasks()[0];assert.deepEqual(await r.workspace(next),{workspace:realpathSync(repo),baseHead:null});
 }finally{r.close();s.close();rmSync(dir,{recursive:true,force:true});}
});

test('team includes Grok when its automatic adapter is available',()=>{
 const s=new Store(':memory:');try{const p=s.addProject({name:'P',path:'/tmp'});
 s.addChat(p.id,{text:'@team compare this'},[...native,'grok']);
 assert.deepEqual(s.messages(p.id).map(m=>m.author),['you',...native,'grok']);
 }finally{s.close();}
});

test('automatic Grok receives shared text and returns in room without a local worktree',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-grok-room-'));const s=new Store(':memory:');const p=s.addProject({name:'P',path:dir});let prompt;
 const grok={status:()=>({configured:true,enabled:true}),createRun:()=>({run:async p=>{prompt=p;return 'Cloud reply';},stop(){}})};
 const r=new Runner(s,dir,{grok});
 try{s.addChat(p.id,{text:'@grok Discuss BLUE_MEADOW',intent:'work'},['grok']);const task=s.tasks()[0];
 r.tick();await until(()=>!r.active);const result=s.task(task.id);
 assert.equal(result.status,'awaiting_review');assert.equal(result.output,'Cloud reply');assert.equal(result.workspace,null);assert.equal(result.baseHead,null);
 assert.equal(result.executionMode,'webhook');assert.match(prompt,/BLUE_MEADOW/);assert.match(prompt,/cloud/i);assert.match(prompt,/no access to.*local files/i);
 assert.equal(s.messages(p.id).at(-1).taskId,task.id);
 }finally{r.close();s.close();rmSync(dir,{recursive:true,force:true});}
});

test('Grok keeps the current request intact and bounds encoded older context as the room grows',async()=>{
 const s=new Store(':memory:');const p=s.addProject({name:'Room',path:'/tmp'});const other=s.addProject({name:'Other',path:'/tmp'});const r=new Runner(s,'/tmp');
 try{
  for(let i=0;i<30;i++){s.addChat(p.id,{text:'@codex Older discussion '+i},native);s.update(s.tasks()[0].id,{output:'界"\\\n'.repeat(500)});}
  s.addChat(p.id,{text:'@codex Recent evidence'},native);s.update(s.tasks()[0].id,{output:'RECENT_PEER_EVIDENCE'});
  const request='@grok CURRENT_REQUEST Keep this entire request, including "quotes" and 界.';
  s.addChat(p.id,{text:request},['grok']);const task={...s.tasks()[0],executionMode:'webhook'};
  s.addChat(p.id,{text:'FUTURE_POST'},native);s.addChat(other.id,{text:'OTHER_ROOM_SECRET'},native);
  const prompt=await r.prompt(task);assert.ok(Buffer.byteLength(JSON.stringify(prompt))<=3000);
  assert.ok(prompt.includes(request));assert.equal(prompt.split(request).length,2);
  assert.ok(prompt.indexOf(request)<prompt.indexOf('RECENT_PEER_EVIDENCE'));
  assert.match(prompt,/Discussion only: do not change files or settings/);
  assert.match(prompt,/older.*omitted/i);assert.doesNotMatch(prompt,/FUTURE_POST|OTHER_ROOM_SECRET|Older discussion 0/);
 }finally{r.close();s.close();}
});

test('stopping automatic Grok preserves cancellation and releases the queue',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-grok-cancel-'));const s=new Store(':memory:');const p=s.addProject({name:'P',path:dir});let finish,stopped=false;
 const grok={status:()=>({configured:true,enabled:true}),createRun:()=>({run:()=>new Promise(resolve=>{finish=resolve;}),stop(){stopped=true;finish?.('late reply');}})};
 const r=new Runner(s,dir,{grok});
 try{s.addChat(p.id,{text:'@grok Wait'},['grok']);const task=s.tasks()[0];r.tick();await until(()=>!!finish);r.cancel(task.id);await until(()=>!r.active);
 assert.equal(stopped,true);assert.equal(s.task(task.id).status,'cancelled');assert.equal(s.task(task.id).output,'');assert.match(s.task(task.id).error,/may still/i);
 }finally{r.close();s.close();rmSync(dir,{recursive:true,force:true});}
});

test('Grok settings require local auth and never return the saved key',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-grok-settings-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{const endpoint=app.url+'/api/grok';const headers={'X-Relay-Token':app.token,'Content-Type':'application/json'};
 assert.equal((await fetch(endpoint)).status,401);
 const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({enabled:true,webhookUrl:'https://api2.cursor.sh/automations/webhook/relay-test',webhookKey:'private-test-key-1234567890'})});
 assert.equal(response.status,200);const status=await response.json();assert.equal(status.configured,true);assert.equal(status.keySaved,true);assert.equal(status.enabled,true);assert.doesNotMatch(JSON.stringify(status),/private-test-key/);
 assert.doesNotMatch(await(await fetch(app.url+'/api/state',{headers})).text(),/private-test-key/);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('saving Grok settings reserves the scheduler and rejects overlapping saves',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-grok-save-race-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 const headers={'X-Relay-Token':app.token,'Content-Type':'application/json'};let release,entered=false;
 const configure=app.runner.grok.configure.bind(app.runner.grok);
 app.runner.grok.configure=async input=>{entered=true;await new Promise(r=>{release=r;});return configure(input);};
 try{const p=app.store.projects()[0];app.store.addChat(p.id,{text:'@grok Wait for setup'},[]);
 const save=fetch(app.url+'/api/grok',{method:'POST',headers,body:JSON.stringify({enabled:true,webhookUrl:'https://api2.cursor.sh/automations/webhook/save-race',webhookKey:'save-race-private-key'})});
 await until(()=>entered);app.runner.tick();const started=!!app.runner.active;
 const other=await fetch(app.url+'/api/grok',{method:'POST',headers,body:'{}'});
 release();assert.equal((await save).status,200);assert.equal(started,false,'queued work must wait for the configuration save');assert.equal(other.status,400);assert.equal(app.runner.configuring,false);
 }finally{release?.();await app.close();rmSync(dir,{recursive:true,force:true});}
});
