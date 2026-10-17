import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { TeamDoc, SubagentsDoc, ChildBindingDoc } from '../src/index.ts';
import { MulticastDoc } from '../src/multicast.ts';
import { LiveDoc } from '@earendil-works/pi-durable';
import { fixture, context, until, output } from './team-fixture.mjs';
import { tmpdir } from 'node:os';
const root = tmpdir();
const pause = ms=>new Promise(r=>setTimeout(r,ms));

for (const phase of ['pending','answered']) test(`SIGKILL private SQLite at ${phase}: same question, reply and child input exactly once`,{timeout:20000},async()=>{
  const directory=await mkdtemp(join(root,`kill-${phase}-`)),path=join(directory,'session.sqlite');
  const child=fork(fileURLToPath(new URL('./team-recovery-process.mjs',import.meta.url)),[path,phase],{stdio:['ignore','pipe','pipe','ipc']});
  let log=''; child.stdout.on('data',s=>log+=s);child.stderr.on('data',s=>log+=s);
  const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(log);})]);
  assert.equal(ready[0].ready,phase);
  const exited=once(child,'exit');child.kill('SIGKILL');assert.equal((await exited)[1],'SIGKILL');
  const f=await fixture({path});
  try {
    f.harness.resume();
    const requests=await f.requests();assert.equal(requests.length,1);
    const r=requests[0];
    assert.equal(r.state,phase==='pending'?'pending':'answered');
    if(phase==='pending') {
      // Moving the wall clock by days does not expire a supervisor question.
      const now=Date.now;try{Date.now=()=>now()+30*86400000;await pause(25);assert.equal((await f.requests())[0].state,'pending');}finally{Date.now=now;}
      await f.invoke('subagent_supervisor',{action:'reply',replyTo:r.id,message:'persisted-answer'});
    }
    await until(async()=>(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions['subagent:recover'].done);
    const run=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions['subagent:recover'];
    const handle=await f.harness.conversation(run.child,context);
    const entries=(await handle.entries({},200,undefined,context)).items;
    assert.equal(entries.filter(e=>e.kind==='pi.user').length,1);
    assert.equal(entries.filter(e=>e.kind==='pi.tool-result'&&JSON.stringify(e.model).includes('Supervisor reply')).length,1);
    assert.equal((await f.requests()).length,1);
    assert.equal((await f.requests())[0].reply,'persisted-answer');
    assert.match(await f.answer('recover'),/continued/);assert.equal(run.done.text,undefined);assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('multicast current group snapshot includes idle, excludes historical and late child; reopen/dedup/conflict + per-request bead links',{timeout:15000},async()=>{
  const path=join(await mkdtemp(join(root,'multicast-')),'session.sqlite');
  const f=await fixture({path});
  for(const name of ['one','two','historical'])await f.invoke('subagent',{name,task:`job:done:${name}`,requestId:name,background:false});
  await f.root.commit(async tx=>{
    const agents=(await tx.doc(SubagentsDoc,f.root.id)).agents;agents['subagent:historical'].role='general';
    const team=await tx.doc(TeamDoc,f.root.id);team.members=team.members.filter(k=>k!=='subagent:historical');
  },context);
  const args={all:true,message:'job:done:batch',requestId:'all-1',beadIds:['bd-first','bd-second']};
  assert.match(output(await f.invoke('subagent_send_many',args)),/accepted/);
  await f.invoke('subagent',{name:'late',task:'job:done:late',requestId:'late',background:false});
  const before=await f.harness.snapshot(MulticastDoc,f.root.id,context);
  assert.deepEqual(before.batches['batch:all-1'].deliveries.map(d=>d.name),['one','two']);
  await f.close();
  const g=await fixture({path,registry:f.registry,models:f.models,provider:f.provider});
  try {
    g.harness.resume();await g.invoke('subagent_send_many',args);
    assert.match(output(await g.invoke('subagent_send_many',{...args,message:'changed'})),/conflicts/);
    assert.match(output(await g.invoke('subagent_send_many',{names:['one','foreign'],message:'job:done:no',requestId:'foreign'})),/foreign/);
    const batch=(await g.harness.snapshot(MulticastDoc,g.root.id,context)).batches['batch:all-1'];
    assert.deepEqual(batch.deliveries.map(d=>d.requestId),before.batches['batch:all-1'].deliveries.map(d=>d.requestId));
    for(const name of ['one','two','historical','late']) {
      const record=await g.record(name),handle=await g.harness.conversation(record.conversationId,context);
      await until(async()=>name==='historical'||name==='late'||(await handle.entries({},200,undefined,context)).items.filter(e=>e.kind==='pi.user').length===2);
      const entries=(await handle.entries({},200,undefined,context)).items;
      assert.equal(entries.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('job:done:batch')).length,['one','two'].includes(name)?1:0);
    }
    const executions=(await g.harness.snapshot(TeamDoc,g.root.id,context)).executions;
    for(const delivery of batch.deliveries)assert.deepEqual(executions[`subagent:${delivery.requestId}`].beadIds,['bd-first','bd-second']);
    await g.invoke('subagent',{action:'send',name:'one',task:'job:done:next-bead',requestId:'bead-next',beadIds:['bd-third'],background:false});
    assert.deepEqual((await g.harness.snapshot(TeamDoc,g.root.id,context)).executions['subagent:bead-next'].beadIds,['bd-third']);
    assert.match(output(await g.invoke('subagent',{action:'status',name:'historical'})),/job:done:historical/);
    assert.equal((await g.record('historical')).role,'general');
    await g.invoke('subagent',{action:'send',name:'historical',task:'job:done:legacy-send',requestId:'legacy-send',background:false});
    await g.invoke('subagent',{action:'stop',name:'historical'});
    assert.equal((await g.record('historical')).role,'general');
    assert.deepEqual(g.errors,[]);
  }finally{await g.close();}
});

test('multicast deduplicates names, exact mode; partial admissions retry only unsuccessful recipients',{timeout:15000},async()=>{
  const f=await fixture({options:{maxActive:1}});
  try {
    for(const name of ['one','two'])await f.invoke('subagent',{name,task:`job:done:${name}`,requestId:name,background:false});
    const args={names:['one','two','one'],message:'job:progress:batch',requestId:'partial',mode:'followUp'};
    await f.invoke('subagent_send_many',args);
    await until(()=>f.blocked.length===1);
    let batch=(await f.harness.snapshot(MulticastDoc,f.root.id,context)).batches['batch:partial'];
    assert.deepEqual(batch.deliveries.map(d=>d.status),['accepted','failed']);
    const firstId=batch.deliveries[0].requestId;
    await f.invoke('subagent',{action:'stop',name:'one'});
    await until(async()=>!(await f.harness.snapshot(LiveDoc,(await f.record('one')).conversationId,context)).run);
    await f.invoke('subagent_send_many',args);
    batch=(await f.harness.snapshot(MulticastDoc,f.root.id,context)).batches['batch:partial'];
    assert.deepEqual(batch.deliveries.map(d=>d.status),['accepted','accepted']);
    assert.equal(batch.deliveries[0].requestId,firstId);
    const run=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions[`subagent:${firstId}`];
    const child=await f.harness.conversation(run.child,context);
    assert.equal((await child.entries({},200,undefined,context)).items.filter(e=>e.kind==='pi.user'&&JSON.stringify(e.model).includes('job:progress:batch')).length,1);
    await f.invoke('subagent',{action:'stop',name:'two'});
    await f.invoke('subagent_send_many',{names:['one'],message:'job:done:steered',requestId:'steer',mode:'steer'});
    const receipts=await f.harness.snapshot((await import('../src/requests.ts')).RequestsDoc,f.root.id,context);
    const steer=(await f.harness.snapshot(MulticastDoc,f.root.id,context)).batches['batch:steer'].deliveries[0];
    assert.equal(receipts.requests[`subagent:${steer.requestId}`].followUp,false);
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});

test('canonical text including malformed JSON stays in child history; all completions bypass legacy holds',{timeout:15000},async()=>{
  const f=await fixture({admit:async(_child,id)=>{if(id.startsWith('subagent-batch:'))throw new Error('hold successful batch');}});
  try {
    await f.invoke('subagent',{name:'success',task:'job:done:success',requestId:'success'});
    await f.harness.waitForTask((await f.record('success')).reporter,context);
    assert.equal((await f.state()).courier,undefined);
    await f.harness.commit(async tx=>{(await tx.doc(SubagentsDoc,f.root.id)).deliveryHold={kind:'admission',requestId:'legacy-hold',reason:'persisted legacy hold'};},context);
    for(const kind of ['invalid','failed'])await f.invoke('subagent',{name:kind,task:`job:${kind}:x`,requestId:kind});
    await until(()=>f.parentInputs.some(x=>x.includes('not valid report JSON'))&&f.parentInputs.some(x=>x.includes('decision needed')));
    assert.equal(f.parentInputs.some(x=>x.includes('invalid_json')||x.includes('invalid_schema')),false);
    const run=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions['subagent:success'];
    const handle=await f.harness.conversation(run.child,context);
    const answerId=Number(run.done.answerRef.split(':').at(-1));
    const entry=await handle.commit(tx=>tx.entry(answerId),context);
    assert.equal(entry.conversationId,run.child);
    const raw=entry.model[0].content[0].text;
    assert.equal(JSON.parse(raw).summary,'job:done:success');
    assert.equal(run.done.text,undefined);assert.equal(await f.answer('success'),raw);
    assert.equal(f.childInputs.filter(x=>x==='job:done:success').length,1);
    assert.equal((await f.state()).deliveryHold.kind,'admission');
    assert.deepEqual(f.errors,[]);
  }finally{await f.close();}
});
