import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import createSearchHistory from '../src/index.ts';
import { searchHistory } from '../src/history.ts';

const user = (id, text) => ({ id, kind: 'pi.user', model: [{ role: 'user', content: text }] });
const entries = [
  user(1, 'Alpha checkout broken'),
  { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', content: [
    { type: 'thinking', thinking: 'hidden-secret' },
    { type: 'text', text: 'First block' }, { type: 'text', text: 'second block' },
    { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'git status' } },
  ] }] },
  { id: 3, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolName: 'bash', isError: true,
    content: [{ type: 'text', text: 'checkout failed' }] }] },
  { id: 4, kind: 'pi.system', model: [{ role: 'system', content: 'system-secret' }] },
  { id: 5, kind: 'pi.reset', model: [] },
  user(6, [{ type: 'text', text: 'Alpha later' }, { type: 'image', data: 'image-secret' }]),
  { id: 7, kind: 'pi.assistant', model: [fauxAssistantMessage([fauxToolCall('search_history', { query: 'Alpha' })])] },
];

test('literal case-insensitive AND search, newest first, historical labels', () => {
  const page = searchHistory(entries, { query: 'ALPHA checkout' }, { activeFrom: 6, lastReset: 5 });
  assert.deepEqual(page.results.map(r => [r.entry, r.context]), [[1, 'before reset']]);
  assert.equal(searchHistory(entries, { query: 'Alpha' }, { activeFrom: 6 }).total, 2);
  assert.equal(searchHistory(entries, { query: 'hidden-secret' }).total, 0);
  assert.equal(searchHistory(entries, { query: 'system-secret' }).total, 0);
  assert.equal(searchHistory(entries, { query: 'image-secret' }).total, 0);
});

test('tool, kind and inclusive range filters; pagination', () => {
  assert.deepEqual(searchHistory(entries, { tool: 'BASH' }).results.map(r => r.entry), [3, 2]);
  assert.deepEqual(searchHistory(entries, { kind: 'tool_call' }).results.map(r => r.entry), [2]);
  assert.deepEqual(searchHistory(entries, { kind: 'tool_result' }).results.map(r => r.entry), [3]);
  const first = searchHistory(entries, { from_entry: 1, to_entry: 6, order: 'oldest', limit: 2 });
  assert.deepEqual(first.results.map(r => r.entry), [1, 2]);
  assert.equal(first.total, 5);
  assert.equal(first.next_offset, 2);
  assert.deepEqual(searchHistory(entries, { order: 'oldest', limit: 2, offset: 2 }).results.map(r => r.entry), [3, 5]);
});

test('entry lookup, typed blocks, self-search exclusion and text bounds', () => {
  const result = searchHistory(entries, { entry: 2 }).results[0];
  assert.match(result.text, /First block\nsecond block/);
  assert.match(result.text, /git status/);
  assert.equal(searchHistory(entries, { entry: 2, query: 'absent', kind: 'user', tool: 'missing', from_entry: 99, to_entry: 100 }).results[0].entry, 2);
  assert.doesNotMatch(result.text, /hidden-secret/);
  assert.equal(searchHistory(entries, { entry: 7 }).total, 1);
  assert.equal(searchHistory(entries, { tool: 'search_history' }).total, 1);
  assert.equal(searchHistory([user(1, 'x'.repeat(10000))], {}).results[0].text.length, 360);
  assert.equal(searchHistory([user(1, 'x'.repeat(10000))], { entry: 1 }).results[0].text.length, 4000);
  assert.equal(searchHistory([], {}).next_offset, null);
});

async function opened() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const extension = createSearchHistory();
  registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, extensions: [extension] } });
  return { harness, root, faux };
}
async function ask(setup, conversation, args) {
  setup.faux.setResponses([
    fauxAssistantMessage([fauxToolCall('search_history', args, { id: 'search-1' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('done')]),
  ]);
  const settled = await (await conversation.submit({ type: 'input', content: 'Search my history.' }, ctx)).wait(ctx);
  assert.equal(settled.status, 'done');
  const page = await conversation.entries({}, 100, undefined, ctx);
  const result = page.items.find(e => e.kind === 'pi.tool-result' && e.model?.some(m => m.toolCallId === 'search-1'));
  assert.ok(result, 'real Harness emitted the tool result');
  const message = result.model.find(m => m.toolCallId === 'search-1');
  return { message, data: message.isError ? undefined : JSON.parse(message.content[0].text) };
}

test('real Harness searches before reset, without other-conversation leakage', async () => {
  const setup = await opened();
  try {
    await setup.root.commit(tx => tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'lost-before-reset unique', timestamp: 1 }] }), ctx);
    const other = await setup.harness.createConversation({ ownership: { kind: 'ownerless' } }, ctx);
    await other.commit(tx => tx.appendEntry(other.id, { kind: 'pi.user', model: [{ role: 'user', content: 'foreign-private unique', timestamp: 1 }] }), ctx);
    await setup.root.reset('Fresh context.', ctx);
    const { data } = await ask(setup, setup.root, { query: 'unique' });
    assert.equal(data.total, 1);
    assert.match(data.results[0].text, /lost-before-reset/);
    assert.equal(data.results[0].context, 'before reset');
    assert.equal(data.truncated, false);
    assert.equal(data.conversation, setup.root.id);
    assert.equal(data.scan_limit, 10000);
  } finally { await setup.harness.close(ctx); }
});

test('real Harness searches pre-compaction entries excluded from active context', async () => {
  const setup = await opened();
  try {
    const [old, kept] = await setup.root.commit(async tx => {
      const old = await tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'pre-compaction token', timestamp: 1 }] });
      const kept = await tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'recent message', timestamp: 2 }] });
      await tx.appendEntry(setup.root.id, { kind: 'pi.compaction', head: kept.id, model: [{ role: 'user', content: 'Summary of earlier work.', timestamp: 3 }] });
      return [old, kept];
    }, ctx);
    assert.equal((await setup.root.context(ctx)).entries.some(e => e.id === old.id), false);
    const { data } = await ask(setup, setup.root, { query: 'pre-compaction' });
    assert.equal(data.results[0].entry, old.id);
    assert.equal(data.results[0].context, 'historical');
    assert.equal(data.active_from, kept.id);
  } finally { await setup.harness.close(ctx); }
});

test('repeated compaction labels superseded summaries as historical', async () => {
  const setup = await opened();
  try {
    const [previous, latest] = await setup.root.commit(async tx => {
      const kept = await tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'retained', timestamp: 1 }] });
      const previous = await tx.appendEntry(setup.root.id, { kind: 'pi.compaction', head: kept.id, model: [{ role: 'user', content: 'previous-summary token', timestamp: 2 }] });
      const latest = await tx.appendEntry(setup.root.id, { kind: 'pi.compaction', head: kept.id, model: [{ role: 'user', content: 'latest-summary token', timestamp: 3 }] });
      return [previous, latest];
    }, ctx);
    const active = await setup.root.context(ctx);
    assert.equal(active.entries.some(e => e.id === previous.id), false);
    assert.equal(active.entries.some(e => e.id === latest.id), true);
    const { data } = await ask(setup, setup.root, { query: 'summary token' });
    assert.deepEqual(data.results.map(r => [r.entry, r.context]), [[latest.id, 'active'], [previous.id, 'historical']]);
  } finally { await setup.harness.close(ctx); }
});

test('fork inherits history only up to fork point', async () => {
  const setup = await opened();
  try {
    const inherited = await setup.root.commit(tx => tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'visible inherited-token', timestamp: 1 }] }), ctx);
    const fork = await setup.root.fork(inherited.id, { ownership: { kind: 'ownerless' } }, ctx);
    await setup.root.commit(tx => tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: 'parent-later-private inherited-token', timestamp: 2 }] }), ctx);
    const { data } = await ask(setup, fork, { query: 'inherited-token' });
    assert.equal(data.total, 1);
    assert.equal(data.results[0].entry, inherited.id);
  } finally { await setup.harness.close(ctx); }
});

test('invalid arguments fail through the real Harness validator', async () => {
  const setup = await opened();
  try {
    const { message } = await ask(setup, setup.root, { limit: 51, conversationId: 99 });
    assert.equal(message.isError, true);
    const reversed = await ask(setup, setup.root, { from_entry: 5, to_entry: 1 });
    assert.equal(reversed.message.isError, true);
  } finally { await setup.harness.close(ctx); }
});

test('bounded scan reports incomplete totals instead of silently losing older history', async () => {
  const setup = await opened();
  try {
    await setup.root.commit(async tx => {
      for (let i = 0; i < 10005; i++) await tx.appendEntry(setup.root.id, { kind: 'pi.user', model: [{ role: 'user', content: `row-${i}`, timestamp: i + 1 }] });
    }, ctx);
    const { data } = await ask(setup, setup.root, { query: 'row-0' });
    assert.equal(data.total, 0);
    assert.equal(data.truncated, true);
    assert.equal(data.scanned_entries, 10000);
    assert.equal(data.total_is_complete, false);
    assert.ok(data.oldest_scanned_entry > 1);
  } finally { await setup.harness.close(ctx); }
});
