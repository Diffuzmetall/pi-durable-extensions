import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { createRegistry } from '@earendil-works/pi-durable';
import { fixture, invoke, assertRefusal, Recorder, ctx, createDcgGuard, apiFor, waitForFile, running } from './support.ts';
const dangerous = 'rm -rf /DATA_ONLY_NEVER_EXECUTE';
const safe = 'git status --short';

test('ISC-2/3 independent recorder never delegates destructive input even without any guard', async () => {
  const f = await fixture();
  const a = apiFor(f.env);
  await createBashTool().execute({ command: dangerous }, a.api, ctx);
  assert.equal(f.env.starts.length, 1); assert.equal(f.env.starts[0].command, dangerous);
  // No real process operation exists in Recorder.exec; guard counts recorder admission, not prepare entry.
});
test('ISC-1/2 public factory selection; absent-mode fixture forwards once', async () => {
  const f = await fixture(); const registry = createRegistry(); registry.install(f.guard);
  assert.equal(f.guard.name, 'dcg-guard'); assert.equal(registry.snapshot().extension('dcg-guard'), f.guard);
  const result = await invoke(f, createBashTool(), safe); assert.equal(result.error, undefined);
  assert.equal(f.env.starts.length, 1); assert.equal(f.env.starts[0].command, safe);
  assert.deepEqual((await f.records())[0].argv, ['--robot', 'test', '--dialect', 'posix', '--enforce-budget', '--stdin']);
});
test('ISC-3 deny zero; ISC-5 prefix and public prepare are checked at final operation', async () => {
  for (const [tool, command] of [[createBashTool(), dangerous], [createBashTool({ commandPrefix: dangerous }), safe], [createBashTool({ prepare(execution) { execution.command = dangerous; } }), safe]] as const) {
    const f = await fixture(); assertRefusal(await invoke(f, tool, command), 'DCG_DENIED', f.env);
  }
});
test('ISC-6/15/20 prepared cwd/env; private method receiver bound; original environment unchanged', async () => {
  const f = await fixture(); const originalCwd = f.env.cwd;
  const tool = createBashTool({ prepare(execution, api) {
    assert.equal((api.env as Recorder).token, 'original-receiver');
    assert.equal((api.env as Recorder).originalReceiver(), 'original-receiver');
    execution.cwd = join(f.dir, 'other'); execution.env = { HOME: '/MODEL_HOME', XDG_CONFIG_HOME: '/MODEL_CONFIG', PRIVATE_SENTINEL: 'MODEL_ONLY' }; execution.inheritEnv = false;
  } });
  assert.equal((await invoke(f, tool, safe)).error, undefined);
  assert.equal(f.env.cwd, originalCwd); assert.equal(f.env.starts[0].options?.cwd, join(f.dir, 'other'));
  const record = (await f.records())[0]; assert.equal(record.cwd, join(f.dir, 'other'));
  assert.deepEqual(record.env, f.options.evaluatorEnv);
  assert.equal(f.env.starts[0].options?.inheritEnv, false); assert.equal(f.env.starts[0].options?.env?.PRIVATE_SENTINEL, 'MODEL_ONLY');
});
test('ISC-7 read-only invocation view rejects assignment, defineProperty and delete', async () => {
  for (const mutate of [(env: any) => { env.cwd = '/'; }, (env: any) => Object.defineProperty(env, 'cwd', { value: '/' }), (env: any) => { delete env.cwd; }]) {
    const f = await fixture(); const original = f.env.cwd;
    assertRefusal(await invoke(f, createBashTool({ prepare(_execution, api) { mutate(api.env); } }), safe), 'DCG_UNAVAILABLE:unsupported_environment', f.env);
    assert.equal(f.env.cwd, original);
  }
});
test('ISC-7 unsupported absent, remote and id-only duck environments fail closed', async () => {
  const f = await fixture(); const remote = new Recorder({ cwd: f.env.cwd }); Object.defineProperty(remote, 'id', { value: 'ssh:fixture' });
  for (const env of [undefined, { id: 'node:local', cwd: f.env.cwd, exec: f.env.exec.bind(f.env) }, remote]) {
    const a = apiFor(env); await assert.rejects(f.wrap(createBashTool()).execute({ command: safe }, a.api, ctx), { message: 'DCG_UNAVAILABLE:unsupported_environment' });
  }
  assert.equal(f.env.starts.length, 0); assert.equal(remote.starts.length, 0);
});
test('ISC-8 invalid effective cwd fails without server-cwd fallback', async () => {
  const f = await fixture(); const file = join(f.dir, 'regular-file'); await writeFile(file, 'data');
  for (const cwd of ['', 'relative', join(f.dir, 'missing'), file]) {
    assertRefusal(await invoke(f, createBashTool({ prepare(execution) { execution.cwd = cwd; } }), safe), 'DCG_UNAVAILABLE:invalid_cwd', f.env);
  }
  assert.deepEqual(await f.records(), []);
});
test('ISC-9 explicit null allow is accepted; every populated/wrong-type mode is unavailable', async () => {
  for (const mode of [null, 'allow', 'warn', 'deny', '', false, 0, [], {}]) {
    const f = await fixture({ patch: { mode } }); const result = await invoke(f, createBashTool(), safe);
    if (mode === null) { assert.equal(result.error, undefined); assert.equal(f.env.starts.length, 1); }
    else assertRefusal(result, 'DCG_UNAVAILABLE:protocol_error', f.env);
  }
});
test('ISC-9 tuple matrix requires exact schema/version/robot/echo/decision/exit and deny tuple', async () => {
  const cases = [
    { patch: { schema_version: '1' } }, { patch: { schema_version: 2 } }, { patch: { dcg_version: '0.10.0' }, expected: 'unsupported_version' },
    { patch: { dcg_version: 153 } }, { patch: { robot_mode: 'true' } }, { patch: { robot_mode: false } },
    { patch: { command: safe + '\n' } }, { patch: { command: 1 } }, { patch: { decision: false } },
    ...['warn', 'log', 'ask', 'indeterminate', 'unknown'].map(decision => ({ patch: { decision }, exit: 1 })),
    { exit: 1 }, { patch: { decision: 'deny', mode: 'deny' }, exit: 0 }, { patch: { decision: 'deny' }, exit: 1 },
    ...['schema_version', 'robot_mode', 'command', 'decision', 'dcg_version'].map(key => ({ omit: [key] })),
  ];
  for (const config of cases) { const f = await fixture(config); assertRefusal(await invoke(f, createBashTool(), safe), 'DCG_UNAVAILABLE:' + (config.expected ?? 'protocol_error'), f.env); }
  const denied = await fixture({ patch: { decision: 'deny', mode: 'deny' }, exit: 1 }); assertRefusal(await invoke(denied, createBashTool(), safe), 'DCG_DENIED', denied.env);
});
test('ISC-10/16 malformed, no JSON exit1, signal, invalid UTF8 and indeterminate are private unavailable errors', async () => {
  for (const config of [{ kind: 'quiet' }, { kind: 'signal' }, { kind: 'invalid-utf8' }, { kind: 'raw', raw: 'PRIVATE_SENTINEL' }, { kind: 'raw', raw: '{}{}' }, { kind: 'raw', raw: '[]' }, { patch: { decision: 'indeterminate', reason: 'PRIVATE_SENTINEL' }, exit: 1 }]) {
    const f = await fixture(config); const result = await invoke(f, createBashTool(), safe);
    assert.match(result.error!, /^DCG_UNAVAILABLE:/); assert.equal(f.env.starts.length, 0);
    assert.ok(!JSON.stringify({ error: result.error, output: result.output, diagnostics: result.diagnostics }).includes('PRIVATE_SENTINEL'));
  }
});
test('ISC-10 missing executable returns fixed spawn_failed with zero starts', async () => {
  const f = await fixture(); const guard = createDcgGuard({ ...f.options, binaryPath: join(f.dir, 'absent-evaluator') });
  const w = guard.wraps!.find(w => 'tool' in w)!; assert.ok('tool' in w);
  const a = apiFor(f.env); await assert.rejects(w.wrap(createBashTool()).execute({ command: safe }, a.api, ctx), { message: 'DCG_UNAVAILABLE:spawn_failed' }); assert.equal(f.env.starts.length, 0);
});
test('ISC-1 frozen owner options reject invalid environments and copy both inputs', async () => {
  const f = await fixture();
  for (const options of [undefined, {}, { ...f.options, binaryPath: 'dcg' }, { ...f.options, binaryPath: '' }, { ...f.options, evaluatorEnv: {} }, { ...f.options, evaluatorEnv: { ...f.options.evaluatorEnv, HOME: 'relative' } }, { ...f.options, evaluatorEnv: { ...f.options.evaluatorEnv, DCG_CONFIG: 'relative' } }, { ...f.options, evaluatorEnv: { ...f.options.evaluatorEnv, BAD: 2 } }, { ...f.options, evaluatorEnv: { ...f.options.evaluatorEnv, 'BAD=NAME': 'bad' } }, { ...f.options, evaluatorEnv: { ...f.options.evaluatorEnv, BAD: 'x\0y' } }]) {
    assert.throws(() => createDcgGuard(options as any), { message: 'DCG_INVALID_OPTIONS' });
  }
  const options = { ...f.options, evaluatorEnv: { ...f.options.evaluatorEnv } }; const guard = createDcgGuard(options);
  options.binaryPath = '/MUTATED_MISSING'; options.evaluatorEnv.HOME = '/MUTATED_HOME';
  const w = guard.wraps!.find(w => 'tool' in w)!; assert.ok('tool' in w); const a = apiFor(f.env);
  await w.wrap(createBashTool()).execute({ command: safe }, a.api, ctx);
  assert.deepEqual((await f.records())[0].env, f.options.evaluatorEnv);
});
test('ISC-11 input UTF8/framing byte limit and invalid input fail before evaluator', async () => {
  for (const command of ['', 'x\0y', '\ud800', 'x'.repeat(65535), 'é'.repeat(32768)]) {
    const f = await fixture(); assertRefusal(await invoke(f, createBashTool(), command), 'DCG_UNAVAILABLE:invalid_input', f.env); assert.deepEqual(await f.records(), []);
  }
  const f = await fixture(); const command = 'é'.repeat(32767);
  assert.equal(Buffer.byteLength(command + '\r\n'), 65536); assert.equal((await invoke(f, createBashTool(), command)).error, undefined);
});
test('ISC-11 raw stdout and stderr byte overflows fail closed', async () => {
  for (const kind of ['stdout-overflow', 'stderr-overflow']) { const f = await fixture({ kind }); assertRefusal(await invoke(f, createBashTool(), safe), 'DCG_UNAVAILABLE:output_limit', f.env); }
});
test('ISC-12 timeout kills TERM-ignoring evaluator and inherited-stdio descendant process group', async () => {
  for (const kind of ['hang', 'descendant']) {
    const f = await fixture({ kind }); const start = Date.now(); assertRefusal(await invoke(f, createBashTool(), safe), 'DCG_UNAVAILABLE:timeout', f.env);
    assert.ok(Date.now() - start >= 1900); assert.ok(Date.now() - start < 4500);
    const pids = (await readFile(f.pids, 'utf8')).trim().split('\n').map(Number); assert.equal(pids.length, kind === 'hang' ? 1 : 2);
    for (const pid of pids) assert.equal(await running(pid), false, `owned process ${pid} still running`);
  }
});
test('ISC-12 exited leader and CLOSED-stdio TERM-ignoring descendant still terminate on protocol refusal', async () => {
  const f = await fixture({ kind: 'descendant-closed' }); assertRefusal(await invoke(f, createBashTool(), safe), 'DCG_UNAVAILABLE:protocol_error', f.env);
  const pids = (await readFile(f.pids, 'utf8')).trim().split('\n').map(Number); assert.equal(pids.length, 2);
  for (const pid of pids) assert.equal(await running(pid), false, `owned process ${pid} still running`);
});
test('ISC-13 abort before and during evaluation refuses zero starts and terminates evaluator', async () => {
  const before = await fixture(); const controller = new AbortController(); controller.abort();
  assertRefusal(await invoke(before, createBashTool(), safe, before.env, controller.signal), 'DCG_UNAVAILABLE:aborted', before.env); assert.deepEqual(await before.records(), []);
  const during = await fixture({ kind: 'hang' }); const cancel = new AbortController();
  const promise = invoke(during, createBashTool(), safe, during.env, cancel.signal); const pids = (await waitForFile(during.pids)).trim().split('\n').map(Number); cancel.abort();
  assertRefusal(await promise, 'DCG_UNAVAILABLE:aborted', during.env); for (const pid of pids) assert.equal(await running(pid), false);
});
test('ISC-17 concurrent calls retain source/cwd/abort state and denied requests never admit', async () => {
  const f = await fixture({ delay: 80 }); const envA = new Recorder({ cwd: f.env.cwd }), envB = new Recorder({ cwd: join(f.dir, 'other') });
  const controller = new AbortController(); const a = invoke(f, createBashTool(), safe, envA);
  const b = invoke(f, createBashTool(), dangerous, envB); const c = invoke(f, createBashTool(), 'printf cancelled', envB, controller.signal); setTimeout(() => controller.abort(), 20);
  const [ra, rb, rc] = await Promise.all([a, b, c]); assert.equal(ra.error, undefined); assert.equal(rb.error, 'DCG_DENIED'); assert.equal(rc.error, 'DCG_UNAVAILABLE:aborted');
  assert.equal(envA.starts.length, 1); assert.equal(envA.starts[0].command, safe); assert.equal(envA.starts[0].options?.cwd, envA.cwd); assert.equal(envB.starts.length, 0);
});
test('ISC-20 selected tool metadata, prepareArguments, streaming window/timeout/result retained', async () => {
  const f = await fixture(); const base = { ...createBashTool(), replay: 'unsafe' as const, executionMode: 'parallel' as const, prepareArguments(args: unknown) { return args as { command: string }; } };
  const wrapped = f.wrap(base); for (const key of ['name', 'description', 'parameters', 'replay', 'executionMode', 'prepareArguments', 'outputLimits'] as const) assert.equal(wrapped[key], base[key]);
  const a = apiFor(f.env); const window = { maxBytes: 13, maxLines: 2, minIntervalMs: 1, bytesPerSecond: 1000 }; Object.assign(a.api, { outputWindow: window });
  const result = await wrapped.execute({ command: safe, timeout: 3 }, a.api, ctx);
  assert.deepEqual(result.structuredOutput, { output: "recorded\n", truncated: false, exitCode: 0 });
  assert.deepEqual(a.output, ['recorded\n']); assert.equal(f.env.starts[0].options?.timeout, 3); assert.deepEqual(f.env.starts[0].options?.window, window);
  assert.equal(f.env.starts[0].context, ctx);
  assert.throws(() => f.wrap({ ...base, replay: 'safe' }), /^Error: DCG_UNAVAILABLE:unsupported_environment$/);
});
