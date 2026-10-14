#!/usr/bin/env node
// Executable wire fixture. Commands are stdin DATA; this file never starts a shell.
import { readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = JSON.parse(readFileSync(process.env.DCG_FIXTURE_OPTIONS, 'utf8'));
if (process.argv.includes('--descendant')) {
  process.on('SIGTERM', () => {});
  appendFileSync(config.pids, `${process.pid}\n`);
  setInterval(() => {}, 1000);
} else {
  if (config.pids) appendFileSync(config.pids, `${process.pid}\n`);
  if (config.kind === 'stdin-close') { process.stdin.destroy(); process.exit(1); }
  if (config.kind === 'hang' || config.kind === 'descendant' || config.kind === 'descendant-closed') {
    process.on('SIGTERM', () => {});
    if (config.kind.startsWith('descendant')) {
      spawn(process.execPath, [process.argv[1], '--descendant'], { env: process.env, stdio: config.kind === 'descendant-closed' ? 'ignore' : ['ignore', 1, 2] });
      setTimeout(() => { if (config.kind === 'descendant-closed') process.stdout.write('{}'); process.exit(0); }, 100);
    } else setInterval(() => {}, 1000);
  } else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const frame = Buffer.concat(chunks);
    const command = frame.toString('utf8').replace(/\r?\n$/, '');
    if (config.log) appendFileSync(config.log, JSON.stringify({ argv: process.argv.slice(2), command, frameHex: frame.toString('hex'), cwd: process.cwd(), env: process.env, pid: process.pid }) + '\n');
    if (config.delay) await new Promise(r => setTimeout(r, config.delay));
    if (config.kind === 'signal') process.kill(process.pid, 'SIGTERM');
    else if (config.kind === 'quiet') { process.stderr.write('PRIVATE_SENTINEL stderr'); process.exitCode = 1; }
    else if (config.kind === 'stdout-overflow') process.stdout.write(Buffer.alloc(1048577, 32));
    else if (config.kind === 'stderr-overflow') process.stderr.write(Buffer.alloc(65537, 32));
    else if (config.kind === 'invalid-utf8') process.stdout.write(Buffer.from([0xff]));
    else if (config.kind === 'raw') { process.stdout.write(config.raw); process.exitCode = config.exit ?? 0; }
    else {
      const denied = config.deny === true || command.includes('rm -rf') || command.includes('git reset --hard');
      let output = { schema_version: 1, dcg_version: '0.15.3', robot_mode: true, command, decision: denied ? 'deny' : 'allow', ...(denied ? { mode: 'deny' } : {}) };
      if (config.base) output = { ...config.base, command };
      Object.assign(output, config.patch ?? {});
      for (const key of config.omit ?? []) delete output[key];
      process.stdout.write(JSON.stringify(output));
      process.exitCode = config.exit ?? (denied ? 1 : 0);
    }
  }
}
