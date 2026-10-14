import {EventEmitter} from 'node:events';
import {StringDecoder} from 'node:string_decoder';
import {reapProcessGroup,stopProcess} from './platform.mjs';

export class Rpc extends EventEmitter {
  constructor(child,{jsonrpc=true}={}) {
    super();this.child=child;this.jsonrpc=jsonrpc;this.pending=new Map();this.sequence=0;this.closed=false;
    let buffer='';const decoder=new StringDecoder('utf8');
    child.stdout.on('data',chunk=>{
      buffer+=decoder.write(chunk);
      if(buffer.length>8_000_000){this.fail(new Error('Agent protocol message exceeded the size limit.'));this.stop();return;}
      let split;
      while((split=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,split);buffer=buffer.slice(split+1);if(line.trim())this.receive(line);}
    });
    child.stderr.on('data',d=>this.emit('diagnostic',d.toString().slice(0,4000)));
    child.stdin.on('error',e=>this.fail(e));
    child.on('error',e=>this.fail(e));
    child.on('close',(code,signal)=>{this.exited=true;this.closed=true;reapProcessGroup(child);this.fail(new Error(`Agent process exited (${signal||code}).`));this.emit('closed');});
  }
  send(message) {
    if(this.closed)throw new Error('Agent connection is closed.');
    this.child.stdin.write(JSON.stringify(this.jsonrpc?{jsonrpc:'2.0',...message}:message)+'\n');
  }
  request(method,params,timeout=30000) {
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out.`));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
    });
  }
  notify(method,params={}){this.send({method,params});}
  receive(line) {
    let m;try{m=JSON.parse(line);}catch{this.emit('diagnostic',line.slice(0,4000));return;}
    if(!m || typeof m!=='object')return;
    if(m.method && m.id!==undefined) {
      Promise.resolve().then(()=>{
        if(!this.onRequest)throw new Error(`Unsupported agent request: ${m.method}`);
        return this.onRequest(m);
      }).then(result=>{if(!this.closed)this.send({id:m.id,result});},e=>{if(!this.closed)this.send({id:m.id,error:{code:-32603,message:e.message}});}).catch(()=>{});
    }else if(m.method){this.emit('notification',m);}
    else if(this.pending.has(m.id)){
      const p=this.pending.get(m.id);this.pending.delete(m.id);clearTimeout(p.timer);
      if(m.error)p.reject(new Error(m.error.message||JSON.stringify(m.error)));else p.resolve(m.result);
    }
  }
  fail(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('failure',error);}
  stop(){
    if(this.stopping)return this.stopping;
    if(this.exited)return Promise.resolve();
    this.closed=true;this.fail(new Error('Agent stopped.'));
    this.stopping=stopProcess(this.child);this.stopping.catch(error=>this.emit('diagnostic',error.message));
    return this.stopping;
  }
}
