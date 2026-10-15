import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { ok } from '@earendil-works/pi-durable/env';
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { ShellExecOptions } from '@earendil-works/pi-durable/env';
import { createDcgGuard } from '../dist/index.js';
export { ctx, createDcgGuard };
export const workRoot = fileURLToPath(new URL('../../../work/dcg-tests/', import.meta.url));
export async function retained(label: string) {
  await mkdir(workRoot, { recursive: true });
  const dir = await mkdtemp(join(workRoot, label + '-'));
  await Promise.all(['home', 'config', 'data', 'cwd', 'other'].map(p => mkdir(join(dir, p))));
  console.log(JSON.stringify({ retained: dir }));
  return dir;
}
export type Start = { command: string | readonly string[]; options: ShellExecOptions | undefined; context: Context };
// Admitted default Node construction, with ONLY an inert exec recording operation.
// This fixture never delegates, even if guard selection is absent or completely broken.
export class Recorder extends NodeExecutionEnv {
  #token = 'original-receiver';
  starts: Start[] = [];
  get token() { return this.#token; }
  originalReceiver() { return this.#token; }
  async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context) {
    assert.equal(this.#token, 'original-receiver');
    this.starts.push({ command, options, context });
    options?.onOutput?.('recorded\n', context, { stream: 'stdout' });
    return ok({ exitCode: 0 });
  }
}
export function apiFor(env: unknown, signal?: AbortSignal) {
  const output: string[] = [], diagnostics: unknown[] = [];
  const api = { env, output(chunk: string | Uint8Array) { output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); },
    diagnostic(d: unknown) { diagnostics.push(d); }, outputWindow: undefined,
    retainedOutput() { return { text: output.join(""), truncated: false }; },
  } as unknown as ToolExecutionApi;
  return { api, output, diagnostics, context: signal ? { ...ctx, abortSignal: signal } : ctx };
}
export async function fixture(config: Record<string, unknown> = {}) {
  const dir = await retained('wire');
  const log = join(dir, 'evaluations.jsonl'), pids = join(dir, 'pids.txt');
  const configPath = join(dir, 'fixture.json');
  await writeFile(configPath, JSON.stringify({ ...config, log, pids }));
  // Absolute node shebang avoids PATH lookup in the complete isolated child environment.
  const script = await readFile(new URL('./fixtures/evaluator.mjs', import.meta.url), 'utf8');
  const binaryPath = join(dir, 'evaluator');
  await writeFile(binaryPath, script.replace('#!/usr/bin/env node', '#!' + process.execPath));
  await chmod(binaryPath, 0o700);
  const evaluatorEnv = { HOME: join(dir, 'home'), XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data'), DCG_FIXTURE_OPTIONS: configPath };
  const options = { binaryPath, evaluatorEnv };
  const guard = createDcgGuard(options);
  const env = new Recorder({ cwd: join(dir, 'cwd') });
  return { dir, options, guard, env, log, pids,
    wrap(tool: ToolRegistration) { const w = guard.wraps?.find(w => 'tool' in w && w.tool === 'bash'); assert.ok(w && 'tool' in w); return w.wrap(tool); },
    async records() { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(s => JSON.parse(s)); } catch (e: any) { if (e.code === 'ENOENT') return []; throw e; } },
  };
}
export async function invoke(f: Awaited<ReturnType<typeof fixture>>, tool: ToolRegistration, command: string, env: unknown = f.env, signal?: AbortSignal) {
  const a = apiFor(env, signal);
  try { const result = await f.wrap(tool).execute({ command }, a.api, a.context); return { ...a, result, error: undefined }; }
  catch (error) { return { ...a, result: undefined, error: String((error as Error).message) }; }
}
export function assertRefusal(result: { error?: string }, expected: string, env: Recorder) { assert.equal(result.error, expected); assert.equal(env.starts.length, 0); }
export async function waitForFile(path: string, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { return await readFile(path, 'utf8'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; } await new Promise(r => setTimeout(r, 10)); }
  throw new Error('fixture barrier not reached');
}
export async function running(pid: number) {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return !/\) [ZX] /.test(stat); } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; }
}
