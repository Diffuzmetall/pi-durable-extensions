import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createBashTool} from '@earendil-works/pi-durable/tools';
import {retained,Recorder,apiFor,ctx,createDcgGuard} from '../support.ts';
const pinned = '0012c40d26a6820657dcb650a0be7b9e174e603e9ae543cc7202bf7113206bf4';
export async function realFixture() {
  const binaryPath = process.env.DCG_TEST_BINARY; assert.ok(binaryPath && isAbsolute(binaryPath), 'DCG_TEST_BINARY absolute verified binary prerequisite missing');
  assert.equal(createHash('sha256').update(await readFile(binaryPath)).digest('hex'), pinned, 'wrong binary snapshot');
  const dir = await retained('real'); const policy = join(dir, 'policy.toml'), systemAllowlist = join(dir, 'system-allowlist.toml');
  await writeFile(policy, '# Isolated owner fixture: compiled defaults, no owner policy or grants.\n'); await writeFile(systemAllowlist, '# isolated empty system allowlist\n');
  const evaluatorEnv = { HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), XDG_STATE_HOME: join(dir, 'state'), XDG_CACHE_HOME: join(dir, 'cache'), DCG_CONFIG: policy, DCG_NO_UPDATE_CHECK: '1', LANG: 'C.UTF-8', DCG_ALLOWLIST_SYSTEM_PATH: systemAllowlist, DCG_ALLOW_ONCE_PATH: join(dir, 'allow-once.jsonl'), DCG_PENDING_EXCEPTIONS_PATH: join(dir, 'pending.jsonl') };
  await mkdir(evaluatorEnv.XDG_STATE_HOME); await mkdir(evaluatorEnv.XDG_CACHE_HOME);
  const env = new Recorder({ cwd: join(dir, 'cwd') });
  const guard = createDcgGuard({ binaryPath, evaluatorEnv }); const w = guard.wraps!.find(w => 'tool' in w)!; assert.ok('tool' in w);
  await writeFile(join(dir, 'provenance.json'), JSON.stringify({ binaryPath, binarySha256: pinned, evaluatorEnv, node: process.version, policySha256: createHash('sha256').update(await readFile(policy)).digest('hex'), source: 'DCG v0.15.3 3eec165ae64a56bfbb2cecaa2510d82076010851; public robot schema 1; default compiled packs, unknown/medium profile' }, null, 2));
  return { dir, env, binaryPath, evaluatorEnv, wrapped: w.wrap(createBashTool()) };
}
export async function robot(f: Awaited<ReturnType<typeof realFixture>>, command: string, label: string, cwd = f.env.cwd, overrides = {}) {
  const child = spawn(f.binaryPath, ['--robot', 'test', '--dialect', 'posix', '--enforce-budget', '--stdin'], { cwd, env: { ...f.evaluatorEnv, ...overrides }, shell: false });
  const stdout: Buffer[] = [], stderr: Buffer[] = []; child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
  let error: unknown; child.on('error', e => { error = String(e); }); child.stdin.on('error', e => { error = String(e); });
  child.stdin.end(command === '' ? '' : command + '\r\n'); const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [exit, signal] = await new Promise<[number | null, string | null]>(r => child.on('close', (code, signal) => r([code, signal]))); clearTimeout(timer);
  const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString();
  const record = { label, binarySha256: pinned, command, frame: command === '' ? '' : command + '\r\n', cwd, exit, signal, stdout: out, stderr: err, error: error ?? null };
  await writeFile(join(f.dir, label + '.json'), JSON.stringify(record, null, 2)); assert.equal(error, undefined); assert.equal(signal, null);
  return { ...record, json: out === '' ? undefined : JSON.parse(out) };
}
export async function guarded(f: Awaited<ReturnType<typeof realFixture>>, command: string) {
  const a = apiFor(f.env); try { await f.wrapped.execute({ command }, a.api, ctx); return undefined; } catch (e) { return (e as Error).message; }
}
