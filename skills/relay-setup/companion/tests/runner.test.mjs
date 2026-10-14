import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtempSync,rmSync,writeFileSync,readFileSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync}from'node:child_process';
import{Store}from'../src/store.mjs';let Runner;try{({Runner}=await import('../src/runner.mjs'));}catch{}
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('condition timed out');};
test('runner produces reviewable evidence and waits for explicit verification',async()=>{
 assert.ok(Runner,'runner must exist');const dir=mkdtempSync(join(tmpdir(),'relay-run-'));const store=new Store(':memory:');const p=store.addProject({name:'P',path:dir});
 class Fake{async run(){return 'checked result';}stop(){}}
 const runner=new Runner(store,dir,{AgentClass:Fake});
 try{const t=store.addTask({projectId:p.id,title:'T',prompt:'Inspect',agent:'codex'});runner.tick();await until(()=>store.task(t.id).status==='awaiting_review');assert.equal(store.task(t.id).output,'checked result');}
 finally{runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('runner cancellation resolves pending approval and preserves cancelled state',async()=>{
 assert.ok(Runner,'runner must exist');const dir=mkdtempSync(join(tmpdir(),'relay-stop-'));const store=new Store(':memory:');const p=store.addProject({name:'P',path:dir});
 class Fake{constructor(id,cwd,callbacks){this.cb=callbacks;}async run(){await this.cb.onApproval({id:'1',kind:'permission',title:'Write?',options:[{id:'yes',label:'Allow'}]});return 'done';}stop(){}}
 const runner=new Runner(store,dir,{AgentClass:Fake});
 try{const t=store.addTask({projectId:p.id,title:'T',prompt:'Inspect',agent:'kimi'});runner.tick();await until(()=>store.task(t.id).status==='needs_input');runner.cancel(t.id);await until(()=>!runner.active);assert.equal(store.task(t.id).status,'cancelled');assert.equal(runner.approvals(t.id).length,0);}
 finally{runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('isolated Git changes apply only after verification to unchanged clean project',async()=>{
 assert.ok(Runner,'runner must exist');const dir=mkdtempSync(join(tmpdir(),'relay-git-'));const repo=join(dir,'project');execFileSync('git',['init',repo],{stdio:'ignore'});
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{env:{...process.env,GIT_AUTHOR_NAME:'Relay Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Relay Test',GIT_COMMITTER_EMAIL:'test@example.invalid'},encoding:'utf8'});
 git('config','core.autocrlf','false');git('config','core.eol','lf');
 writeFileSync(join(repo,'file.txt'),'old\n');git('add','.');git('commit','-m','base');const store=new Store(':memory:');const p=store.addProject({name:'P',path:repo});
 class Fake{constructor(id,cwd){this.cwd=cwd;}async run(){writeFileSync(join(this.cwd,'file.txt'),'new\n');writeFileSync(join(this.cwd,'added.txt'),'added\n');return 'implemented';}stop(){}}
 const runner=new Runner(store,dir,{AgentClass:Fake});
 try{const t=store.addTask({projectId:p.id,title:'T',prompt:'Implement',agent:'codex'});runner.tick();await until(()=>store.task(t.id).status==='awaiting_review');assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'old\n');await assert.rejects(runner.apply(t.id),/verified/);await runner.verify(t.id);writeFileSync(join(repo,'dirty.txt'),'uncommitted');await assert.rejects(runner.apply(t.id),/clean/);rmSync(join(repo,'dirty.txt'));await runner.apply(t.id);assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'new\n');assert.equal(readFileSync(join(repo,'added.txt'),'utf8'),'added\n');}
 finally{runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('verification is bound to exact changes, including later unverified handoff edits',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-verify-'));const repo=join(dir,'project');execFileSync('git',['init',repo],{stdio:'ignore'});
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{env:{...process.env,GIT_AUTHOR_NAME:'Relay Test',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Relay Test',GIT_COMMITTER_EMAIL:'test@example.invalid'},encoding:'utf8'});
 git('config','core.autocrlf','false');git('config','core.eol','lf');
 writeFileSync(join(repo,'file.txt'),'base\n');git('add','.');git('commit','-m','base');const store=new Store(':memory:');const p=store.addProject({name:'P',path:repo});
 class Fake{constructor(id,cwd){this.cwd=cwd;this.id=id;}async run(){writeFileSync(join(this.cwd,'file.txt'),this.id+'\n');return 'done';}stop(){}}
 const runner=new Runner(store,dir,{AgentClass:Fake});
 try{const parent=store.addTask({projectId:p.id,title:'Parent',prompt:'Work',agent:'codex'});runner.tick();await until(()=>store.task(parent.id).status==='awaiting_review');
 assert.equal(typeof runner.verify,'function','verification must record exact snapshot');await runner.verify(parent.id);
 const child=store.addTask({projectId:p.id,title:'Child',prompt:'Change again',agent:'kimi',parentTaskId:parent.id});runner.tick();await until(()=>store.task(child.id).status==='awaiting_review');
 await assert.rejects(runner.apply(parent.id),/changed since verification/);assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'base\n');await runner.verify(child.id);await runner.apply(child.id);assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'kimi\n');}
 finally{runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('cleanup failure saves the output as failed, persists a pause, and releases bookkeeping without starting queued work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-cleanup-'));const store=new Store(join(dir,'state.db'));const p=store.addProject({name:'P',path:dir});let starts=0;
 class Fake{async run(){starts++;return 'saved output';}async stop(){throw new Error('private process diagnostics');}}
 const runner=new Runner(store,dir,{AgentClass:Fake});
 try{
  const first=store.addTask({projectId:p.id,title:'First',prompt:'Inspect',agent:'codex'});const next=store.addTask({projectId:p.id,title:'Next',prompt:'Wait',agent:'kimi'});
  runner.tick();await until(()=>runner.paused&&!runner.active);
  const task=store.task(first.id);assert.equal(task.status,'failed');assert.equal(task.output,'saved output');assert.equal(task.cleanupFailed,true);assert.match(task.error,/processes.*resum/i);assert.doesNotMatch(task.error,/private process/);
  assert.equal(JSON.parse(readFileSync(join(dir,'settings.json'),'utf8')).paused,true);runner.tick();assert.equal(starts,1);assert.equal(store.task(next.id).status,'queued');
  const {createApp}=await import('../src/server.mjs');const restarted=await createApp({dataDir:dir,port:0,runAgents:false});
  try{assert.equal(restarted.runner.paused,true);assert.match(restarted.runner.cleanupError,/processes/);}finally{await restarted.close();}
 }finally{runner.active=null;runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('cancellation and shutdown consume stop failures even if the agent never settles its run',async()=>{
 for(const action of ['cancel','close']){
  const dir=mkdtempSync(join(tmpdir(),'relay-stop-failure-'));const store=new Store(':memory:');const p=store.addProject({name:'P',path:dir});let started=false,stops=0;
  class Fake{async run(){started=true;return new Promise(()=>{});}async stop(){stops++;throw new Error('stop failed');}}
  const runner=new Runner(store,dir,{AgentClass:Fake});
  try{const task=store.addTask({projectId:p.id,title:'Task',prompt:'Inspect',agent:'codex'});runner.tick();await until(()=>started);action==='cancel'?runner.cancel(task.id):runner.close();await until(()=>runner.paused&&!runner.active);assert.equal(stops,1);assert.equal(store.task(task.id).status,action==='cancel'?'cancelled':'interrupted');assert.equal(store.task(task.id).cleanupFailed,true);assert.match(store.task(task.id).error,/processes/);}
  finally{runner.active=null;runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('time limits consume cleanup rejection and leave the queue paused',{timeout:5000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-timeout-cleanup-'));const store=new Store(':memory:');const p=store.addProject({name:'P',path:dir});let ready;const started=new Promise(resolve=>{ready=resolve;});
 class Fake{async run(){ready();return new Promise(()=>{});}async stop(){throw new Error('private cleanup detail');}}
 const runner=new Runner(store,dir,{AgentClass:Fake});
 try{
  const task=store.addTask({projectId:p.id,title:'Task',prompt:'Inspect',agent:'codex',timeoutMinutes:1});
  t.mock.timers.enable({apis:['setTimeout']});runner.tick();await started;
  t.mock.timers.tick(60000);t.mock.timers.reset();await until(()=>runner.paused&&!runner.active);
  assert.equal(store.task(task.id).status,'failed');assert.equal(store.task(task.id).cleanupFailed,true);assert.doesNotMatch(store.task(task.id).error,/private cleanup detail/);
 }finally{t.mock.timers.reset();runner.active=null;runner.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
