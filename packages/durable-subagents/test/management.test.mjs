import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, LiveDoc, InboxDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import installSubagents, { createSubagent, SubagentsDoc } from '../src/index.ts';
import { RequestsDoc } from '../src/requests.ts';

const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(probe) {
  for (let i = 0; i < 600; i++) { const value = await probe(); if (value) return value; await pause(5); }
  throw new Error('condition not reached');
}
function latch() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture({ storage = new MemoryStorage(), admit, options, adapter = false } = {}) {
  const provider = fauxProvider(), models = createModels(), releases = [];
  models.setProvider(provider.provider);
  const gates = new Map(), seen = [], admissions = [], reports = [];
  const admission = async (child, id, ctx) => { admissions.push([child.id, id]); await admit?.(child, id, ctx); };
  const registry = createRegistry();
  const read = defineTool({ name: 'read', parameters: Type.Object({}), execute: async () => ({ output: [{ type: 'text', text: 'read' }] }) });
  const gate = defineTool({ name: 'gate', parameters: Type.Object({}), replay: 'unsafe', execute: async (_args, api, ctx) => {
    gates.set(api.conversationId, (gates.get(api.conversationId) ?? 0) + 1);
    await new Promise((resolve, reject) => {
      releases.push(resolve);
      ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true });
    });
    return { output: [{ type: 'text', text: 'released' }] };
  } });
  registry.install(defineExtension({ name: 'fixture-tools', tools: [read, gate, ...(adapter ? [
    defineTool({ name: 'codemode', callers: ['model'], parameters: Type.Object({}), execute: async () => ({ output: [{ type: 'text', text: 'codemode' }] }) }),
    defineTool({ name: 'mcp_probe', callers: ['tools'], parameters: Type.Object({}), execute: async () => ({ output: [{ type: 'text', text: 'mcp' }] }) }),
  ] : [])] }));
  if (adapter) {
    registry.install(defineExtension({ name: 'subagent', tools: [defineTool({ name: 'subagent', parameters: Type.Object({}), execute: async () => { throw new Error('old owner ran'); } })] }));
    registry.install({ ...defineExtension({ name: 'hindsight' }), [Symbol.for('pi.durable.hindsight.controller')]: { admit: admission } });
  } else registry.install(createSubagent(admission, typeof options === 'function' ? options(provider) : options));
  const selectedRegistry = adapter ? installSubagents(registry) : registry;
  provider.setResponses(Array.from({ length: 1000 }, () => transcript => {
    const messages = transcript.messages;
    const user = messages.findLast(m => m.role === 'user');
    const content = typeof user?.content === 'string' ? user.content : '';
    const last = messages.at(-1);
    if (content.startsWith('child:')) {
      seen.push(content);
      if (content.startsWith('child:block') && last?.role !== 'toolResult')
        return fauxAssistantMessage(fauxToolCall('gate', {}), { stopReason: 'toolUse' });
      return fauxAssistantMessage(JSON.stringify({ status: 'done', summary: `answer:${content}`, changes: [], verify: [], outputs: [], needs: [] }));
    }
    if (content.startsWith('Subagent ')) { reports.push(content); return fauxAssistantMessage('report acknowledged'); }
    if (last?.role === 'toolResult') return fauxAssistantMessage('command complete');
    return fauxAssistantMessage(fauxToolCall('subagent', JSON.parse(content)), { stopReason: 'toolUse' });
  }));
  const errors = [];
  const harness = await Harness.open(storage, { models, registry: selectedRegistry, onReport: e => errors.push(e) }, context);
  const root = await harness.root(context, { agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } } });
  const invoke = async args => {
    const submission = await root.submit({ type: 'input', content: JSON.stringify(args) }, context);
    assert.equal((await submission.wait(context)).status, 'done');
    const entries = (await root.entries({}, 1000, undefined, context)).items;
    return entries.find(e => e.kind === 'pi.tool-result');
  };
  const agents = async () => (await harness.snapshot(SubagentsDoc, root.id, context))?.agents ?? {};
  const child = async name => harness.conversation(Object.values(await agents()).find(a => a.name === name).conversationId, context);
  return { harness, root, models, registry: selectedRegistry, provider, gates, seen, reports, admissions, errors, invoke, agents, child,
    close: async () => { releases.forEach(r => r()); await harness.close(context); } };
}
const output = result => JSON.stringify(result.model);

test('default adapter replaces exactly one owner, preserves Hindsight, enforces roles and rejects widening', { timeout: 12000 }, async () => {
  const empty = createRegistry();
  assert.throws(() => installSubagents(empty), /Hindsight/);
  const f = await fixture({ adapter: true });
  try {
    assert.equal(f.registry.snapshot().installed().filter(e => e.name === 'subagent').length, 1);
    for (const role of ['worker', 'reviewer']) {
      await f.invoke({ task: `child:${role}`, name: role, role });
      const agent = await (await f.child(role)).agent(context);
      const tools = agent.callable.map(t => t.name).sort();
      assert.deepEqual(tools, role === 'reviewer' ? ['read'] : ['gate', 'mcp_probe', 'read']);
      assert.ok(agent.tools.some(t => t.name === 'contact_supervisor'));
      assert.equal(agent.tools.some(t => t.name === 'codemode'), role !== 'reviewer');
      assert.equal(agent.tools.some(t => t.name === 'mcp_probe'), false);
    }
    const before = Object.keys(await f.agents()).length;
    assert.match(output(await f.invoke({ task: 'child:bad', name: 'bad', role: 'reviewer', tools: ['gate'] })), /Role tool unavailable/);
    assert.match(output(await f.invoke({ task: 'child:bad', name: 'bad', role: 'general' })), /use worker/);
    assert.match(output(await f.invoke({ task: 'child:bad', name: 'bad', role: 'worker', tools: ['subagent'] })), /Role tool unavailable/);
    assert.match(output(await f.invoke({ task: 'child:bad', name: 'bad', role: 'bogus' })), /Role not allowed/);
    assert.equal(Object.keys(await f.agents()).length, before);
    assert.ok(f.admissions.length > 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('send reuses named conversation, deduplicates requests, checks conflicts and reports status one/all', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    await f.invoke({ task: 'child:first', name: 'persistent', requestId: 'spawn-one' });
    const child = await f.child('persistent');
    await until(async () => (await f.harness.snapshot(SubagentsDoc, f.root.id, context)).agents['subagent:spawn-one'].settled);
    const send = { action: 'send', name: 'persistent', message: 'child:second', followUp: true, requestId: 'send-one' };
    await f.invoke(send);
    await until(async () => (await child.entries({}, 100, undefined, context)).items.filter(e => e.kind === 'pi.user').length === 2);
    await f.invoke(send);
    assert.equal(Object.values(await f.agents()).length, 1);
    assert.equal((await f.child('persistent')).id, child.id);
    assert.match(output(await f.invoke({ ...send, message: 'child:conflict' })), /requestId conflicts/);
    const entries = (await child.entries({}, 100, undefined, context)).items;
    assert.equal(entries.filter(e => e.kind === 'pi.user').length, 2);
    const requests = await f.harness.snapshot(RequestsDoc, f.root.id, context);
    await f.harness.waitForTask(requests.requests['subagent:send-one'].reporter, context);
    assert.match(output(await f.invoke({ action: 'status', name: 'persistent' })), /answer:child:second/);
    assert.match(output(await f.invoke({ action: 'status' })), /persistent: idle/);
    assert.match(output(await f.invoke({ action: 'send', name: 'absent', task: 'child:none' })), /No subagent/);
    assert.match(output(await f.invoke({ action: 'status', name: 'absent' })), /No subagent/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('legacy unnamed children remain addressable; foreground send returns canonical output in the same conversation', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    await f.invoke({ task: 'child:unnamed', requestId: 'unnamed', background: false });
    const record = Object.values(await f.agents())[0];
    assert.equal(record.name, 'child-subagent:unnamed');
    assert.match(output(await f.invoke({ action: 'send', name: record.name, task: 'child:foreground-send', background: false })), /answer:child:foreground-send/);
    assert.match(output(await f.invoke({ action: 'status', name: record.name })), /answer:child:foreground-send/);
    assert.match(output(await f.invoke({ action: 'status' })), /idle/);
    assert.match(output(await f.invoke({ action: 'stop', name: record.name })), /Stopped/);
    assert.equal(Object.values(await f.agents())[0].conversationId, record.conversationId);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('send followUp stays queued; unified scoped stop leaves sibling working and allows later sends', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    for (const name of ['first', 'sibling']) await f.invoke({ task: `child:block-${name}`, name, role: 'worker' });
    const child = await f.child('first'), sibling = await f.child('sibling');
    await until(() => f.gates.size === 2);
    await f.invoke({ action: 'send', name: 'first', task: 'child:queued', followUp: true, requestId: 'queued' });
    await until(async () => (await f.harness.snapshot(InboxDoc, child.id, context))?.items?.length > 0);
    assert.match(output(await f.invoke({ action: 'status', name: 'first' })), /first: working/);
    await f.invoke({ action: 'stop', name: 'first' });
    assert.equal((await f.harness.snapshot(LiveDoc, child.id, context))?.run, undefined);
    assert.notEqual((await f.harness.snapshot(LiveDoc, sibling.id, context))?.run, undefined);
    const receipts = await f.harness.snapshot(RequestsDoc, f.root.id, context);
    await f.harness.waitForTask(receipts.requests['subagent:queued'].reporter, context);
    await f.invoke({ action: 'send', name: 'first', task: 'child:after-stop', requestId: 'after-stop' });
    await until(async () => (await child.entries({}, 100, undefined, context)).items.some(e => e.kind === 'pi.user' && JSON.stringify(e.model).includes('child:after-stop')));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('model policy is required; host-authorized catalog model and thinking/tools use real SDK configure', { timeout: 12000 }, async () => {
  const f = await fixture({ options: provider => ({ resolveModel: selection => {
    if (selection !== 'allowed') throw new Error('host denied model');
    return { provider: provider.getModel().provider, modelId: provider.getModel().id };
  } }) });
  try {
    assert.match(output(await f.invoke({ task: 'child:bad', name: 'bad', model: 'denied' })), /host denied/);
    assert.equal(Object.keys(await f.agents()).length, 0);
    await f.invoke({ task: 'child:configured', name: 'configured', role: 'worker', model: 'allowed', thinking: 'high', tools: ['read'] });
    const agent = await (await f.child('configured')).agent(context);
    assert.equal(agent.model.modelId, f.provider.getModel().id);
    assert.deepEqual(agent.callable.map(t => t.name), ['read']);
    assert.notEqual(agent.thinkingLevel, undefined);
    assert.match(output(await f.invoke({ action: 'send', name: 'configured', task: 'child:none', tools: ['gate'] })), /spawn-only/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
  const noPolicy = await fixture();
  try {
    assert.match(output(await noPolicy.invoke({ task: 'child:bad', name: 'bad', model: 'anything' })), /host resolveModel policy/);
    assert.equal(Object.keys(await noPolicy.agents()).length, 0);
  } finally { await noPolicy.close(); }
});

test('default maxActive is 20, not 10, and a twenty-first active child is rejected', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 20; i++) await f.invoke({ task: `child:block-${i}`, name: `child-${i}`, role: 'worker' });
    await until(() => f.gates.size === 20);
    assert.match(output(await f.invoke({ task: 'child:block-over', name: 'overflow', role: 'worker' })), /admission limit/);
    assert.equal(Object.keys(await f.agents()).length, 20);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('SQLite reopen resumes pending send once in the original conversation; duplicate call adds no input', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'subagents-private-send-'));
  const path = join(directory, 'session.sqlite'), paused = latch();
  const f = await fixture({ storage: await openNodeSqliteStorage(path), admit: async (_child, id, ctx) => {
    if (!id.startsWith('subagent-send:')) return;
    paused.resolve();
    await new Promise((_, reject) => ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true }));
  } });
  await f.invoke({ task: 'child:initial', name: 'persistent', requestId: 'initial' });
  const original = await f.child('persistent');
  const send = { action: 'send', name: 'persistent', task: 'child:after-reopen', requestId: 'durable-send', followUp: true };
  await f.invoke(send); await paused.promise;
  const receipt = (await f.harness.snapshot(RequestsDoc, f.root.id, context)).requests['subagent:durable-send'];
  await f.harness.close(context);
  f.registry.install(createSubagent());
  const harness = await Harness.open(await openNodeSqliteStorage(path), { models: f.models, registry: f.registry }, context);
  const root = await harness.root(context);
  try {
    harness.resume(); await harness.waitForTask(receipt.reporter, context);
    const again = await root.submit({ type: 'input', content: JSON.stringify(send) }, context); await again.wait(context);
    const state = await harness.snapshot(SubagentsDoc, root.id, context);
    assert.equal(Object.values(state.agents).length, 1);
    assert.equal(Object.values(state.agents)[0].conversationId, original.id);
    const child = await harness.conversation(original.id, context);
    const entries = (await child.entries({}, 100, undefined, context)).items;
    assert.equal(entries.filter(e => e.kind === 'pi.user' && JSON.stringify(e.model).includes('child:after-reopen')).length, 1);
    assert.equal((await root.commit(tx => tx.submissionByRequest(child.id, receipt.requestId), context)).status, 'done');
  } finally { await harness.close(context); }
});
