import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
let Store;
try { ({Store} = await import('../src/store.mjs')); } catch {}
test('task state persists and requires review before completion', () => {
  assert.equal(typeof Store, 'function', 'task store must exist');
  const dir=mkdtempSync(join(tmpdir(),'relay-test-'));
  try {
    let db=new Store(join(dir,'state.db'));
    const p=db.addProject({name:'Test',path:dir});
    const t=db.addTask({projectId:p.id,title:'Inspect',prompt:'Read files',agent:'codex'});
    assert.throws(()=>db.transition(t.id,'completed'), /transition/);
    db.transition(t.id,'running');
    db.transition(t.id,'awaiting_review',{output:'Evidence'});
    db.close(); db=new Store(join(dir,'state.db'));
    assert.equal(db.task(t.id).output,'Evidence');
    db.transition(t.id,'completed');
    assert.equal(db.task(t.id).status,'completed');
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('restart interrupts active work without rerunning it', () => {
  assert.ok(Store,'task store must exist');
  const db=new Store(':memory:');
  const p=db.addProject({name:'P',path:'/tmp'});
  const t=db.addTask({projectId:p.id,title:'Work',prompt:'work',agent:'kimi'});
  db.transition(t.id,'running'); db.recover();
  assert.equal(db.task(t.id).status,'interrupted'); db.close();
});
test('task creation validates agent and project and keeps event order',()=>{
  assert.ok(Store,'task store must exist');
  const db=new Store(':memory:'); const p=db.addProject({name:'P',path:'/tmp'});
  assert.throws(()=>db.addTask({projectId:p.id,title:'x',prompt:'x',agent:'unknown'}));
  assert.throws(()=>db.addTask({projectId:'missing',title:'x',prompt:'x',agent:'codex'}));
  const t=db.addTask({projectId:p.id,title:'x',prompt:'x',agent:'hermes'});
  db.event(t.id,'message',{text:'first'});db.event(t.id,'message',{text:'second'});
  assert.deepEqual(db.events(t.id).filter(e=>e.type==='message').map(e=>e.data.text),['first','second']); db.close();
});
test('long tasks retain their most recent activity in bounded responses',()=>{
 const db=new Store(':memory:');const p=db.addProject({name:'P',path:'/tmp'});const t=db.addTask({projectId:p.id,title:'T',prompt:'Work',agent:'kimi'});
 for(let i=0;i<3001;i++)db.event(t.id,'tool',{text:`Tool ${i}`});db.event(t.id,'notice',{text:'Final validation passed'});
 const events=db.events(t.id);assert.equal(events.at(-1).data.text,'Final validation passed');assert.equal(events.length,3000);assert.ok(events[0].id<events.at(-1).id);db.close();
});
