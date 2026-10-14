import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { fixture, ctx } from './support.ts';
test('ISC-19 actual crash and retained SQLite reopen before/after evaluator allow never replay unsafe shell operation', async () => {
  for (const mode of ['before-evaluation', 'after-evaluation']) {
    const f = await fixture(); const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/crash-harness.mjs', import.meta.url)), f.dir, mode, JSON.stringify(f.options)], { shell: false });
    const output: Buffer[] = []; child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => output.push(b)); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const exit = await new Promise(r => child.on('close', r)); clearTimeout(timer); assert.equal(exit, 42, Buffer.concat(output).toString());
    const barrier = JSON.parse(await readFile(join(f.dir, 'crash-barrier.json'), 'utf8')); assert.equal(barrier.intentCommitted, true); if (mode === 'after-evaluation') assert.equal(barrier.evaluatorExited, true);
    const beforeRecords = await f.records(); assert.equal(beforeRecords.length, mode === 'after-evaluation' ? 1 : 0);
    const registry = createRegistry(); registry.install(defineExtension({ name: 'fixture-coding', tools: [createBashTool()] })); registry.install(f.guard);
    const faux = fauxProvider({ models: [{ id: 'crash' }], tokensPerSecond: 100000 }); faux.setResponses([fauxAssistantMessage('recovery finished')]); const models = createModels(); models.setProvider(faux.provider);
    const harness = await Harness.open(await openNodeSqliteStorage(join(f.dir, 'crash.sqlite')), { registry, models, env: () => f.env }, ctx);
    try {
      const { id } = JSON.parse(await readFile(join(f.dir, 'root.json'), 'utf8')); const root = (await harness.conversation(id, ctx))!; harness.resume(); await root.waitForIdle(ctx);
      const result = (await root.context(ctx)).messages.find(m => m.role === 'toolResult'); assert.ok(result); assert.equal(result.isError, true); assert.match(JSON.stringify(result), /interrupted/);
      assert.equal(f.env.starts.length, 0); assert.equal((await f.records()).length, beforeRecords.length);
      await assert.rejects(readFile(join(f.dir, 'admitted-shells.jsonl')), { code: 'ENOENT' });
    } finally { await harness.close(ctx); }
  }
});
