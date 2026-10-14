import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBashTool } from '@earendil-works/pi-durable/tools';
import { fixture, apiFor, ctx } from './support.ts';
test('ISC-8 retained symlink+dotdot cwd uses identical lexical absolute path for evaluator AND actual harmless Node pwd', async () => {
  const f = await fixture(); const base = join(f.dir, 'base'), target = join(f.dir, 'target'), nested = join(target, 'nested'); await mkdir(base); await mkdir(nested, { recursive: true }); await symlink(nested, join(base, 'link'), 'dir');
  const raw = base + '/link/..', normalized = resolve(raw);
  const probe = spawn(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: raw, shell: false }); const probeOutput: Buffer[] = []; probe.stdout.on('data', b => probeOutput.push(b)); const controlExit = await new Promise(r => probe.on('close', r)); assert.equal(controlExit, 0); const osRawActualCwd = Buffer.concat(probeOutput).toString(); assert.equal(osRawActualCwd, target); assert.notEqual(osRawActualCwd, normalized);
  const forwarded: string[] = [];
  class HarmlessPwdEnvironment extends NodeExecutionEnv {
    async exec(command: string | readonly string[], options: any, context: any) {
      // Hard assertion independently forbids any destructive DATA from reaching this real shell fixture.
      assert.equal(command, 'pwd -P'); forwarded.push(options.cwd); return super.exec(command, options, context);
    }
  }
  const env = new HarmlessPwdEnvironment({ cwd: f.env.cwd }), a = apiFor(env);
  const result = await f.wrap(createBashTool({ prepare(execution) { execution.cwd = raw; } })).execute({ command: 'pwd -P' }, a.api, ctx);
  const evaluations = await f.records(), actualPwd = a.output.join('').trim();
  await writeFile(join(f.dir, 'cwd-regression.json'), JSON.stringify({ raw, lexicalExpected: normalized, osRawActualCwd, evaluatorActualCwd: evaluations[0]?.cwd, forwardedCwd: forwarded[0], actualPwd, result }, null, 2));
  assert.equal(evaluations[0].cwd, normalized); assert.equal(forwarded[0], normalized); assert.equal(actualPwd, normalized); assert.equal(evaluations.length, 1); assert.equal(forwarded.length, 1);
});
