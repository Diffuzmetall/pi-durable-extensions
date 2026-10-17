import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { fixture, context } from './team-fixture.mjs';
import { TeamDoc } from '../src/index.ts';
const finalModelText=e=>e.model[0].content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
function assertModelBoundary(entry,raw,reference,long) {
 const primary=entry.model[0].content[0].text,diagnostics=entry.data?.diagnostics??[];
 if(!long){assert.equal(primary,raw,'settled model result body, not pre-boundary afterTool value');assert.equal(diagnostics.some(d=>d.code==='truncated'),false);}
 else {assert.ok(Buffer.byteLength(primary)<Buffer.byteLength(raw));assert.ok(raw.startsWith(primary),'native clipped body must come from canonical answer, not a summary');assert.ok(diagnostics.some(d=>d.code==='truncated'),'native SDK must disclose truncation');assert.match(finalModelText(entry),/Output truncated/);assert.ok(finalModelText(entry).includes(reference),'bounded model view must retain canonical reference outside clipped body');}
}
const answers={plain:'Готово 🙂\n  literal text\n',json:'{"summary":"optional JSON", "anything": 1}',malformed:'{broken JSON\n',long:'🙂Ж\n'.repeat(18000),control:'literal\n\u001b[2J\u202eend\n'};
async function setup(){
 const f=await fixture(),seen=[],calls=[];
 f.registry.install(defineExtension({name:'native-text-probe',tools:[defineTool({name:'nested_status',parameters:Type.Object({name:Type.String(),requestId:Type.String()}),execute:async(args,api,ctx)=>{
  const r=await api.executeTool('subagent',{action:'status',...args},ctx);return {output:[{type:'text',text:JSON.stringify(r.structuredOutput)}]};
 }})],hooks:[hook(ToolTask,{afterTool:(call,result)=>{seen.push({name:call.name,result});}})]}));
 f.provider.setResponses(Array.from({length:500},()=>t=>{
  const content=t.messages.findLast(m=>m.role==='user')?.content;
  if(typeof content==='string'&&content.startsWith('job:')){calls.push(content);return fauxAssistantMessage(answers[content.slice(4)]);}
  if(typeof content==='string'&&content.startsWith('Subagent '))return fauxAssistantMessage('notice received');
  if(t.messages.at(-1)?.role==='toolResult')return fauxAssistantMessage('complete');
  const command=JSON.parse(content);return fauxAssistantMessage(fauxToolCall(command.tool,command.args),{stopReason:'toolUse'});
 }));
 return {...f,seen,calls};
}
test('legacy canonical refs resolve real history; missing/foreign entry is never reconstructed from a saved summary',{timeout:10000},async()=>{
 const f=await setup();try {
  await f.invoke('subagent',{name:'one',task:'job:plain',requestId:'one',background:false});
  await f.invoke('subagent',{name:'two',task:'job:json',requestId:'two',background:false});
  const runs=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions,one=runs['subagent:one'],two=runs['subagent:two'];
  const missing=`durable:${one.child}:99999999`;
  await f.root.commit(async tx=>{(await tx.doc(TeamDoc,f.root.id)).executions['subagent:one'].done={answerRef:missing,text:'PRETEND RAW FROM OLD SUMMARY'};},context);
  await f.invoke('subagent',{action:'status',name:'one',requestId:one.requestId});
  assert.equal(f.seen.findLast(x=>x.name==='subagent').result.structuredOutput.agents[0].result.text,`Canonical answer unavailable: ${missing}`);
  await f.root.commit(async tx=>{(await tx.doc(TeamDoc,f.root.id)).executions['subagent:one'].done={answerRef:`durable:${one.child}:${two.done.answerRef.split(':').at(-1)}`,text:'PRETEND RAW'};},context);
  await f.invoke('subagent',{action:'status',name:'one',requestId:one.requestId});const denied=f.seen.findLast(x=>x.name==='subagent').result;
  assert.equal(denied.isError,true);assert.equal(denied.structuredOutput,undefined);assert.equal(f.calls.length,2);
 }finally{await f.close();}
});
for(const kind of ['plain','json','malformed','long','control'])test(`native ${kind}: settled model boundary and full canonical API/CodeMode data without schema`,{timeout:15000},async()=>{
 const f=await setup(),sandbox=new CodemodeSandbox({memoryLimitBytes:128*1024*1024});f.registry.install(createCodemodeExtension({sandbox,models:false}));
 try{
  const foregroundEntry=await f.invoke('subagent',{name:kind,task:`job:${kind}`,requestId:kind,background:false});
  const run=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions[`subagent:${kind}`];assert.ok(run.done.answerRef);
  assertModelBoundary(foregroundEntry,answers[kind],run.done.answerRef,kind==='long');
  assert.equal(run.done.text,undefined,'canonical reference, not a second raw/summary document');
  if(kind==='json')await f.root.commit(async tx=>{(await tx.doc(TeamDoc,f.root.id)).executions[`subagent:${kind}`].done.text='OLD FORMATTED SUMMARY, NOT CANONICAL';},context);
  const args={action:'status',name:kind,requestId:run.requestId};
  const statusEntry=await f.invoke('subagent',args);const status=f.seen.findLast(x=>x.name==='subagent').result;
  assert.equal(status.structuredOutput.agents[0].result.text,answers[kind]);assert.equal(status.structuredOutput.truncated,false);
  assertModelBoundary(statusEntry,answers[kind],run.done.answerRef,kind==='long');
  await f.invoke('nested_status',{name:kind,requestId:run.requestId});
  assert.equal(f.seen.findLast(x=>x.name==='subagent').result.structuredOutput.agents[0].result.text,answers[kind]);
  await f.invoke('codemode',{code:`const r=await tools.subagent(${JSON.stringify(args)}); if(r.agents[0].result.text!==${JSON.stringify(answers[kind])}) throw Error('canonical bytes changed'); if(r.truncated) throw Error('unexpected truncation'); text('canonical exact');`});
  assert.equal(f.seen.findLast(x=>x.name==='codemode').result.isError,false);
  // A new background execution uses the same native path and does not inspect JSON syntax.
  await f.invoke('subagent',{action:'send',name:kind,task:`job:${kind}`,requestId:`background-${kind}`});
  const receipts=await f.harness.snapshot((await import('../src/requests.ts')).RequestsDoc,f.root.id,context);
  const reporter=receipts.requests[`subagent:background-${kind}`].reporter;await f.harness.waitForTask(reporter,context);
  const notice=await f.root.commit(tx=>tx.submissionByRequest(f.root.id,`subagent-urgent:${reporter}`),context);assert.ok(notice);
  if(notice.entry){const e=await f.root.commit(tx=>tx.entry(notice.entry),context);const text=e.model[0].content;
   assert.match(text,/Subagent /);assert.doesNotMatch(text,/invalid_schema|invalid_json|Needs=|Verify:|Summary:|not acceptance/);
   if(kind!=='control')assert.ok(text.endsWith(answers[kind]));else{assert.equal(text.includes('\u001b'),false);assert.match(text,/\\u001b/);}
  }
  assert.equal(f.calls.filter(x=>x===`job:${kind}`).length,2);assert.deepEqual(f.errors,[]);
 }finally{await f.close();await sandbox.close();}
});
