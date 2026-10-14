import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createBashTool} from '@earendil-works/pi-durable/tools';
import {apiFor,ctx,createDcgGuard} from '../support.ts';
import {realFixture,robot,guarded} from './real-support.ts';
test('ISC-14/22 pinned actual classifier corpus and CRLF stdin exact framing through public package', async () => {
  const f = await realFixture();
  const corpus: [string, string, string, string?][] = [
    ['safe', 'git status --short', 'allow'], ['git-deny', 'git reset --hard HEAD', 'deny', 'core.git:reset-hard'],
    ['fs-deny', 'rm -rf "$TARGET"', 'deny', 'core.filesystem:rm-rf-general'], ['quoted-text', 'printf "%s" "rm -rf /"', 'allow'],
    ['nested', "bash -c 'git reset --hard HEAD'", 'deny', 'core.git:reset-hard'], ['compound', 'git status; git reset --hard HEAD', 'deny', 'core.git:reset-hard'],
    ['redirection', 'printf "safe" > fixture-output', 'allow'], ['heredoc-deny', 'bash <<\'EOF\'\ngit reset --hard HEAD\nEOF\n', 'deny', 'core.git:reset-hard'],
    ...['', '\n', '\r', '\r\n', '\n\n', '\u2028', '\u2029', '\u0085'].map((ending, i) => [`ending-${i}`, 'printf "safe"' + ending, 'allow'] as [string, string, string]),
    ['heredoc-lf', 'cat <<\'EOF\'\nsafe\nEOF\n', 'allow'], ['heredoc-crlf', 'cat <<\'EOF\'\r\nsafe\r\nEOF\r\n', 'allow'],
  ];
  for (const [label, command, decision, rule] of corpus) {
    const r = await robot(f, command, label); assert.equal(r.json.schema_version, 1); assert.equal(r.json.dcg_version, '0.15.3'); assert.equal(r.json.robot_mode, true); assert.equal(r.json.command, command); assert.equal(r.json.decision, decision); assert.equal(r.exit, decision === 'allow' ? 0 : 1);
    if (rule) assert.equal(r.json.rule_id, rule); if (decision === 'allow') assert.ok(r.json.mode === undefined || r.json.mode === null); else assert.equal(r.json.mode, 'deny');
    const before = f.env.starts.length; const error = await guarded(f, command); assert.equal(error, decision === 'allow' ? undefined : 'DCG_DENIED'); assert.equal(f.env.starts.length - before, decision === 'allow' ? 1 : 0);
    if (decision === 'allow') assert.equal(f.env.starts.at(-1)!.command, command);
  }
});
test('ISC-10 empty-stdin actual exit1/no JSON and indeterminate budget are never allow', async () => {
  const f = await realFixture(); const empty = await robot(f, '', 'empty-stdin'); assert.equal(empty.exit, 1); assert.equal(empty.stdout, ''); assert.match(empty.stderr, /stdin did not contain a command/);
  assert.equal(await guarded(f, ''), 'DCG_UNAVAILABLE:invalid_input'); assert.equal(f.env.starts.length, 0);
  const command = Array.from({ length: 200 }, () => 'git status --short').join('; ');
  const indeterminate = await robot(f, command, 'indeterminate', f.env.cwd, { DCG_HOOK_TIMEOUT_MS: '10' }); assert.equal(indeterminate.exit, 1); assert.equal(indeterminate.json.decision, 'indeterminate');
  const guard = createDcgGuard({ binaryPath: f.binaryPath, evaluatorEnv: { ...f.evaluatorEnv, DCG_HOOK_TIMEOUT_MS: '10' } }); const w = guard.wraps!.find(w => 'tool' in w)!; assert.ok('tool' in w); const a = apiFor(f.env);
  await assert.rejects(w.wrap(createBashTool()).execute({ command }, a.api, ctx), { message: 'DCG_UNAVAILABLE:protocol_error' }); assert.equal(f.env.starts.length, 0);
});
test('ISC-18 one isolated exact-command single-use grant races to at most one recorder admission', async () => {
  const f = await realFixture(); const command = 'git reset --hard HEAD';
  const now = new Date(), expires = new Date(now.getTime() + 3600000);
  // Source-grounded AllowOnceEntry fixture (pending_exceptions.rs:63-82); owner stores are never opened.
  await writeFile(f.evaluatorEnv.DCG_ALLOW_ONCE_PATH, JSON.stringify({ schema_version: 1, source_short_code: 'fixture', source_full_hash: 'fixture-only', created_at: now.toISOString(), expires_at: expires.toISOString(), scope_kind: 'cwd', scope_path: f.env.cwd, command_raw: command, command_redacted: command, reason: 'isolated one-use acceptance fixture', single_use: true, consumed_at: null, force_allow_config: false }) + '\n');
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => guarded(f, command)));
  await writeFile(join(f.dir, 'grant-race.json'), JSON.stringify({ outcomes, starts: f.env.starts.map(s => ({ command: s.command, cwd: s.options?.cwd })), remainingStore: await readFile(f.evaluatorEnv.DCG_ALLOW_ONCE_PATH, 'utf8') }, null, 2));
  assert.equal(outcomes.filter(x => x === undefined).length, 1, 'grant must positively authorize once, not vacuously deny all'); assert.equal(f.env.starts.length, 1); assert.ok(outcomes.filter(Boolean).every(x => x === 'DCG_DENIED'));
  assert.equal(await guarded(f, command), 'DCG_DENIED'); assert.equal(f.env.starts.length, 1);
});
// Unsupported scoped-policy strict falsifier lives unchanged in scoped-policy.counterexample.ts.
test('ISC-23 conditional default-policy corpus WITHOUT scoped exceptions denies cd/target destructive data', async () => {
  const f = await realFixture(), target = join(f.dir, 'other');
  const corpus: [string, string][] = [['default-target', 'git reset --hard HEAD'], ['default-cd-and', `cd ${target} && git reset --hard HEAD`], ['default-cd-sequence', `cd ${target}; git reset --hard HEAD`], ['default-subshell', `(cd ${target}; git reset --hard HEAD)`]];
  for (const [label, command] of corpus) {
    const result = await robot(f, command, label, label === 'default-target' ? target : f.env.cwd); assert.equal(result.json.decision, 'deny'); assert.equal(result.json.rule_id, 'core.git:reset-hard'); assert.equal(result.exit, 1);
    const guard = createDcgGuard({ binaryPath: f.binaryPath, evaluatorEnv: f.evaluatorEnv }); const wrap = guard.wraps!.find(w => 'tool' in w)!; assert.ok('tool' in wrap);
    const a = apiFor(f.env); await assert.rejects(wrap.wrap(createBashTool({ prepare(e) { if (label === 'default-target') e.cwd = target; } })).execute({ command }, a.api, ctx), { message: 'DCG_DENIED' }); assert.equal(f.env.starts.length, 0);
  }
  // This separate default-policy evidence DOES NOT erase, replace or close the scoped allowlist falsifier above.
});
test('ISC-18 actual one-use grant consumed before final abort is conservatively lost, not refunded', async () => {
  const f = await realFixture(), command = 'git reset --hard HEAD', now = new Date();
  await writeFile(f.evaluatorEnv.DCG_ALLOW_ONCE_PATH, JSON.stringify({ schema_version: 1, source_short_code: 'fixture-abort', source_full_hash: 'fixture-abort-only', created_at: now.toISOString(), expires_at: new Date(now.getTime() + 3600000).toISOString(), scope_kind: 'cwd', scope_path: f.env.cwd, command_raw: command, command_redacted: command, reason: 'isolated conservative grant loss fixture', single_use: true, consumed_at: null, force_allow_config: false }) + '\n');
  // An executable transport recorder delegates ONLY stdin DATA to the pinned actual DCG binary, never a shell.
  // It publishes the real completed tuple and its PID so a real AbortSignal can stop final admission deterministically.
  const shim = join(f.dir, 'grant-evaluator'), pidFile = join(f.dir, 'grant-evaluator.pid'), receipt = join(f.dir, 'grant-before-abort.json');
  await writeFile(shim, '#!' + process.execPath + '\n' + `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); const input=[];for await(const b of process.stdin)input.push(b);const child=spawn(${JSON.stringify(f.binaryPath)},process.argv.slice(2),{cwd:process.cwd(),env:process.env,shell:false});const out=[],err=[];child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));child.stdin.end(Buffer.concat(input));const code=await new Promise(r=>child.on('close',r));writeFileSync(${JSON.stringify(receipt)},JSON.stringify({exit:code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()}));process.stdout.write(Buffer.concat(out));process.stderr.write(Buffer.concat(err));process.exitCode=code;\n`); await chmod(shim, 0o700);
  const controller = new AbortController(), getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!; let afterExit = false;
  Object.defineProperty(controller.signal, 'aborted', { get() { if (!getter.call(this) && existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 0); } catch (e: any) { if (e.code === 'ESRCH') { afterExit = true; controller.abort(); } } } return getter.call(this); } });
  const guard = createDcgGuard({ binaryPath: shim, evaluatorEnv: f.evaluatorEnv }), wrap = guard.wraps!.find(w => 'tool' in w)!; assert.ok('tool' in wrap); const a = apiFor(f.env, controller.signal);
  await assert.rejects(wrap.wrap(createBashTool()).execute({ command }, a.api, a.context), { message: 'DCG_UNAVAILABLE:aborted' }); assert.equal(afterExit, true); assert.equal(f.env.starts.length, 0);
  const evaluated = JSON.parse(await readFile(receipt, 'utf8')); assert.equal(evaluated.exit, 0); assert.equal(JSON.parse(evaluated.stdout).decision, 'allow');
  const remainingStore = (await readFile(f.evaluatorEnv.DCG_ALLOW_ONCE_PATH, 'utf8')).trim(); // Actual DCG may prune consumed single-use entries entirely.
  if (remainingStore !== '') assert.ok(JSON.parse(remainingStore).consumed_at, 'grant must not remain unconsumed');
  await writeFile(join(f.dir, 'grant-after-abort.json'), JSON.stringify({ afterExit, starts: f.env.starts.length, remainingStore }, null, 2));
  const subsequent = await robot(f, command, 'after-aborted-consumed-grant'); assert.equal(subsequent.json.decision, 'deny'); assert.equal(await guarded(f, command), 'DCG_DENIED'); assert.equal(f.env.starts.length, 0);
});
