import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import install from '../src/adapter.mjs';
import { ensurePrivateDirectory } from '../src/private-fs.mjs';
import { resolvePiConfig } from '../src/bridge.mjs';

const directory = process.env.HINDSIGHT_EXAMPLE_DIR
  ? join(process.env.HINDSIGHT_EXAMPLE_DIR, `run-${Date.now()}`)
  : await mkdtemp(join(tmpdir(), 'pi-durable-hindsight-example-'));
await ensurePrivateDirectory(directory);
// The example is offline and must not inherit a host's process-wide overrides.
process.env.HINDSIGHT_LOG_FILE = join(directory, 'memory.log');
process.env.HINDSIGHT_DIAG_FILE = join(directory, 'diagnostics.jsonl');
process.env.HINDSIGHT_USAGE_FILE = join(directory, 'usage.jsonl');
const registry = await install(createRegistry());
const controller = registry.snapshot().extension('hindsight')?.[Symbol.for('pi.durable.hindsight.controller')];
if (!controller) throw new Error('Hindsight controller was not installed');

const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([() => fauxAssistantMessage('BARE-HARNESS-OK')]);
const storage = await openNodeSqliteStorage(join(directory, 'session.sqlite'));
const session = await Harness.open(storage, { models, registry }, context);
try {
  await controller.bind({ session, storage, directory, context });
  const root = await session.root(context, { agent: { cwd: directory, model: { provider: 'faux', modelId: 'faux-1' } } });
  await controller.admit(root, 'example-request-1', context);
  const result = await (await root.submit({
    type: 'input', content: 'deterministic bare candidate check', requestId: 'example-request-1'
  }, context)).wait(context);
  if (result.status !== 'done') throw new Error(`unexpected Harness status: ${result.status}`);
  console.log(JSON.stringify({ status: result.status, directory, retained: true }));
} finally {
  await controller.close();
  await session.close(context);
}
