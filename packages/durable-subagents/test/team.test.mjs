import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TeamDoc, SupervisorDoc, SubagentsDoc } from '../src/index.ts';
import { LiveDoc } from '@earendil-works/pi-durable';
import { MulticastDoc } from '../src/multicast.ts';
import { fixture, context, until, output } from './team-fixture.mjs';
const pause = ms => new Promise(r => setTimeout(r, ms));

test('minimal ask -> exact parent reply -> same child resumes; foreground yields needs_attention', {timeout:15000},async()=>{
  const f=await fixture();
  try {
    const result=await f.invoke('subagent',{name:'one',task:'job:decision:one',background:false,requestId:'one',beadIds:['bd-a']});
    assert.match(output(result),/needs_attention/);
    const r=(await f.requests())[0],record=await f.record('one');
    assert.equal(r.state,'pending');assert.equal(r.child,record.conversationId);
    assert.notEqual((await f.harness.snapshot(LiveDoc,r.child,context)).run,undefined);
    assert.match(output(await f.invoke('subagent',{action:'status'})),/awaiting_supervisor/);
    await f.invoke('subagent_supervisor',{action:'reply',replyTo:r.id,message:'proceed'});
    await until(async()=>(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions['subagent:one'].done);
    assert.equal((await f.requests())[0].state,'answered');
    assert.equal((await f.record('one')).conversationId,record.conversationId);
    assert.equal(f.childInputs.filter(x=>x==='job:decision:one').length,1);
    assert.match(await f.answer('one'),/continued/);
    await f.harness.waitForTask(record.reporter,context);
    const completion=await f.root.commit(tx=>tx.submissionByRequest(f.root.id,`subagent-urgent:${record.reporter}`),context);
    assert.ok(completion,'foreground completion after attention return must still be admitted');
    assert.equal((await f.state()).courier,undefined);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('background two questions: isolated replies, invalid interview, idempotent/conflicting replies and stop/stale refusal', {timeout:15000},async()=>{
  const f=await fixture();
  try {
    for(const name of ['one','two'])await f.invoke('subagent',{name,task:`job:${name==='two'?'interview':'decision'}:${name}`,requestId:name});
    await until(async()=>(await f.requests()).length===2);
    const [one,two]=await f.requests();
    assert.match(output(await f.invoke('subagent_supervisor',{action:'reply',replyTo:'foreign',message:'no'})),/foreign/);
    assert.match(output(await f.invoke('subagent_supervisor',{action:'reply',replyTo:two.id,message:'not-json'})),/JSON object/);
    assert.match(output(await f.invoke('subagent_supervisor',{action:'reply',replyTo:two.id,message:'{"color":"green"}'})),/permitted/);
    assert.equal((await f.requests()).find(r=>r.id===two.id).state,'pending');
    await f.invoke('subagent_supervisor',{action:'reply',replyTo:two.id,message:'{"color":"blue"}'});
    await f.invoke('subagent_supervisor',{action:'reply',replyTo:two.id,message:'{"color":"blue"}'});
    assert.match(output(await f.invoke('subagent_supervisor',{action:'reply',replyTo:two.id,message:'{"color":"red"}'})),/conflicts/);
    assert.equal((await f.requests()).find(r=>r.id===one.id).state,'pending');
    await f.invoke('subagent',{action:'stop',name:one.name});
    assert.equal((await f.requests()).find(r=>r.id===one.id).state,'cancelled');
    assert.match(output(await f.invoke('subagent_supervisor',{action:'reply',replyTo:one.id,message:'too late'})),/cancelled/);
    await f.invoke('subagent',{action:'send',name:one.name,task:'job:done:new',requestId:'new'});
    await until(async()=>Object.values((await f.harness.snapshot(TeamDoc,f.root.id,context)).executions).find(e=>e.requestId==='subagent-send:new')?.done);
    assert.match(output(await f.invoke('subagent_supervisor',{action:'reply',replyTo:one.id,message:'stale'})),/cancelled/);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('quiet bounded latest progress and parent/child authority, worker nested tool inheritance, reviewer no widening', {timeout:15000},async()=>{
  const f=await fixture();
  try {
    assert.match(output(await f.invoke('subagent',{name:'old',task:'job:done:x',role:'general'})),/use worker/);
    await f.invoke('subagent',{name:'worker',task:'job:progress:x',requestId:'worker'});
    await until(()=>f.blocked.length===1);
    const before=f.parentInputs.filter(x=>x.startsWith('Subagent ')).length;
    assert.equal(before,0);
    assert.match(output(await f.invoke('subagent',{action:'status'})),/halfway/);
    assert.match(output(await f.invoke('contact_supervisor',{reason:'need_decision',message:'root-forged'})),/genuine owned child/);
    await f.invoke('subagent',{name:'reviewer',task:'job:done:review',role:'reviewer',requestId:'reviewer'});
    const reviewer=await f.harness.conversation((await f.record('reviewer')).conversationId,context);
    assert.deepEqual((await reviewer.agent(context)).tools.map(t=>t.name).sort(),['contact_supervisor','read']);
    const worker=await f.harness.conversation((await f.record('worker')).conversationId,context);
    const tools=(await worker.agent(context));
    assert.ok(tools.callable.some(t=>t.name==='mcp_read'));
    assert.ok(!tools.tools.some(t=>t.name==='subagent_supervisor'));
    await f.invoke('subagent',{action:'stop',name:'worker'});
    await f.invoke('subagent',{action:'send',name:'worker',task:'job:nested:x',requestId:'nested'});
    await until(async()=>(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions['subagent:nested']?.done);
    assert.match(await f.answer('worker'),/mcp-ok/);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

