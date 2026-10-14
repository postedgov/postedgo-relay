import {spawn} from 'node:child_process';
import {readFile,mkdir,open} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openTarget} from './platform.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dataDir=resolve(process.env.RELAY_DATA_DIR||join(root,'.relay'));
await mkdir(dataDir,{recursive:true,mode:0o700});
async function running(){
  try{
    const runtime=JSON.parse(await readFile(join(dataDir,'runtime.json'),'utf8'));
    if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.url))return null;
    const token=(await readFile(join(dataDir,'token'),'utf8')).trim();
    const r=await fetch(runtime.url+'/api/state',{headers:{'X-Relay-Token':token},signal:AbortSignal.timeout(1000)});
    if(!r.ok)return null;
    const state=await r.json();if(!Array.isArray(state.projects))return null;
    return{...runtime,token};
  }catch{return null;}
}
let runtime=await running();
if(process.argv.includes('--stop')){
  if(runtime){
    const response=await fetch(runtime.url+'/api/shutdown',{method:'POST',headers:{'X-Relay-Token':runtime.token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Relay could not stop. Use the running app to stop active work.');
    const result=await response.json();
    const deadline=Date.now()+15000;while(Date.now()<deadline&&await running())await new Promise(r=>setTimeout(r,100));
    if(await running())throw new Error('Relay is still stopping. Check active work before restarting.');
    console.log('Relay service stopped. Running tasks were saved.');
    if(result.warning){console.error(result.warning);process.exitCode=1;}
  }
  else console.log('Relay is not running.');
}else{
  if(!runtime){
    const log=await open(join(dataDir,'server.log'),'a',0o600);
    const child=spawn(process.execPath,[join(root,'src/server.mjs')],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,RELAY_DATA_DIR:dataDir}});let startError=false;child.once('error',()=>{startError=true;});child.unref();await log.close();
    const deadline=Date.now()+15000;
    while(Date.now()<deadline&&!runtime&&!startError&&child.exitCode==null){await new Promise(r=>setTimeout(r,250));runtime=await running();}
    if(!runtime)throw new Error('Relay could not start. Check server.log in the selected Relay data folder; its port may already be in use.');
  }
  if(!process.argv.includes('--no-open'))await openTarget(runtime.url+'/#token='+runtime.token);
  console.log('Relay is ready at '+runtime.url);
}
