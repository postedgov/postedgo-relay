import http from 'node:http';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
let createApp;try{({createApp}=await import('../src/server.mjs'));}catch{}
test('API requires token, rejects foreign origins and validates project paths',async()=>{
 assert.equal(typeof createApp,'function','HTTP service must exist');
 const dir=mkdtempSync(join(tmpdir(),'relay-api-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{
 const url=app.url;const headers={'X-Relay-Token':app.token,'Content-Type':'application/json'};
 assert.equal((await fetch(url+'/api/state')).status,401);
 assert.equal((await fetch(url+'/api/state',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 const badHost=await new Promise((resolve,reject)=>{const req=http.get(url+'/api/state',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
 assert.equal(badHost,403);
 assert.equal((await fetch(url+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Bad',path:'/nonexistent-relay-folder'})})).status,400);
 const p=await(await fetch(url+'/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Test',path:dir})})).json();
 const t=await(await fetch(url+'/api/tasks',{method:'POST',headers,body:JSON.stringify({projectId:p.id,title:'Inspect',prompt:'Read project',agent:'grok'})})).json();
 assert.equal(t.status,'queued');
 assert.equal((await fetch(url+`/api/tasks/${t.id}/verify`,{method:'POST',headers,body:'{}'})).status,400);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('duplicate server startup does not interrupt the running instance tasks',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-duplicate-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{const p=app.store.projects()[0];const t=app.store.addTask({projectId:p.id,title:'Running',prompt:'Inspect',agent:'codex'});app.store.transition(t.id,'running');
 await assert.rejects(createApp({dataDir:dir,port:app.server.address().port,runAgents:false}),/EADDRINUSE/);
 assert.equal(app.store.task(t.id).status,'running');}
 finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
test('malformed request URLs return 400 and leave the service healthy',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-url-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{const status=await new Promise((resolveStatus,reject)=>{const req=http.get({hostname:'127.0.0.1',port:app.server.address().port,path:'//['},res=>{res.resume();resolveStatus(res.statusCode);});req.on('error',reject);});assert.equal(status,400);assert.equal((await fetch(app.url+'/health')).status,200);}
 finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown is authenticated and gracefully retires only its local app',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-stop-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{
  const request={method:'POST',headers:{'Content-Type':'application/json'},body:'{}'};
  assert.equal((await fetch(app.url+'/api/shutdown',request)).status,401);
  assert.equal((await fetch(app.url+'/api/shutdown',{...request,headers:{...request.headers,'X-Relay-Token':app.token,Origin:'https://evil.example'}})).status,403);
  const state=await(await fetch(app.url+'/api/state',{headers:{'X-Relay-Token':app.token}})).json();assert.ok(state.agents.some(a=>a.id===state.leadAgent));
  const closed=new Promise(resolve=>app.server.once('close',resolve));
  assert.equal((await fetch(app.url+'/api/shutdown',{...request,headers:{...request.headers,'X-Relay-Token':app.token}})).status,200);await closed;
  await assert.rejects(fetch(app.url+'/api/state'));
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown keeps the local status available until active work has stopped',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-drain-'));const app=await createApp({dataDir:dir,port:0,runAgents:false});
 try{
  let release;app.runner.active={id:'fixture'};app.runner.close=()=>{release=()=>{app.runner.active=null;};};
  const closing=app.close();assert.equal(app.server.listening,true,'readiness must not disappear before process cleanup');
  const response=await fetch(app.url+'/api/state',{headers:{'X-Relay-Token':app.token}});assert.equal(response.status,200);
  release();await closing;assert.equal(app.server.listening,false);
 }finally{app.runner.active=null;await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('shutdown reports uncertain cleanup and restart stays paused until an explicit queue resume',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'relay-cleanup-api-'));let app=await createApp({dataDir:dir,port:0,runAgents:false});let started=false;
 class Fake{async run(){started=true;return new Promise(()=>{});}async stop(){throw new Error('private diagnostic');}}
 try{
  app.runner.AgentClass=Fake;const task=app.store.addTask({projectId:app.store.projects()[0].id,title:'Inspect',prompt:'Inspect',agent:'codex'});app.runner.tick();
  for(let i=0;i<100&&!started;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(started,true);
  const headers={'X-Relay-Token':app.token,'Content-Type':'application/json'};const closed=new Promise(resolve=>app.server.once('close',resolve));
  const result=await(await fetch(app.url+'/api/shutdown',{method:'POST',headers,body:'{}'})).json();assert.equal(result.ok,true);assert.match(result.warning,/processes/);assert.doesNotMatch(result.warning,/private diagnostic/);await closed;await app.close();
  const {writeFile}=await import('node:fs/promises');await writeFile(join(dir,'settings.json'),JSON.stringify({paused:false}));
  app=await createApp({dataDir:dir,port:0,runAgents:false});const restartedHeaders={'X-Relay-Token':app.token,'Content-Type':'application/json'};
  const state=await(await fetch(app.url+'/api/state',{headers:restartedHeaders})).json();assert.equal(state.paused,true);assert.match(state.cleanupError,/processes/);assert.equal(app.store.task(task.id).status,'interrupted');
  assert.equal((await fetch(app.url+'/api/queue',{method:'POST',headers:restartedHeaders,body:JSON.stringify({paused:false})})).status,200);
  assert.equal(app.runner.paused,false);assert.equal(app.runner.cleanupError,null);assert.ok(app.store.task(task.id).cleanupAcknowledgedAt);
 }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
