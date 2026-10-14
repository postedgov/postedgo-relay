import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,mkdir,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GrokConnection} from '../src/grok.mjs';

const webhookUrl='https://api2.cursor.sh/automations/webhook/relay-test';
const webhookKey='private-webhook-key';
const posixFixture={skip:process.platform==='win32'?'POSIX shebang fixture; Windows process commands are covered by platform tests.':false};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,fetchImpl){
 const dataDir=await mkdtemp(join(tmpdir(),'relay-grok-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const state={stops:0,dispatches:0};
 const connection=new GrokConnection(dataDir,{fetchImpl:async(url,options)=>{state.dispatches++;state.url=url;state.options=options;state.payload=JSON.parse(options.body);return fetchImpl?fetchImpl(url,options,state):new Response('',{status:200});},tunnelFactory:async args=>{state.tunnelArgs=args;state.localUrl=args.localUrl;return{url:args.localUrl,stop:async()=>{state.stops++;}};}});
 await connection.load();await connection.configure({webhookUrl,webhookKey,enabled:true});
 const run=connection.createRun('task-1',(type,data)=>{(state.events??=[]).push({type,data});});t.after(async()=>{try{await run.stop();}catch(error){if(!state.expectedCleanupFailure)throw error;}});
 return{connection,run,state,dataDir};
}
async function dispatched(state){for(let i=0;i<100&&!state.payload;i++)await pause(5);assert.ok(state.payload,'webhook dispatched');}
async function callback(state,body,headers={}){return fetch(state.payload.callback.url,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${state.payload.callback.token}`,...headers},body:JSON.stringify(body)});}

test('configuration persists privately, validates the vendor boundary and never returns the key',async t=>{
 const {connection,dataDir}=await fixture(t);const status=connection.status();
 assert.equal(status.configured,true);assert.equal(status.enabled,true);assert.equal(status.keySaved,true);assert.equal(status.tunnelInstalled,true);assert.ok(status.instruction.includes('requestId'));assert.ok(!JSON.stringify(status).includes(webhookKey));
 const path=join(dataDir,'grok.json');if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
 assert.equal(JSON.parse(await readFile(path,'utf8')).webhookKey,webhookKey);
 const restored=new GrokConnection(dataDir);await restored.load();assert.equal(restored.status().configured,true);
 for(const url of ['http://api2.cursor.sh/automations/webhook/test','https://evil.test/automations/webhook/test','https://api2.cursor.sh.evil.test/automations/webhook/test','https://api2.cursor.sh/other','https://x@api2.cursor.sh/automations/webhook/test','https://api2.cursor.sh:444/automations/webhook/test','https://api2.cursor.sh/automations/webhook/test?q=1','https://api2.cursor.sh/automations/webhook/test#secret'])await assert.rejects(connection.configure({webhookUrl:url,webhookKey,enabled:true}),/webhook URL/);
 await connection.configure({webhookKey:'',enabled:false});assert.equal(connection.status().keySaved,true);assert.equal(connection.status().enabled,false);
 await assert.rejects(connection.configure({webhookUrl:'https://api3.cursor.sh/automations/webhook/new',enabled:true}),/key/);
 await assert.rejects(connection.configure({webhookKey:'unsafe\r\nkey'}),/key/);
});

test('HTTP acceptance waits for a valid final reply and keeps callback credentials out of events',async t=>{
 const {run,state,connection}=await fixture(t);let settled=false;
 const pending=run.run('Room context and requested answer',2000).finally(()=>{settled=true;});await dispatched(state);await pause(20);assert.equal(settled,false);
 assert.equal(state.url,webhookUrl);assert.equal(state.options.headers.Authorization,`Bearer ${webhookKey}`);assert.equal(state.options.redirect,'error');
 assert.equal(state.payload.prompt,'Room context and requested answer');assert.match(state.payload.callback.token,/^[a-f0-9]{64}$/);assert.equal(state.payload.requestId,'task-1');
 assert.equal((await callback(state,{requestId:'task-1',text:'The Grok reply.'})).status,200);assert.equal(await pending,'The Grok reply.');
 assert.equal(state.stops,1);assert.ok(connection.status().lastResultAt);assert.ok(state.events.some(e=>e.type==='output'&&e.data.text==='The Grok reply.'));
 assert.ok(!JSON.stringify(state.events).includes(state.payload.callback.token));assert.ok(!JSON.stringify(state.events).includes(webhookKey));
 await assert.rejects(fetch(state.payload.callback.url));
});

test('callback metadata precedes prompt text in the webhook body',async t=>{
 const {run,state}=await fixture(t);const pending=run.run('A bounded room prompt',2000);pending.catch(()=>{});await dispatched(state);
 const prefix=JSON.parse(state.options.body.slice(0,state.options.body.indexOf(',"prompt":'))+'}');
 assert.equal(prefix.requestId,'task-1');assert.ok(prefix.callback,'callback must survive a truncated prompt');assert.equal(prefix.callback.token,state.payload.callback.token);
 assert.equal((await callback(state,{requestId:prefix.requestId,text:'reply with intact callback'})).status,200);
 assert.equal(await pending,'reply with intact callback');
});

test('oversized escaped or multibyte prompts fail before opening a tunnel or dispatching',async t=>{
 for(const prompt of ['界'.repeat(1100),'"\\\n'.repeat(600)]){
  const {run,state}=await fixture(t);
  await assert.rejects(run.run(prompt,100),/too large/i);
  assert.equal(state.dispatches,0);assert.equal(state.tunnelArgs,undefined);
 }
});

test('callback rejects unauthenticated, mismatched, malformed and oversized results without finishing',async t=>{
 const {run,state}=await fixture(t);const pending=run.run('prompt',3000);pending.catch(()=>{});await dispatched(state);
 assert.equal((await fetch(state.payload.callback.url)).status,405);
 assert.equal((await callback(state,{requestId:'task-1',text:'bad'},{authorization:'Bearer wrong'})).status,401);
 assert.equal((await callback(state,{requestId:'other-task',text:'bad'})).status,400);
 assert.equal((await callback(state,{requestId:'task-1',text:''})).status,400);
 assert.equal((await callback(state,{requestId:'task-1',text:'a'.repeat(500001)})).status,400);
 assert.equal((await callback(state,{requestId:'task-1',text:'x',error:'ambiguous'})).status,400);
 const oversized=await callback(state,{requestId:'task-1',text:'a'.repeat(1050000)}).catch(()=>null);assert.ok(!oversized||oversized.status===413);
 assert.equal((await callback(state,{requestId:'task-1',text:'good'},{'content-type':'text/plain'})).status,415);
 assert.equal((await callback(state,{requestId:'task-1',text:'good'})).status,200);assert.equal(await pending,'good');
});

test('a fast callback is retained until dispatch acceptance and a duplicate cannot overwrite it',async t=>{
 let accept;const accepted=new Promise(resolve=>{accept=resolve;});
 const {run,state}=await fixture(t,async()=>{await accepted;return new Response('',{status:200});});
 let settled=false;const pending=run.run('prompt',2000).finally(()=>{settled=true;});await dispatched(state);
 assert.equal((await callback(state,{requestId:'task-1',text:'first'})).status,200);
 assert.equal((await callback(state,{requestId:'task-1',text:'second'})).status,409);
 assert.equal(settled,false);accept();assert.equal(await pending,'first');
});

test('dispatch failures are redacted, not retried, and clean up the listener and tunnel',async t=>{
 const {run,state}=await fixture(t,async()=>{throw new Error(`${webhookKey} and the prompt`);});
 await assert.rejects(run.run('private prompt',1000),e=>/dispatch failed/.test(e.message)&&!e.message.includes(webhookKey)&&!e.message.includes('private prompt'));
 assert.equal(state.dispatches,1);assert.equal(state.stops,1);await assert.rejects(fetch(state.localUrl+'/result'));
});

test('non-200 dispatch and remote errors fail visibly without reflecting response content',async t=>{
 const first=await fixture(t,async()=>new Response(webhookKey,{status:202}));await assert.rejects(first.run.run('prompt',1000),/HTTP 202/);assert.equal(first.state.stops,1);
 const second=await fixture(t);const pending=second.run.run('prompt',1000);const rejected=assert.rejects(pending,/Grok reported a failure/);await dispatched(second.state);
 assert.equal((await callback(second.state,{requestId:'task-1',error:webhookKey})).status,200);await rejected;
 assert.ok(!JSON.stringify(second.state.events).includes(webhookKey));
});

test('cancellation stops waiting, aborts dispatch and rejects late callbacks',async t=>{
 const {run,state}=await fixture(t,(_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('fetch aborted')),{once:true})));
 const pending=run.run('prompt',3000);const rejected=assert.rejects(pending,/cancelled/);await dispatched(state);await run.stop();await rejected;
 assert.equal(state.options.signal.aborted,true);assert.equal(state.stops,1);await assert.rejects(callback(state,{requestId:'task-1',text:'late'}));
 await run.stop();assert.equal(state.stops,1);
});

test('timeout covers dispatch and tunnel death ends a pending reply with cleanup',async t=>{
 const first=await fixture(t);await assert.rejects(first.run.run('prompt',40),/time limit/);assert.equal(first.state.stops,1);
 const second=await fixture(t);const pending=second.run.run('prompt',2000);const rejected=assert.rejects(pending,/reply connection closed/);await dispatched(second.state);second.state.tunnelArgs.onFailure();await rejected;assert.equal(second.state.stops,1);
});

test('disabled connections cannot dispatch and a stopped run cannot be reused',async t=>{
 const {connection,state,run}=await fixture(t);await connection.configure({enabled:false});await assert.rejects(run.run('prompt',1000),/not enabled/);assert.equal(state.dispatches,0);
 const stopped=connection.createRun('task-2',()=>{});await stopped.stop();await assert.rejects(stopped.run('prompt',1000),/cancelled/);
});


test('cancellation during callback listener startup does not leave a listening server',async t=>{
 const {run,state}=await fixture(t);const pending=run.run('prompt',1000);const rejected=assert.rejects(pending,/cancelled/);await run.stop();await rejected;assert.equal(state.dispatches,0);
});

test('cancellation during tunnel setup disposes a tunnel that resolves late',async t=>{
 const {connection,run,state}=await fixture(t);let finish,start;
 const started=new Promise(resolve=>{start=resolve;});
 connection.tunnelFactory=({localUrl})=>{start();return new Promise(resolve=>{finish=()=>resolve({url:localUrl,stop:async()=>{state.stops++;}});});};
 const pending=run.run('prompt',1000);const rejected=assert.rejects(pending,/cancelled/);await started;const stopping=run.stop();finish();await stopping;await rejected;assert.equal(state.stops,1);assert.equal(state.dispatches,0);
});

async function processFixture(t,script,fetchImpl,probeImpl=async()=>new Response('',{status:404,headers:{'X-Relay-Reply':'1'}})){
 const dataDir=await mkdtemp(join(tmpdir(),'relay-grok-process-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));await mkdir(join(dataDir,'bin'));
 await writeFile(join(dataDir,'bin/cloudflared'),`#!${process.execPath}\n${script}`,{mode:0o700});
 const connection=new GrokConnection(dataDir,{fetchImpl,probeImpl});await connection.configure({webhookUrl,webhookKey,enabled:true});
 const run=connection.createRun('process-task');t.after(()=>run.stop());return{connection,run,dataDir};
}

test('production tunnel waits for registration, isolates configuration and stops its process',posixFixture,async t=>{
 let dispatchedAt,localUrl;
 const fixture=await processFixture(t,`
import fs from 'node:fs';
fs.writeFileSync('../process.json',JSON.stringify({pid:process.pid,args:process.argv,home:process.env.HOME,unexpected:process.env.TUNNEL_TOKEN}));
console.error('https://relay-test.trycloudflare.com');
setTimeout(()=>console.error('Registered tunnel connection connIndex=0'),70);
setInterval(()=>{},1000);
`,async(_url,options)=>{
  dispatchedAt=Date.now();const payload=JSON.parse(options.body);assert.equal(payload.callback.url,'https://relay-test.trycloudflare.com/result');
  const processInfo=JSON.parse(await readFile(join(fixture.dataDir,'process.json'),'utf8'));localUrl=processInfo.args[processInfo.args.indexOf('--url')+1];
  await fetch(localUrl+'/result',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${payload.callback.token}`},body:JSON.stringify({requestId:'process-task',text:'real process, local callback'})});return new Response('',{status:200});
 });
 assert.equal(fixture.connection.status().tunnelInstalled,true);const started=Date.now();assert.equal(await fixture.run.run('prompt',3000),'real process, local callback');assert.ok(dispatchedAt-started>=60);
 const info=JSON.parse(await readFile(join(fixture.dataDir,'process.json'),'utf8'));assert.ok(info.args.includes('--no-autoupdate'));assert.ok(info.args.includes('--config'));assert.ok(info.home.startsWith(fixture.dataDir));assert.throws(()=>process.kill(info.pid,0),/ESRCH/);
 assert.deepEqual((await readdir(fixture.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);await assert.rejects(fetch(localUrl+'/result'));
});

test('production tunnel startup failure and cancellation both clean temporary state',posixFixture,async t=>{
 const failed=await processFixture(t,`process.stderr.write('private diagnostic should not escape');process.exit(1);`,()=>assert.fail('must not dispatch'));
 await assert.rejects(failed.run.run('prompt',1000),e=>/reply connection/.test(e.message)&&!e.message.includes('private diagnostic'));assert.deepEqual((await readdir(failed.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);
 const cancelled=await processFixture(t,`setInterval(()=>{},1000);`,()=>assert.fail('must not dispatch'));
 const pending=cancelled.run.run('prompt',1000);const rejected=assert.rejects(pending,/cancelled/);await pause(40);await cancelled.run.stop();await rejected;
 for(let i=0;i<100&&(await readdir(cancelled.dataDir)).some(name=>name.startsWith('grok-tunnel-'));i++)await pause(10);
 assert.deepEqual((await readdir(cancelled.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);
});


test('known callback and webhook credentials are redacted even if the bot echoes them',async t=>{
 const {run,state}=await fixture(t);const pending=run.run('prompt',2000);await dispatched(state);
 await callback(state,{requestId:'task-1',text:`Echo ${state.payload.callback.token} ${webhookKey}`});assert.equal(await pending,'Echo [redacted] [redacted]');
 assert.ok(!JSON.stringify(state.events).includes(state.payload.callback.token));
});

test('production tunnel does not inherit named tunnel credentials from Relay environment',posixFixture,async t=>{
 const previous=process.env.TUNNEL_TOKEN;process.env.TUNNEL_TOKEN='secret-unrelated-tunnel';
 t.after(()=>{if(previous===undefined)delete process.env.TUNNEL_TOKEN;else process.env.TUNNEL_TOKEN=previous;});
 const fixture=await processFixture(t,`require('node:fs').writeFileSync('../environment.json',JSON.stringify(process.env));setInterval(()=>{},1000);`,()=>assert.fail('must not dispatch'));
 const pending=fixture.run.run('prompt',5000);const rejected=assert.rejects(pending,/cancelled/);
 let environment;for(let i=0;i<300&&!environment;i++){try{environment=JSON.parse(await readFile(join(fixture.dataDir,'environment.json'),'utf8'));}catch{await pause(5);}}
 assert.ok(environment);assert.equal(environment.TUNNEL_TOKEN,undefined);await fixture.run.stop();await rejected;
});

test('invalid saved settings leave Relay available and can be replaced without leaking their contents',async t=>{
 const {dataDir}=await fixture(t);const invalid=JSON.stringify({webhookUrl:'https://evil.test',webhookKey:'private-invalid-key',enabled:true});await writeFile(join(dataDir,'grok.json'),invalid);
 const restored=new GrokConnection(dataDir);await restored.load();const status=restored.status();assert.equal(status.configured,false);assert.equal(status.enabled,false);assert.ok(status.configurationError);assert.ok(!JSON.stringify(status).includes('private-invalid-key'));assert.equal(await readFile(join(dataDir,'grok.json'),'utf8'),invalid);
 await restored.configure({webhookUrl,webhookKey,enabled:true});assert.equal(restored.status().configured,true);assert.equal(restored.status().configurationError,undefined);
});

test('configuration rejects falsey non-string keys instead of silently retaining credentials',async t=>{
 const {connection}=await fixture(t);for(const key of [false,0,null])await assert.rejects(connection.configure({webhookKey:key}),/key/);
});

test('unexpected tunnel process exit also kills its owned descendants',posixFixture,async t=>{
 const fixture=await processFixture(t,`
const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
require('node:fs').writeFileSync('../descendant.json',JSON.stringify({pid:child.pid}));
setTimeout(()=>process.exit(1),30);
`,()=>assert.fail('must not dispatch'));
 await assert.rejects(fixture.run.run('prompt',2000),/reply connection/);const {pid}=JSON.parse(await readFile(join(fixture.dataDir,'descendant.json'),'utf8'));
 t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});await pause(30);assert.throws(()=>process.kill(pid,0),/ESRCH/);
});

test('stop reports cleanup failure without exposing credentials so the scheduler can pause',async t=>{
 const {connection,run,state}=await fixture(t);state.expectedCleanupFailure=true;connection.tunnelFactory=async({localUrl})=>({url:localUrl,stop:async()=>{throw new Error(webhookKey);}});
 const pending=run.run('prompt',2000);const rejected=assert.rejects(pending,e=>/cleanup failed/.test(e.message)&&!e.message.includes(webhookKey));await dispatched(state);await assert.rejects(run.stop(),e=>/cleanup failed/.test(e.message)&&!e.message.includes(webhookKey));await rejected;assert.ok(!JSON.stringify(state.events).includes(webhookKey));
});

test('changing webhook credentials clears prior reply evidence while enabled toggles preserve it',async t=>{
 for(const change of [{webhookKey:'replacement-key'},{webhookUrl:'https://api3.cursor.sh/automations/webhook/new',webhookKey}]){
  const {connection,run,state}=await fixture(t);const pending=run.run('prompt',2000);await dispatched(state);await callback(state,{requestId:'task-1',text:'verified reply'});await pending;
  const lastResultAt=connection.status().lastResultAt;assert.ok(lastResultAt);
  await connection.configure({enabled:false});assert.equal(connection.status().lastResultAt,lastResultAt);
  await connection.configure({enabled:true});assert.equal(connection.status().lastResultAt,lastResultAt);
  await connection.configure(change);assert.equal(connection.status().lastResultAt,undefined);
 }
});


const readyProcess=`
require('node:fs').writeFileSync('../process.json',JSON.stringify({pid:process.pid,args:process.argv}));
console.error('https://relay-test.trycloudflare.com');console.error('Registered tunnel connection connIndex=0');setInterval(()=>{},1000);
`;

test('callback root identifies only the reply listener without exposing data',async t=>{
 const {run,state}=await fixture(t);const pending=run.run('prompt',2000);const rejected=assert.rejects(pending,/cancelled/);await dispatched(state);
 const response=await fetch(state.localUrl);assert.equal(response.status,404);assert.equal(response.headers.get('X-Relay-Reply'),'1');assert.equal(await response.text(),'');await run.stop();await rejected;
});

test('production tunnel waits through DNS, edge and unrecognized responses before dispatching',posixFixture,async t=>{
 let probes=0;
 const fixture=await processFixture(t,readyProcess,async(_url,options)=>{
  assert.equal(probes,4);const payload=JSON.parse(options.body);const info=JSON.parse(await readFile(join(fixture.dataDir,'process.json'),'utf8'));const localUrl=info.args[info.args.indexOf('--url')+1];
  await fetch(localUrl+'/result',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${payload.callback.token}`},body:JSON.stringify({requestId:'process-task',text:'ready after propagation'})});return new Response('',{status:200});
 },async(url,options)=>{
  probes++;assert.equal(url,'https://relay-test.trycloudflare.com/');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);assert.equal(options.headers,undefined);
  if(probes===1)throw new Error('getaddrinfo ENOTFOUND');
  if(probes===2)return new Response('',{status:530});
  if(probes===3)return new Response('',{status:404});
  return new Response('',{status:404,headers:{'X-Relay-Reply':'1'}});
 });
 assert.equal(await fixture.run.run('private prompt',6000),'ready after propagation');assert.equal(probes,4);assert.deepEqual((await readdir(fixture.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);
});

test('cancelling a pending readiness probe aborts it and cleans its process before returning',posixFixture,async t=>{
 let probeSignal;
 const fixture=await processFixture(t,readyProcess,()=>assert.fail('must not dispatch'),(_url,options)=>new Promise((_resolve,reject)=>{probeSignal=options.signal;options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});}));
 const pending=fixture.run.run('prompt',2000);const rejected=assert.rejects(pending,/cancelled/);rejected.catch(()=>{});
 for(let i=0;i<100&&!probeSignal;i++)await pause(5);assert.ok(probeSignal);await fixture.run.stop();await rejected;assert.equal(probeSignal.aborted,true);
 const {pid}=JSON.parse(await readFile(join(fixture.dataDir,'process.json'),'utf8'));assert.throws(()=>process.kill(pid,0),/ESRCH/);assert.deepEqual((await readdir(fixture.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);
});

test('overall task timeout bounds repeated readiness failures without dispatch',posixFixture,async t=>{
 let probes=0;const fixture=await processFixture(t,readyProcess,()=>assert.fail('must not dispatch'),async()=>{probes++;return new Response('',{status:530});});
 await assert.rejects(fixture.run.run('prompt',1500),/time limit/);assert.ok(probes>=1);assert.deepEqual((await readdir(fixture.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);
});

test('startup allows a sixty-second negative DNS cache while the overall task limit still applies',posixFixture,async t=>{
 let resolveProbe,announceProbe;const probing=new Promise(resolve=>{announceProbe=resolve;});
 const fixture=await processFixture(t,readyProcess,async(_url,options)=>{
  const payload=JSON.parse(options.body);const info=JSON.parse(await readFile(join(fixture.dataDir,'process.json'),'utf8'));const localUrl=info.args[info.args.indexOf('--url')+1];
  await fetch(localUrl+'/result',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${payload.callback.token}`},body:JSON.stringify({requestId:'process-task',text:'reply after negative DNS cache'})});return new Response('',{status:200});
 },()=>new Promise(resolve=>{resolveProbe=resolve;announceProbe();}));
 t.mock.timers.enable({apis:['setTimeout']});const pending=fixture.run.run('prompt',120000);pending.catch(()=>{});await probing;
 t.mock.timers.tick(60000);t.mock.timers.reset();resolveProbe(new Response('',{status:404,headers:{'X-Relay-Reply':'1'}}));
 assert.equal(await pending,'reply after negative DNS cache');assert.deepEqual((await readdir(fixture.dataDir)).filter(name=>name.startsWith('grok-tunnel-')),[]);
});
