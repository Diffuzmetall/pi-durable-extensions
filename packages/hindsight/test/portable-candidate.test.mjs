import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createModels } from '@earendil-works/pi-ai/models';
import install, { HINDSIGHT_CONTROLLER as controllerKey } from '../src/adapter.mjs';
import { assertPrivateFsCapabilities, ensurePrivateDirectory, ensurePrivateFile, privateLimits, privateModes, readPrivateFile, writePrivateFileExclusive } from '../src/private-fs.mjs';

const root = new URL('../src/', import.meta.url);
const rootPath = root.pathname;
const forbidden = /(?:pi-pocket|PocketHost|dataDir|\/home\/ubuntu\/Projects\/pi-pocket)/i;

async function sourceFiles(directory) {
  const result = [];
  for (const name of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, name.name);
    if (name.isDirectory()) result.push(...await sourceFiles(path));
    else if (/\.(?:mjs|js)$/.test(name.name)) result.push(path);
  }
  return result;
}

test('import guard positive control rejects a Pocket fixture', () => {
  assert.equal(forbidden.test("import '/workspace/pi-pocket/src/server/index.mjs'"), true);
});

test('portable source has no Pocket/workspace runtime imports', async () => {
  const files = await sourceFiles(rootPath);
  const hits = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (forbidden.test(text)) hits.push(file.replace(rootPath, 'src/'));
  }
  assert.deepEqual(hits, []);
});

test('private host paths and cache files stay private under umask 022', async () => {
  const previousUmask = process.umask(0o022);
  const directory = await mkdtemp(join(tmpdir(), 'hindsight-private-fixture-'));
  const savedEnvironment = Object.fromEntries(['HINDSIGHT_LOG_FILE', 'HINDSIGHT_DIAG_FILE', 'HINDSIGHT_USAGE_FILE'].map(key => [key, process.env[key]]));
  for (const key of Object.keys(savedEnvironment)) delete process.env[key];
  try {
    const createdDirectory = join(directory, 'created');
    await ensurePrivateDirectory(createdDirectory);
    assert.equal((await stat(createdDirectory)).mode & 0o777, privateModes.directory);
    const cache = join(createdDirectory, 'cache-entry');
    await writePrivateFileExclusive(cache, '{"private":true}');
    assert.equal((await stat(cache)).mode & 0o777, privateModes.file);
    assert.equal((await lstat(cache)).isSymbolicLink(), false);

    const registry = await install(createRegistry());
    const controller = registry.snapshot().extension('hindsight')?.[controllerKey];
    const storage = await openNodeSqliteStorage(join(createdDirectory, 'session.sqlite'));
    const session = await Harness.open(storage, { models: createModels(), registry }, context);
    try {
      await controller.bind({ session, storage, directory: createdDirectory, context });
      for (const key of ['HINDSIGHT_LOG_FILE', 'HINDSIGHT_DIAG_FILE', 'HINDSIGHT_USAGE_FILE']) {
        assert.equal((await stat(process.env[key])).mode & 0o777, privateModes.file, key);
      }
    } finally {
      await controller.close();
      await session.close(context);
    }

    const insecureDirectory = join(directory, 'insecure-directory');
    await mkdir(insecureDirectory, { mode: 0o755 });
    await assert.rejects(ensurePrivateDirectory(insecureDirectory), /insecure mode/);
    const hostileDirectory = join(directory, 'hostile-directory');
    await symlink(createdDirectory, hostileDirectory);
    await assert.rejects(ensurePrivateDirectory(hostileDirectory), /symlink|not a directory/);
    const insecureFile = join(directory, 'insecure-file');
    await writeFile(insecureFile, 'existing', { mode: 0o644 });
    await assert.rejects(ensurePrivateFile(insecureFile), /insecure mode/);
    const hostileFile = join(directory, 'hostile-file');
    await symlink(cache, hostileFile);
    await assert.rejects(writePrivateFileExclusive(hostileFile, 'must not follow'), /symlink|EEXIST|private/);
  } finally {
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.umask(previousUmask);
  }
});

test('private cache reads reject replaced symlinks, oversize content, and unsupported trust-boundary capabilities', async () => {
  const helperSource = await readFile(new URL('../src/private-fs.mjs', import.meta.url), 'utf8');
  assert.equal(helperSource.includes('handle.readFile'), false);
  assert.match(helperSource, /Buffer\.alloc\(maxBytes \+ 1\)/);
  const directory = await mkdtemp(join(tmpdir(), 'hindsight-cache-read-fixture-'));
  const cache = join(directory, 'cache-entry');
  const moved = join(directory, 'cache-entry-moved');
  await writePrivateFileExclusive(cache, '{"cache":true}');
  assert.equal(await readPrivateFile(cache, { maxBytes: privateLimits.cacheBytes }), '{"cache":true}');
  await rename(cache, moved);
  await symlink(moved, cache);
  await assert.rejects(readPrivateFile(cache, { maxBytes: privateLimits.cacheBytes }), /symlink|ELOOP|private/);

  const oversized = join(directory, 'oversized');
  await writePrivateFileExclusive(oversized, '12345');
  await assert.rejects(readPrivateFile(oversized, { maxBytes: 4 }), /maximum size/);

  assert.doesNotThrow(() => assertPrivateFsCapabilities());
  assert.throws(() => assertPrivateFsCapabilities({ platform: 'linux', hasGetuid: false, hasNoFollow: true }), /requires Linux/);
  assert.throws(() => assertPrivateFsCapabilities({ platform: 'darwin', hasGetuid: true, hasNoFollow: true }), /requires Linux/);
});

test('source-owned package has the required explicit exports', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './bridge', './controller', './delivery', './extension', './lifecycle']);
  assert.equal(manifest.engines.node, '>=24');
  assert.equal(manifest.peerDependencies['@earendil-works/pi-durable'], '1.0.2');
  assert.equal(manifest.peerDependencies['@earendil-works/chord'], '1.0.2');
});
