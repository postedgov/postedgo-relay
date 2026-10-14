import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
let install;try{({install}=await import('./install.mjs'));}catch{}
async function fixture(){
 const base=await mkdtemp(join(tmpdir(),'relay-install-'));const source=join(base,'plugin');await mkdir(join(source,'companion/src'),{recursive:true});
 const files={'src/launch.mjs':'// launcher','src/server.mjs':'// server','package.json':'{"version":"0.1.1"}','LICENSE':'MIT notice'};
 for(const [path,data] of Object.entries(files))await writeFile(join(source,'companion',path),data);
 await writeFile(join(source,'SHA256SUMS'),Object.entries(files).map(([path,data])=>`${createHash('sha256').update(data).digest('hex')}  companion/${path}`).join('\n')+'\n');
 return{base,source,target:join(base,'installed')};
}
test('installer copies verified companion only and never overwrites an existing installation',async()=>{
 assert.equal(typeof install,'function');const f=await fixture();try{
 await mkdir(join(f.source,'companion/.relay'));await writeFile(join(f.source,'companion/.relay/token'),'must-not-copy');
 await install({source:f.source,target:f.target});assert.equal(await readFile(join(f.target,'src/server.mjs'),'utf8'),'// server');
 await assert.rejects(readFile(join(f.target,'.relay/token')),/ENOENT/);
 await writeFile(join(f.target,'keep.txt'),'user data');await assert.rejects(install({source:f.source,target:f.target}),/exist/i);assert.equal(await readFile(join(f.target,'keep.txt'),'utf8'),'user data');
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('installer rejects modified files, paths outside companion without partial installs',async()=>{
 assert.equal(typeof install,'function');const f=await fixture();try{
 await writeFile(join(f.source,'companion/src/server.mjs'),'changed');await assert.rejects(install({source:f.source,target:f.target}),/hash/i);await assert.rejects(readFile(join(f.target,'src/launch.mjs')),/ENOENT/);
 await writeFile(join(f.source,'SHA256SUMS'),'a'.repeat(64)+'  companion/../escape\n');await assert.rejects(install({source:f.source,target:f.target}),/path/i);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
test('installer refuses package-local destination',async()=>{
 assert.equal(typeof install,'function');const f=await fixture();try{await assert.rejects(install({source:f.source,target:join(f.source,'installed')}),/outside/i);}finally{await rm(f.base,{recursive:true,force:true});}
});
test('installer rejects a symlink in the verified source tree',{skip:process.platform==='win32'?'Symlink creation needs Windows developer privileges':false},async()=>{
 const f=await fixture();try{await rm(join(f.source,'companion/src/server.mjs'));await symlink(join(f.source,'companion/src/launch.mjs'),join(f.source,'companion/src/server.mjs'));await assert.rejects(install({source:f.source,target:f.target}),/symbolic/i);}finally{await rm(f.base,{recursive:true,force:true});}
});
test('installer preserves the enclosing marketplace package while allowing isolated skill installs',async()=>{
 const f=await fixture();try{
  const bundle=join(f.source,'skills/relay-setup');await mkdir(join(f.source,'skills'),{recursive:true});
  const {rename}=await import('node:fs/promises');await mkdir(bundle);
  await rename(join(f.source,'companion'),join(bundle,'companion'));
  await rename(join(f.source,'SHA256SUMS'),join(bundle,'SHA256SUMS'));
  await writeFile(join(f.source,'plugin.json'),'{"name":"postedgo-relay"}');
  await assert.rejects(install({source:bundle,target:join(f.source,'installed-data')}),/outside/i);
  const result=await install({source:bundle,target:f.target});assert.equal(result.installationDir,f.target);
 }finally{await rm(f.base,{recursive:true,force:true});}
});
