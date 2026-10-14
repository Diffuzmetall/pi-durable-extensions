import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, chmod, mkdir } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { fixture, apiFor, ctx, waitForFile, assertRefusal, invoke, running } from './support.ts';
const safe = 'git status --short';
test('ISC-5/8/17 TOCTOU snapshot freezes source/cwd/scalars/env/spill/window/callback before evaluator await', async () => {
  const f = await fixture({ delay: 150 }); const args = { command: safe, timeout: 2 };
  const env = { KEY: 'original' }, spill = { afterBytes: 10, afterLines: 2 }, window = { maxBytes: 9, maxLines: 3, minIntervalMs: 1, bytesPerSecond: 999 };
  let originalCallback = 0, changedCallback = 0;
  const options = { cwd: f.env.cwd, env, spill, window, inheritEnv: false, timeout: 2, onOutput() { originalCallback++; } };
  const original = { ...createBashTool(), async execute(call: any, api: any, context: any) { const result = await api.env.exec(call.command, options, context); assert.equal(result.ok, true); return {}; } };
  const a = apiFor(f.env); const promise = f.wrap(original).execute(args, a.api, ctx);
  await waitForFile(f.log); args.command = 'rm -rf /DATA_ONLY'; options.cwd = join(f.dir, 'other'); options.timeout = 999; options.inheritEnv = true; env.KEY = 'mutated'; spill.afterBytes = 999; window.maxBytes = 999; options.onOutput = () => { changedCallback++; };
  await promise; const start = f.env.starts[0]; assert.equal(f.env.starts.length, 1); assert.equal(start.command, safe); assert.equal(start.options?.cwd, f.env.cwd); assert.equal(start.options?.timeout, 2); assert.equal(start.options?.inheritEnv, false);
  assert.deepEqual(start.options?.env, { KEY: 'original' }); assert.deepEqual(start.options?.spill, { afterBytes: 10, afterLines: 2 }); assert.equal(start.options?.window?.maxBytes, 9); assert.equal(originalCallback, 1); assert.equal(changedCallback, 0);
  // Caller-owned maps are still mutable and were not frozen by the production guard.
  assert.equal(Object.isFrozen(env), false); assert.equal(Object.isFrozen(options), false);
});
test('ISC-7/8/11 argv arrays, missing cwd and unreadable directory cannot start', async () => {
  const f = await fixture();
  const arrayTool = { ...createBashTool(), async execute(_args: any, api: any, context: any) { await api.env.exec(['sh', '-c', 'rm -rf /DATA_ONLY'], { cwd: f.env.cwd }, context); return {}; } };
  assertRefusal(await invoke(f, arrayTool, safe), 'DCG_UNAVAILABLE:invalid_input', f.env);
  const missing = { ...createBashTool(), async execute(_args: any, api: any, context: any) { await api.env.exec(safe, { cwd: undefined }, context); return {}; } };
  const emptyEnv = new (f.env.constructor as any)({ cwd: f.env.cwd }); Object.defineProperty(emptyEnv, 'cwd', { value: undefined });
  const a = apiFor(emptyEnv); await assert.rejects(f.wrap(missing).execute({ command: safe }, a.api, ctx), { message: 'DCG_UNAVAILABLE:invalid_cwd' }); assert.equal(emptyEnv.starts.length, 0);
  assert.notEqual(process.getuid?.(), 0, 'unreadable-directory probe requires a non-root test actor'); const closed = join(f.dir, 'unsearchable'); await mkdir(closed); await chmod(closed, 0);
  try { assertRefusal(await invoke(f, createBashTool({ prepare(execution) { execution.cwd = closed; } }), safe), 'DCG_UNAVAILABLE:invalid_cwd', f.env); } finally { await chmod(closed, 0o700); }
});
test('ISC-7 distinct public Durable class copy is unsupported, never id-only accepted', async () => {
  const require = createRequire(new URL('../../../package.json', import.meta.url)); const entry = require.resolve('@earendil-works/pi-durable/env/node');
  const { NodeExecutionEnv: OtherNodeEnv } = await import(pathToFileURL(entry).href); const f = await fixture();
  assert.ok(!(new OtherNodeEnv({ cwd: f.env.cwd }) instanceof (f.env.constructor as any)), 'duplicate-class fixture prerequisite missing');
  const other = new OtherNodeEnv({ cwd: f.env.cwd }); let starts = 0; other.exec = async () => { starts++; throw new Error('inert duplicate recorder'); };
  const a = apiFor(other); await assert.rejects(f.wrap(createBashTool()).execute({ command: safe }, a.api, ctx), { message: 'DCG_UNAVAILABLE:unsupported_environment' }); assert.equal(starts, 0);
});
test('ISC-10 synchronous spawn throw and stdin failure remain fixed private refusals', async t => {
  const f = await fixture();
  t.mock.method(childProcess, 'spawn', () => { throw new Error('PRIVATE_SENTINEL_SYNC_SPAWN'); }); syncBuiltinESMExports();
  try { assertRefusal(await invoke(f, createBashTool(), safe), 'DCG_UNAVAILABLE:spawn_failed', f.env); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const closed = await fixture({ kind: 'stdin-close' }); const result = await invoke(closed, createBashTool(), 'x'.repeat(65534)); assert.match(result.error!, /^DCG_UNAVAILABLE:/); assert.equal(closed.env.starts.length, 0);
});
test('ISC-13 distinct inner exec context abort terminates evaluator without cancelling another invocation', async () => {
  const f = await fixture({ kind: 'hang' }); const inner = new AbortController();
  const tool = { ...createBashTool(), async execute(args: any, api: any) { await api.env.exec(args.command, { cwd: f.env.cwd }, { ...ctx, abortSignal: inner.signal }); return {}; } };
  const a = apiFor(f.env); const promise = f.wrap(tool).execute({ command: safe }, a.api, ctx).catch((e: Error) => e.message);
  const pids = (await waitForFile(f.pids)).trim().split('\n').map(Number); inner.abort(); assert.equal(await promise, 'DCG_UNAVAILABLE:aborted'); assert.equal(f.env.starts.length, 0); for (const pid of pids) assert.equal(await running(pid), false);
});
test('ISC-13 outer Context lookup aborts after accepted verdict immediately before original admission', async () => {
  const f = await fixture(); const outer = new AbortController(), inner = new AbortController(); const lookups: { lookup: number; before: boolean; after: boolean }[] = [];
  const outerContext = { ...ctx }, innerContext = { ...ctx, abortSignal: inner.signal };
  Object.defineProperty(outerContext, 'abortSignal', { get() { const before = outer.signal.aborted; if (lookups.length === 1) outer.abort(); lookups.push({ lookup: lookups.length + 1, before, after: outer.signal.aborted }); return outer.signal; } });
  // The selected tool passes a separate plain inner Context, so it never reads the outer getter.
  const tool = { ...createBashTool(), async execute(args: any, api: any) { await api.env.exec(args.command, { cwd: f.env.cwd }, innerContext); return {}; } };
  const a = apiFor(f.env); const error = await f.wrap(tool).execute({ command: safe }, a.api, outerContext).then(() => undefined, (e: Error) => e.message);
  await writeFile(join(f.dir, 'final-abort.json'), JSON.stringify({ lookups, error, starts: f.env.starts.length, innerAborted: inner.signal.aborted }, null, 2));
  assertRefusal({ error }, 'DCG_UNAVAILABLE:aborted', f.env);
  assert.deepEqual(lookups, [{ lookup: 1, before: false, after: false }, { lookup: 2, before: false, after: true }]); assert.equal(inner.signal.aborted, false); assert.equal((await f.records())[0].command, safe);
});
