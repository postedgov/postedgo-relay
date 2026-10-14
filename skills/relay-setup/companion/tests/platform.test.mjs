import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
let platform;try{platform=await import('../src/platform.mjs');}catch{}

test('Windows PATH normalization preserves system environment and adds user executables',()=>{
 assert.ok(platform,'portable platform helpers must exist');
 const env=platform.environment({Path:'C:\\Tools;C:\\Other',SystemRoot:'C:\\Windows',PATHEXT:'.EXE;.CMD'},'win32','C:\\Users\\Test User');
 assert.equal(env.Path,undefined);assert.ok(env.PATH.startsWith('C:\\Tools;C:\\Other;'));assert.ok(env.PATH.includes('C:\\Users\\Test User\\.local\\bin'));assert.equal(env.SystemRoot,'C:\\Windows');assert.equal(env.PATHEXT,'.EXE;.CMD');
 const posix=platform.environment({PATH:'/custom/bin'},'linux','/home/test');assert.ok(posix.PATH.startsWith('/custom/bin:'));assert.ok(posix.PATH.includes('/home/test/.local/bin'));
});
test('Windows executable search honors PATHEXT without executing cmd or bat shims',()=>{
 assert.ok(platform);
 const attempted=[];const found=platform.findExecutable('codex',{platform:'win32',env:{Path:'"C:\\Program Files\\Tools";C:\\Tools'},check:path=>{attempted.push(path);if(path!=='C:\\Tools\\codex.EXE')throw new Error('missing');}});
 assert.equal(found,'C:\\Tools\\codex.EXE');assert.ok(attempted.every(path=>!/[.]cmd$|[.]bat$/i.test(path)));assert.ok(attempted.includes('C:\\Program Files\\Tools\\codex.EXE'));
 const noNative=platform.findExecutable('codex',{platform:'win32',env:{PATH:'C:\\Tools',PATHEXT:'.CMD;.BAT'},check:()=>assert.fail('no shell shims should be probed')});assert.equal(noNative,null);
});
test('open actions pass a URL or path as one argument without a shell',async()=>{
 assert.ok(platform);const calls=[];const exec=async(...args)=>calls.push(args);
 for(const system of ['darwin','linux','win32'])await platform.openTarget('http://127.0.0.1:4317/#token=private&value=1',{platform:system,exec,env:{SystemRoot:'C:\\Windows'}});
 assert.equal(calls[0][0],'/usr/bin/open');assert.equal(calls[1][0],'xdg-open');assert.match(calls[2][0],/rundll32\.exe$/i);
 for(const call of calls){assert.equal(call[1].at(-1),'http://127.0.0.1:4317/#token=private&value=1');assert.equal(call[2].shell,undefined);}
 await platform.openTarget('C:\\Work & Files\\Room',{platform:'win32',exec,env:{SystemRoot:'C:\\Windows'}});assert.match(calls.at(-1)[0],/explorer\.exe$/i);assert.equal(calls.at(-1)[1][0],'C:\\Work & Files\\Room');
});
test('Windows tunnel environment isolates credentials and supplies Windows runtime directories',()=>{
 assert.ok(platform);const env=platform.tunnelEnvironment('C:\\Private\\Tunnel',{PATH:'C:\\Tools',SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TUNNEL_TOKEN:'secret',APPDATA:'C:\\Existing'},'win32');
 assert.equal(env.TUNNEL_TOKEN,undefined);assert.equal(env.SystemRoot,'C:\\Windows');for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP'])assert.equal(env[key],'C:\\Private\\Tunnel');
});
test('Windows process cleanup waits for taskkill tree completion and uses no command shell',async()=>{
 assert.ok(platform);const child=new EventEmitter();child.pid=1234;let complete;let call;let finished=false;
 const stopping=platform.stopProcess(child,{platform:'win32',env:{SystemRoot:'C:\\Windows'},exec:(...args)=>{call=args;return new Promise(resolve=>{complete=resolve;});}}).then(()=>{finished=true;});
 child.emit('close',0);await new Promise(r=>setImmediate(r));assert.equal(finished,false);assert.match(call[0],/taskkill\.exe$/i);assert.deepEqual(call[1],['/PID','1234','/T','/F']);assert.equal(call[2].shell,undefined);complete();await stopping;assert.equal(finished,true);
});
test('Windows process cleanup failures remain visible',async()=>{
 assert.ok(platform);const child=new EventEmitter();child.pid=1234;child.kill=()=>child.emit('close',0);
 await assert.rejects(platform.stopProcess(child,{platform:'win32',exec:async()=>{throw new Error('sensitive detail');}}),e=>/process tree/.test(e.message)&&!e.message.includes('sensitive detail'));
});

test('Windows cleanup never sends a POSIX process-group signal',async t=>{
 assert.ok(platform);const signals=[];t.mock.method(process,'kill',(...args)=>{signals.push(args);});
 const child=new EventEmitter();child.pid=1234;
 await platform.stopProcess(child,{platform:'win32',exec:async()=>{child.emit('close',0);}});assert.deepEqual(signals,[]);
});

test('Windows owned execution routes arguments through the job helper without a shell or policy bypass',()=>{
 assert.equal(typeof platform.spawnOwned,'function');const calls=[];const spawn=(...args)=>{calls.push(args);return {};};
 const args=['app-server','spaces & quotes " and slash\\'];const command='C:\\Tools & More\\codex.exe';
 platform.spawnOwned(command,args,{cwd:'C:\\Work',env:{SystemRoot:'C:\\Windows'},stdio:['pipe','pipe','pipe']},{platform:'win32',spawn});
 const [file,argv,options]=calls[0];assert.match(file,/powershell\.exe$/);assert.ok(argv.includes('-NoProfile'));assert.ok(argv.includes('-NonInteractive'));assert.ok(!argv.includes('-ExecutionPolicy'));assert.match(argv[argv.indexOf('-File')+1],/windows-job\.ps1$/);
 assert.deepEqual(JSON.parse(Buffer.from(argv[argv.indexOf('-CommandSpec')+1],'base64').toString('utf8')),{file:command,args});assert.equal(options.shell,undefined);assert.equal(options.windowsHide,true);
});
