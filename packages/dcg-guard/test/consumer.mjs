import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, copyFile, realpath, writeFile, lstat } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = process.env.DCG_TEST_CONSUMER_ROOT, archive = process.env.DCG_TEST_ARCHIVE, binary = process.env.DCG_TEST_BINARY;
assert.ok(root && isAbsolute(root), 'DCG_TEST_CONSUMER_ROOT prerequisite missing'); assert.ok(archive && isAbsolute(archive), 'DCG_TEST_ARCHIVE prerequisite missing'); assert.ok(binary && isAbsolute(binary), 'DCG_TEST_BINARY prerequisite missing');
assert.ok(!(await realpath(root)).startsWith(fileURLToPath(new URL('../../../', import.meta.url))), 'clean consumer must be outside workspace');
const evidenceRoot = fileURLToPath(new URL('../../../work/dcg-tests/', import.meta.url)); await mkdir(evidenceRoot, { recursive: true }); const evidence = await mkdtemp(join(evidenceRoot, 'consumer-'));
const bytes = await readFile(archive); const archiveSha256 = createHash('sha256').update(bytes).digest('hex');
async function command(program, args, env = process.env) {
  const child = spawn(program, args, { cwd: root, env, shell: false }); const out = [], err = []; child.stdout.on('data', b => out.push(b)); child.stderr.on('data', b => err.push(b)); let error; child.on('error', e => error = String(e));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000); const exit = await new Promise(r => child.on('close', r)); clearTimeout(timer);
  return { exit, error: error ?? null, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
}
const members = await command('tar', ['-tzf', archive]); assert.equal(members.exit, 0); assert.ok(members.stdout.includes('package/dist/index.js')); assert.ok(!members.stdout.split('\n').some(p => p.startsWith('/') || p.includes('..') || /package\/(src|test|node_modules)\//.test(p)));
const archived = await command('tar', ['-xOzf', archive, 'package/dist/index.js']); assert.equal(archived.exit, 0); assert.equal(archived.stdout, await readFile(new URL('../dist/index.js', import.meta.url), 'utf8'), 'consumer archive must match current package-built dist');
const installedPath = join(root, 'node_modules/@pi-pocket/dcg-guard/dist/index.js'); assert.equal(await realpath(installedPath), installedPath); assert.equal(await readFile(installedPath, 'utf8'), archived.stdout, 'installed code differs from exact archive');
// Package lane provisions this NEW file reservation and hands it off; no installation here.
const driver = join(root, '.dcg-consumer-driver-' + basename(evidence) + '.mjs'); assert.equal((await lstat(root)).isDirectory(), true);
await copyFile(new URL('./consumer-driver.mjs', import.meta.url), driver);
const result = await command(process.execPath, [driver, root, evidence], { ...process.env, DCG_TEST_BINARY: binary });
await writeFile(join(evidence, 'acceptance.json'), JSON.stringify({ root, archive, archiveSha256, members: members.stdout, codeSha256: createHash('sha256').update(archived.stdout).digest('hex'), ...result }, null, 2));
console.log(JSON.stringify({ retained: evidence, archiveSha256, ...result })); assert.equal(result.error, null); assert.equal(result.exit, 0, 'clean-consumer public driver failed');
