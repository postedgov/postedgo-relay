import {mkdir,lstat,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const inside=(root,target)=>{const path=relative(root,target);return !path||(!isAbsolute(path)&&path.split(sep)[0]!=='..');};
export async function install({source=resolve(import.meta.dirname,'..'),target}={}){
 source=await realpath(source);target=resolve(target||join(homedir(),'.postedgo-relay'));
 let pluginRoot=source;
 for(let parent=dirname(source);parent!==dirname(parent);parent=dirname(parent)){
  try{
   const manifest=JSON.parse(await readFile(join(parent,'plugin.json'),'utf8'));
   if(manifest.name==='postedgo-relay'){pluginRoot=parent;break;}
  }catch(error){if(error.code!=='ENOENT')throw new Error('Cannot verify the enclosing plugin directory.');}
 }
 if(inside(pluginRoot,target))throw new Error('Install outside the plugin folder so updates cannot replace your room data.');
 const files=[];
 for(const line of (await readFile(join(source,'SHA256SUMS'),'utf8')).trim().split('\n')){
  const match=line.match(/^([a-f0-9]{64})  (.+)$/);if(!match)throw new Error('Invalid release hash list.');
  if(!match[2].startsWith('companion/'))continue;
  const path=match[2].slice(10);
  if(!/^(?:(?:src|public|tests)\/[a-zA-Z0-9_.-]+|package\.json|LICENSE|Launch Relay\.(?:command|cmd)|launch-relay\.sh)$/.test(path))throw new Error('Invalid companion release path.');
  let current=source;
  for(const part of ['companion',...path.split('/')]){current=join(current,part);if((await lstat(current)).isSymbolicLink())throw new Error('Release paths cannot be symbolic links.');}
  if(!(await lstat(current)).isFile())throw new Error('Expected a release file.');
  const data=await readFile(current);
  if(createHash('sha256').update(data).digest('hex')!==match[1])throw new Error('Release hash mismatch. Download a fresh publisher release.');
  if(files.some(file=>file.path===path))throw new Error('Duplicate release path.');
  files.push({path,data});
 }
 for(const required of ['src/launch.mjs','src/server.mjs','package.json','LICENSE'])if(!files.some(file=>file.path===required))throw new Error('The companion release is incomplete.');
 await mkdir(dirname(target),{recursive:true});
 if(inside(pluginRoot,join(await realpath(dirname(target)),target.split(sep).at(-1))))throw new Error('Install outside the plugin folder.');
 await mkdir(target,{mode:0o700});
 try{
  for(const {path,data} of files){const file=join(target,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,data,{flag:'wx',mode:/\.(command|sh)$/.test(file)?0o755:0o644});}
 }catch(error){await rm(target,{recursive:true,force:true});throw error;}
 return{installationDir:target,launcher:join(target,'src/launch.mjs'),files:files.length};
}
if(process.argv[1]&&await realpath(fileURLToPath(import.meta.url))===await realpath(process.argv[1])){
 try{console.log(JSON.stringify(await install({target:process.argv[2]}),null,2));}
 catch(error){console.error(error.code==='EEXIST'?'Relay already exists at this location. Open its existing launcher; this installer will not overwrite it.':error.message);process.exitCode=1;}
}
