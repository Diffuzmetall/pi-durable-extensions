import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const artifactRoot = tmpdir();
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineExtension, defineTool, MemoryStorage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createSubagent, TeamDoc } from '../src/index.ts';
import { savedAnswerText } from '../src/reports.ts';
import { SubagentsDoc } from '../src/documents.ts';
import { courierFor } from '../src/delivery.ts';

function latch() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const bounded = (promise) => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('bounded wait exceeded')), 3000); timer.unref();
})]);
async function until(probe) {
  for (let i = 0; i < 200; i++) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('condition not reached');
}
async function fixture({ background = true, storage = new MemoryStorage(), admit, options = { roles: { worker: ['gate'] } } } = {}) {
  const entered = latch(), released = latch();
  let childCalls = 0;
  const provider = fauxProvider();
  const models = createModels(); models.setProvider(provider.provider);
  const extension = createSubagent(admit, options);
  const registry = createRegistry(); registry.install(extension);
  registry.install(defineExtension({ name: 'fixture-gate', tools: [defineTool({
    name: 'gate', parameters: Type.Object({}), replay: 'unsafe',
    execute: async (_args, _api, ctx) => {
      childCalls++; entered.resolve();
      await new Promise((resolve, reject) => {
        const signal = ctx.abortSignal;
        const abort = () => reject(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        released.promise.then(resolve).finally(() => signal?.removeEventListener('abort', abort));
      });
      return { output: [{ type: 'text', text: 'released' }] };
    },
  })] }));
  const respond = (transcript) => {
    const messages = transcript.messages;
    const user = messages.findLast(m => m.role === 'user');
    const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
    const last = messages.at(-1);
    if (text?.includes('blocked-child')) {
      return last?.role === 'toolResult' ? fauxAssistantMessage(JSON.stringify({ status: 'done', summary: 'child-result', changes: [], verify: [], outputs: [], needs: [] })) : fauxAssistantMessage(fauxToolCall('gate', {}), { stopReason: 'toolUse' });
    }
    if (text?.includes('Subagent ')) return fauxAssistantMessage('report-received');
    if (last?.role === 'toolResult') return fauxAssistantMessage('parent-free');
    if (text === 'release-hold') return fauxAssistantMessage(fauxToolCall('subagent_release_hold', {}), { stopReason: 'toolUse' });
    if (text === 'stop-worker') return fauxAssistantMessage(fauxToolCall('subagent_stop', { name: 'worker' }), { stopReason: 'toolUse' });
    const second = text === 'second';
    const role = text === 'bad-role' ? 'forbidden' : 'worker';
    const task = text === 'conflict' ? 'different-task' : 'blocked-child';
    return fauxAssistantMessage(fauxToolCall('subagent', { task, role, name: second ? 'sibling' : 'worker',
      requestId: second ? 'second-admission' : 'stable-admission', background }), { stopReason: 'toolUse' });
  };
  provider.setResponses(Array.from({ length: 40 }, () => respond));
  const errors = [];
  const harness = await Harness.open(storage, { models, registry, onReport: e => errors.push(e) }, context);
  const root = await harness.root(context, { agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } } });
  return { harness, root, models, registry, provider, entered, released, errors, childCalls: () => childCalls };
}
const agents = async f => (await f.harness.snapshot(SubagentsDoc, f.root.id, context)).agents;
const reportInputs = async f => (await f.root.entries({}, 100, undefined, context)).items.filter(e => e.kind === 'pi.user' && (JSON.stringify(e.model).includes('Details=') || JSON.stringify(e.model).includes('reported=done')));
const canonical = async (f, record) => {const runs=Object.values((await f.harness.snapshot(TeamDoc,f.root.id,context)).executions).filter(e=>e.child===record.conversationId&&e.done);return f.root.commit(tx=>savedAnswerText(tx,record.conversationId,runs.at(-1).done),context);};

test('background anchor frees parent, stable admission deduplicates, one report', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const request = await f.root.submit({ type: 'input', content: 'start', requestId: 'root-1' }, context);
    await bounded(f.entered.promise);
    assert.equal((await bounded(request.wait(context))).status, 'done');
    await bounded(f.root.waitForIdle(context));
    const first = Object.values(await agents(f)); assert.equal(first.length, 1);
    const child = await f.harness.conversation(first[0].conversationId, context);
    assert.equal((await child.agent(context)).tools.some(t => t.name === 'subagent'), false);
    assert.equal((await child.agent(context)).tools.some(t => t.name === 'subagent_stop'), false);
    const owner = await child.commit(tx => tx.conversation(child.id), context);
    const anchor = await f.harness.getTask(owner.owner.taskId, context);
    assert.equal(anchor.background, true);
    await f.root.submit({ type: 'input', content: 'duplicate', requestId: 'root-2' }, context).then(s => bounded(s.wait(context)));
    assert.equal(Object.values(await agents(f)).length, 1);
    assert.equal(f.childCalls(), 1);
    await f.root.abort(context);
    assert.equal(f.childCalls(), 1);
    f.released.resolve();
    await until(async () => (await reportInputs(f)).length === 1);
    const record = Object.values(await agents(f))[0];
    await bounded(f.harness.waitForTask(record.reporter, context));
    assert.equal((await reportInputs(f)).length, 1);
    assert.match(await canonical(f, record), /child-result/);
    assert.deepEqual(f.errors, []);
  } finally { f.released.resolve(); await f.harness.close(context); }
});

test('explicit foreground waits on child and returns canonical output', { timeout: 10000 }, async () => {
  const f = await fixture({ background: false });
  try {
    const request = await f.root.submit({ type: 'input', content: 'start' }, context);
    await bounded(f.entered.promise);
    let done = false; const waiting = request.wait(context).then(s => { done = true; return s; });
    await new Promise(r => setTimeout(r, 20)); assert.equal(done, false);
    f.released.resolve(); assert.equal((await bounded(waiting)).status, 'done');
    const entries = (await f.root.entries({}, 100, undefined, context)).items;
    const tool = entries.find(e => e.kind === 'pi.tool-result');
    assert.ok(JSON.stringify(tool.model).includes('child-result'));
    assert.equal((await reportInputs(f)).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.released.resolve(); await f.harness.close(context); }
});

test('SQLite reopen keeps report and stable delivery id without rerunning child', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(artifactRoot, 'bb2-anchor-'));
  const path = join(directory, 'fixture.sqlite');
  const paused = latch();
  const f = await fixture({ storage: await openNodeSqliteStorage(path), admit: async (_target, requestId, ctx) => {
    if (!requestId.startsWith('subagent-urgent:')) return;
    paused.resolve();
    await new Promise((_, reject) => ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true }));
  } });
  await f.root.submit({ type: 'input', content: 'start' }, context).then(s => bounded(s.wait(context)));
  f.released.resolve(); await bounded(paused.promise);
  const record = Object.values(await agents(f))[0];
  const deliveryId = `subagent-urgent:${record.reporter}`;
  assert.equal((await f.harness.snapshot(SubagentsDoc, f.root.id, context)).courier, undefined);
  assert.match(await canonical(f, record), /child-result/);
  assert.equal((await reportInputs(f)).length, 0);
  await f.harness.close(context);
  const registry = createRegistry(); registry.install(createSubagent());
  const reopened = await Harness.open(await openNodeSqliteStorage(path), { models: f.models, registry }, context);
  const root = await reopened.root(context);
  try {
    reopened.resume();
    const pending = await reopened.snapshot(SubagentsDoc, root.id, context);
    await bounded(reopened.waitForTask(record.reporter, context));
    const after = { root };
    assert.equal((await reportInputs(after)).length, 1);
    assert.ok((await root.commit(tx => tx.submissionByRequest(root.id, deliveryId), context)).entry);
    assert.equal(f.childCalls(), 1);
    assert.equal(Object.values((await reopened.snapshot(SubagentsDoc, root.id, context)).agents).length, 1);
  } finally { await reopened.close(context); }
});

test('scoped unsafe stop cancels one blocked child but not its sibling', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const send = async content => bounded((await f.root.submit({ type: 'input', content }, context)).wait(context));
    await send('start'); await bounded(f.entered.promise);
    await send('second'); await until(() => f.childCalls() === 2);
    const records = Object.values(await agents(f));
    const worker = records.find(a => a.name === 'worker');
    const sibling = records.find(a => a.name === 'sibling');
    assert.notEqual(worker.conversationId, sibling.conversationId);
    await send('stop-worker');
    await bounded(f.harness.waitForTask(worker.reporter, context));
    const siblingTask = await f.harness.getTask(sibling.reporter, context);
    assert.notEqual(siblingTask.state.status, 'terminal');
    assert.ok((await agents(f))['subagent:stable-admission'].report.includes('failed'));
    f.released.resolve(); await bounded(f.harness.waitForTask(sibling.reporter, context));
    assert.match(await canonical(f, (await agents(f))['subagent:second-admission']), /child-result/);
    assert.deepEqual(f.errors, []);
  } finally { f.released.resolve(); await f.harness.close(context); }
});

test('admission limit, role allowlist and conflicting request id reject before child creation', { timeout: 10000 }, async () => {
  const f = await fixture({ options: { maxActive: 1, roles: { worker: ['gate'] } } });
  try {
    const send = async content => bounded((await f.root.submit({ type: 'input', content }, context)).wait(context));
    await send('start'); await bounded(f.entered.promise);
    for (const content of ['second', 'bad-role', 'conflict']) await send(content);
    assert.equal(Object.values(await agents(f)).length, 1);
    assert.equal(f.childCalls(), 1);
    const entries = (await f.root.entries({}, 100, undefined, context)).items;
    const results = entries.filter(e => e.kind === 'pi.tool-result');
    assert.ok(JSON.stringify(results).includes('Subagent admission limit reached'));
    assert.ok(JSON.stringify(results).includes('Role not allowed: forbidden'));
    assert.ok(JSON.stringify(results).includes('requestId conflicts'));
    const record = Object.values(await agents(f))[0];
    const child = await f.harness.conversation(record.conversationId, context);
    assert.deepEqual((await child.agent(context)).tools.map(t => t.name), ['gate', 'contact_supervisor']);
    assert.deepEqual(f.errors, []);
  } finally { f.released.resolve(); await f.harness.close(context); }
});

test('SQLite reopen after admission before submission keeps one child and one execution', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(artifactRoot, 'bb2-admission-'));
  const path = join(directory, 'fixture.sqlite');
  const paused = latch();
  const f = await fixture({ storage: await openNodeSqliteStorage(path), admit: async (_target, requestId, ctx) => {
    if (requestId.startsWith('subagent-batch:')) return;
    paused.resolve();
    await new Promise((_, reject) => ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true }));
  } });
  await f.root.submit({ type: 'input', content: 'start' }, context).then(s => bounded(s.wait(context)));
  await bounded(paused.promise);
  const before = Object.values(await agents(f))[0];
  assert.equal(f.childCalls(), 0);
  await f.harness.close(context);
  f.registry.install(createSubagent());
  const harness = await Harness.open(await openNodeSqliteStorage(path), { models: f.models, registry: f.registry }, context);
  const root = await harness.root(context);
  try {
    harness.resume(); await bounded(f.entered.promise);
    f.released.resolve(); await bounded(harness.waitForTask(before.reporter, context));
    await until(async () => (await reportInputs({ root })).length === 1);
    const after = Object.values((await harness.snapshot(SubagentsDoc, root.id, context)).agents);
    assert.equal(after.length, 1); assert.equal(after[0].conversationId, before.conversationId);
    assert.equal(f.childCalls(), 1); assert.equal((await reportInputs({ root })).length, 1);
  } finally { f.released.resolve(); await harness.close(context); }
});

test('SQLite reopen never replays an interrupted unsafe child tool', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(artifactRoot, 'bb2-unsafe-'));
  const path = join(directory, 'fixture.sqlite');
  const f = await fixture({ storage: await openNodeSqliteStorage(path) });
  await f.root.submit({ type: 'input', content: 'start' }, context).then(s => bounded(s.wait(context)));
  await bounded(f.entered.promise);
  const before = Object.values(await agents(f))[0];
  await f.harness.close(context);
  const harness = await Harness.open(await openNodeSqliteStorage(path), { models: f.models, registry: f.registry }, context);
  try {
    harness.resume();
    await bounded(harness.waitForTask(before.reporter, context));
    assert.equal(f.childCalls(), 1);
    const child = await harness.conversation(before.conversationId, context);
    const entries = (await child.entries({}, 100, undefined, context)).items;
    assert.ok(JSON.stringify(entries).includes('interrupted'));
  } finally { f.released.resolve(); await harness.close(context); }
});

test('background child results each directly admit one native report', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const send = async content => bounded((await f.root.submit({ type: 'input', content }, context)).wait(context));
    await send('start'); await bounded(f.entered.promise);
    await send('second'); await until(() => f.childCalls() === 2);
    f.released.resolve();
    await until(async () => (await reportInputs(f)).length === 2);
    const reports = await reportInputs(f);
    assert.equal(reports.length, 2);
    assert.match(JSON.stringify(reports.map(r => r.model)), /Subagent .*worker.*Details=/);
    assert.match(JSON.stringify(reports.map(r => r.model)), /Subagent .*sibling.*Details=/);
    assert.equal((await f.harness.snapshot(SubagentsDoc, f.root.id, context)).courier, undefined);
    assert.deepEqual(f.errors, []);
  } finally { f.released.resolve(); await f.harness.close(context); }
});

test('persisted legacy delivery hold retains its batch until explicitly released', { timeout: 10000 }, async () => {
  let permitted = false;
  const deliveryIds = [];
  const f = await fixture({ admit: async (_target, requestId) => {
    if (!requestId.startsWith('subagent-batch:')) return;
    deliveryIds.push(requestId);
    if (!permitted) throw new Error('synthetic budget hold: allowance exhausted');
  } });
  try {
    const send = async content => bounded((await f.root.submit({ type: 'input', content }, context)).wait(context));
    const courier = await f.harness.commit(async tx => {
      const state = await tx.doc(SubagentsDoc, f.root.id);
      state.outbox = [{ id: '1', name: 'legacy-worker', text: 'Subagent legacy-worker reported=done Summary: "child-result"' }];
      state.courier = await tx.createTask(courierFor(), null, { conversationId: f.root.id, ownership: { kind: 'conversation' }, background: true });
      return state.courier;
    }, context);
    f.harness.resume();
    await until(async () => (await f.harness.snapshot(SubagentsDoc, f.root.id, context))?.deliveryHold !== undefined);
    assert.equal((await reportInputs(f)).length, 0);
    const held = await f.harness.snapshot(SubagentsDoc, f.root.id, context);
    assert.match(held.deliveryHold.reason, /synthetic budget hold/);
    assert.equal(held.sending.reports.length, 1);
    assert.match(held.sending.reports[0].text, /Summary: "child-result"/);
    await new Promise(r => setTimeout(r, 50));
    assert.equal(deliveryIds.length, 1);
    assert.equal((await reportInputs(f)).length, 0);
    permitted = true;
    await send('release-hold');
    await until(async () => (await reportInputs(f)).length === 1);
    assert.equal((await reportInputs(f)).length, 1);
    assert.equal(deliveryIds.length, 2);
    assert.equal(deliveryIds[1], deliveryIds[0]);
    const entries = (await f.root.entries({}, 100, undefined, context)).items;
    assert.match(JSON.stringify(entries), /synthetic budget hold: allowance exhausted/);
    await bounded(f.harness.waitForTask(courier, context));
    assert.deepEqual(f.errors, []);
  } finally { f.released.resolve(); await f.harness.close(context); }
});

test('foreground parent cancellation aborts its child while background parent cancellation does not', { timeout: 10000 }, async () => {
  const f = await fixture({ background: false });
  try {
    const submission = await f.root.submit({ type: 'input', content: 'start' }, context);
    await bounded(f.entered.promise);
    const record = Object.values(await agents(f))[0];
    await bounded(f.root.abort(context));
    const settled = await bounded(submission.wait(context));
    assert.equal(settled.status, 'unanswered');
    const child = await f.harness.conversation(record.conversationId, context);
    await bounded(child.waitForIdle(context));
    assert.equal(f.childCalls(), 1);
    const entries = (await child.entries({}, 100, undefined, context)).items;
    assert.ok(JSON.stringify(entries).includes('aborted'));
  } finally { f.released.resolve(); await f.harness.close(context); }
});
