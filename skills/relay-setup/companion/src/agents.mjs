import {environment,findExecutable,spawnOwned} from './platform.mjs';
import {Rpc} from './rpc.mjs';

export const agentEnvironment=environment();
export function executable(name){return findExecutable(name,{env:agentEnvironment});}
export function preferredAgent(agents){return agents.find(a=>a.id==='codex'&&a.available&&a.mode!=='manual')?.id||agents.find(a=>a.available&&a.mode!=='manual')?.id||'grok';}
export function discoverAgents(){
  return ['codex','kimi','hermes','grok'].map(id=>({id,name:{codex:'Codex',kimi:'Kimi',hermes:'Hermes',grok:'Grok Bot'}[id],
    available:id==='grok'||!!executable(id),mode:id==='grok'?'manual':'native',
    detail:id==='grok'?'Copy a handoff into Grok Bot, then bring the result back.':executable(id)?'Installed · uses your existing sign-in':'Install the agent CLI to connect.'}));
}
export class Agent {
  constructor(id,cwd,{onEvent=()=>{},onApproval=async()=>{throw new Error('Approval unavailable');},intent='work'}={}){
    const binary=executable(id);if(!binary)throw new Error(`${id} is not installed.`);
    this.id=id;this.cwd=cwd;this.intent=intent;this.onEvent=onEvent;this.onApproval=onApproval;this.messages=new Map();this.output='';
    this.rpc=new Rpc(spawnOwned(binary,id==='codex'?['app-server']:['acp'],{cwd,env:agentEnvironment,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true}),{jsonrpc:id!=='codex'});
    this.rpc.on('diagnostic',text=>onEvent('diagnostic',{text}));
    this.rpc.on('notification',m=>this.notification(m));
    this.rpc.onRequest=m=>this.request(m);
  }
  async initialize(){
    if(this.id==='codex'){
      const info=await this.rpc.request('initialize',{clientInfo:{name:'relay_local_hub',title:'Relay',version:'0.1.0'},capabilities:{}});
      this.rpc.notify('initialized');return info;
    }
    return this.rpc.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'relay',title:'Relay',version:'0.1.0'}},45000);
  }
  async run(prompt,timeout){
    await this.initialize();
    if(this.id==='codex'){
      const {thread}=await this.rpc.request('thread/start',{cwd:this.cwd,approvalPolicy:'on-request',sandbox:this.intent==='review'?'read-only':'workspace-write'});
      this.sessionId=thread.id;this.onEvent('session',{id:thread.id});
      let finish,rejectFinish;
      const done=new Promise((resolve,reject)=>{finish=resolve;rejectFinish=reject;});
      const failed=e=>rejectFinish(e);this.rpc.on('failure',failed);
      const completed=m=>{if(m.method==='turn/completed'){const turn=m.params.turn;if(turn.status==='completed')finish();else rejectFinish(new Error(turn.error?.message||`Turn ${turn.status}`));}};
      this.rpc.on('notification',completed);
      // Attach the rejection handler before starting a turn, since process failure can race its response.
      const wait=done.then(()=>({ok:true}),error=>({error}));
      const timer=setTimeout(()=>rejectFinish(new Error('Task time limit reached.')),timeout);
      try{await this.rpc.request('turn/start',{threadId:thread.id,input:[{type:'text',text:prompt}]});const result=await wait;if(result.error)throw result.error;}
      finally{clearTimeout(timer);this.rpc.off('failure',failed);this.rpc.off('notification',completed);}
    }else{
      const session=await this.rpc.request('session/new',{cwd:this.cwd,mcpServers:[]},60000);
      this.sessionId=session.sessionId;this.onEvent('session',{id:this.sessionId});
      const result=await this.rpc.request('session/prompt',{sessionId:this.sessionId,prompt:[{type:'text',text:prompt}]},timeout);
      if(result.stopReason!=='end_turn')throw new Error(`Agent stopped: ${result.stopReason||'unknown reason'}.`);
    }
    return this.output;
  }
  notification({method,params={}}){
    if(this.id==='codex'){
      if(method==='item/agentMessage/delta'){
        this.messages.set(params.itemId,(this.messages.get(params.itemId)||'')+(params.delta||''));this.text();
      }else if(method==='item/completed' && params.item?.type==='agentMessage'){
        this.messages.set(params.item.id,params.item.text||this.messages.get(params.item.id)||'');this.text();
      }else if(['item/started','item/completed'].includes(method)){
        const i=params.item||{};if(i.type!=='agentMessage')this.onEvent('tool',{title:i.command||i.type||'Agent activity',status:method==='item/started'?'running':'completed',text:(i.aggregatedOutput||'').slice(-16000)});
      }else if(method==='error')this.onEvent('notice',{text:params.error?.message||'Agent reported an error.'});
    }else if(method==='session/update'){
      const u=params.update||{};
      if(u.sessionUpdate==='agent_message_chunk' && u.content?.type==='text'){this.output=(this.output+u.content.text).slice(-500000);this.onEvent('output',{text:this.output});}
      else if(['tool_call','tool_call_update'].includes(u.sessionUpdate))this.onEvent('tool',{title:u.title||u.toolCallId||'Agent activity',status:u.status||'running',text:JSON.stringify(u.content||u.rawOutput||'').slice(-16000)});
    }
  }
  text(){this.output=[...this.messages.values()].join('\n\n').slice(-500000);this.onEvent('output',{text:this.output});}
  async request(m){
    const p=m.params||{};
    if(m.method==='session/request_permission'){
      const options=(p.options||[]).filter(o=>!['allow_always','reject_always'].includes(o.kind)).map(o=>({id:o.optionId,label:o.name||o.kind}));
      if(!options.length)return{outcome:{outcome:'cancelled'}};
      const answer=await this.onApproval({id:String(m.id),kind:'permission',title:p.toolCall?.title||'Agent requests permission',description:JSON.stringify(p.toolCall?.rawInput||p.toolCall||{},null,2).slice(0,16000),options});
      return{outcome:{outcome:'selected',optionId:answer.optionId}};
    }
    if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(m.method)){
      const offered=p.availableDecisions||['accept','decline','cancel'];
      const allowed=offered.filter(x=>typeof x==='string'&&['accept','decline','cancel'].includes(x));
      const options=allowed.map(id=>({id,label:{accept:'Allow once',decline:'Deny',cancel:'Cancel turn'}[id]}));
      if(!options.length)return{decision:'cancel'};
      const answer=await this.onApproval({id:String(m.id),kind:'permission',title:p.command||p.reason||'Approve agent action',description:JSON.stringify(p,null,2).slice(0,16000),options});
      return{decision:answer.optionId};
    }
    if(m.method==='item/tool/requestUserInput'){
      const answer=await this.onApproval({id:String(m.id),kind:'question',title:'Your input is needed',description:'',options:[{id:'submit',label:'Send answer'}],questions:p.questions||[]});
      return{answers:Object.fromEntries((p.questions||[]).map(q=>[q.id,{answers:[String(answer.answers?.[q.id]||'')]}]))};
    }
    this.onEvent('notice',{text:`Unsupported agent request: ${m.method}. The action was not approved.`});
    throw new Error(`Relay does not support ${m.method}; no permission granted.`);
  }
  stop(){return this.rpc.stop();}
}
