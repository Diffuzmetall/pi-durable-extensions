import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry, defineExtension, defineTool, InboxDoc } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SupervisorDoc, attentionFor } from '../src/supervisor.ts';
import { createSubagent } from '../src/index.ts';
import { fixture, until, context, output } from './team-fixture.mjs';

test('important update continues the child without a reply or pending question and notifies parent', { timeout: 12000 }, async () => {
  const f = await fixture();
  try {
    await f.invoke('subagent', { name: 'finder', task: 'job:update:contract' });
    await until(() => f.blocked.length === 1);
    const state = await f.harness.snapshot(SupervisorDoc, f.root.id, context);
    const updates = Object.values(state?.updates ?? {});
    assert.equal(updates.length, 1);
    assert.equal((await f.requests()).length, 0);
    await until(() => f.parentInputs.some(content => content.startsWith('Subagent finder important update')));
    const visible = output(await f.invoke('subagent_supervisor', { action: 'pending' }));
    assert.match(visible, /Implementation must use the corrected contract/);
    assert.match(visible, /admitted/);
    assert.match(output(await f.invoke('subagent', { action: 'status', name: 'finder' })), /working/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

async function busyFixture(path, holdAdmission = false) {
  const provider = fauxProvider(), models = createModels(), registry = createRegistry();
  models.setProvider(provider.provider);
  let releaseParent;
  let parentBlocked = false, childContinued = false, admissionReached = false;
  const gate = (name, parent) => defineTool({ name, parameters: Type.Object({}), replay: 'unsafe',
    execute: async (_args, _api, ctx) => {
      if (parent) parentBlocked = true; else childContinued = true;
      await new Promise((resolve, reject) => {
        if (parent) releaseParent = resolve;
        ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true });
      });
      return { output: [{ type: 'text', text: 'parent boundary released' }] };
    } });
  registry.install(defineExtension({ name: 'private-gates', tools: [gate('parent_gate', true), gate('child_gate', false)] }));
  registry.install(createSubagent(async (conversation, requestId, ctx) => {
    if (conversation.id === 1 && requestId.startsWith('supervisor-update:') && holdAdmission) {
      admissionReached = true;
      await new Promise((_resolve, reject) => ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true }));
    }
  }));
  provider.setResponses(Array.from({ length: 200 }, () => transcript => {
    const user = transcript.messages.findLast(message => message.role === 'user')?.content;
    const results = transcript.messages.slice(transcript.messages.findLastIndex(message => message.role === 'user') + 1).filter(message => message.role === 'toolResult');
    if (user === 'child:update') return fauxAssistantMessage(fauxToolCall(results.length ? 'child_gate' : 'contact_supervisor', results.length ? {} :
      { reason: 'important_update', message: 'Change the implementation before the next step' }), { stopReason: 'toolUse' });
    if (user === 'launch' && !results.length) return fauxAssistantMessage([
      fauxToolCall('subagent', { name: 'finder', task: 'child:update', requestId: 'finder' }), fauxToolCall('parent_gate', {}),
    ], { stopReason: 'toolUse' });
    return fauxAssistantMessage('Parent took the next boundary');
  }));
  const harness = await Harness.open(path ? await openNodeSqliteStorage(path) : new MemoryStorage(), { models, registry }, context);
  const root = await harness.root(context, { agent: { model: { provider: provider.getModel().provider, modelId: provider.getModel().id } } });
  harness.resume();
  return { harness, root, parentBlocked: () => parentBlocked, childContinued: () => childContinued, admissionReached: () => admissionReached,
    release: () => releaseParent?.(), updates: async () => Object.values((await harness.snapshot(SupervisorDoc, root.id, context))?.updates ?? {}),
    close: async () => { releaseParent?.(); await harness.close(context); } };
}

test('important update is a steer while parent tool is busy; child continues before that parent boundary', { timeout: 12000 }, async () => {
  const f = await busyFixture();
  try {
    const submission = await f.root.submit({ type: 'input', content: 'launch' }, context);
    await until(async () => f.parentBlocked() && f.childContinued() && (await f.updates())[0]?.state === 'admitted');
    const inbox = await f.harness.snapshot(InboxDoc, f.root.id, context);
    const notice = inbox.items.find(item => JSON.stringify(item.content).includes('important update'));
    assert.equal(notice?.mode, 'steer');
    assert.equal(Object.values((await f.harness.snapshot(SupervisorDoc, f.root.id, context)).requests).length, 0);
    f.release();
    assert.equal((await submission.wait(context)).status, 'done');
    const entries = (await f.root.entries({}, 100, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('important update')).length, 1);
  } finally { await f.close(); }
});

test('important update survives SQLite reopen and duplicate attention admits only one parent input', { timeout: 20000 }, async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'important-update-')), 'session.sqlite');
  let f = await busyFixture(path, true);
  try {
    const submission = await f.root.submit({ type: 'input', content: 'launch' }, context);
    await until(() => f.admissionReached() && f.childContinued() && f.parentBlocked());
    const update = (await f.updates())[0];
    assert.equal(update.state, 'pending');
    f.release(); await submission.wait(context); await f.close();
    f = await busyFixture(path);
    await until(async () => (await f.updates())[0]?.state === 'admitted');
    const duplicate = await f.harness.commit(tx => tx.createTask(attentionFor(), { updateId: update.id },
      { conversationId: f.root.id, ownership: { kind: 'conversation' }, background: true }), context);
    await f.harness.waitForTask(duplicate, context);
    await until(async () => (await f.root.entries({}, 100, undefined, context)).items.some(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('important update')));
    const entries = (await f.root.entries({}, 100, undefined, context)).items;
    assert.equal(entries.filter(entry => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('important update')).length, 1);
    assert.equal((await f.updates())[0].id, update.id);
  } finally { await f.close(); }
});

test('blocked important update admission is visible without blocking child or creating an answerable question', { timeout: 12000 }, async () => {
  const f = await fixture({ admit: async (conversation, requestId) => {
    if (conversation.id === 1 && requestId.startsWith('supervisor-update:')) throw new Error('private admission budget hold');
  } });
  try {
    await f.invoke('subagent', { name: 'finder', task: 'job:update:held' });
    await until(() => f.blocked.length === 1);
    await until(async () => Object.values((await f.harness.snapshot(SupervisorDoc, f.root.id, context))?.updates ?? {})[0]?.state === 'blocked');
    const state = await f.harness.snapshot(SupervisorDoc, f.root.id, context);
    const update = Object.values(state.updates)[0];
    assert.match(update.deliveryError, /budget hold/);
    assert.equal((await f.requests()).length, 0);
    assert.match(output(await f.invoke('subagent_supervisor', { action: 'pending' })), /blocked/);
    assert.match(output(await f.invoke('subagent_supervisor', { action: 'reply', replyTo: update.id, message: 'not a question' })), /Unknown or foreign/);
    assert.match(output(await f.invoke('contact_supervisor', { reason: 'important_update', message: 'root impersonation' })), /genuine owned child/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
