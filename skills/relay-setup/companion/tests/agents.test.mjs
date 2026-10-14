import test from 'node:test';import assert from 'node:assert/strict';
import {Agent}from'../src/agents.mjs';
function receiver(onApproval){const a=Object.create(Agent.prototype);a.onApproval=onApproval;a.onEvent=()=>{};return a;}
test('ACP permissions offer only per-action approvals and return selected option',async()=>{
 let offered;const a=receiver(async d=>{offered=d.options;return{optionId:'one'};});
 const result=await a.request({id:1,method:'session/request_permission',params:{toolCall:{title:'Read file'},options:[{optionId:'one',kind:'allow_once',name:'Allow once'},{optionId:'forever',kind:'allow_always',name:'Always allow'},{optionId:'no',kind:'reject_once',name:'Reject'}]}});
 assert.deepEqual(offered.map(o=>o.id),['one','no']);assert.equal(result.outcome.optionId,'one');
});
test('Codex approval mapping does not offer persistent policy changes',async()=>{
 const a=receiver(async d=>{assert.deepEqual(d.options.map(o=>o.id),['accept','decline']);return{optionId:'decline'};});
 assert.deepEqual(await a.request({id:3,method:'item/commandExecution/requestApproval',params:{availableDecisions:['accept','acceptForSession','decline',{acceptWithExecpolicyAmendment:{}}]}}),{decision:'decline'});
});
test('unsupported agent requests fail closed',async()=>{
 const a=receiver(()=>assert.fail('must not request approval'));
 await assert.rejects(a.request({method:'unknown/action',params:{}}),/does not support/);
});
test('Codex questions return the required answer structure',async()=>{
 const a=receiver(async()=>({answers:{q:'use the existing file'}}));
 assert.deepEqual(await a.request({id:4,method:'item/tool/requestUserInput',params:{questions:[{id:'q',question:'Which file?'}]}}),{answers:{q:{answers:['use the existing file']}}});
});

test('lead chooses Codex when available and falls back to installed automatic agents',async()=>{
 const {preferredAgent}=await import('../src/agents.mjs');assert.equal(typeof preferredAgent,'function');
 const agents=[{id:'codex',available:false,mode:'native'},{id:'kimi',available:true,mode:'native'},{id:'hermes',available:false,mode:'native'},{id:'grok',available:true,mode:'manual'}];
 assert.equal(preferredAgent(agents),'kimi');agents[0].available=true;assert.equal(preferredAgent(agents),'codex');agents[0].available=false;agents[1].available=false;assert.equal(preferredAgent(agents),'grok');agents[3].mode='webhook';assert.equal(preferredAgent(agents),'grok');
});
