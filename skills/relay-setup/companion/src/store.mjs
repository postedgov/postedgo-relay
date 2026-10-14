import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

export const AGENTS = ['codex', 'kimi', 'hermes', 'grok'];
const transitions = {
  queued: ['running', 'handoff', 'cancelled'],
  running: ['handoff', 'needs_input', 'awaiting_review', 'failed', 'cancelled', 'interrupted'],
  needs_input: ['running', 'failed', 'cancelled', 'interrupted'],
  handoff: ['awaiting_review', 'cancelled'],
  awaiting_review: ['completed'],
  completed: [], failed: [], cancelled: [], interrupted: [],
};
export function requiredText(value, name, max=20000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} is required (maximum ${max} characters).`);
  return value.trim();
}
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId,id);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, projectId TEXT NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL, taskId TEXT, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_project ON messages(projectId,id);`);
  }
  close() { this.db.close(); }
  projects() { return this.db.prepare('SELECT data FROM projects').all().map(r=>JSON.parse(r.data)); }
  project(id) { return this.projects().find(p=>p.id===id); }
  addProject({name,path}) {
    name=requiredText(name,'Project name',120); path=requiredText(path,'Folder',4096);
    const existing=this.projects().find(p=>p.path===path); if(existing) return existing;
    const p={id:randomUUID(),name,path,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO projects VALUES (?,?)').run(p.id,JSON.stringify(p));return p;
  }
  tasks() { return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(r=>JSON.parse(r.data)); }
  messages(projectId,before=Number.MAX_SAFE_INTEGER) {
    if(!this.project(projectId))throw new Error('Project not found.');
    return this.db.prepare('SELECT * FROM messages WHERE projectId=? AND id<? ORDER BY id DESC LIMIT 200').all(projectId,before).reverse();
  }
  addChat(projectId,input,available) {
    if(!this.project(projectId))throw new Error('Project not found.');
    const text=requiredText(input.text,'Message');
    const recipient=input.recipient??'codex';const intent=input.intent??'review';
    if(![...AGENTS,'team'].includes(recipient))throw new Error('Choose a chat recipient.');
    if(!['review','work'].includes(intent))throw new Error('Choose Discussion or Work.');
    const mentions=[...text.matchAll(/(?:^|\s)@(codex|kimi|hermes|grok|team)\b/gi)].map(m=>m[1].toLowerCase());
    const speakers=[...new Set((mentions.length?mentions:[recipient]).flatMap(id=>id==='team'?AGENTS.filter(a=>available.includes(a)):[id]))];
    if(!speakers.length)throw new Error('No automatic agents are available.');
    for(const id of speakers)if(id!=='grok'&&!available.includes(id))throw new Error(`${id} is not installed. Choose another participant.`);
    const insert=this.db.prepare('INSERT INTO messages(projectId,role,author,text,taskId,createdAt) VALUES (?,?,?,?,?,?)');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      insert.run(projectId,'user','you',text,null,new Date().toISOString());
      for(const agent of speakers){
        const task=this.addTask({projectId,agent,title:text.slice(0,160),prompt:text,intent,isolate:intent==='work'});
        this.attachChatReply(task);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  attachChatReply(task){
    const result=this.db.prepare('INSERT INTO messages(projectId,role,author,text,taskId,createdAt) VALUES (?,?,?,?,?,?)').run(task.projectId,'assistant',task.agent,'',task.id,task.createdAt);
    return this.update(task.id,{chatMessageId:Number(result.lastInsertRowid)});
  }
  addChatReply(input){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const next=this.attachChatReply(this.addTask(input));
      this.db.exec('COMMIT');return next;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  task(id) { const r=this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); if(!r)throw new Error('Task not found.');return JSON.parse(r.data); }
  addTask(input) {
    if(!this.project(input.projectId))throw new Error('Project not found.');
    if(!AGENTS.includes(input.agent))throw new Error('Choose an available agent.');
    if(input.parentTaskId) {
      const parent=this.task(input.parentTaskId);
      if(parent.projectId!==input.projectId || !['awaiting_review','completed','failed','cancelled','interrupted'].includes(parent.status))throw new Error('Source task must have stopped and belong to this project.');
    }
    const minutes=Number(input.timeoutMinutes ?? 20);
    if(!Number.isInteger(minutes)||minutes<1||minutes>120)throw new Error('Time limit must be 1–120 minutes.');
    const task={id:randomUUID(),projectId:input.projectId,title:requiredText(input.title,'Title',160),
      prompt:requiredText(input.prompt,'Instructions'),agent:input.agent,status:'queued',
      intent:input.intent==='review'?'review':'work',isolate:input.isolate!==false,
      parentTaskId:input.parentTaskId || null,timeoutMinutes:minutes,workspace:null,baseHead:null,
      output:'',error:null,sessionId:null,appliedAt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO tasks VALUES (?,?)').run(task.id,JSON.stringify(task));
    this.event(task.id,'status',{status:'queued'});return task;
  }
  update(id,patch) {
    const task={...this.task(id),...patch,id,updatedAt:new Date().toISOString()};
    this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task),id);return task;
  }
  transition(id,status,patch={}) {
    const old=this.task(id);
    if(!transitions[old.status]?.includes(status))throw new Error(`Invalid transition: ${old.status} → ${status}`);
    const t=this.update(id,{...patch,status});this.event(id,'status',{status});return t;
  }
  event(taskId,type,data) {
    this.db.prepare('INSERT INTO events(taskId,type,data,createdAt) VALUES (?,?,?,?)').run(taskId,type,JSON.stringify(data),new Date().toISOString());
  }
  events(taskId,after=0) {
    return this.db.prepare('SELECT * FROM events WHERE taskId=? AND id>? ORDER BY id DESC LIMIT 3000').all(taskId,after).reverse().map(r=>({...r,data:JSON.parse(r.data)}));
  }
  recover() { for(const t of this.tasks()) if(['running','needs_input'].includes(t.status))this.transition(t.id,'interrupted',{error:'Relay restarted. Review the saved output before continuing.'}); }
}
