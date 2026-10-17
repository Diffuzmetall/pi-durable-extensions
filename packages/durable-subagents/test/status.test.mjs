import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { RequestsDoc } from '../src/requests.ts';
import { Anchor } from '../src/tasks.ts';
import { TeamDoc, ChildBindingDoc, SupervisorDoc, SubagentsDoc } from '../src/index.ts';
import { fixture, context, until, output } from './team-fixture.mjs';

async function setup(options={}) {
  const dir=await mkdtemp(join(tmpdir(),'team-status-test-'));
  const f=await fixture({path:join(dir,'private.sqlite'),...options});
  const seen=[];
  f.registry.install(defineExtension({name:'status-probe',tools:[
    defineTool({name:'schema_probe',parameters:Type.Object({}),structuredOutputSchema:Type.Object({answer:Type.Number()}),
      execute:async()=>({output:[{type:'text',text:'human-only'}],structuredOutput:{answer:42}})}),
    defineTool({name:'nested',parameters:Type.Object({tool:Type.String(),args:Type.Any()}),execute:async(a,api,ctx)=>{
      const r=await api.executeTool(a.tool,a.args,ctx);return {output:[{type:'text',text:JSON.stringify(r)}]};
    }}),
  ],hooks:[hook(ToolTask,{afterTool:(call,result)=>{seen.push({name:call.name,result});}})]}));
  const nested=async(args,who)=>{
    const before=seen.length;await f.invoke('nested',{tool:'subagent',args},who);
    return seen.slice(before).find(x=>x.name==='subagent')?.result;
  };
  return {...f,seen,nested};
}

test('SDK probe: direct model output and nested/CodeMode consume declared structuredOutput, not JSON-in-text',async()=>{
  const f=await setup(),sandbox=new CodemodeSandbox({memoryLimitBytes:128*1024*1024});
  f.registry.install(createCodemodeExtension({sandbox,models:false}));
  try {
    const direct=await f.invoke('schema_probe',{});
    assert.equal(direct.model[0].content[0].text,'human-only'); // Assert model text, not timestamp/call-ID digits.
    assert.deepEqual(f.seen.find(x=>x.name==='schema_probe').result.structuredOutput,{answer:42});
    const nested=await f.invoke('nested',{tool:'schema_probe',args:{}});
    assert.match(output(nested),/structuredOutput.*answer.*42/);
    const cm=await f.invoke('codemode',{code:'const r=await tools.schema_probe({}); text(r.answer);'});
    assert.match(output(cm),/42/);assert.doesNotMatch(output(cm),/human-only/);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();await sandbox.close();}
});

test('child prompt requests ordinary text and retains supervision without any mandatory JSON schema',async()=>{
  const source=await readFile(new URL('../src/supervisor.ts',import.meta.url),'utf8');
  assert.match(source,/Answer the parent in ordinary text/);
  assert.doesNotMatch(source,/Return one raw JSON|six-field|outputs.*needs.*string\[\]/);
  assert.match(source,/important_update.*need_decision/);
});

test('status returns saved exact result after direct delivery, native selectors in spawn/send receipts, direct and CodeMode',async()=>{
  const f=await setup({admit:async(child,id)=>{if(id.startsWith('subagent-batch:'))throw Error('private hold');}});
  const sandbox=new CodemodeSandbox({memoryLimitBytes:128*1024*1024});
  f.registry.install(createCodemodeExtension({sandbox,models:false}));
  try {
    await f.invoke('subagent',{name:'worker',task:'job:first',requestId:'z-first',background:false});
    const first=f.seen.find(x=>x.name==='subagent').result.structuredOutput;
    assert.equal(first.executionId,'subagent:z-first');assert.ok(first.requestId.startsWith('subagent:'));
    const before=f.childInputs.length;
    const direct=await f.invoke('subagent',{action:'status',name:'worker',requestId:first.requestId});
    assert.match(output(direct),/job:first/);assert.doesNotMatch(output(direct),/Summary:/);
    const result=f.seen.findLast(x=>x.name==='subagent').result.structuredOutput;
    assert.equal(result.action,'status');assert.equal(result.agents[0].executionId,first.executionId);
    assert.match(result.agents[0].result.text,/job:first/);assert.equal(result.agents[0].result.correlation,'exact');
    assert.match(result.agents[0].result.answerRef,/^durable:/);
    const cm=await f.invoke('codemode',{code:`const r=await tools.subagent({action:'status',name:'worker',requestId:${JSON.stringify(first.requestId)}}); text(r.agents[0].result);`});
    assert.match(output(cm),/job:first/);assert.match(output(cm),/answerRef/);
    await f.invoke('subagent',{action:'send',name:'worker',task:'job:second',requestId:'a-second'});
    const send=f.seen.findLast(x=>x.name==='subagent').result.structuredOutput;
    assert.equal(send.executionId,'subagent:a-second');assert.equal(send.requestId,'subagent-send:a-second');
    await until(async()=> (await f.harness.snapshot(TeamDoc,f.root.id,context)).executions[send.executionId]?.done);
    await f.harness.waitForTask((await f.record('worker')).reporter,context);
    assert.equal((await f.state()).courier,undefined);
    const current=await f.nested({action:'status',name:'worker'});
    assert.equal(current.isError,undefined);assert.equal(current.structuredOutput.agents[0].executionId,send.executionId);
    assert.match(current.structuredOutput.agents[0].result.text,/job:second/);
    assert.equal(f.childInputs.length,before+1);assert.deepEqual(f.errors,[]);
  } finally {await f.close();await sandbox.close();}
});

test('new pending admission never borrows a late old report; progress and questions correlate; exact selector fails closed',async()=>{
  const f=await setup();
  try {
    await f.invoke('subagent',{name:'worker',task:'job:first',requestId:'z-first',background:false});
    await f.invoke('subagent',{action:'send',name:'worker',task:'job:progress',requestId:'a-new'});
    await until(()=>f.blocked.length);
    const record=await f.record('worker');
    await f.root.commit(async tx=>{
      (await tx.doc(SubagentsDoc,f.root.id)).agents['subagent:z-first'].report='LATE OLD REPORT';
      const s=await tx.doc(SupervisorDoc,f.root.id);
      s.progress['subagent:z-first']={id:'old-progress',execution:'subagent:z-first',message:'old progress'};
      s.requests['old-question']={id:'old-question',child:record.conversationId,name:'worker',execution:'subagent:z-first',requestId:record.requestId,reason:'need_decision',message:'old',state:'pending'};
      s.requests['new-question']={id:'new-question',child:record.conversationId,name:'worker',execution:'subagent:a-new',requestId:'subagent-send:a-new',reason:'need_decision',message:'new',state:'pending'};
    },context);
    const row=(await f.nested({action:'status',name:'worker'})).structuredOutput.agents[0];
    assert.equal(row.executionId,'subagent:a-new');assert.equal(row.result,null);
    assert.deepEqual(row.pendingReplyTo,['new-question']);assert.equal(row.progress.stale,true);
    assert.equal(row.progress.executionId,'subagent:z-first');assert.equal(row.workState,'awaiting_supervisor');
    const old=(await f.nested({action:'status',name:'worker',requestId:record.requestId})).structuredOutput.agents[0];
    assert.match(old.result.text,/job:first/);assert.deepEqual(old.pendingReplyTo,['old-question']);assert.equal(old.progress.stale,false);
    for(const args of [{action:'status',name:'worker',requestId:'absent'}, {action:'status',requestId:record.requestId}]) {
      const bad=await f.nested(args);assert.equal(bad.isError,true);
    }
    const before=f.childInputs.length;await f.nested({action:'status',name:'worker'});assert.equal(f.childInputs.length,before);
  } finally {await f.close();}
});


test('parent-only retrieval guards unknown names, foreign selectors, child and forged sibling bindings before data access',async()=>{
  const f=await setup();
  try {
    for(const name of ['one','two'])await f.invoke('subagent',{name,task:`job:${name}`,requestId:name,background:false});
    const a=await f.record('one'),b=await f.record('two');
    assert.equal((await f.nested({action:'status',name:'missing'})).isError,true);
    assert.equal((await f.nested({action:'status',name:'one',requestId:b.requestId})).isError,true);
    const child=await f.harness.conversation(a.conversationId,context);
    // Deliberately re-expose the control tool to exercise requireParent, not only catalog filtering.
    await child.configure({tools:null},context);
    const denied=await f.invoke('subagent',{action:'status',name:'two'},child);
    assert.match(output(denied),/parent-only/);assert.doesNotMatch(output(denied),/job:two/);
    const stranger=await f.harness.createConversation({ownership:{kind:'ownerless'},agent:{model:(await f.root.agent(context)).model}},context);
    await stranger.commit(async tx=>{(await tx.doc(SubagentsDoc,stranger.id)).agents.foreign=a;},context);
    const forged=await f.nested({action:'status',name:'one'},stranger);
    assert.equal(forged.isError,true);assert.equal(forged.structuredOutput,undefined);
    await f.root.commit(async tx=>{(await tx.doc(ChildBindingDoc,a.conversationId)).binding.key='wrong';},context);
    const stale=await f.nested({action:'status',name:'one'});assert.equal(stale.isError,true);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});

test('legacy unscoped results are disclosed, never borrowed for missing modern execution; selectors stay exact at max length',async()=>{
  const f=await setup();
  try {
    const long='x'.repeat(200);
    await f.invoke('subagent',{name:'worker',task:'job:first',requestId:long,background:false});
    await f.invoke('subagent',{action:'send',name:'worker',task:'job:second',requestId:long+'no',background:false});
    assert.equal(f.seen.findLast(x=>x.name==='subagent').result.isError,true);
    await f.invoke('subagent',{action:'send',name:'worker',task:'job:second',requestId:'y'.repeat(200),background:false});
    const receipt=f.seen.findLast(x=>x.name==='subagent').result.structuredOutput;
    const exact=await f.nested({action:'status',name:'worker',requestId:receipt.requestId});
    assert.match(exact.structuredOutput.agents[0].result.text,/job:second/);
    await f.root.commit(async tx=>{delete (await tx.doc(TeamDoc,f.root.id)).executions[receipt.executionId];},context);
    const missing=(await f.nested({action:'status',name:'worker'})).structuredOutput.agents[0];
    assert.equal(missing.result,null);assert.equal(missing.executionId,null);assert.equal(missing.workState,'unknown');
    assert.equal((await f.nested({action:'status',name:'worker',requestId:receipt.requestId})).isError,true);
    const record=await f.record('worker');
    await f.root.commit(async tx=>{
      (await tx.doc(TeamDoc,f.root.id)).executions={};(await tx.doc(RequestsDoc,f.root.id)).requests={};
      (await tx.doc(SubagentsDoc,f.root.id)).agents['subagent:'+long].report='LEGACY saved result';
    },context);
    const legacy=(await f.nested({action:'status',name:'worker',requestId:record.requestId})).structuredOutput.agents[0];
    assert.equal(legacy.executionId,null);assert.equal(legacy.result.correlation,'legacy-unscoped');
    assert.match(legacy.result.answerRef,/^durable:/);assert.match(legacy.result.text,/job:first/);
    assert.doesNotMatch(legacy.result.text,/LEGACY saved result/,'an existing native answer wins over an old summary');
    await f.root.commit(async tx=>{(await tx.doc(SubagentsDoc,f.root.id)).agents['subagent:'+long].requestId='historical-without-native-receipt';},context);
    const summary=(await f.nested({action:'status',name:'worker',requestId:'historical-without-native-receipt'})).structuredOutput.agents[0];
    assert.equal(summary.result.answerRef,null);assert.equal(summary.result.text,'Saved result without canonical answer reference:\nLEGACY saved result');
    assert.equal((await f.nested({action:'status',name:'worker',requestId:'missing'})).isError,true);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});

test('all-status has a fixed inventory bound and no full report bodies; named status retains exact saved text',async()=>{
  const f=await setup();
  try {
    await f.root.commit(async tx=>{
      const state=await tx.doc(SubagentsDoc,f.root.id),supervisor=await tx.doc(SupervisorDoc,f.root.id);
      for(let n=0;n<55;n++) {
        const key=`legacy-${n}`,owner=await tx.createTask(Anchor,null,{ownership:{kind:'conversation'},background:true});
        const child=await tx.createConversation({ownership:{kind:'task',taskId:owner}});
        state.agents[key]={name:key,conversationId:child.id,requestId:key,task:'historical',role:'worker',ownerTaskId:owner,background:true,report:'FULL-REPORT-'+('x'.repeat(4000))};
        supervisor.progress[key]={id:`progress-${n}`,execution:key,message:'p'.repeat(8000)};
      }
      const record=state.agents['legacy-0'];
      (await tx.doc(TeamDoc,f.root.id)).executions['pending']={child:record.conversationId,key:'legacy-0',requestId:'native-pending',background:true};
      (await tx.doc(RequestsDoc,f.root.id)).requests['pending']={action:'spawn',key:'legacy-0',requestId:'native-pending',task:'historical',background:true,followUp:false,selection:'{}',ownerTaskId:record.ownerTaskId};
      for(let n=0;n<101;n++) supervisor.requests[`q-${n}`]={id:`q-${n}`,child:record.conversationId,name:record.name,execution:'pending',requestId:'native-pending',reason:'need_decision',message:'question',state:'pending'};
    },context);
    const all=(await f.nested({action:'status'})).structuredOutput;
    assert.equal(all.agents.length,50);assert.equal(all.truncated,true);
    assert.equal(all.agents[0].pendingReplyTo.length,100);
    const pending=(await f.nested({action:'status',name:'legacy-0'})).structuredOutput;
    assert.equal(pending.agents[0].pendingReplyTo.length,101);assert.equal(pending.truncated,false);
    assert.ok(all.agents.every(a=>a.result===null&&a.progress.message.length===256));
    assert.doesNotMatch(JSON.stringify(all),/FULL-REPORT/);assert.ok(JSON.stringify(all).length<40000);
    const named=(await f.nested({action:'status',name:'legacy-54'})).structuredOutput;
    assert.match(named.agents[0].result.text,/FULL-REPORT/);assert.equal(named.truncated,false);
    assert.equal(f.childInputs.length,0);assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});

test('schema accepts foreground needs_attention and stop through direct and CodeMode paths',async()=>{
  const f=await setup(),sandbox=new CodemodeSandbox({memoryLimitBytes:128*1024*1024});
  f.registry.install(createCodemodeExtension({sandbox,models:false}));
  try {
    const attention=await f.nested({name:'worker',task:'job:decision',requestId:'ask',background:false});
    assert.equal(attention.isError,undefined);assert.equal(attention.structuredOutput.status,'needs_attention');
    assert.equal(attention.structuredOutput.executionId,'subagent:ask');
    const status=(await f.nested({action:'status',name:'worker'})).structuredOutput.agents[0];
    assert.deepEqual(status.pendingReplyTo,[attention.structuredOutput.replyTo]);
    const cm=await f.invoke('codemode',{code:"text(await tools.subagent({action:'stop',name:'worker'}));"});
    assert.match(output(cm),/stop/);assert.match(output(cm),/worker/);
    const stopped=f.seen.findLast(x=>x.name==='subagent').result;
    assert.deepEqual(stopped.structuredOutput,{action:'stop',name:'worker'});
    const cmAttention=await f.invoke('codemode',{code:"text(await tools.subagent({name:'cm-worker',task:'job:decision',requestId:'cm-ask',background:false}));"});
    assert.match(output(cmAttention),/needs_attention/);assert.match(output(cmAttention),/supervisor:/);
    const directStop=await f.invoke('subagent',{action:'stop',name:'cm-worker'});
    assert.match(output(directStop),/Stopped cm-worker/);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();await sandbox.close();}
});
