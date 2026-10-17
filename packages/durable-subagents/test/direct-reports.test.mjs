import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, defineTask, InboxDoc, hook, ToolTask } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSubagent, SubagentsDoc, TeamDoc } from '../src/index.ts';
import { RequestsDoc } from '../src/requests.ts';
const latch=()=>{let resolve; const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const bounded=(p,timeout=2500)=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('native gate did not complete')),timeout);t.unref();})]);
const report=JSON.stringify({status:'done',summary:'direct-child-result',changes:[],verify:[],outputs:[],needs:[]});
async function fixture({path,origin,admit,background=true,failReports=true,phaseGates}={}) {
 const provider=fauxProvider(),models=createModels(),registry=createRegistry(),child=latch(),parent=latch(),childEntered=latch(),parentEntered=latch(),errors=[],results=[];
 let executions=0, sawReport=false;
 models.setProvider(provider.provider);
 const gate=(name,entered,released)=>defineTool({name,parameters:Type.Object({}),replay:'unsafe',execute:async(_a,_api,c)=>{
  if(name==='child_gate')executions++;entered.resolve();await new Promise((resolve,reject)=>{released.promise.then(resolve);c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true});});return {output:[{type:'text',text:'released'}]};}});
 registry.install(defineExtension({name:'direct-fixture',tools:[gate('child_gate',childEntered,child),gate('parent_gate',parentEntered,parent)],hooks:[hook(ToolTask,{afterTool:(call,result)=>{results.push({name:call.name,result});}})]}));
 const extension=createSubagent(admit,{origin});
 if(phaseGates) {
  extension.tasks=extension.tasks.map(task=>{
   const definition=task.definition;
   const key=definition.name==='bb.subagent-reporter'?'report':definition.name==='bb.subagent-foreground'?'wait':undefined;
   const gate=key==='report'?phaseGates.report:phaseGates.foreground;
   if(!key||!gate)return task;
   return defineTask({...definition,phases:{...definition.phases,[key]:async(task,runtime,c)=>{
    gate.entered.resolve();await new Promise((resolve,reject)=>{gate.release.promise.then(resolve);c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true});});
    await definition.phases[key](task,runtime,c);
   }}});
  });
 }
 registry.install(extension);
 const call=(name,args)=>fauxAssistantMessage(fauxToolCall(name,args),{stopReason:'toolUse'});
 provider.setResponses(Array.from({length:200},()=>t=>{
  const text=t.messages.findLast(m=>m.role==='user')?.content,last=t.messages.at(-1);
  if(text==='child-steer')return fauxAssistantMessage(report);
  if(text==='child-work')return last?.role==='toolResult'?fauxAssistantMessage(report):call('child_gate',{});
  if(text==='busy')return last?.role==='toolResult'?fauxAssistantMessage('PARENT-FINAL-WITHOUT-REPORT'):call('parent_gate',{});
  if(typeof text==='string'&&text.startsWith('Subagent ')){sawReport=true;return failReports?fauxAssistantMessage('',{stopReason:'error',errorMessage:'PARENT-FAIL-AFTER-PLACEMENT'}):fauxAssistantMessage('report processed');}
  if(last?.role==='toolResult')return fauxAssistantMessage('spawn-returned');
  if(typeof text==='string'&&text.startsWith('{')){const c=JSON.parse(text);return call(c.tool,c.args);}
  return call('subagent',{name:'worker',task:'child-work',requestId:'one-child',background});
 }));
 const harness=await Harness.open(path?await openNodeSqliteStorage(path):new MemoryStorage(),{registry,models,onReport:e=>errors.push(e)},ctx);
 const root=await harness.root(ctx,{agent:{model:{provider:provider.getModel().provider,modelId:provider.getModel().id}}});
 const state=()=>harness.snapshot(SubagentsDoc,root.id,ctx);
 const record=async()=>Object.values((await state()).agents)[0];
 const start=async()=>{const s=await root.submit({type:'input',content:'start'},ctx);await bounded(childEntered.promise);if(background)assert.equal((await bounded(s.wait(ctx))).status,'done');return s;};
 return {harness,registry,root,state,record,start,child,parent,childEntered,parentEntered,errors,results,executions:()=>executions,sawReport:()=>sawReport,close:async()=>{child.resolve();parent.resolve();await harness.close(ctx);}};
}
const receipt=async f=>{const r=await f.record();return f.root.commit(tx=>tx.submissionByRequest(f.root.id,`subagent-urgent:${r.reporter}`),ctx);};

async function coalesce(f) {
 await f.start();const first=(await f.record()).reporter;
 const childId=(await f.record()).conversationId;
 const watch=await f.harness.watchDoc(InboxDoc,childId,ctx);
 const admitted=new Promise(resolve=>{const check=value=>{if(value?.items.some(i=>i.mode==='steer'))resolve();};check(watch.value);watch.start(async value=>check(value));});
 try {
  const send=await f.root.submit({type:'input',content:JSON.stringify({tool:'subagent',args:{action:'send',name:'worker',message:'child-steer',requestId:'coalesced-steer'}})},ctx);
  assert.equal((await bounded(send.wait(ctx))).status,'done');await bounded(admitted);
 }finally{await watch.stop();}
 const second=(await f.harness.snapshot(RequestsDoc,f.root.id,ctx)).requests['subagent:coalesced-steer'].reporter;assert.notEqual(first,second);f.child.resolve();return [first,second];
}
async function assertCoalesced(f,reporters) {
 await bounded(Promise.all(reporters.map(id=>f.harness.waitForTask(id,ctx))));
 const team=await f.harness.snapshot(TeamDoc,f.root.id,ctx),runs=[team.executions['subagent:one-child'],team.executions['subagent:coalesced-steer']];
 assert.ok(runs[0].done.answerRef);assert.equal(runs[0].done.answerRef,runs[1].done.answerRef);
 for(const run of runs) {
  const s=await f.root.submit({type:'input',content:JSON.stringify({tool:'subagent',args:{action:'status',name:'worker',requestId:run.requestId}})},ctx);
  assert.equal((await bounded(s.wait(ctx))).status,'done');
  const result=f.results.findLast(x=>x.name==='subagent').result;
  assert.equal(result.structuredOutput.agents[0].result.answerRef,run.done.answerRef);
  assert.match(result.structuredOutput.agents[0].result.text,/direct-child-result/);
 }
 const entries=(await f.root.entries({},200,undefined,ctx)).items;
 assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('Details=')).length,1,'one notification for one canonical child answer');
 assert.equal((await f.state()).courier,undefined);
 return runs;
}
if (!process.env.PRIVATE_DIRECT_CRASH) {
test('foreground stop before child submit settles exact execution and guard without extra user input',{timeout:10000},async()=>{
 const delayed=latch(),release=latch();
 const f=await fixture({background:false,failReports:false,admit:async(_target,id,c)=>{if(!id.startsWith('subagent-urgent:')){delayed.resolve();await new Promise((resolve,reject)=>{release.promise.then(resolve);c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true});});}}});
 try {
  const parent=await f.root.submit({type:'input',content:'start'},ctx);await bounded(delayed.promise);
  const record=await f.record();assert.equal(f.executions(),0);
  // Run the real registered stop tool in this parent conversation without another user message.
  const call=fauxToolCall('subagent_stop',{name:'worker'});
  const stop=await f.harness.commit(async tx=>{const assistant=await tx.appendEntry(f.root.id,{kind:'pi.assistant',model:[fauxAssistantMessage(call,{stopReason:'toolUse'})]});
   return tx.createTask(ToolTask,{kind:'model',assistant:assistant.id,callId:call.id},{conversationId:f.root.id,ownership:{kind:'conversation'},background:true});},ctx);
  await bounded(f.harness.waitForTask(stop,ctx));
  const requests=await f.harness.snapshot(RequestsDoc,f.root.id,ctx);assert.equal(requests.stopped[record.requestId],true);
  release.resolve();await bounded(f.harness.waitForTask(record.reporter,ctx));
  const run=(await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'];
  assert.ok(run.done,'stopped-before-submit must persist execution done before Reporter terminal');
  assert.equal((await bounded(parent.wait(ctx))).status,'done','foreground parent must not strand after stopped-before-submit');
  assert.match(run.done.text,/stopped before submission/);assert.equal(run.done.answerRef,undefined);
  assert.equal((await f.harness.getTask(run.foreground,ctx)).state.outcome.status,'completed');
  assert.equal(f.executions(),0);assert.equal(await receipt(f),undefined);
  const child=await f.harness.conversation(record.conversationId,ctx);assert.equal((await child.entries({},100,undefined,ctx)).items.length,0);
  const entries=(await f.root.entries({},100,undefined,ctx)).items;assert.equal(entries.filter(e=>e.kind==='pi.user').length,1);
 }finally{release.resolve();await f.close();}
});

test('foreground terminal Reporter retains a native notification owner when its guard is abandoned on restart',{timeout:12000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'foreground-terminal-handback-')),'session.sqlite');
 const foregroundGate={entered:latch(),release:latch()};let f=await fixture({path,background:false,failReports:false,phaseGates:{foreground:foregroundGate}});
 try {
  const parent=await f.start();await bounded(foregroundGate.entered.promise);f.child.resolve();
  const reporter=(await f.record()).reporter;await bounded(f.harness.waitForTask(reporter,ctx));
  const run=(await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'];
  assert.ok(run.done.answerRef);assert.notEqual((await f.harness.getTask(run.foreground,ctx)).state.status,'terminal');assert.equal(await receipt(f),undefined);
  assert.equal(f.executions(),1);await f.harness.close(ctx);await parent.wait(ctx).catch(()=>{});
  f=await fixture({path,background:false,failReports:false});f.harness.resume();await bounded(f.harness.waitForTask(run.foreground,ctx));
  assert.equal((await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'].attentionReturned,true);
  const completion=await receipt(f);assert.ok(completion,'restart handback must recover completion even when the original Reporter is terminal');
  const entries=(await f.root.entries({},100,undefined,ctx)).items,inbox=await f.harness.snapshot(InboxDoc,f.root.id,ctx);
  assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('Details=')).length+inbox.items.filter(i=>i.id===completion.id).length,1);
  assert.equal(f.executions(),0);
 }finally{foregroundGate.release.resolve();await f.close();}
});

test('foreground restart handback checkpoint deduplicates submit across a second reopen with original Reporter attribution',{timeout:12000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'foreground-handback-owner-')),'session.sqlite'),foregroundGate={entered:latch(),release:latch()},submitted=latch();
 let f=await fixture({path,background:false,failReports:false,phaseGates:{foreground:foregroundGate}});let reporter,foreground,admitted;
 try {
  const parent=await f.start();await bounded(foregroundGate.entered.promise);f.child.resolve();reporter=(await f.record()).reporter;
  await bounded(f.harness.waitForTask(reporter,ctx));foreground=(await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'].foreground;
  await f.harness.close(ctx);await parent.wait(ctx).catch(()=>{});
  f=await fixture({path,failReports:false,origin:{record(){},submit:async(_target,sources,send,c,id)=>{
   assert.deepEqual(sources,[reporter]);assert.equal(id,`subagent-urgent:${reporter}`);const s=await send();admitted=await s.status(c);submitted.resolve();
   await new Promise((_,reject)=>c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true}));return s;
  }}});f.harness.resume();await bounded(submitted.promise);
  const checkpoint=(await f.harness.getTask(foreground,ctx)).state.checkpoint;assert.equal(checkpoint.report.reporter,reporter);
  assert.equal((await f.state()).agents['subagent:one-child'].reported.length,1);await f.harness.close(ctx);
  const submissions=[];f=await fixture({path,failReports:false,origin:{record(){},submit:async(_target,sources,send,_c,id)=>{submissions.push({sources,id});return send();}}});
  f.harness.resume();await bounded(f.harness.waitForTask(foreground,ctx));
  const completion=await receipt(f);assert.equal(completion.id,admitted.id);assert.equal(completion.entry,admitted.entry);assert.equal(f.executions(),0);
  assert.deepEqual(submissions,[{sources:[reporter],id:`subagent-urgent:${reporter}`}]);
  const entries=(await f.root.entries({},100,undefined,ctx)).items,inbox=await f.harness.snapshot(InboxDoc,f.root.id,ctx);
  assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('Details=')).length+inbox.items.filter(i=>i.id===completion.id).length,1);
 }finally{foregroundGate.release.resolve();await f.close();}
});

test('foreground restart handback cannot bypass genuine admission denial',{timeout:10000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'foreground-handback-denied-')),'session.sqlite'),foregroundGate={entered:latch(),release:latch()};
 let f=await fixture({path,background:false,failReports:false,phaseGates:{foreground:foregroundGate}});
 try {
  const parent=await f.start();await bounded(foregroundGate.entered.promise);f.child.resolve();const reporter=(await f.record()).reporter;
  await bounded(f.harness.waitForTask(reporter,ctx));const run=(await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'];
  await f.harness.close(ctx);await parent.wait(ctx).catch(()=>{});
  f=await fixture({path,failReports:false,admit:async(_target,id)=>{if(id.startsWith('subagent-urgent:'))throw Error('HANDOFF-ADMISSION-DENIED');}});
  f.harness.resume();const terminal=await bounded(f.harness.waitForTask(run.foreground,ctx));assert.notEqual(terminal.state.outcome.status,'completed');
  assert.match(JSON.stringify(terminal),/HANDOFF-ADMISSION-DENIED/);assert.equal(await receipt(f),undefined);assert.equal(f.executions(),0);
  assert.equal((await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'].done.answerRef,run.done.answerRef);
 }finally{foregroundGate.release.resolve();await f.close();}
});

test('foreground restart does not notify again when a coalesced background Reporter already owns the answer',{timeout:12000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'foreground-coalesced-owner-')),'session.sqlite'),foregroundGate={entered:latch(),release:latch()};
 let f=await fixture({path,background:false,failReports:false,phaseGates:{foreground:foregroundGate}});
 try {
  const parent=await f.start();await bounded(foregroundGate.entered.promise);const first=(await f.record()).reporter,childId=(await f.record()).conversationId;
  const watch=await f.harness.watchDoc(InboxDoc,childId,ctx),admitted=new Promise(resolve=>{const check=v=>{if(v?.items.some(i=>i.mode==='steer'))resolve();};check(watch.value);watch.start(async v=>check(v));});
  try{
   const call=fauxToolCall('subagent',{action:'send',name:'worker',message:'child-steer',requestId:'background-coalesced',background:true});
   const id=await f.harness.commit(async tx=>{const a=await tx.appendEntry(f.root.id,{kind:'pi.assistant',model:[fauxAssistantMessage(call,{stopReason:'toolUse'})]});return tx.createTask(ToolTask,{kind:'model',assistant:a.id,callId:call.id},{conversationId:f.root.id,ownership:{kind:'conversation'},background:true});},ctx);
   await bounded(f.harness.waitForTask(id,ctx));await bounded(admitted);
  }finally{await watch.stop();}
  const second=(await f.harness.snapshot(RequestsDoc,f.root.id,ctx)).requests['subagent:background-coalesced'].reporter;
  f.child.resolve();await bounded(Promise.all([first,second].map(id=>f.harness.waitForTask(id,ctx))));
  const team=await f.harness.snapshot(TeamDoc,f.root.id,ctx),run=team.executions['subagent:one-child'];
  assert.equal(run.done.answerRef,team.executions['subagent:background-coalesced'].done.answerRef);assert.equal(f.executions(),1);
  const original=await f.root.commit(tx=>tx.submissionByRequest(f.root.id,`subagent-urgent:${second}`),ctx);assert.ok(original);assert.equal(await receipt(f),undefined);
  await f.harness.close(ctx);await parent.wait(ctx).catch(()=>{});
  f=await fixture({path,failReports:false});f.harness.resume();await bounded(f.harness.waitForTask(run.foreground,ctx));
  assert.equal(await receipt(f),undefined,'handback cannot claim an answer already owned by the background Reporter');assert.equal(f.executions(),0);
  assert.equal((await f.state()).agents['subagent:one-child'].reported.length,1);
 }finally{foregroundGate.release.resolve();await f.close();}
});

test('foreground deliver checkpoint survives actual restart handback before report and admits one completion',{timeout:12000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'foreground-handback-')),'session.sqlite');
 const held=()=>({entered:latch(),release:latch()}),reportGate=held(),foregroundGate=held();
 let f=await fixture({path,background:false,failReports:false,phaseGates:{report:reportGate,foreground:foregroundGate}});
 let expected;
 try {
  const parent=await f.start();await bounded(foregroundGate.entered.promise);f.child.resolve();await bounded(reportGate.entered.promise);
  const run=(await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'];expected=run.done.answerRef;
  assert.ok(expected);assert.equal(run.attentionReturned,undefined);assert.equal(f.executions(),1);
  const reporter=(await f.record()).reporter;
  assert.equal((await f.harness.getTask(reporter,ctx)).state.checkpoint.phase,'report');assert.equal(await receipt(f),undefined);
  await f.harness.close(ctx);await parent.wait(ctx).catch(()=>{});
  const recoveredGate=held();f=await fixture({path,background:false,failReports:false,phaseGates:{report:recoveredGate}});
  const watch=await f.harness.watchDoc(TeamDoc,f.root.id,ctx);
  const handedBack=new Promise(resolve=>{const check=value=>{if(value?.executions['subagent:one-child']?.attentionReturned)resolve();};check(watch.value);watch.start(async value=>check(value));});
  try{f.harness.resume();await bounded(recoveredGate.entered.promise);await bounded(handedBack);}finally{await watch.stop();}
  const after=(await f.harness.snapshot(TeamDoc,f.root.id,ctx)).executions['subagent:one-child'];
  assert.equal(after.done.answerRef,expected);await bounded(f.harness.waitForTask(after.foreground,ctx));assert.equal((await f.harness.getTask(after.foreground,ctx)).state.outcome.status,'aborted');
  recoveredGate.release.resolve();await bounded(f.harness.waitForTask(reporter,ctx));
  const completion=await receipt(f);assert.ok(completion,'restart-abandoned foreground guard hands completion back to native Reporter');
  assert.equal(completion.requestId,`subagent-urgent:${reporter}`);assert.equal(f.executions(),0);
  const entries=(await f.root.entries({},100,undefined,ctx)).items,inbox=await f.harness.snapshot(InboxDoc,f.root.id,ctx);
  assert.ok(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('Details=')).length+inbox.items.filter(i=>i.id===completion.id).length<=1,'native admission is not forced placement after unsafe parent restart');
 }finally{reportGate.release.resolve();foregroundGate.release.resolve();await f.close();}
});

test('coalesced native child submissions keep both exact results but notify the parent once',{timeout:10000},async()=>{
 const f=await fixture({failReports:false});try{const reporters=await coalesce(f);await assertCoalesced(f,reporters);assert.equal(f.executions(),1);}finally{await f.close();}
});
test('coalesced answer claim reopens with its owning report checkpoint before submit; no work or notification lost',{timeout:10000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'coalesced-owner-')),'session.sqlite'),claimed=latch();let owner;
 let f=await fixture({path,failReports:false,admit:async(_target,id,c)=>{if(id.startsWith('subagent-urgent:')){owner=Number(id.split(':').at(-1));claimed.resolve();await new Promise((_,reject)=>c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true}));}}});
 try{
  const reporters=await coalesce(f);await bounded(claimed.promise);
  await bounded(f.harness.waitForTask(reporters.find(id=>id!==owner),ctx));
  const checkpoint=(await f.harness.getTask(owner,ctx)).state.checkpoint;assert.equal(checkpoint.phase,'report');assert.equal(checkpoint.notify,true);
  assert.equal((await f.state()).agents['subagent:one-child'].reported.length,1);
  const entries=(await f.root.entries({},100,undefined,ctx)).items;assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('Details=')).length,0);
  assert.equal(f.executions(),1);await f.harness.close(ctx);
  f=await fixture({path,failReports:false});f.harness.resume();await assertCoalesced(f,reporters);assert.equal(f.executions(),0);
 }finally{await f.close();}
});

test('legacy v1 report checkpoint without notify preserves urgent request identity after placed submit/reopen',{timeout:10000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'legacy-urgent-')),'session.sqlite'),placed=latch();let admitted;
 let f=await fixture({path,failReports:false});
 try{
  const legacy=defineTask({name:'bb.subagent-reporter',version:1,initial:()=>({phase:'report',text:'Subagent legacy reported=done',urgent:true}),phases:{report:async(task,runtime,c)=>{
   const parent=await runtime.conversation(runtime.conversationId,c);const s=await parent.submit({type:'input',content:task.state.checkpoint.text,whenBusy:'steer',requestId:`subagent-urgent:${task.id}`},c);admitted=await s.status(c);placed.resolve();
   await new Promise((_,reject)=>c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true}));
  }},abort:(_task,runtime,c)=>runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c)});
  f.registry.install(defineExtension({name:'subagent',tasks:[legacy]}));
  const id=await f.harness.commit(tx=>tx.createTask(legacy,{key:'legacy',conversationId:f.root.id,task:'unused',requestId:'unused'}, {conversationId:f.root.id,ownership:{kind:'conversation'},background:true}),ctx);
  f.harness.resume();await bounded(placed.promise);assert.ok(admitted.entry);assert.equal((await f.harness.getTask(id,ctx)).state.checkpoint.notify,undefined);
  await f.harness.close(ctx);f=await fixture({path,failReports:false});f.harness.resume();await bounded(f.harness.waitForTask(id,ctx));
  const receipt=await f.root.commit(tx=>tx.submissionByRequest(f.root.id,`subagent-urgent:${id}`),ctx);assert.equal(receipt.id,admitted.id);assert.equal(receipt.entry,admitted.entry);
  const entries=(await f.root.entries({},100,undefined,ctx)).items;assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('Subagent legacy reported=done')).length,1);
 }finally{await f.close();}
});

test('busy parent: direct admission and Reporter terminal precede parent release; placement at next native step, not final answer',{timeout:10000},async()=>{
 const f=await fixture();try{
  await f.start();const busy=await f.root.submit({type:'input',content:'busy'},ctx);await bounded(f.parentEntered.promise);
  f.child.resolve();const r=await f.record();await bounded(f.harness.waitForTask(r.reporter,ctx));
  const s=await receipt(f);assert.ok(s,'direct native Reporter request admitted before parent release');assert.equal(s.status,'queued');assert.equal(f.sawReport(),false);
  const inbox=await f.harness.snapshot(InboxDoc,f.root.id,ctx);assert.equal(inbox.items.find(i=>i.id===s.id).mode,'steer');
  assert.equal((await f.state()).courier,undefined);assert.deepEqual((await f.state()).outbox??[],[]);assert.equal(f.executions(),1);
  f.parent.resolve();assert.equal((await bounded(busy.wait(ctx))).status,'unanswered');assert.equal(f.sawReport(),true);
  const placed=await receipt(f);assert.ok(placed.entry);assert.equal(placed.status,'unanswered');
  const entries=(await f.root.entries({},100,undefined,ctx)).items;
  assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('direct-child-result')).length,1);
  assert.equal(entries.some(e=>JSON.stringify(e.model).includes('PARENT-FINAL-WITHOUT-REPORT')),false);
 }finally{await f.close();}
});

test('legacy uncertain held outbox does not block new direct delivery and is preserved',{timeout:10000},async()=>{
 const f=await fixture();try{
  await f.start();const legacy={requestId:'legacy-uncertain',reports:[{id:'unknown',name:'old',text:'do not replay'}]};
  await f.harness.commit(async tx=>{const s=await tx.doc(SubagentsDoc,f.root.id);s.sending=legacy;s.outbox=[{id:'queued-old',name:'old',text:'keep'}];s.deliveryHold={kind:'uncertain',requestId:legacy.requestId,reason:'unknown receipt'};},ctx);
  f.child.resolve();await bounded(f.harness.waitForTask((await f.record()).reporter,ctx));assert.ok(await receipt(f));
  const state=await f.state();assert.deepEqual(state.sending,legacy);assert.equal(state.outbox.length,1);assert.equal(state.deliveryHold.kind,'uncertain');assert.equal(state.courier,undefined);
 }finally{await f.close();}
});

test('genuine parent admission denial is visible and never force delivered',{timeout:10000},async()=>{
 const f=await fixture({admit:async(_c,id)=>{if(id.startsWith('subagent-urgent:'))throw Error('DIRECT-ADMISSION-DENIED');}});try{
  await f.start();f.child.resolve();const terminal=await bounded(f.harness.waitForTask((await f.record()).reporter,ctx));
  assert.notEqual(terminal.state.outcome.status,'completed');assert.match(JSON.stringify(terminal),/DIRECT-ADMISSION-DENIED/);assert.equal(await receipt(f),undefined);assert.equal(f.sawReport(),false);
 }finally{await f.close();}
});

test('foreground wait returns result with no injected completion',{timeout:10000},async()=>{
 const f=await fixture({background:false});try{const s=await f.start();f.child.resolve();assert.equal((await bounded(s.wait(ctx))).status,'done');await bounded(f.harness.waitForTask((await f.record()).reporter,ctx));assert.equal(await receipt(f),undefined);assert.equal(f.sawReport(),false);}finally{await f.close();}
});

test('SQLite reopen after submit before Reporter terminal deduplicates native request without child replay',{timeout:10000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'direct-reopen-')),'session.sqlite'),submitted=latch();let armed=true;
 const origin={record(){},submit:async(_c,_sources,send,c,id)=>{const s=await send();if(armed&&id.startsWith('subagent-urgent:')){submitted.resolve();await new Promise((_,reject)=>c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true}));}return s;}};
 let f=await fixture({path,origin});let reporter;
 try{await f.start();f.child.resolve();await bounded(submitted.promise);reporter=(await f.record()).reporter;assert.ok((await receipt(f)).entry);assert.equal(f.executions(),1);await f.harness.close(ctx);
  armed=false;f=await fixture({path,origin});f.harness.resume();await bounded(f.harness.waitForTask(reporter,ctx));const s=await receipt(f);assert.ok(s);assert.equal(f.executions(),0);
  const entries=(await f.root.entries({},100,undefined,ctx)).items;
  const inbox=await f.harness.snapshot(InboxDoc,f.root.id,ctx);
  assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('direct-child-result')).length+inbox.items.filter(i=>i.id===s.id).length,1);
  const state=await f.state();assert.equal(state.courier,undefined);assert.deepEqual(state.outbox??[],[]);
 }finally{await f.close();}
});

test('SIGKILL after native direct submit before Reporter terminal: same receipt and one child execution',{timeout:15000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'direct-kill-')),'session.sqlite');
 const child=fork(fileURLToPath(import.meta.url),[],{env:{...process.env,PRIVATE_DIRECT_CRASH:path},execArgv:[],stdio:['ignore','ignore','inherit','ipc']});
 let f;
 try{
  // Only cold process/SDK startup gets the larger deadline; require the actual
  // durable-admission IPC receipt, and fail immediately on process exit/error.
  const readiness=Promise.race([once(child,'message'),once(child,'exit').then(([code,signal])=>{throw Error(`Private admission process exited before receipt: ${code}/${signal}`);})]);
  const [ready]=await bounded(readiness,10000);assert.equal(ready.executions,1);assert.ok(ready.entry);
  const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');
  const submissions=[];
  f=await fixture({path,origin:{record(){},submit:async(_parent,sources,send,_ctx,id)=>{submissions.push({sources,id});return send();}}});
  f.harness.resume();await bounded(f.harness.waitForTask(ready.reporter,ctx));
  const s=await receipt(f);assert.equal(s.id,ready.id);assert.equal(s.entry,ready.entry);assert.equal(f.executions(),0);
  assert.deepEqual(submissions,[{sources:[ready.reporter],id:`subagent-urgent:${ready.reporter}`}]);
  const entries=(await f.root.entries({},100,undefined,ctx)).items;
  assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('direct-child-result')).length,1);
  assert.equal((await f.state()).courier,undefined);
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await f?.close();}
});
} else {
 const f=await fixture({path:process.env.PRIVATE_DIRECT_CRASH,origin:{record(){},submit:async(_parent,_sources,send,c,id)=>{
  const s=await send();if(id.startsWith('subagent-urgent:')){
   const r=await f.record(),receipt=await s.status(c);process.send({reporter:r.reporter,id:receipt.id,entry:receipt.entry,executions:f.executions()});
   await new Promise((_,reject)=>c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true}));
  }return s;
 }}});
 await f.start();f.child.resolve();
}
