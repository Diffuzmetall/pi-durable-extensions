import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'index.mjs');
const DEFAULT_CATALOG = path.join(ROOT, 'catalog.json');
const TEST_ROOT = await mkdtemp(path.join(ROOT, 'retained-test-'));
const MAX_DECOMPRESSED_TAR_BYTES = 16 * 1024 * 1024;
const MAX_MEMBER_BYTES = 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 1024;
const CANONICAL_HINDSIGHT_ARTIFACT_SHA256 = '4ce1fc0d192530ccbaa42ffd05c3bac21d4f9b8d81179960b6fb05f121043443';
const CANONICAL_HINDSIGHT_MEMBER_PATH = 'package/src/vendor/mcp-server.js';
const CANONICAL_HINDSIGHT_MEMBER_BYTES = 1242386;
const CANONICAL_HINDSIGHT_MEMBER_SHA256 = 'c1adb47de2972bbb4a708fc209dc4e1dbfc7fa53afc6666b133865f24ac9f03d';

async function fixture(status = 'stable', manifest = {}) {
  const root = await mkdtemp(path.join(TEST_ROOT, 'fixture-'));
  const pkg = path.join(root, 'package');
  await mkdir(pkg);
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'synthetic-extension', version: '1.2.3', scripts: { install: 'node -e "require(\'fs\').writeFileSync(\'lifecycle-ran\',\'bad\')"' },
    ...manifest,
  }));
  await writeFile(path.join(pkg, 'index.js'), 'export const fixture = true;\n');
  const artifact = path.join(root, 'synthetic.tgz');
  execFileSync('tar', ['-czf', artifact, '-C', root, 'package']);
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({
    schemaVersion: 1,
    runtime: { node: '>=24.19.0', piDurable: '1.1.0' },
    components: [{
      id: 'codemode', version: '1.2.3', status, kind: 'extension', description: 'fixture',
      testedRuntime: { node: '>=24.19.0', piDurable: '1.1.0' },
      artifact: { path: 'synthetic.tgz', sha256: digest },
      requirements: { auth: 'none', services: [], activation: 'manual' },
    }],
  }, null, 2));
  return { root, catalog, artifact, digest };
}

async function canonicalCodexFixture() {
  const bundle = process.env.PPC_U6_BUNDLE;
  if (!bundle) return null;
  const root = await mkdtemp(path.join(TEST_ROOT, 'canonical-codex-'));
  const artifact = path.join(root, 'codex-api.tgz');
  const sourceArtifact = path.join(bundle, 'artifacts', 'pi-durable-codex-api-candidate-0.1.0-candidate.tgz');
  await writeFile(artifact, await readFile(sourceArtifact), { flag: 'wx', mode: 0o600 });
  const sourceCatalog = JSON.parse(await readFile(DEFAULT_CATALOG, 'utf8'));
  const entry = sourceCatalog.components.find((item) => item.id === 'codex-api');
  assert.ok(entry);
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({ ...sourceCatalog, components: [{ ...entry, artifact: { ...entry.artifact, path: 'codex-api.tgz' } }] }, null, 2), { flag: 'wx', mode: 0o600 });
  return { root, artifact, catalog, entry };
}

async function auditManager(root, body) {
  return managerScript(root, `import { existsSync, mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; ${body}`);
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function runWithOccupiedFd3(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
}

function jsonOutput(result) { return JSON.parse(result.stdout || result.stderr); }

function tarHeader(name, size = 0, type = '0') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header[156] = type.charCodeAt(0);
  return header;
}

async function hostileFixture(archive) {
  const root = await mkdtemp(path.join(TEST_ROOT, 'hostile-'));
  const artifact = path.join(root, 'hostile.tgz');
  await writeFile(artifact, archive);
  const digest = createHash('sha256').update(archive).digest('hex');
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({
    schemaVersion: 1,
    runtime: { node: '>=24.19.0', piDurable: '1.1.0' },
    components: [{
      id: 'codemode', version: '1.2.3', status: 'stable', kind: 'extension', description: 'hostile fixture',
      testedRuntime: { node: '>=24.19.0', piDurable: '1.1.0' },
      artifact: { path: 'hostile.tgz', sha256: digest },
      requirements: { auth: 'none', services: [], activation: 'manual' },
    }],
  }, null, 2));
  return { root, catalog };
}

function singleMemberArchive(name, data, type = '0') {
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return gzipSync(Buffer.concat([tarHeader(name, data.length, type), data, padding, Buffer.alloc(1024)]));
}

async function canonicalHindsightFixture() {
  const source = process.env.PORTABLE_HINDSIGHT_ARTIFACT;
  assert.ok(source, 'PORTABLE_HINDSIGHT_ARTIFACT is required for canonical Hindsight regression');
  const bytes = await readFile(source);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), CANONICAL_HINDSIGHT_ARTIFACT_SHA256);
  const root = await mkdtemp(path.join(TEST_ROOT, 'canonical-hindsight-'));
  const artifact = path.join(root, 'hindsight.tgz');
  await writeFile(artifact, bytes, { flag: 'wx' });
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({
    schemaVersion: 1,
    runtime: { node: '>=24.19.0', piDurable: '1.0.2' },
    components: [{
      id: 'hindsight', version: '0.1.0', status: 'stable', kind: 'adapter', description: 'canonical Hindsight regression',
      testedRuntime: { node: '>=24', piDurable: '1.0.2' },
      artifact: { path: 'hindsight.tgz', sha256: CANONICAL_HINDSIGHT_ARTIFACT_SHA256 },
      requirements: { auth: 'none', services: [], activation: 'manual' },
    }],
  }, null, 2), { flag: 'wx' });
  return { root, catalog, artifact };
}

async function syntheticOversizeFixture({ name, memberPath, size = CANONICAL_HINDSIGHT_MEMBER_BYTES, fill = 0x61 }) {
  const root = await mkdtemp(path.join(TEST_ROOT, `${name}-`));
  const artifact = path.join(root, 'oversize.tgz');
  const archive = singleMemberArchive(memberPath, Buffer.alloc(size, fill));
  await writeFile(artifact, archive, { flag: 'wx' });
  const digest = createHash('sha256').update(archive).digest('hex');
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({
    schemaVersion: 1,
    runtime: { node: '>=24.19.0', piDurable: '1.0.2' },
    components: [{
      id: 'hindsight', version: '0.1.0', status: 'stable', kind: 'adapter', description: name,
      testedRuntime: { node: '>=24', piDurable: '1.0.2' },
      artifact: { path: 'oversize.tgz', sha256: digest },
      requirements: { auth: 'none', services: [], activation: 'manual' },
    }],
  }, null, 2), { flag: 'wx' });
  return { root, catalog, artifact };
}

async function binFixture() {
  const root = await mkdtemp(path.join(TEST_ROOT, 'npm-bin-'));
  const pkg = path.join(root, 'package');
  const vendor = path.join(pkg, 'vendor');
  const depSource = path.join(root, 'tiny-bin-source', 'package');
  const devSource = path.join(root, 'dev-only-source', 'package');
  await mkdir(vendor, { recursive: true });
  await mkdir(path.join(depSource, 'bin'), { recursive: true });
  await mkdir(devSource, { recursive: true });
  await writeFile(path.join(depSource, 'package.json'), JSON.stringify({ name: 'tiny-bin-dependency', version: '1.0.0', bin: { 'tiny-bin': 'bin/cli.js' } }));
  await writeFile(path.join(depSource, 'bin', 'cli.js'), '#!/usr/bin/env node\nconsole.log("tiny");\n');
  await writeFile(path.join(devSource, 'package.json'), JSON.stringify({ name: 'dev-only-dependency', version: '1.0.0' }));
  const depTar = path.join(vendor, 'tiny-bin-dependency.tgz');
  const devTar = path.join(vendor, 'dev-only-dependency.tgz');
  execFileSync('tar', ['-czf', depTar, '-C', path.dirname(depSource), 'package']);
  execFileSync('tar', ['-czf', devTar, '-C', path.dirname(devSource), 'package']);
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'npm-bin-fixture', version: '1.2.3',
    dependencies: { 'tiny-bin-dependency': 'file:vendor/tiny-bin-dependency.tgz' },
    devDependencies: { 'dev-only-dependency': 'file:vendor/dev-only-dependency.tgz' },
    allowScripts: ['tiny-bin-dependency', 'dev-only-dependency'],
  }));
  await writeFile(path.join(pkg, 'index.js'), 'export const fixture = true;\n');
  const artifact = path.join(root, 'npm-bin-fixture.tgz');
  execFileSync('tar', ['-czf', artifact, '-C', root, 'package']);
  const digest = createHash('sha256').update(await readFile(artifact)).digest('hex');
  const catalog = path.join(root, 'catalog.json');
  await writeFile(catalog, JSON.stringify({
    schemaVersion: 1,
    runtime: { node: '>=24.19.0', piDurable: '1.1.0' },
    components: [{
      id: 'codemode', version: '1.2.3', status: 'stable', kind: 'extension', description: 'offline npm bin fixture',
      testedRuntime: { node: '>=24.19.0', piDurable: '1.1.0' },
      artifact: { path: 'npm-bin-fixture.tgz', sha256: digest },
      requirements: { auth: 'none', services: [], activation: 'manual' },
    }],
  }, null, 2));
  return { root, pkg, catalog };
}

async function managerScript(root, body) {
  const file = path.join(root, `manager-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(file, `#!/usr/bin/env node\n${body}\n`);
  await chmod(file, 0o700);
  return file;
}

test('active catalog has ten entries, preserves Context7, and pins the seven-file DCG candidate', async () => {
  const catalog = JSON.parse(await readFile(DEFAULT_CATALOG, 'utf8'));
  assert.equal(catalog.components.length, 10);
  assert.equal(catalog.components.some((entry) => entry.id === 'context7'), true);
  assert.equal(catalog.components.some((entry) => entry.id === 'dcg-guard'), true);
  assert.deepEqual(catalog.deferred, []);
  const listed = run(['list', '--catalog', DEFAULT_CATALOG, '--allow-experimental', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 10);
  assert.equal(JSON.parse(listed.stdout).some((entry) => entry.id === 'context7'), true);
  assert.equal(JSON.parse(listed.stdout).some((entry) => entry.id === 'dcg-guard'), true);
  const info = run(['info', 'context7', '--catalog', DEFAULT_CATALOG, '--json']);
  assert.equal(info.status, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).version, '0.1.0-candidate.1');
  const dcg = run(['info', 'dcg-guard', '--catalog', DEFAULT_CATALOG, '--json']);
  assert.equal(dcg.status, 0, dcg.stderr);
  assert.equal(JSON.parse(dcg.stdout).package, '@pi-pocket/dcg-guard');
  assert.equal(JSON.parse(dcg.stdout).version, '0.1.0');
  assert.equal(JSON.parse(dcg.stdout).status, 'candidate');
  assert.equal(JSON.parse(dcg.stdout).artifact.sha256, 'e8f98754876383f425e42e95cb6bc9fc889f78e57d77544eeb1eeeba6a7bfe5b');
  assert.equal(JSON.parse(dcg.stdout).artifact.entries, 7);
  assert.deepEqual(JSON.parse(dcg.stdout).testedRuntime, { node: '>=24.19.0', piDurable: '1.1.0' });
  const missingTarget = run(['install', 'dcg-guard', '--catalog', DEFAULT_CATALOG, '--version', '0.1.0', '--allow-experimental', '--json']);
  assert.notEqual(missingTarget.status, 0);
  assert.equal(jsonOutput(missingTarget).error, 'target');
});

test('excluded builtins are rejected from synthetic catalogs', async () => {
  const fixtureData = await fixture('experimental');
  const catalog = JSON.parse(await readFile(fixtureData.catalog, 'utf8'));
  for (const id of ['pi-durable-beads', 'lancet', 'goals', 'schedules', 'triggers']) {
    const excludedCatalog = path.join(fixtureData.root, `${id}.json`);
    catalog.components[0].id = id;
    await writeFile(excludedCatalog, JSON.stringify(catalog));
    const result = run(['list', '--catalog', excludedCatalog, '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid or excluded component id/);
    catalog.components[0].id = 'codemode';
  }
});

test('list and info keep experimental opt-in explicit', async () => {
  const fixtureData = await fixture('experimental');
  const hidden = run(['list', '--catalog', fixtureData.catalog, '--json']);
  assert.deepEqual(JSON.parse(hidden.stdout), []);
  const shown = run(['list', '--catalog', fixtureData.catalog, '--allow-experimental', '--json']);
  assert.equal(JSON.parse(shown.stdout)[0].id, 'codemode');
  const info = run(['info', 'codemode', '--catalog', fixtureData.catalog, '--json']);
  assert.equal(JSON.parse(info.stdout).version, '1.2.3');
  const unknown = run(['info', 'not-cataloged', '--catalog', fixtureData.catalog, '--json']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown component/);
});

test('dry-run validates digest without writing or running npm', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'new-target');
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--dry-run', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).action, 'install');
  await assert.rejects(readFile(target));
  assert.equal((await readdir(fixtureData.root)).filter((name) => name.includes('.staging-')).length, 0);
});

test('install suppresses lifecycle scripts, publishes, and repeats as a no-op', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'target');
  const installed = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--json']);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).action, 'installed');
  assert.equal((await readFile(path.join(target, 'index.js'), 'utf8')).trim(), 'export const fixture = true;');
  await assert.rejects(readFile(path.join(target, 'lifecycle-ran')));
  const repeat = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--json']);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).action, 'noop');
  await writeFile(path.join(target, 'foreign.txt'), 'do not clobber');
  const markedCollision = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3']);
  assert.notEqual(markedCollision.status, 0);
  assert.match(markedCollision.stderr, /target already exists/);
  assert.equal(await readFile(path.join(target, 'foreign.txt'), 'utf8'), 'do not clobber');
});

test('integrity, foreign targets, symlinks, invalid ids, and package-manager failures are safe', async () => {
  const fixtureData = await fixture();
  const tampered = path.join(fixtureData.root, 'tampered.tgz');
  await writeFile(tampered, 'not the pinned artifact');
  const tamperedCatalog = path.join(fixtureData.root, 'tampered-catalog.json');
  const catalog = JSON.parse(await readFile(fixtureData.catalog, 'utf8'));
  catalog.components[0].artifact.path = 'tampered.tgz';
  await writeFile(tamperedCatalog, JSON.stringify(catalog));
  const badHash = run(['install', 'codemode', '--catalog', tamperedCatalog, '--target', path.join(fixtureData.root, 'bad'), '--version', '1.2.3']);
  assert.notEqual(badHash.status, 0);
  assert.match(badHash.stderr, /integrity mismatch/);

  const foreign = path.join(fixtureData.root, 'foreign');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'keep.txt'), 'keep');
  const collision = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', foreign, '--version', '1.2.3']);
  assert.notEqual(collision.status, 0);
  assert.equal(await readFile(path.join(foreign, 'keep.txt'), 'utf8'), 'keep');

  const linkTarget = path.join(fixtureData.root, 'link-target');
  await symlink(foreign, linkTarget);
  const linkResult = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', linkTarget, '--version', '1.2.3']);
  assert.notEqual(linkResult.status, 0);
  assert.match(linkResult.stderr, /symlink/);

  const invalid = run(['install', '../codemode', '--catalog', fixtureData.catalog, '--target', path.join(fixtureData.root, 'invalid'), '--version', '1.2.3']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid component id/);

  const hugeMarkerTarget = path.join(fixtureData.root, 'huge-marker-target');
  await mkdir(hugeMarkerTarget);
  const hugeMarker = Buffer.alloc(4 * 1024 * 1024 + 1, 0x7b);
  await writeFile(path.join(hugeMarkerTarget, '.portable-install.json'), hugeMarker);
  const hugeMarkerResult = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', hugeMarkerTarget, '--version', '1.2.3']);
  assert.notEqual(hugeMarkerResult.status, 0);
  assert.match(hugeMarkerResult.stderr, /byte limit/);
  assert.equal((await readFile(path.join(hugeMarkerTarget, '.portable-install.json'))).length, hugeMarker.length);

  const failedTarget = path.join(fixtureData.root, 'failed-target');
  const manager = await managerScript(fixtureData.root, 'process.exit(17);');
  const failed = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', failedTarget, '--version', '1.2.3', '--package-manager', manager]);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /retained staging/);
  await assert.rejects(readFile(failedTarget));
  assert.ok((await readdir(fixtureData.root)).some((name) => name.includes('.staging-')));
});

test('installer passes only dependency flags and does not launch a service', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'safe-target');
  const auditFile = path.join(fixtureData.root, 'manager-audit.json');
  const manager = await managerScript(fixtureData.root, "import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(process.env.PPC_AUDIT_FILE, JSON.stringify({ args: process.argv.slice(2), targetExists: existsSync(process.env.PPC_INSTALL_TARGET), cwd: process.cwd(), cache: process.env.npm_config_cache }));");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager], { PPC_AUDIT_FILE: auditFile });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(await readFile(auditFile, 'utf8'));
  assert.equal(audit.targetExists, false);
  assert.ok(audit.args.includes('--ignore-scripts'));
  assert.ok(audit.args.includes('--no-save'));
  assert.ok(audit.args.includes('--package-lock=false'));
  assert.ok(audit.args.includes('--workspaces=false'));
  assert.ok(audit.args.includes('--bin-links=false'));
  assert.ok(audit.args.includes('--omit=dev'));
  assert.equal(audit.args.some((arg) => /^(start|restart|run)$/.test(arg)), false);
  assert.equal(await readFile(path.join(target, 'index.js'), 'utf8'), 'export const fixture = true;\n');
});

test('canonical Codex peer materialization uses only validated specs and scrubbed manager environment', async () => {
  const fixtureData = await canonicalCodexFixture();
  if (!fixtureData) return;
  const target = path.join(fixtureData.root, 'target');
  const auditFile = path.join(fixtureData.root, 'manager-audit.json');
  const manager = await auditManager(fixtureData.root, "const prefix = process.argv[process.argv.indexOf('--prefix') + 1]; mkdirSync(join(prefix, 'node_modules'), { recursive: true }); writeFileSync(process.env.PPC_AUDIT_FILE, JSON.stringify({ args: process.argv.slice(2), targetExists: existsSync(process.env.PPC_INSTALL_TARGET), cwd: process.cwd(), cache: process.env.npm_config_cache, userconfig: process.env.npm_config_userconfig, globalconfig: process.env.npm_config_globalconfig, nodePath: process.env.NODE_PATH ?? null, token: process.env.NPM_TOKEN ?? null, authToken: process.env.NODE_AUTH_TOKEN ?? null }));");
  const result = run(['install', 'codex-api', '--catalog', fixtureData.catalog, '--target', target, '--version', fixtureData.entry.version, '--allow-experimental', '--package-manager', manager], {
    PPC_AUDIT_FILE: auditFile,
    NODE_PATH: '/tmp/untrusted-node-path',
    NPM_TOKEN: 'must-not-reach-manager',
    NODE_AUTH_TOKEN: 'must-not-reach-manager',
    npm_config_cache: '/tmp/untrusted-npm-cache',
  });
  assert.equal(result.status, 0, result.stderr);
  const audit = JSON.parse(await readFile(auditFile, 'utf8'));
  const expectedPeers = [
    '@earendil-works/chord@1.1.0',
    '@earendil-works/pi-ai@1.1.0',
    '@earendil-works/pi-durable@1.1.0',
    'typebox@1.3.27',
  ];
  assert.deepEqual(audit.args.slice(-expectedPeers.length), expectedPeers);
  assert.equal(audit.targetExists, false);
  assert.equal(audit.userconfig, '/dev/null');
  assert.equal(audit.globalconfig, '/nonexistent/pi-durable-extensions-global.npmrc');
  assert.match(audit.cache, /^\/proc\/self\/fd\/4$/);
  assert.match(audit.args[audit.args.indexOf('--prefix') + 1], /^\/proc\/self\/fd\/5$/);
  assert.equal(audit.nodePath, null);
  assert.equal(audit.token, null);
  assert.equal(audit.authToken, null);
  const marker = JSON.parse(await readFile(path.join(target, '.portable-install.json'), 'utf8'));
  assert.deepEqual(marker.peerMaterialization.selected, expectedPeers);
  await assert.rejects(lstat(path.join(target, 'package-lock.json')));
});

test('descriptor-bound peer copy rejects a symlink source entry and retains staging', async () => {
  const fixtureData = await canonicalCodexFixture();
  if (!fixtureData) return;
  const target = path.join(fixtureData.root, 'target');
  const manager = await auditManager(fixtureData.root, "const prefix = process.argv[process.argv.indexOf('--prefix') + 1]; mkdirSync(join(prefix, 'node_modules'), { recursive: true }); const { symlinkSync } = await import('node:fs'); symlinkSync('/etc/passwd', join(prefix, 'node_modules', 'unexpected-link')); ");
  const result = run(['install', 'codex-api', '--catalog', fixtureData.catalog, '--target', target, '--version', fixtureData.entry.version, '--allow-experimental', '--package-manager', manager]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symlink/);
  await assert.rejects(readFile(target));
  assert.ok((await readdir(fixtureData.root)).some((name) => name.startsWith('.codex-api.staging-')));
});

test('undeclared false optional peer metadata is rejected', async () => {
  const fixtureData = await fixture('stable', { peerDependenciesMeta: { 'unexpected-peer': { optional: false } } });
  const target = path.join(fixtureData.root, 'target');
  const manager = await auditManager(fixtureData.root, "writeFileSync(process.env.PPC_AUDIT_FILE, 'called');");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager], { PPC_AUDIT_FILE: path.join(fixtureData.root, 'manager-called') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /undeclared package|peer-dependency/);
  await assert.rejects(readFile(target));
});

test('final manifest revalidation occurs after marker construction', async () => {
  const source = await readFile(CLI, 'utf8');
  assert.match(source, /buildMarker\(staging,[\s\S]+assertPackageManifestUnchanged\(staging, peerPlan, packageBytes\)[\s\S]+publishNoClobber/);
});

test('unknown peer declarations and injection-shaped values fail before manager execution', async () => {
  const fixtureData = await fixture('stable', { peerDependencies: { 'evil;touch': '1.0.0' } });
  const target = path.join(fixtureData.root, 'target');
  const auditFile = path.join(fixtureData.root, 'manager-called');
  const manager = await auditManager(fixtureData.root, "writeFileSync(process.env.PPC_AUDIT_FILE, 'called');");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /untrusted peer declarations|peer-dependency/);
  await assert.rejects(readFile(auditFile));
  await assert.rejects(readFile(target));
  assert.ok((await readdir(fixtureData.root)).some((name) => name.startsWith('.codemode.staging-')));
});

test('raw package manifest changes and package-lock creation are refused after manager execution', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'target');
  const manager = await managerScript(fixtureData.root, "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; const prefixIndex = process.argv.indexOf('--prefix'); if (prefixIndex >= 0) mkdirSync(join(process.argv[prefixIndex + 1], 'node_modules'), { recursive: true }); appendFileSync('package.json', '\\n'); writeFileSync('package-lock.json', '{}');");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package.json changed|package-lock/);
  await assert.rejects(readFile(target));
  assert.ok((await readdir(fixtureData.root)).some((name) => name.startsWith('.codemode.staging-')));
});

test('peer materialization source contains no deletion or cleanup hook', async () => {
  const source = await readFile(CLI, 'utf8');
  assert.doesNotMatch(source, /\\b(?:unlink|rmdir|rmSync|rm\\s+-rf)\\b/);
});

test('canonical Codex API peer materializes with default npm from the public registry', { skip: !process.env.PPC_RUN_PUBLIC_NPM_PEER || !process.env.PPC_U6_BUNDLE }, async () => {
  const fixtureData = await canonicalCodexFixture();
  const target = path.join(fixtureData.root, 'target');
  const result = run(['install', 'codex-api', '--catalog', fixtureData.catalog, '--target', target, '--version', fixtureData.entry.version, '--allow-experimental']);
  assert.equal(result.status, 0, result.stderr);
  const marker = JSON.parse(await readFile(path.join(target, '.portable-install.json'), 'utf8'));
  assert.deepEqual(marker.peerMaterialization.selected, [
    '@earendil-works/chord@1.1.0',
    '@earendil-works/pi-ai@1.1.0',
    '@earendil-works/pi-durable@1.1.0',
    'typebox@1.3.27',
  ]);
  assert.equal(marker.peerMaterialization.source, 'verified-extracted-package-root');
  assert.ok((await lstat(path.join(target, 'node_modules', '@earendil-works', 'pi-durable'))).isDirectory());
  assert.ok((await lstat(path.join(target, 'node_modules', 'typebox'))).isDirectory());
  await assert.rejects(lstat(path.join(target, 'package-lock.json')));
});

test('offline npm bin fixture proves default hazard and explicit no-link install', async () => {
  const fixtureData = await binFixture();
  const hazardEnv = { ...process.env };
  for (const key of Object.keys(hazardEnv)) if (/^npm_config_/i.test(key)) delete hazardEnv[key];
  hazardEnv.npm_config_userconfig = '/nonexistent';
  hazardEnv.npm_config_globalconfig = '/dev/null';
  hazardEnv.npm_config_cache = path.join(fixtureData.root, 'default-cache');
  const defaultInstall = spawnSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--workspaces=false', '--offline'], {
    cwd: fixtureData.pkg,
    encoding: 'utf8',
    env: hazardEnv,
  });
  assert.equal(defaultInstall.status, 0, defaultInstall.stderr);
  assert.equal((await lstat(path.join(fixtureData.pkg, 'node_modules', '.bin', 'tiny-bin'))).isSymbolicLink(), true);

  const target = path.join(fixtureData.root, 'installed');
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3']);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(lstat(path.join(target, 'node_modules', '.bin', 'tiny-bin')));
  assert.equal((await lstat(path.join(target, 'node_modules', 'tiny-bin-dependency', 'bin', 'cli.js'))).isFile(), true);
  await assert.rejects(readFile(path.join(target, 'node_modules', 'dev-only-dependency', 'package.json')));
});

test('trusted package-manager output may exceed archive member caps', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'large-dependency-output');
  const manager = await managerScript(fixtureData.root, "import { writeFileSync } from 'node:fs'; writeFileSync('native-addon.bin', Buffer.alloc(1024 * 1024 + 1, 0x61));");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(path.join(target, 'native-addon.bin'))).length, 1024 * 1024 + 1);
  const repeat = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /noop/);
});

test('target race is no-clobber and retains staging', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'raced-target');
  const manager = await managerScript(fixtureData.root, "import { mkdirSync, writeFileSync } from 'node:fs'; import path from 'node:path'; mkdirSync(process.env.PPC_INSTALL_TARGET, { recursive: true }); writeFileSync(path.join(process.env.PPC_INSTALL_TARGET, 'racer.txt'), 'racer'); writeFileSync(path.join(process.env.PPC_INSTALL_TARGET, '.portable-install.json'), '{\\\"schemaVersion\\\":1,\\\"id\\\":\\\"codemode\\\",\\\"version\\\":\\\"1.2.3\\\"}');");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(target, 'racer.txt'), 'utf8'), 'racer');
  assert.match(await readFile(path.join(target, '.portable-install.json'), 'utf8'), /"version":"1.2.3"/);
  assert.match(result.stderr, /race|target already exists|no-clobber/);
  assert.ok((await readdir(fixtureData.root)).some((name) => name.includes('.staging-')));
});

test('canonical Hindsight oversized vendor member is accepted before package manager execution', { skip: !process.env.PORTABLE_HINDSIGHT_ARTIFACT }, async () => {
  const fixtureData = await canonicalHindsightFixture();
  const target = path.join(fixtureData.root, 'target');
  const audit = path.join(fixtureData.root, 'manager-called');
  const manager = await managerScript(fixtureData.root, "import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(process.env.PPC_AUDIT_FILE, JSON.stringify({ targetExists: existsSync(process.env.PPC_INSTALL_TARGET) })); process.exit(17);");
  const result = run(['install', 'hindsight', '--catalog', fixtureData.catalog, '--target', target, '--version', '0.1.0', '--package-manager', manager], { PPC_AUDIT_FILE: audit });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /archive member exceeds 1048576 byte limit/);
  assert.match(result.stderr, /package manager failed/);
  assert.deepEqual(JSON.parse(await readFile(audit, 'utf8')), { targetExists: false });
  await assert.rejects(readFile(target));
  const stagingName = (await readdir(fixtureData.root)).find((name) => name.startsWith('.hindsight.staging-'));
  assert.ok(stagingName);
  const extracted = await readFile(path.join(fixtureData.root, stagingName, 'src/vendor/mcp-server.js'));
  assert.equal(extracted.length, CANONICAL_HINDSIGHT_MEMBER_BYTES);
  assert.equal(createHash('sha256').update(extracted).digest('hex'), CANONICAL_HINDSIGHT_MEMBER_SHA256);
});

test('Hindsight oversized allowance is conjunctive and preserves refusal boundaries', { skip: !process.env.PORTABLE_HINDSIGHT_ARTIFACT }, async () => {
  const wrongId = await canonicalHindsightFixture();
  const wrongIdTarget = path.join(wrongId.root, 'target');
  const wrongIdAudit = path.join(wrongId.root, 'manager-called');
  const wrongIdManager = await managerScript(wrongId.root, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PPC_AUDIT_FILE, 'called');");
  const wrongIdCatalog = JSON.parse(await readFile(wrongId.catalog, 'utf8'));
  wrongIdCatalog.components[0].id = 'codemode';
  const wrongIdCatalogPath = path.join(wrongId.root, 'wrong-id.json');
  await writeFile(wrongIdCatalogPath, JSON.stringify(wrongIdCatalog), { flag: 'wx' });
  const wrongIdResult = run(['install', 'codemode', '--catalog', wrongIdCatalogPath, '--target', wrongIdTarget, '--version', '0.1.0', '--package-manager', wrongIdManager], { PPC_AUDIT_FILE: wrongIdAudit });
  assert.notEqual(wrongIdResult.status, 0);
  assert.match(wrongIdResult.stderr, /archive member exceeds 1048576 byte limit/);
  await assert.rejects(readFile(wrongIdTarget));
  await assert.rejects(readFile(wrongIdAudit));
  assert.ok((await readdir(wrongId.root)).some((name) => name.startsWith('.codemode.staging-')));

  const wrongDigest = await canonicalHindsightFixture();
  const wrongDigestCatalog = JSON.parse(await readFile(wrongDigest.catalog, 'utf8'));
  wrongDigestCatalog.components[0].artifact.sha256 = '0'.repeat(64);
  const wrongDigestCatalogPath = path.join(wrongDigest.root, 'wrong-digest.json');
  await writeFile(wrongDigestCatalogPath, JSON.stringify(wrongDigestCatalog), { flag: 'wx' });
  const wrongDigestTarget = path.join(wrongDigest.root, 'target');
  const wrongDigestResult = run(['install', 'hindsight', '--catalog', wrongDigestCatalogPath, '--target', wrongDigestTarget, '--version', '0.1.0'], { });
  assert.notEqual(wrongDigestResult.status, 0);
  assert.match(wrongDigestResult.stderr, /integrity mismatch/);
  await assert.rejects(readFile(wrongDigestTarget));
  assert.equal((await readdir(wrongDigest.root)).some((name) => name.includes('.staging-')), false);

  const cases = [
    { name: 'wrong-path', memberPath: 'package/src/vendor/not-mcp-server.js' },
    { name: 'wrong-size', memberPath: CANONICAL_HINDSIGHT_MEMBER_PATH, size: CANONICAL_HINDSIGHT_MEMBER_BYTES + 1 },
    { name: 'wrong-member-digest', memberPath: CANONICAL_HINDSIGHT_MEMBER_PATH, fill: 0x62 },
  ];
  for (const item of cases) {
    const data = await syntheticOversizeFixture(item);
    const target = path.join(data.root, 'target');
    const audit = path.join(data.root, 'manager-called');
    const manager = await managerScript(data.root, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PPC_AUDIT_FILE, 'called');");
    const result = run(['install', 'hindsight', '--catalog', data.catalog, '--target', target, '--version', '0.1.0', '--package-manager', manager], { PPC_AUDIT_FILE: audit });
    assert.notEqual(result.status, 0, item.name);
    assert.match(result.stderr, /archive member exceeds 1048576 byte limit/, item.name);
    await assert.rejects(readFile(target), item.name);
    await assert.rejects(readFile(audit), item.name);
    assert.ok((await readdir(data.root)).some((name) => name.startsWith('.hindsight.staging-')), item.name);
  }
});

test('archive resource caps reject compressed bombs, too many members, and oversized extraction', async () => {
  const cases = [
    { name: 'compressed', archive: Buffer.alloc(4 * 1024 * 1024 + 1, 0x61), pattern: /byte limit/ },
    { name: 'bomb', archive: gzipSync(Buffer.alloc(MAX_DECOMPRESSED_TAR_BYTES + 1)), pattern: /decompress|byte limit/ },
    { name: 'member', archive: Buffer.concat([tarHeader('package/too-large', MAX_MEMBER_BYTES + 1), Buffer.alloc(1024)]), pattern: /member|byte limit/ },
    { name: 'members', archive: Buffer.concat([...Array.from({ length: MAX_ARCHIVE_MEMBERS + 1 }, (_, index) => tarHeader(`package/d-${index}`, 0, '5')), Buffer.alloc(1024)]), pattern: /members/ },
    {
      name: 'aggregate',
      archive: gzipSync(Buffer.concat([
        ...Array.from({ length: 9 }, (_, index) => [tarHeader(`package/f-${index}`, MAX_MEMBER_BYTES), Buffer.alloc(MAX_MEMBER_BYTES, 0x61)]).flat(),
        Buffer.alloc(1024),
      ])),
      pattern: /extracted bytes/,
    },
  ];
  for (const hostile of cases) {
    const fixtureData = await hostileFixture(hostile.archive);
    const target = path.join(fixtureData.root, `${hostile.name}-target`);
    const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3']);
    assert.notEqual(result.status, 0, hostile.name);
    assert.match(result.stderr, hostile.pattern, hostile.name);
    await assert.rejects(readFile(target));
    if (hostile.name !== 'compressed') assert.ok((await readdir(fixtureData.root)).some((name) => name.includes('.staging-')), hostile.name);
  }
});

test('Linux directory-fd anchoring prevents parent swap redirect publication', async () => {
  const fixtureData = await fixture();
  const parent = path.join(fixtureData.root, 'fresh-parent');
  const moved = path.join(fixtureData.root, 'moved-parent');
  await mkdir(parent);
  const target = path.join(parent, 'target');
  const manager = await managerScript(fixtureData.root, "import { mkdirSync, renameSync } from 'node:fs'; renameSync(process.env.PPC_PARENT, process.env.PPC_MOVED); mkdirSync(process.env.PPC_PARENT);");
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager], {
    PPC_PARENT: parent,
    PPC_MOVED: moved,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(moved, 'target', 'index.js'), 'utf8'), 'export const fixture = true;\n');
  await assert.rejects(readFile(path.join(parent, 'target', 'index.js')));
});

test('child fd 3 is explicitly remapped when the CLI starts with fd 3 occupied', async () => {
  const fixtureData = await fixture();
  const target = path.join(fixtureData.root, 'occupied-fd-target');
  const audit = path.join(fixtureData.root, 'fd-audit.json');
  const manager = await managerScript(fixtureData.root, "import { statSync, writeFileSync } from 'node:fs'; writeFileSync(process.env.PPC_FD_AUDIT, JSON.stringify({ isDirectory: statSync('/proc/self/fd/3').isDirectory() }));");
  const result = runWithOccupiedFd3(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', manager], { PPC_FD_AUDIT: audit });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(audit, 'utf8')), { isDirectory: true });
  assert.equal(await readFile(path.join(target, 'index.js'), 'utf8'), 'export const fixture = true;\n');
});

test('publication uses pinned GNU mv despite caller PATH replacement', async () => {
  const fixtureData = await fixture();
  const fakeBin = path.join(fixtureData.root, 'fake-bin');
  await mkdir(fakeBin);
  const fakeMv = path.join(fakeBin, 'mv');
  const fakeMarker = path.join(fixtureData.root, 'fake-mv-used');
  await writeFile(fakeMv, `#!/bin/sh\nprintf used > ${JSON.stringify(fakeMarker)}\nexit 99\n`);
  await chmod(fakeMv, 0o700);
  const target = path.join(fixtureData.root, 'pinned-mv-target');
  const result = run(['install', 'codemode', '--catalog', fixtureData.catalog, '--target', target, '--version', '1.2.3', '--package-manager', '/bin/true'], { PATH: `${fakeBin}:${process.env.PATH}` });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(readFile(fakeMarker));
  assert.equal(await readFile(path.join(target, 'index.js'), 'utf8'), 'export const fixture = true;\n');
});

test('doctor reports artifact integrity and does not probe external services', async () => {
  const fixtureData = await fixture();
  const report = run(['doctor', 'codemode', '--catalog', fixtureData.catalog, '--json']);
  assert.equal(report.status, 0, report.stderr);
  const parsed = jsonOutput(report);
  assert.equal(parsed.reports[0].artifact, 'integrity-ok');
  assert.equal(parsed.reports[0].external, 'not-probed');
});
