import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPinnedContextBuilder, resolveContextBinding } from '../src/extension.mjs';
import { withRetainAcceptance, resolvePiConfig } from '../src/bridge.mjs';
import { resolveConfig } from '../src/vendor/pi.mjs';

for (const mode of ['recall', 'pages', 'reflect', 'none']) test(`pinned no-page deferral: ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-parity-'));
  const saved = Object.fromEntries(['HINDSIGHT_LOG_FILE', 'HINDSIGHT_DIAG_FILE'].map(k => [k, process.env[k]]));
  process.env.HINDSIGHT_LOG_FILE = join(directory, 'memory.log');
  process.env.HINDSIGHT_DIAG_FILE = join(directory, 'diag');
  let searches = 0, recalls = 0, reflections = 0;
  try {
    const builder = createPinnedContextBuilder({
      cacheFileFor: () => join(directory, 'cache'),
      resolveBinding: async () => ({ cfg: resolveConfig({ autoInject: mode, pageRefreshEveryTurns: 10 }), bankId: 'fixture' }),
      resolveClient: async () => ({
        searchKnowledgePages: async () => { searches++; return []; },
        recallObservations: async () => { recalls++; return ['RAW-MEMORY-MARKER']; },
        reflect: async () => { reflections++; throw new Error('No billed reflection'); },
        listPages: async () => ({ items: [] })
      })
    });
    const result = await builder({ conversationId: 1, binding: { cwd: directory, bankId: 'fixture' }, prompt: 'goal', snapshot: { deferInitialReflect: true, pages: { atTurn: 0, list: [] } }, lifecycle: { deferInitialReflect: true }, turn: 1 });
    assert.equal(searches, mode === 'pages' ? 1 : 0);
    assert.equal(recalls, mode === 'recall' ? 1 : 0);
    assert.equal(reflections, 0);
    if (mode === 'recall') assert.ok(result.context.includes('RAW-MEMORY-MARKER'));
    else assert.equal(result.context, undefined);
    const diagnostics = await readFile(join(directory, 'diag'), 'utf8').catch(() => '');
    assert.equal(diagnostics.includes('reflect_deferred_new_bank'), mode === 'reflect');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('retain POST 404 is non-acceptance; lookup 404 remains native', async () => {
  const client = withRetainAcceptance({ bankUrl: suffix => `https://fixture.invalid${suffix}`, fetchWithAuth: async () => new Response(null, { status: 404 }) });
  await assert.rejects(client.fetchWithAuth(client.bankUrl('/memories'), { method: 'POST' }), { status: 404, accepted: false });
  assert.equal((await client.fetchWithAuth(client.bankUrl('/memories'), { method: 'GET' })).status, 404);
});

test('disableHooks gates automatic context/delivery, config disabled also gates tools', async () => {
  const resolver = disabled => cwd => resolvePiConfig(cwd, { env: {}, raw: { bankId: 'fixture', disabled } });
  const hooks = await resolveContextBinding('/fixture', { resolveBinding: resolver(false), hooksDisabled: true });
  assert.equal(hooks.contextEnabled, false); assert.equal(hooks.enabled, false); assert.equal(hooks.toolsEnabled, true);
  const disabled = await resolveContextBinding('/fixture', { resolveBinding: resolver(true), hooksDisabled: false });
  assert.equal(disabled.contextEnabled, false); assert.equal(disabled.enabled, false); assert.equal(disabled.toolsEnabled, false);
});
