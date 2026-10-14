import http from 'node:http';
import {readFile,writeFile,mkdir,realpath,stat,chmod} from 'node:fs/promises';
import {dirname,join,resolve,parse} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {Store,requiredText} from './store.mjs';
import {Runner} from './runner.mjs';
import {discoverAgents,preferredAgent} from './agents.mjs';
import {openTarget} from './platform.mjs';
import {GrokConnection} from './grok.mjs';
const exec=promisify(execFile);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
async function body(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new Error('Send JSON with Content-Type application/json.');
  let size=0;const chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>1000000)throw new Error('Request is too large.');chunks.push(chunk);}
  const value=JSON.parse(Buffer.concat(chunks).toString()||'{}');
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected a JSON object.');return value;
}
export async function createApp({dataDir=join(root,'.relay'),port=4317,runAgents=true}={}){
  dataDir=resolve(dataDir);await mkdir(dataDir,{recursive:true,mode:0o700});await chmod(dataDir,0o700);
  const tokenPath=join(dataDir,'token');let token;
  try{token=(await readFile(tokenPath,'utf8')).trim();if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid local token file.');}
  catch(e){if(e.code!=='ENOENT')throw e;token=randomBytes(32).toString('hex');await writeFile(tokenPath,token,{mode:0o600,flag:'wx'});}
  const store=new Store(join(dataDir,'state.db'));
  const grok=new GrokConnection(dataDir);await grok.load();
  const runner=new Runner(store,dataDir,{grok});
  const agents=()=>discoverAgents().map(a=>{
    if(a.id!=='grok')return a;
    const g=grok.status();
    return g.enabled&&g.configured?{...a,mode:'webhook',available:g.tunnelInstalled,detail:g.tunnelInstalled?'Automatic replies · approvals stay in Grok Bot':'Reply connection helper is missing'}:a;
  });
  try{runner.paused=JSON.parse(await readFile(join(dataDir,'settings.json'),'utf8')).paused===true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(runner.cleanupError)runner.paused=true;
  if(!store.projects().length){const path=dataDir===join(root,'.relay')?resolve(root,'..','Relay Playground'):join(dataDir,'playground');await mkdir(path,{recursive:true});await writeFile(join(path,'README.md'),'# Relay playground\n\nA local folder for trying agent tasks. Add your own project using the sidebar.\n',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});store.addProject({name:'Playground',path});}
  let url;let interval;let closing;
  const chatState=projectId=>{
    const messages=store.messages(projectId).map(m=>{
      if(!m.taskId)return m;
      const task=store.task(m.taskId);
      return {...m,text:task.output,task,approvals:runner.approvals(task.id)};
    });
    const hasEarlier=messages.length>0&&Boolean(store.db.prepare('SELECT 1 FROM messages WHERE projectId=? AND id<? LIMIT 1').get(projectId,messages[0].id));
    return {messages,hasEarlier};
  };
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expected=new URL(url);
    if(req.headers.host!==expected.host){json(res,403,{error:'Invalid local host.'});return;}
    if(req.headers.origin && req.headers.origin!==url){json(res,403,{error:'Only the Relay dashboard may access this service.'});return;}
    let path;
    try{const parsed=new URL(req.url,url);if(parsed.origin!==url)throw new Error('Invalid origin');path=parsed.pathname;}catch{json(res,400,{error:'Invalid request URL.'});return;}
    if(path==='/health'&&req.method==='GET'){json(res,200,{app:'relay',version:'0.1.0'});return;}
    if(!path.startsWith('/api/')){
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/style.css':'style.css'};
      if(req.method!=='GET'||!files[path]){res.writeHead(404);res.end('Not found');return;}
      try{const content=await readFile(join(root,'public',files[path]));res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.end(content);}catch{res.writeHead(503);res.end('Relay dashboard is being prepared.');}return;
    }
    const supplied=String(req.headers['x-relay-token']||'');
    if(Buffer.byteLength(supplied)!==Buffer.byteLength(token)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(token))){json(res,401,{error:'Open Relay using its launcher to connect this browser.'});return;}
    try{
      if(req.method==='GET'&&path==='/api/state'){json(res,200,{projects:store.projects(),tasks:store.tasks().map(({output,handoffPrompt,...t})=>t),agents:agents(),leadAgent:preferredAgent(agents()),paused:runner.paused,cleanupError:runner.cleanupError,activeTaskId:runner.active?.id||store.tasks().find(t=>t.status==='handoff')?.id||null});return;}
      if(req.method==='GET'&&path==='/api/grok'){json(res,200,grok.status());return;}
      const chatMatch=path.match(/^\/api\/chat\/([^/]+)$/);
      if(req.method==='GET'&&chatMatch){json(res,200,chatState(chatMatch[1]));return;}
      const match=path.match(/^\/api\/tasks\/([a-f0-9-]+)(?:\/([a-z-]+))?$/);
      if(req.method==='GET'&&match&&!match[2]){const t=store.task(match[1]);json(res,200,{task:t,events:store.events(t.id),approvals:runner.approvals(t.id),handoffPrompt:t.handoffPrompt||''});return;}
      if(closing||runner.closed&&path!=='/api/shutdown'){json(res,503,{error:'Relay is stopping. Wait for cleanup before restarting.'});return;}
      if(req.method!=='POST'){json(res,404,{error:'Route not found.'});return;}
      const input=await body(req);
      if(chatMatch){store.addChat(chatMatch[1],{...input,recipient:input.recipient??preferredAgent(agents())},agents().filter(a=>a.available&&a.mode!=='manual').map(a=>a.id));json(res,200,chatState(chatMatch[1]));return;}
      if(path==='/api/shutdown'){const warning=await stopWork();json(res,200,{ok:true,warning});setImmediate(()=>void app.close().catch(()=>console.error('Relay shutdown failed. Check active processes before restarting.')));return;}
      if(path==='/api/grok'){
        if(runner.active&&store.task(runner.active.id).agent==='grok')throw new Error('Stop the current Grok reply before changing its connection.');
        if(runner.configuring)throw new Error('A connection save is already in progress.');
        runner.configuring=true;
        try{await grok.configure(input);json(res,200,grok.status());}finally{runner.configuring=false;}return;
      }
      if(path==='/api/projects'){
        const folder=await realpath(requiredText(input.path,'Folder',4096));
        if(!(await stat(folder)).isDirectory()||folder===parse(folder).root||folder===homedir())throw new Error('Choose a dedicated project folder.');
        json(res,200,store.addProject({name:input.name,path:folder}));return;
      }
      if(path==='/api/pick-folder'){
        if(process.platform!=='darwin')throw new Error('Paste the full project folder path on this device.');
        try{const {stdout}=await exec('/usr/bin/osascript',['-e','POSIX path of (choose folder with prompt "Choose a project folder for Relay")'],{timeout:120000});json(res,200,{path:stdout.trim()});}
        catch(e){if(String(e.stderr||'').includes('(-128)'))json(res,200,{path:null});else throw new Error('Folder picker could not open. Paste a folder path instead.');}return;
      }
      if(path==='/api/open-project'){
        const p=store.project(input.projectId);if(!p)throw new Error('Project not found.');await openTarget(p.path);json(res,200,{ok:true});return;
      }
      if(path==='/api/queue'){
        if(typeof input.paused!=='boolean')throw new Error('Expected paused to be true or false.');
        if(!input.paused&&runner.active)throw new Error('Wait for the current task to stop before resuming the queue.');
        await writeFile(join(dataDir,'settings.json'),JSON.stringify({paused:input.paused}),{mode:0o600});
        if(!input.paused)for(const task of store.tasks())if(task.cleanupFailed&&!task.cleanupAcknowledgedAt)store.update(task.id,{cleanupAcknowledgedAt:new Date().toISOString()});
        runner.paused=input.paused;json(res,200,{paused:runner.paused});return;
      }
      if(path==='/api/tasks'){
        const agent=agents().find(a=>a.id===input.agent);if(!agent?.available)throw new Error('That agent is not available.');
        const fromChat=input.parentTaskId&&store.task(input.parentTaskId).chatMessageId;
        json(res,200,fromChat?store.addChatReply(input):store.addTask(input));return;
      }
      if(match){
        const task=store.task(match[1]);const action=match[2];
        if(action==='cancel'){runner.cancel(task.id);json(res,200,store.task(task.id));return;}
        if(action==='verify'){json(res,200,await runner.verify(task.id));return;}
        if(action==='approve'){runner.answer(task.id,input);json(res,200,{ok:true});return;}
        if(action==='resume'){
          if(!['failed','cancelled','interrupted'].includes(task.status))throw new Error('Only stopped tasks can be continued.');
          const next={...task,parentTaskId:task.id};
          json(res,200,task.chatMessageId?store.addChatReply(next):store.addTask(next));return;
        }
        if(action==='handoff'){
          if(task.status!=='handoff')throw new Error('This task is not waiting for a Grok result.');
          json(res,200,store.transition(task.id,'awaiting_review',{output:requiredText(input.output,'Result',500000)}));return;
        }
        if(action==='apply'){json(res,200,await runner.apply(task.id));return;}
        if(action==='open-folder'){await openTarget(task.workspace||store.project(task.projectId).path);json(res,200,{ok:true});return;}
      }
      json(res,404,{error:'Route not found.'});
    }catch(e){json(res,400,{error:e.code==='ENOENT'?'That folder does not exist.':e.message});}
  });
  server.requestTimeout=150000;server.headersTimeout=10000;
  try{await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolveListen);});}catch(e){store.close();throw e;}
  store.recover();
  url=`http://127.0.0.1:${server.address().port}`;
  if(runAgents)interval=setInterval(()=>runner.tick(),500);
  const stopWork=async()=>{clearInterval(interval);runner.close();while(runner.active)await new Promise(r=>setTimeout(r,10));return runner.cleanupError;};
  const app={url,token,store,runner,server,dataDir,close(){if(closing)return closing;closing=(async()=>{const warning=await stopWork();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();return{warning};})();return closing;}};
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  process.umask(0o077);
  const app=await createApp({dataDir:process.env.RELAY_DATA_DIR||undefined,port:Number(process.env.RELAY_PORT||4317)});
  await writeFile(join(app.dataDir,'runtime.json'),JSON.stringify({url:app.url,pid:process.pid}),{mode:0o600});
  console.log(`Relay is running at ${app.url}. Open it using the Relay launcher.`);
  const shutdown=()=>app.close().then(({warning})=>{if(warning)console.error(warning);process.exit(warning?1:0);});process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
