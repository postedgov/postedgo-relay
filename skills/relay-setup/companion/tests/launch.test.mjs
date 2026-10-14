import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const exec=promisify(execFile);
test('launcher uses its selected data directory, waits for readiness, reuses it and stops by authenticated request',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-launch-'));const env={...process.env,RELAY_DATA_DIR:dir,RELAY_PORT:'0'};
 const launch=async(...args)=>exec(process.execPath,[resolve('src/launch.mjs'),...args],{env,timeout:20000});let runtime,token;
 try{
  const first=await launch('--no-open');runtime=JSON.parse(await readFile(join(dir,'runtime.json'),'utf8'));token=(await readFile(join(dir,'token'),'utf8')).trim();
  assert.ok(!first.stdout.includes(token));assert.match(first.stdout,/Relay is ready/);
  const headers={'X-Relay-Token':token};const state=await(await fetch(runtime.url+'/api/state',{headers})).json();assert.equal(state.tasks.length,0);assert.ok(state.projects.every(p=>p.path.startsWith(dir)));
  await launch('--no-open');assert.equal(JSON.parse(await readFile(join(dir,'runtime.json'),'utf8')).pid,runtime.pid);
  const stopped=await launch('--stop');assert.match(stopped.stdout,/stopped/);await assert.rejects(fetch(runtime.url+'/api/state',{headers}));
  assert.match((await launch('--stop')).stdout,/not running/);
 }finally{
  if(runtime)await fetch(runtime.url+'/api/shutdown',{method:'POST',headers:{'X-Relay-Token':token,'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
  await rm(dir,{recursive:true,force:true});
 }
});
