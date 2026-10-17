import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, LiveDoc, InboxDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { courierFor } from '../src/delivery.ts';
import { SubagentsDoc } from '../src/documents.ts';
const until = async probe => { for(let i=0;i<800;i++){if(await probe())return;await new Promise(r=>setTimeout(r,5));}throw Error('did not settle'); };
async function fixture({path, failNotice=false, gate=false}={}) {
 const provider=fauxProvider(), models=createModels(), registry=createRegistry(), notices=[];
 models.setProvider(provider.provider);const courier=courierFor();let release, entered=false;
 registry.install(defineExtension({name:'delivery-fixture',tasks:[courier],tools:[defineTool({name:'gate',parameters:Type.Object({}),replay:'unsafe',execute:async(_a,_api,c)=>{
 entered=true;await new Promise((resolve,reject)=>{release=resolve;c.abortSignal.addEventListener('abort',()=>reject(c.abortSignal.reason),{once:true});});return {output:[{type:'text',text:'released'}]};}})]}));
 provider.setResponses(Array.from({length:100},()=>transcript=>{
 const text=transcript.messages.findLast(m=>m.role==='user')?.content;
 if(text==='busy')return transcript.messages.at(-1)?.role==='toolResult'?fauxAssistantMessage('',{stopReason:'error',errorMessage:'PRIVATE-PARENT-FAIL'}):fauxAssistantMessage(fauxToolCall('gate',{}),{stopReason:'toolUse'});
 notices.push(text);return failNotice&&notices.length===1?fauxAssistantMessage('',{stopReason:'error',errorMessage:'PRIVATE-NOTICE-FAIL'}):fauxAssistantMessage('notice received');
 }));
 const harness=await Harness.open(path?await openNodeSqliteStorage(path):new MemoryStorage(),{models,registry},ctx);
 const root=await harness.root(ctx,{agent:{model:{provider:provider.getModel().provider,modelId:provider.getModel().id}}});
 const enqueue=async(text='REPORT-A')=>{harness.resume();return harness.commit(async tx=>{const s=await tx.doc(SubagentsDoc,root.id);s.outbox=[...(s.outbox??[]),{id:'1',name:'worker',text}];const t=s.courier===undefined?undefined:await tx.task(s.courier);if(!t||t.state.status==='terminal')s.courier=await tx.createTask(courier,null,{conversationId:root.id,ownership:{kind:'conversation'},background:true});return s.courier;},ctx);};
 return {harness,root,enqueue,notices,release:()=>release?.(),entered:()=>entered,state:()=>harness.snapshot(SubagentsDoc,root.id,ctx),close:async()=>{release?.();await harness.close(ctx);}};
}
test('idle completion starts a parent turn without user input', {timeout:10000}, async()=>{
 const f=await fixture();try{const id=await f.enqueue();await f.harness.waitForTask(id,ctx);assert.deepEqual(f.notices,['REPORT-A']);assert.equal((await f.state()).sending,undefined);}finally{await f.close();}
});
test('queued follow-up survives failed busy parent and is placed once', {timeout:10000},async()=>{
 const f=await fixture();try{const busy=await f.root.submit({type:'input',content:'busy'},ctx);await until(f.entered);const id=await f.enqueue();await until(async()=>(await f.harness.snapshot(InboxDoc,f.root.id,ctx))?.items.length>0);f.release();assert.equal((await busy.wait(ctx)).status,'unanswered');await f.harness.waitForTask(id,ctx);assert.deepEqual(f.notices,['REPORT-A']);const e=(await f.root.entries({},100,undefined,ctx)).items;assert.equal(e.filter(x=>x.kind==='pi.user'&&JSON.stringify(x.model).includes('REPORT-A')).length,1);}finally{await f.close();}
});
test('placed report is delivered even if parent model fails; later batch is not held', {timeout:10000},async()=>{
 const f=await fixture({failNotice:true});try{const id=await f.enqueue();await until(async()=>f.notices.length===1&&!(await f.harness.snapshot(LiveDoc,f.root.id,ctx))?.run);await until(async()=>!(await f.state()).sending);assert.equal((await f.state()).deliveryHold,undefined);await f.harness.waitForTask(id,ctx);const second=await f.enqueue('REPORT-B');await f.harness.waitForTask(second,ctx);assert.deepEqual(f.notices,['REPORT-A','REPORT-B']);}finally{await f.close();}
});
test('reopen reconciles legacy uncertain hold from placed receipt without redelivery', {timeout:10000},async()=>{
 const path=join(await mkdtemp(join(tmpdir(),'delivery-reopen-')),'session.sqlite');let f=await fixture({path,failNotice:true});
 try{const s=await f.root.submit({type:'input',content:'REPORT-OLD',requestId:'old-delivery'},ctx);assert.equal((await s.wait(ctx)).status,'unanswered');await f.harness.commit(async tx=>{const state=await tx.doc(SubagentsDoc,f.root.id);state.sending={requestId:'old-delivery',reports:[{id:'1',name:'worker',text:'REPORT-OLD'}]};state.deliveryHold={kind:'uncertain',requestId:'old-delivery',reason:'Delivery outcome uncertain: unanswered'};state.courier=await tx.createTask(courierFor(),null,{conversationId:f.root.id,ownership:{kind:'conversation'},background:true});},ctx);await f.close();f=await fixture({path});f.harness.resume();await until(async()=>!(await f.state()).deliveryHold);assert.equal((await f.state()).sending,undefined);assert.deepEqual(f.notices,[]);const second=await f.enqueue('REPORT-NEW');await f.harness.waitForTask(second,ctx);assert.deepEqual(f.notices,['REPORT-NEW']);const entries=(await f.root.entries({},100,undefined,ctx)).items;assert.equal(entries.filter(x=>x.kind==='pi.user'&&JSON.stringify(x.model).includes('REPORT-OLD')).length,1);}finally{await f.close();}
});

for (const kind of ['missing', 'unplaced']) test(`legacy ${kind} receipt stays held; no guessed replay`, {timeout:10000},async()=>{
 const f=await fixture();try {
  const requestId=`unknown-${kind}`;
  if(kind==='unplaced') {
   const busy=await f.root.submit({type:'input',content:'busy'},ctx);await until(f.entered);
   const queued=await f.root.submit({type:'input',content:'DO-NOT-REPLAY',whenBusy:'followUp',requestId},ctx);
   assert.equal(await queued.abort(ctx),'aborted');await f.root.abort(ctx);await busy.wait(ctx);
  }
  const id=await f.harness.commit(async tx=>{const state=await tx.doc(SubagentsDoc,f.root.id);state.sending={requestId,reports:[{id:'1',name:'worker',text:'DO-NOT-REPLAY'}]};state.deliveryHold={kind:'uncertain',requestId,reason:'unknown'};state.courier=await tx.createTask(courierFor(),null,{conversationId:f.root.id,ownership:{kind:'conversation'},background:true});return state.courier;},ctx);
  f.harness.resume();await until(async()=>{const task=await f.harness.getTask(id,ctx);return task.state.status==='running'&&task.state.checkpoint.phase==='hold';});
  await new Promise(r=>setTimeout(r,40));assert.equal((await f.state()).deliveryHold.kind,'uncertain');assert.deepEqual(f.notices,[]);
 }finally{await f.close();}
});
