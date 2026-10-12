import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, configure, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import install, { HINDSIGHT_CONTROLLER as key } from '../src/adapter.mjs';
import { createHindsightController } from '../src/index.mjs';
import { resolvePiConfig } from '../src/bridge.mjs';
import { ContextState } from '../src/extension.mjs';
import { DeliveryState } from '../src/delivery.mjs';

test('real Harness: stable root admission, host-owned child tool, model memory and reload binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-memory-test-'));
  const registry = createRegistry();
  let controller;
  // Test-owned host seam, not a library-exported child tool. Native task owns the child.
  const childExtension = defineExtension({ name: 'fixture-child', tools: [defineTool({
    name: 'fixture_child', description: 'Run a deterministic child fixture',
    parameters: Type.Object({ task: Type.String() }), replay: 'safe',
    async execute(args, api, ctx) {
      const id = await api.commit(async tx => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing) return existing.id;
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } });
        await configure(tx, child.id, { extensions: { remove: [childExtension] } });
        return child.id;
      }, ctx);
      const child = await api.conversation(id, ctx);
      const requestId = `fixture-child:${api.taskId}`;
      await controller.admit(child, requestId, ctx);
      const settled = await (await child.submit({ type: 'input', content: args.task, requestId }, ctx)).wait(ctx);
      assert.equal(settled.status, 'done');
      return { content: [{ type: 'text', text: 'CHILD-COMPLETE' }], details: { conversationId: id } };
    }
  })] });
  registry.install(childExtension);
  const options = {
    resolveBinding: cwd => resolvePiConfig(cwd, { env: {}, raw: { bankId: 'fixture', autoSeed: false, autoUpdate: false, codebaseSurvey: false, serverMode: 'external', autoInject: 'none' } }),
    resolveClient: async binding => ({ bank: binding.bankId, listPages: async () => ({ items: [] }), supportsIdempotentRetain: async () => true, retain: async () => { throw Object.assign(new Error('offline rejection'), { accepted: false }); } }),
    buildContext: async () => ({ context: 'MEMORY-MARKER', snapshot: {} }),
    lifecycleEffects: { hasGit: () => false, usageAppend: () => {} }
  };
  controller = createHindsightController(registry, options);
  const models = createModels();
  const faux = fauxProvider(); models.setProvider(faux.provider);
  const requests = [];
  faux.setResponses([
    req => { requests.push(JSON.stringify(req)); return fauxAssistantMessage(fauxToolCall('fixture_child', { task: 'child task' }), { stopReason: 'toolUse' }); },
    req => { requests.push(JSON.stringify(req)); return fauxAssistantMessage('CHILD-FINAL'); },
    req => { requests.push(JSON.stringify(req)); return fauxAssistantMessage('ROOT-FINAL'); }
  ]);
  const storage = await openNodeSqliteStorage(join(directory, 'session.sqlite'));
  const session = await Harness.open(storage, { models, registry }, context);
  try {
    await controller.bind({ session, storage, directory, context });
    const root = await session.root(context, { agent: { cwd: directory, model: { provider: 'faux', modelId: 'faux-1' } } });
    await controller.admit(root, 'root-stable', context);
    await controller.admit(root, 'root-stable', context);
    const request = { type: 'input', content: 'root task', requestId: 'root-stable' };
    const submission = await root.submit(request, context);
    assert.equal((await submission.wait(context)).status, 'done');
    assert.equal((await root.submit(request, context)).id, submission.id);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(r => r.includes('MEMORY-MARKER')));
    assert.ok(!requests[1].includes('"name":"fixture_child"'));
    await controller.drain(100);
    const conversations = await session.commit(tx => tx.scanConversations({}, 20), context);
    assert.equal(conversations.items.length, 2);
    for (const record of conversations.items) {
      const state = await session.snapshot(ContextState, record.id, context);
      assert.equal(Object.keys(state.admissions).length, 1);
      assert.equal(Object.keys(state.prepared).length, 1);
      const outbox = await session.snapshot(DeliveryState, record.id, context);
      assert.equal(outbox.intents.length, 1);
      assert.equal(outbox.intents[0].status, 'pending');
      assert.ok(outbox.intents[0].payload.includes(record.id === root.id ? 'ROOT-FINAL' : 'CHILD-FINAL'));
    }
    // Actual adapter same-controller path; no real configuration or clients used.
    Object.defineProperty(registry, key, { value: controller });
    const candidate = await install(registry);
    assert.equal(candidate.snapshot().extension('hindsight')[key], controller);
    const next = await install(candidate);
    assert.notEqual(next.snapshot().extension('hindsight')[key], controller);
    await next.snapshot().extension('hindsight')[key].close(); // unbound candidate retires without effects
    await controller.admit(root, 'root-stable', context); // original binding survives
    // Host replacement/removal seam: retire first, bind a fresh offline controller.
    const retired = controller;
    await retired.close();
    await assert.rejects(retired.admit(root, 'after-retirement', context), /not available/);
    const replacementRegistry = createRegistry();
    controller = createHindsightController(replacementRegistry, options);
    await controller.bind({ session, storage, directory, context });
    await controller.admit(root, 'root-stable', context);
    assert.deepEqual(Object.keys((await session.snapshot(ContextState, root.id, context)).admissions), ['root-stable']);
    // Removal must retire the controller without closing the native Harness.
    await controller.close();
    await assert.rejects(controller.admit(root, 'after-removal', context), /not available/);
    assert.equal((await session.root(context)).id, root.id);
  } finally {
    await controller.close();
    await session.close(context);
  }
});

test('pure adapter creates an unbound candidate without network/config effects', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('No network allowed'); };
  try {
    const base = createRegistry();
    const registry = await install(base);
    assert.equal(base.snapshot().extension('hindsight'), undefined);
    const controller = registry.snapshot().extension('hindsight')[key];
    assert.equal(typeof controller.bind, 'function');
    await assert.rejects(controller.admit({ id: 1 }, 'unbound', context), /not available/);
    await controller.close();
  } finally { globalThis.fetch = previousFetch; }
});
