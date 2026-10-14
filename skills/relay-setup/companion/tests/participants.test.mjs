import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('function renderAgents()'),source.indexOf('function updateComposerNote()'));
function fixture(chosen='codex'){
 const elements=new Map();const make=()=>({value:'',children:[],append(...n){this.children.push(...n);},replaceChildren(...n){this.children=n;},addEventListener(){},setAttribute(){}});
 const $=id=>{if(!elements.has(id))elements.set(id,make());return elements.get(id);};$('chat-recipient').value=chosen;
 const state={leadAgent:'kimi',agents:[{id:'codex',name:'Codex',available:false,mode:'native'},{id:'kimi',name:'Kimi',available:true,mode:'native'},{id:'hermes',name:'Hermes',available:true,mode:'native'},{id:'grok',name:'Grok Bot',available:true,mode:'manual'}]};
 const context=vm.createContext({state,$,participantsFingerprint:'',agentCopy:{},agentName:id=>state.agents.find(a=>a.id===id).name,node:(tag,cls,text)=>Object.assign(make(),{textContent:text,className:cls}),Option:class{constructor(text,value){this.text=text;this.value=value;}},updateComposerNote(){}});
 vm.runInContext(render+';renderAgents();',context);return $;
}
test('first-run room selects an available lead when Codex is absent',()=>{
 const $=fixture();assert.equal($('chat-recipient').value,'kimi');assert.match($('chat-recipient').children.find(o=>o.value==='kimi').text,/Lead/);assert.doesNotMatch($('chat-recipient').children.find(o=>o.value==='codex').text,/Lead/);
});
test('agent rendering preserves an explicitly selected available recipient',()=>{assert.equal(fixture('hermes')('chat-recipient').value,'hermes');});
test('room shows cleanup failure instead of a routine paused message',()=>{
 const room={};const state={tasks:[],paused:true,cleanupError:'Process cleanup failed. Check running processes before resuming.'};
 const render=source.slice(source.indexOf('function updateRoomStatus()'),source.indexOf('async function refreshChat('));
 vm.runInNewContext(render+';updateRoomStatus();',{state,selectedProject:'test',$:()=>room});
 assert.equal(room.textContent,state.cleanupError);
});
