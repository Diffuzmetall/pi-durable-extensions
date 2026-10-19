import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,context} from './team-fixture.mjs';
import {TeamDoc} from '../src/index.ts';

test('selected owner accepts plain answers and injects no strict JSON contract across SDK 1.2/1.3', {timeout:15000}, async()=>{
  const f=await fixture();
  try {
    const first=await f.invoke('subagent',{name:'text-smoke',task:'job:invalid:first',requestId:'text-first',background:false});
    assert.equal(first.model[0].content[0].text,'not valid report JSON');
    const before=await f.record('text-smoke');
    const child=await f.harness.conversation(before.conversationId,context);
    const entries=(await child.entries({},100,undefined,context)).items;
    const system=entries.find(e=>e.kind==='pi.system');
    assert.ok(system,'real child system context must be recorded');
    const prompt=JSON.stringify(system.model);
    assert.equal(prompt.includes('Return one raw JSON'),false);
    assert.ok(prompt.includes('Answer the parent in ordinary text'));
    await f.invoke('subagent',{action:'send',name:'text-smoke',task:'job:invalid:second',requestId:'text-second',background:false});
    assert.equal((await f.record('text-smoke')).conversationId,before.conversationId);
    assert.equal(f.childInputs.filter(x=>x==='job:invalid:first').length,1);
    assert.equal(f.childInputs.filter(x=>x==='job:invalid:second').length,1);
    const runs=(await f.harness.snapshot(TeamDoc,f.root.id,context)).executions;
    assert.ok(runs['subagent:text-first'].done.answerRef);
    assert.equal(runs['subagent:text-first'].done.text,undefined);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});
