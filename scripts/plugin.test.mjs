import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,cp,rm,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const root=resolve(import.meta.dirname,'..');
async function files(dir,prefix=''){
 const result=[];
 for(const entry of await readdir(join(dir,prefix),{withFileTypes:true})){
  const path=prefix?`${prefix}/${entry.name}`:entry.name;
  if(['.git','__pycache__'].includes(entry.name))continue;
  assert.ok(!entry.isSymbolicLink(),`Unexpected symbolic link: ${path}`);
  if(entry.isDirectory())result.push(...await files(dir,path));else result.push(path);
 }
 return result.sort();
}
test('marketplace metadata, hashes and every skill resource resolve in the release',async()=>{
 const portable=JSON.parse(await readFile(join(root,'plugin.json')));
 const cursor=JSON.parse(await readFile(join(root,'.cursor-plugin/plugin.json')));
 for(const key of ['name','version','description','author','license','keywords'])assert.deepEqual(cursor[key],portable[key],key);
 assert.equal(cursor.skills,'skills/');await readFile(join(root,cursor.logo));
 const paths=await files(root);
 const hashes=(await readFile(join(root,'SHA256SUMS'),'utf8')).trim().split('\n');
 assert.deepEqual(hashes.map(line=>line.slice(66)).sort(),paths.filter(path=>path!=='SHA256SUMS'));
 for(const line of hashes){
  assert.match(line,/^[a-f0-9]{64}  [^\r\n]+$/);
  const path=line.slice(66);assert.ok(!path.split('/').includes('..')&&!path.startsWith('/'));
  assert.equal(createHash('sha256').update(await readFile(join(root,path))).digest('hex'),line.slice(0,64),path);
 }
 for(const name of ['relay-setup','relay-reply']){
  const skill=join(root,'skills',name);const body=await readFile(join(skill,'SKILL.md'),'utf8');
  assert.ok(body.startsWith(`---\nname: ${name}\ndescription: `));
  await readFile(join(skill,'LICENSE'));
  for(const [,link] of body.matchAll(/\]\(([^)]+)\)/g)){
   if(/^https?:/.test(link))continue;
   assert.ok(!link.split('/').includes('..')&&!link.startsWith('/'),`${name}: ${link}`);
   await readFile(join(skill,link));
  }
 }
});
test('setup works with only its skill folder: install, launch, authentication, empty state and stop',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-plugin-'));const skill=join(dir,'opaque-mount');const target=join(dir,'installed');
 const env={...process.env,RELAY_PORT:'0',RELAY_DATA_DIR:join(target,'.relay')};
 let launcher;
 try{
  await cp(join(root,'skills/relay-setup'),skill,{recursive:true});
  const installed=await run(process.execPath,[join(skill,'scripts/install.mjs'),target],{cwd:tmpdir(),timeout:15000});
  const result=JSON.parse(installed.stdout);assert.equal(result.installationDir,target);assert.equal(result.files,28);
  launcher=result.launcher;assert.match(await readFile(join(target,'LICENSE'),'utf8'),/MIT License/);
  await run(process.execPath,[launcher,'--no-open'],{env,cwd:tmpdir(),timeout:20000});
  const runtime=JSON.parse(await readFile(join(env.RELAY_DATA_DIR,'runtime.json')));
  const token=(await readFile(join(env.RELAY_DATA_DIR,'token'),'utf8')).trim();
  assert.match(runtime.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(runtime.url+'/api/state')).status,401);
  assert.equal((await fetch(runtime.url+'/api/state',{headers:{'X-Relay-Token':'wrong'}})).status,401);
  const state=await fetch(runtime.url+'/api/state',{headers:{'X-Relay-Token':token}});assert.equal(state.status,200);
  assert.equal((await state.json()).tasks.length,0);
  const grok=await fetch(runtime.url+'/api/grok',{headers:{'X-Relay-Token':token}}).then(r=>r.json());
  assert.equal(grok.keySaved,false);assert.equal(grok.configured,false);
  await run(process.execPath,[launcher,'--stop'],{env,cwd:tmpdir(),timeout:20000});
  await assert.rejects(fetch(runtime.url+'/api/state'));
 }finally{
  try{if(launcher)await run(process.execPath,[launcher,'--stop'],{env,cwd:tmpdir(),timeout:20000});}
  finally{await rm(dir,{recursive:true,force:true});}
 }
});
test('reply helper works with only its skill folder and performs no real network requests',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'relay-reply-plugin-'));
 try{
  await cp(join(root,'skills/relay-reply'),join(dir,'opaque-mount'),{recursive:true});
  const result=await run(process.platform==='win32'?'python':'python3',[join(dir,'opaque-mount/scripts/test_reply.py')],{cwd:tmpdir(),timeout:10000});
  assert.match(result.stderr,/Ran 4 tests/);assert.match(result.stderr,/OK/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
