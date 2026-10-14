// Retained unsafe recovery probe: actual process death after public Harness execute intent.
import { join } from 'node:path';
import { readFileSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineExtension, wrapTool } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { ok } from '@earendil-works/pi-durable/env';
import { createDcgGuard } from '../../dist/index.js';
const [dir, mode, optionsJson] = process.argv.slice(2); const options = JSON.parse(optionsJson);
class Recorder extends NodeExecutionEnv { async exec(command) { appendFileSync(join(dir, 'admitted-shells.jsonl'), JSON.stringify({ command }) + '\n'); return ok({ exitCode: 0 }); } }
const env = new Recorder({ cwd: join(dir, 'cwd') });
const base = createBashTool(); const registry = createRegistry(); registry.install(defineExtension({ name: 'fixture-coding', tools: [base] })); registry.install(createDcgGuard(options));
registry.install(defineExtension({ name: 'fixture-crash-barrier', wraps: [wrapTool(base, tool => ({ ...tool, async execute(args, api, context) {
  if (mode === 'before-evaluation') { writeFileSync(join(dir, 'crash-barrier.json'), JSON.stringify({ mode, intentCommitted: true })); process.exit(42); }
  const signal = context.abortSignal; const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
  Object.defineProperty(signal, 'aborted', { get() {
    const path = join(dir, 'pids.txt');
    if (existsSync(path)) { const pid = Number(readFileSync(path, 'utf8').trim()); try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') { writeFileSync(join(dir, 'crash-barrier.json'), JSON.stringify({ mode, evaluatorPid: pid, evaluatorExited: true, intentCommitted: true })); process.exit(42); } } }
    return getter.call(this);
  } });
  return tool.execute(args, api, context);
} }))] }));
const faux = fauxProvider({ models: [{ id: 'crash' }], tokensPerSecond: 100000 }); const models = createModels(); models.setProvider(faux.provider);
const harness = await Harness.open(await openNodeSqliteStorage(join(dir, 'crash.sqlite')), { registry, models, env: () => env }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } }); writeFileSync(join(dir, 'root.json'), JSON.stringify({ id: root.id }));
faux.setResponses([fauxAssistantMessage([fauxToolCall('bash', { command: 'git status --short' })], { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
const submission = await root.submit({ type: 'input', content: 'unsafe crash fixture' }, ctx); await submission.wait(ctx); process.exit(43);
