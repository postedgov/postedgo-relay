import {execFile,spawn} from 'node:child_process';
import {accessSync,constants,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {posix,win32} from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);

export function environment(env=process.env,platform=process.platform,home=homedir()){
 const path=platform==='win32'?win32:posix;const result={...env};const key=Object.keys(env).find(key=>key.toLowerCase()==='path');
 for(const name of Object.keys(result))if(name.toLowerCase()==='path')delete result[name];
 result.PATH=[env[key],path.join(home,'.local','bin'),path.join(home,'.kimi-code','bin'),...(platform==='win32'?[]:['/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'])].filter(Boolean).join(platform==='win32'?';':':');return result;
}
export function findExecutable(name,{platform=process.platform,env=process.env,check}={}){
 const windows=platform==='win32',path=windows?win32:posix;
 check??=file=>{if(!statSync(file).isFile())throw new Error('Not a file');accessSync(file,windows?constants.F_OK:constants.X_OK);};
 if(name==='codex'&&platform==='darwin'){const bundled='/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';try{check(bundled);return bundled;}catch{}}
 const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path');
 // shortcut: Windows batch shims need shell parsing; require a native executable until a safe adapter exists.
 const extensions=windows?(env.PATHEXT||'.EXE;.COM').split(';').filter(ext=>/^\.(exe|com)$/i.test(ext)):[''];
 for(const folder of (env[pathKey]||'').split(windows?';':':').filter(Boolean))for(const extension of extensions){
  const file=path.join(folder.replace(/^"(.*)"$/,'$1'),name+extension);try{check(file);return file;}catch{}
 }
 return null;
}
export async function openTarget(target,{platform=process.platform,env=process.env,exec:run=exec}={}){
 let command,args=[target];
 if(platform==='darwin')command='/usr/bin/open';
 else if(platform==='win32'){
  const root=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows';const url=/^https?:\/\//.test(target);
  command=url?win32.join(root,'System32','rundll32.exe'):win32.join(root,'explorer.exe');if(url)args=['url.dll,FileProtocolHandler',target];
 }else command='xdg-open';
 try{await run(command,args,{windowsHide:true,timeout:15000});}catch{throw new Error('Could not open the browser or folder. Open the local Relay address or project folder manually.');}
}
export function tunnelEnvironment(folder,env=process.env,platform=process.platform){
 const result={PATH:env.PATH,HOME:folder,TMPDIR:folder,LANG:env.LANG||'en_US.UTF-8'};
 if(platform==='win32')Object.assign(result,{SystemRoot:env.SystemRoot||env.SYSTEMROOT||'C:\\Windows',WINDIR:env.WINDIR||env.SystemRoot||'C:\\Windows',USERPROFILE:folder,APPDATA:folder,LOCALAPPDATA:folder,TEMP:folder,TMP:folder});return result;
}
export function spawnOwned(file,args,options,{platform=process.platform,spawn:run=spawn}={}){
 if(platform!=='win32')return run(file,args,{...options,detached:true});
 const env=options.env||process.env;const powershell=win32.join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const command=Buffer.from(JSON.stringify({file,args})).toString('base64');
 return run(powershell,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./windows-job.ps1',import.meta.url)),'-CommandSpec',command],{...options,detached:false,windowsHide:true});
}
export function reapProcessGroup(child,platform=process.platform){if(platform!=='win32'&&child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}}
export async function stopProcess(child,{platform=process.platform,env=process.env,exec:run=exec}={}){
 if(child.exitCode!=null||child.signalCode!=null){reapProcessGroup(child,platform);return;}
 let close;const closed=new Promise(resolve=>{close=resolve;child.once('close',resolve);});let timer;
 try{
  if(platform==='win32'&&child.pid){
   try{await run(win32.join(env.SystemRoot||env.SYSTEMROOT||'C:\\Windows','System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});}
   catch{try{child.kill();}catch{}throw new Error('Could not stop the agent process tree. Check running processes before continuing.');}
  }else{
   const kill=signal=>{try{if(child.pid)process.kill(-child.pid,signal);else child.kill(signal);}catch{try{child.kill(signal);}catch{}}};
   timer=setTimeout(()=>kill('SIGKILL'),2000);kill('SIGTERM');
  }
  await closed;reapProcessGroup(child,platform);
 }finally{clearTimeout(timer);child.removeListener('close',close);}
}
