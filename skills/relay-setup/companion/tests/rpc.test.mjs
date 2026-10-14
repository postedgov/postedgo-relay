import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
let Rpc;
try {({Rpc}=await import('../src/rpc.mjs'));}catch{}
function child(){const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>c.emit('close',null,'SIGTERM');return c;}
test('RPC handles split messages and routes server approval requests',async()=>{
 assert.equal(typeof Rpc,'function','RPC transport must exist');
 const c=child();const rpc=new Rpc(c);const sent=[];c.stdin.on('data',d=>sent.push(JSON.parse(d)));
 const promise=rpc.request('initialize',{});const id=sent[0].id;
 c.stdout.write('{"id":');c.stdout.write(`${id},"result":{"ok":true}}\n`);
 assert.deepEqual(await promise,{ok:true});
 rpc.onRequest=async m=>({outcome:m.params.value});
 c.stdout.write('{"id":"permission","method":"session/request_permission","params":{"value":"approved"}}\n');
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(sent.at(-1).result,{outcome:'approved'});rpc.stop();
});
test('RPC rejects pending work when subprocess exits',async()=>{
 assert.ok(Rpc,'RPC transport must exist');const c=child();const rpc=new Rpc(c);const p=rpc.request('test',{});
 c.emit('close',1,null);await assert.rejects(p,/exited/);
});
test('RPC request timeouts remove pending requests',async()=>{
 assert.ok(Rpc,'RPC transport must exist');const rpc=new Rpc(child());await assert.rejects(rpc.request('stuck',{},10),/timed out/);assert.equal(rpc.pending.size,0);rpc.stop();
});
test('stop waits for a slow subprocess to exit before resolving',async()=>{
 const c=child();c.kill=()=>{setTimeout(()=>c.emit('close',null,'SIGTERM'),40);};
 const rpc=new Rpc(c);const start=Date.now();await rpc.stop();assert.ok(Date.now()-start>=30,'stop must wait for process exit');
});
test('stop retires a tool process even when its parent exits first',{skip:process.platform==='win32'?'POSIX process-group fixture; Windows taskkill is covered by platform tests.':false},async()=>{
 const {spawn}=await import('node:child_process');
 const code=`const {spawn}=require('node:child_process');const sub=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});sub.stdout.once('data',()=>console.log(JSON.stringify({method:'child',params:{pid:sub.pid}})));setInterval(()=>{},1000);`;
 const proc=spawn(process.execPath,['-e',code],{detached:true,stdio:['pipe','pipe','pipe']});const rpc=new Rpc(proc);
 const pid=await new Promise(resolve=>rpc.once('notification',m=>resolve(m.params.pid)));
 const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
 try{await rpc.stop();await new Promise(r=>setTimeout(r,80));assert.equal(alive(),false,'descendant must stop too');}
 finally{try{process.kill(pid,'SIGKILL');}catch{}try{process.kill(-proc.pid,'SIGKILL');}catch{}}
});
