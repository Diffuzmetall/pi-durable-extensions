// This file is COPIED into the clean consumer; every import below resolves from there.
import assert from 'node:assert/strict';
import { realpath, readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createDcgGuard } from '@pi-pocket/dcg-guard';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { ok } from '@earendil-works/pi-durable/env';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
const [consumer, dir] = process.argv.slice(2);
for (const name of ['@pi-pocket/dcg-guard', '@earendil-works/pi-durable']) {
  const path = fileURLToPath(import.meta.resolve(name)); assert.ok(path.startsWith(consumer + '/node_modules/')); assert.equal(await realpath(path), path, 'workspace symlink disallowed'); assert.ok(path.endsWith('.js'), 'compiled dependency entrypoint required');
}
for (const name of ['home', 'config', 'data', 'cwd']) await mkdir(join(dir, name), { recursive: true });
const evaluatorEnv = { HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), DCG_CONFIG: join(dir, 'policy.toml'), DCG_ALLOWLIST_SYSTEM_PATH: join(dir, 'system-allowlist.toml'), DCG_ALLOW_ONCE_PATH: join(dir, 'data/allow-once.jsonl'), DCG_PENDING_EXCEPTIONS_PATH: join(dir, 'data/pending-exceptions.jsonl'), DCG_NO_UPDATE_CHECK: '1' };
await writeFile(evaluatorEnv.DCG_CONFIG, '# dedicated compiled defaults, no scoped allowlists or owner settings\n'); await writeFile(evaluatorEnv.DCG_ALLOWLIST_SYSTEM_PATH, '# isolated empty system allowlist\n');
class Recorder extends NodeExecutionEnv {
  starts = [];
  async exec(command, options, context) { this.starts.push(command); options?.onOutput?.('consumer-recorded\n', context, { stream: 'stdout' }); return ok({ exitCode: 0 }); }
}
const env = new Recorder({ cwd: join(dir, 'cwd') });
// Prove the unconditional recorder before selecting DCG; input is only DATA.
await env.exec('git reset --hard HEAD', {}, ctx); assert.equal(env.starts.length, 1); env.starts.length = 0;
const registry = createRegistry(); registry.install(CodingTools); const guard = createDcgGuard({ binaryPath: process.env.DCG_TEST_BINARY, evaluatorEnv }); registry.install(guard);
const faux = fauxProvider({ models: [{ id: 'consumer' }], tokensPerSecond: 100000 }); const models = createModels(); models.setProvider(faux.provider);
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'consumer.sqlite')), { registry, models, env: () => env }, ctx);
try {
  const conversation = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, extensions: [CodingTools, guard] } });
  for (const [command, denied] of [['git status --short', false], ['git reset --hard HEAD', true]]) {
    faux.setResponses([fauxAssistantMessage([fauxToolCall('bash', { command })], { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
    const before = env.starts.length; const submission = await conversation.submit({ type: 'input', content: 'consumer acceptance' }, ctx); assert.equal((await submission.wait(ctx)).status, 'done');
    const result = (await conversation.context(ctx)).messages.findLast(m => m.role === 'toolResult'); assert.equal(result.isError, denied); assert.equal(env.starts.length - before, denied ? 0 : 1); if (denied) assert.match(JSON.stringify(result), /DCG_DENIED/);
  }
  console.log(JSON.stringify({ result: 'PASS', factory: guard.name, durableEntry: import.meta.resolve('@earendil-works/pi-durable'), packageEntry: import.meta.resolve('@pi-pocket/dcg-guard'), starts: env.starts.length, node: process.version }));
} finally { await harness.close(ctx); }
