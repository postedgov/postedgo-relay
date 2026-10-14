import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
let spawnOwned;try{({spawnOwned}=await import('../src/platform.mjs'));}catch{}
const windows={skip:process.platform!=='win32'?'Requires real Windows Job Objects and PowerShell; no simulated certification.':false,timeout:20000};
async function waitFor(check){for(let i=0;i<400;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}assert.fail('Windows child lifecycle did not finish');}
for(const mode of ['parent-exit','wrapper-killed'])test(`owned Windows descendants stop after ${mode}`,windows,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-job-'));const path=join(dir,'process.json');const script=join(dir,'spawn.cjs');let info;
 await writeFile(script,`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],JSON.stringify({pid:child.pid,args:process.argv.slice(3)}));${mode==='parent-exit'?'process.exit(0);':'setInterval(()=>{},1000);'}`);
 const proc=spawnOwned(process.execPath,[script,path,'space & quote " tail\\'],{stdio:['pipe','pipe','pipe']});const closed=once(proc,'close');proc.stdout.resume();proc.stderr.resume();
 t.after(async()=>{try{proc.kill();}catch{}if(info?.pid){try{process.kill(info.pid);}catch{}}await rm(dir,{recursive:true,force:true});});
 await waitFor(async()=>{try{info=JSON.parse(await readFile(path,'utf8'));return true;}catch{return false;}});assert.deepEqual(info.args,['space & quote " tail\\']);
 if(mode==='wrapper-killed')proc.kill();await closed;
 await waitFor(()=>{try{process.kill(info.pid,0);return false;}catch{return true;}});
});

test('Windows job helper preserves UTF-8 stdin, stdout and stderr for agent RPC',windows,async t=>{
 const {Rpc}=await import('../src/rpc.mjs');
 const script=`let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\n'))>=0){const message=JSON.parse(input.slice(0,end));input=input.slice(end+1);process.stderr.write('diagnostic café 界\\n');process.stdout.write(JSON.stringify({id:message.id,result:message.params})+'\\n');}});`;
 const child=spawnOwned(process.execPath,['-e',script],{stdio:['pipe','pipe','pipe']});const rpc=new Rpc(child);let diagnostics='';rpc.on('diagnostic',text=>{diagnostics+=text;});t.after(()=>rpc.stop());
 const params={text:'Room says café, 界 and 👋',quoted:'spaces & quotes " tail\\'};
 assert.deepEqual(await rpc.request('echo',params,15000),params);await waitFor(()=>diagnostics.includes('diagnostic café 界'));await rpc.stop();
});
