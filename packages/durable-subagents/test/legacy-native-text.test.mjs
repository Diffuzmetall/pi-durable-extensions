import test from 'node:test';
import assert from 'node:assert/strict';
import { defineExtension, defineTask } from '@earendil-works/pi-durable';
import { createSubagent, SubagentsDoc, TeamDoc } from '../src/index.ts';
import { Anchor, BACKGROUND, reporterFor } from '../src/tasks.ts';
import { courierFor } from '../src/delivery.ts';
import { watchUntil } from '../src/supervisor.ts';
import { fixture, context } from './team-fixture.mjs';
const raw='{"status":"done","summary":"job:done:legacy","changes":[],"verify":[],"outputs":[],"needs":[]}';
const modelText=entry=>entry.model[0].content[0].text;

test('pre-team v1 DELIVER without execution retains retrievable canonical result through trusted native submission', {timeout:10000},async()=>{
 const f=await fixture();try {
  const seeded=await f.harness.commit(async tx=>{
   const anchor=await tx.createTask(Anchor,null,{...BACKGROUND,conversationId:f.root.id});
   const child=await tx.createConversation({ownership:{kind:'task',taskId:anchor}}),requestId='legacy-native-input';
   const reporter=await tx.createTask(reporterFor(courierFor()),{key:'legacy',conversationId:child.id,task:'job:done:legacy',requestId},{...BACKGROUND,conversationId:f.root.id});
   (await tx.doc(SubagentsDoc,f.root.id)).agents.legacy={name:'legacy',conversationId:child.id,ownerTaskId:anchor,requestId,task:'job:done:legacy',role:'worker',background:true,reporter};
   return {child:child.id,requestId,reporter};
  },context);
  f.harness.resume();await f.harness.waitForTask(seeded.reporter,context);
  assert.equal(Object.keys((await f.harness.snapshot(TeamDoc,f.root.id,context))?.executions??{}).length,0);
  const native=await f.root.commit(tx=>tx.submissionByRequest(seeded.child,seeded.requestId),context);assert.equal(native.status,'done');
  const result=await f.invoke('subagent',{action:'status',name:'legacy',requestId:seeded.requestId});
  assert.equal(modelText(result),raw,'legacy deliver must remain retrievable without a raw/summary store');
  const child=await f.harness.conversation(seeded.child,context);assert.equal((await child.entries({},100,undefined,context)).items.filter(e=>e.kind==='pi.user').length,1);
  assert.equal(f.childInputs.length,1);assert.equal((await f.record('legacy')).report,undefined);
 }finally{await f.close();}
});

test('already-terminal pre-upgrade foreground guard is consumed from canonical entry, not its old formatted outcome', {timeout:10000},async()=>{
 const f=await fixture();try {
  const current=createSubagent();
  const old=defineTask({name:'bb.subagent-foreground',version:1,initial:()=>({phase:'wait'}),phases:{wait:async(task,runtime,c)=>{
   await watchUntil(()=>runtime.watchDoc(TeamDoc,runtime.conversationId,c),s=>s?.executions[task.input.execution]?.done);
   await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:'done',text:'LEGACY FORMATTED SUMMARY'}}}),c);
  }},abort:(_task,runtime,c)=>runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c)});
  f.registry.install(defineExtension({...current,tasks:current.tasks.map(t=>t.definition.name==='bb.subagent-foreground'?old:t)}));
  const args={name:'worker',task:'job:done:legacy',requestId:'old-guard',background:false};await f.invoke('subagent',args);
  const run=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions['subagent:old-guard'];
  const before=await f.harness.getTask(run.foreground,context);assert.equal(before.state.status,'terminal');assert.equal(before.state.outcome.result.text,'LEGACY FORMATTED SUMMARY');
  assert.ok(run.done.answerRef);f.registry.install(createSubagent());
  const result=await f.invoke('subagent',args);assert.equal(modelText(result),raw,'new consumer must resolve canonical result even when guard will never reexecute');
  assert.deepEqual(await f.harness.getTask(run.foreground,context),before);assert.equal(f.childInputs.length,1);
 }finally{await f.close();}
});
