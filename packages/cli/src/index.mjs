#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { promises as fs, constants as FS_CONSTANTS } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATALOG = path.resolve(HERE, '..', 'catalog.json');
const MARKER = '.portable-install.json';
const NODE_BASELINE = 24;
const MAX_COMPRESSED_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_DECOMPRESSED_TAR_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_MEMBERS = 1024;
const MAX_MEMBER_BYTES = 1024 * 1024;
const HINDSIGHT_OVERSIZE_MEMBER = Object.freeze({
  componentId: 'hindsight',
  artifactSha256: '4ce1fc0d192530ccbaa42ffd05c3bac21d4f9b8d81179960b6fb05f121043443',
  rawPath: 'package/src/vendor/mcp-server.js',
  type: '0',
  size: 1242386,
  sha256: 'c1adb47de2972bbb4a708fc209dc4e1dbfc7fa53afc6666b133865f24ac9f03d',
});
const MAX_EXTRACTED_BYTES = 8 * 1024 * 1024;
const MAX_MARKER_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const TRUSTED_GNU_MV = '/usr/bin/mv';
const TRUSTED_PEER_MANIFESTS = Object.freeze({
  codemode: Object.freeze({
    packageName: '@pi-durable-extensions/codemode',
    artifactSha256: 'ecb6df1fb3cd55d4ad6bfe8922c881ffe9339246fba882f353a7b5db5f5e9f69',
    peers: Object.freeze({}),
    optional: Object.freeze({}),
  }),
  'agent-mail': Object.freeze({
    packageName: '@pi-pocket-candidates/agent-mail-mcp',
    artifactSha256: '2c95c873150506cf3624b4b1abc025f286a90785f4ce7b06490e41860f79c61a',
    peers: Object.freeze({}),
    optional: Object.freeze({}),
  }),
  'codex-api': Object.freeze({
    packageName: '@pi-durable/codex-api-candidate',
    artifactSha256: '92e3e3e792fed2c8044566810ed70f3feb6430ac5e6c4efa0c993edba603ec9e',
    peers: Object.freeze({
      '@earendil-works/chord': '>=1.1.0 <1.2.0',
      '@earendil-works/pi-ai': '>=1.1.0 <1.2.0',
      '@earendil-works/pi-durable': '>=1.1.0 <1.2.0',
      typebox: '>=1.3.27 <1.4.0',
    }),
    pins: Object.freeze({
      '@earendil-works/chord': '1.1.0',
      '@earendil-works/pi-ai': '1.1.0',
      '@earendil-works/pi-durable': '1.1.0',
      typebox: '1.3.27',
    }),
    optional: Object.freeze({}),
  }),
  'agent-profiles': Object.freeze({
    packageName: '@pi-pocket/agent-profiles',
    artifactSha256: '2705e5e3fbf9bd9009e965b436acb9716f8c3723459e2133d28df78fc4ccdf4b',
    peers: Object.freeze({}),
    optional: Object.freeze({}),
  }),
  'web-tools': Object.freeze({
    packageName: 'pi-durable-web-tools',
    artifactSha256: 'ff40a993db9e89c6e49369c9b7497e545b1c2cf385018c4690a52a760826e4ff',
    peers: Object.freeze({
      '@earendil-works/pi-ai': '*',
      '@earendil-works/pi-durable': '*',
      '@earendil-works/pi-coding-agent': '*',
      defuddle: '*',
      linkedom: '*',
      'wreq-js': '*',
    }),
    pins: Object.freeze({
      '@earendil-works/pi-ai': '1.1.0',
      '@earendil-works/pi-durable': '1.1.0',
    }),
    meta: Object.freeze({
      '@earendil-works/pi-coding-agent': Object.freeze({ optional: true }),
      defuddle: Object.freeze({ optional: true }),
      linkedom: Object.freeze({ optional: true }),
      'wreq-js': Object.freeze({ optional: true }),
    }),
    optional: Object.freeze({
      '@earendil-works/pi-coding-agent': true,
      defuddle: true,
      linkedom: true,
      'wreq-js': true,
    }),
  }),
  context7: Object.freeze({
    packageName: '@pi-durable-extensions/context7',
    artifactSha256: 'b327b32efcc00254a91f7a9736b9e0fc3ae80b588ca5f36caebd10f9f422c720',
    peers: Object.freeze({}),
    pins: Object.freeze({}),
    optional: Object.freeze({}),
  }),
  'antigravity-shim': Object.freeze({
    packageName: 'pi-antigravity-shim-candidate',
    artifactSha256: '26f485ff8ce6b01e0766fd5fa808d706f820d0738bb91f66cd0185eae263e74b',
    peers: Object.freeze({ 'pi-antigravity': '>=0.10.0' }),
    meta: Object.freeze({ 'pi-antigravity': Object.freeze({ optional: false }) }),
    optional: Object.freeze({}),
  }),
  'codex-voice': Object.freeze({
    packageName: '@pi-durable-extensions/codex-voice',
    artifactSha256: 'e78b974d00ce8cb2beafde7fcd30906c285b047540ec1e93fa12dbccb31aa55e',
    peers: Object.freeze({
      '@earendil-works/pi-ai': '>=1.1.0 <1.2.0',
      '@earendil-works/pi-durable': '>=1.1.0 <1.2.0',
    }),
    pins: Object.freeze({
      '@earendil-works/pi-ai': '1.1.0',
      '@earendil-works/pi-durable': '1.1.0',
    }),
    optional: Object.freeze({}),
  }),
  hindsight: Object.freeze({
    packageName: 'pi-durable-hindsight',
    artifactSha256: '4ce1fc0d192530ccbaa42ffd05c3bac21d4f9b8d81179960b6fb05f121043443',
    peers: Object.freeze({
      '@earendil-works/pi-durable': '1.0.2',
      '@earendil-works/chord': '1.0.2',
    }),
    pins: Object.freeze({
      '@earendil-works/pi-durable': '1.0.2',
      '@earendil-works/chord': '1.0.2',
    }),
    optional: Object.freeze({}),
  }),
  'agent-mail-identity': Object.freeze({
    packageName: '@pi-durable-extensions/agent-mail-identity',
    artifactSha256: 'd41c29e35d8c383d4823162cb6b3ae04c9e2b895ed641f71371bc2503915847b',
    peers: Object.freeze({
      '@earendil-works/pi-ai': '1.1.0',
      '@earendil-works/pi-durable': '1.1.0',
    }),
    pins: Object.freeze({
      '@earendil-works/pi-ai': '1.1.0',
      '@earendil-works/pi-durable': '1.1.0',
    }),
    optional: Object.freeze({}),
  }),
});
const COMPONENT_IDS = new Set([
  'codemode', 'agent-mail', 'codex-api', 'agent-profiles',
  'web-tools', 'context7', 'antigravity-shim', 'codex-voice', 'hindsight',
  'agent-mail-identity',
]);
const FORBIDDEN_IDS = new Set(['pi-durable-beads', 'lancet', 'goals', 'schedules', 'triggers']);

class CliError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

const fail = (message, code = 'invalid') => { throw new CliError(message, code); };

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command.startsWith('-')) fail('command is required: list, info, install, or doctor');
  const options = { command, positional: [], json: false, dryRun: false, allowExperimental: false };
  const takesValue = new Set(['catalog', 'target', 'version', 'package-manager']);
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith('-')) { options.positional.push(item); continue; }
    if (item === '--json') { options.json = true; continue; }
    if (item === '--dry-run') { options.dryRun = true; continue; }
    if (item === '--allow-experimental') { options.allowExperimental = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/.exec(item);
    const name = match?.[1];
    const value = match?.[2];
    if (match && takesValue.has(name)) { options[name.replaceAll('-', '')] = value; continue; }
    if (item.startsWith('--') && takesValue.has(item.slice(2))) {
      if (i + 1 >= rest.length) fail(`${item} requires a value`);
      options[item.slice(2).replaceAll('-', '')] = rest[++i];
      continue;
    }
    fail(`unknown option: ${item}`);
  }
  return options;
}

function print(value, json) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function validId(id) {
  return typeof id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(id) && !id.includes('..') && !id.includes('/') && !id.includes('\\');
}

function validVersion(version) {
  return typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function validSha(value) {
  return typeof value === 'string' && /^(?:sha256-)?[a-f0-9]{64}$/i.test(value);
}

function normalizedSha(value) { return value.toLowerCase().replace(/^sha256-/, ''); }

async function readJson(file, label) {
  try { return JSON.parse((await readBoundedFile(file, 256 * 1024, label)).toString('utf8')); }
  catch (error) { if (error instanceof CliError) throw error; fail(`cannot read ${label}: ${error.message}`, 'io'); }
}

function validateEntry(entry, index) {
  if (!entry || typeof entry !== 'object') fail(`catalog component ${index} is not an object`, 'catalog');
  if (!validId(entry.id) || FORBIDDEN_IDS.has(entry.id)) fail(`invalid or excluded component id: ${String(entry.id)}`, 'catalog');
  if (!COMPONENT_IDS.has(entry.id)) fail(`component is outside the approved collection: ${entry.id}`, 'catalog');
  if (!validVersion(entry.version)) fail(`invalid version for ${entry.id}`, 'catalog');
  if (!['stable', 'experimental', 'candidate', 'blocked'].includes(entry.status)) fail(`invalid status for ${entry.id}`, 'catalog');
  if (!['extension', 'adapter', 'service'].includes(entry.kind)) fail(`invalid kind for ${entry.id}`, 'catalog');
  if (!entry.artifact || typeof entry.artifact !== 'object' || typeof entry.artifact.path !== 'string' || !validSha(entry.artifact.sha256)) {
    fail(`artifact path and sha256 are required for ${entry.id}`, 'catalog');
  }
  if (path.isAbsolute(entry.artifact.path) || entry.artifact.path.split(/[\\/]+/).includes('..')) fail(`artifact path escapes catalog for ${entry.id}`, 'catalog');
}

async function readCatalog(file) {
  const catalogPath = path.resolve(file || DEFAULT_CATALOG);
  const catalog = await readJson(catalogPath, 'catalog');
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.components)) fail('catalog schemaVersion 1 and components[] are required', 'catalog');
  const seen = new Set();
  catalog.components.forEach((entry, index) => {
    validateEntry(entry, index);
    if (seen.has(entry.id)) fail(`duplicate component id: ${entry.id}`, 'catalog');
    seen.add(entry.id);
  });
  return { catalog, catalogPath, catalogDir: path.dirname(catalogPath) };
}

function findEntry(catalog, id) {
  if (!validId(id) || FORBIDDEN_IDS.has(id)) fail(`invalid component id: ${String(id)}`, 'invalid-id');
  const entry = catalog.components.find((item) => item.id === id);
  if (!entry) fail(`unknown component: ${id}`, 'not-found');
  return entry;
}

function assertAbsoluteTarget(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target === path.parse(target).root) fail('target must be an absolute non-root path', 'target');
  if (target.includes('\0') || target.split(/[\\/]+/).includes('..')) fail('target contains an unsafe traversal segment', 'target');
  return path.resolve(target);
}

async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readBoundedFile(file, limit, label) {
  let handle;
  try {
    const initial = await fs.lstat(file);
    if (initial.isSymbolicLink() || !initial.isFile()) fail(`${label} must be a regular file`, 'filesystem');
    if (initial.size > limit) fail(`${label} exceeds ${limit} byte limit`, 'resource-limit');
    handle = await fs.open(file, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const chunks = [];
    let total = 0;
    while (total < limit) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total === limit) {
      const probe = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(probe, 0, 1, null);
      if (bytesRead) fail(`${label} exceeds ${limit} byte limit`, 'resource-limit');
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof CliError) throw error;
    fail(`cannot read ${label}: ${error.message}`, 'io');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function openAnchoredParent(target) {
  if (process.platform !== 'linux') fail('Linux directory-fd anchoring is required for install targets', 'platform');
  const parent = path.dirname(target);
  const root = path.parse(parent).root;
  const flags = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW;
  let current;
  try {
    current = await fs.open(root, flags);
    const relative = path.relative(root, parent);
    for (const part of relative ? relative.split(path.sep) : []) {
      const next = await fs.open(`/proc/self/fd/${current.fd}/${part}`, flags);
      await current.close();
      current = next;
    }
    return { handle: current, name: path.basename(target), parentPath: `/proc/self/fd/${current.fd}`, childParentPath: '/proc/self/fd/3' };
  } catch (error) {
    await current?.close().catch(() => {});
    if (error.code === 'ENOENT') fail(`target parent does not exist: ${parent}`, 'target');
    if (error.code === 'ELOOP') fail(`target parent contains a symlink: ${parent}`, 'symlink');
    if (error.code === 'ENOTDIR') fail(`target parent is not a directory: ${parent}`, 'target');
    throw error;
  }
}

function anchoredChild(anchor) { return path.join(anchor.parentPath, anchor.name); }
function childProcessPath(anchor, name) { return path.join(anchor.childParentPath, name); }

async function assertTargetSafe(target) {
  const stat = await lstatOrNull(target);
  if (!stat) return { exists: false };
  if (stat.isSymbolicLink()) fail(`refusing symlink target: ${target}`, 'symlink');
  if (!stat.isDirectory()) fail(`target is not a directory: ${target}`, 'target');
  return { exists: true, stat };
}

async function sha256BoundedFile(file, limit) {
  return createHash('sha256').update(await readBoundedFile(file, limit, file)).digest('hex');
}

async function sha256File(file) {
  let handle;
  try {
    handle = await fs.open(file, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const hash = createHash('sha256');
    while (true) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } catch (error) {
    fail(`cannot hash ${file}: ${error.message}`, 'io');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function safeMemberName(name) {
  if (!name || name.includes('\0') || name.includes('\\') || path.posix.isAbsolute(name)) fail(`unsafe archive member: ${JSON.stringify(name)}`, 'archive');
  const rawSegments = name.split('/');
  if (rawSegments.includes('..')) fail(`archive traversal member: ${JSON.stringify(name)}`, 'archive');
  const clean = path.posix.normalize(name.replace(/\/+$/, ''));
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../') || clean.includes('/../')) fail(`archive traversal member: ${JSON.stringify(name)}`, 'archive');
  return clean;
}

function octal(buffer, start, length) {
  const text = buffer.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function paxFields(buffer) {
  const fields = {};
  let offset = 0;
  while (offset < buffer.length) {
    const end = buffer.indexOf(0x0a, offset);
    if (end < 0) fail('invalid pax header', 'archive');
    const line = buffer.subarray(offset, end).toString('utf8');
    const space = line.indexOf(' ');
    const equals = line.indexOf('=');
    if (space < 1 || equals <= space) fail('invalid pax field', 'archive');
    fields[line.slice(space + 1, equals)] = line.slice(equals + 1);
    offset = end + 1;
  }
  return fields;
}

function approvedOversizeMember(context, rawPath, type, size, data) {
  if (context?.componentId !== HINDSIGHT_OVERSIZE_MEMBER.componentId
    || context.artifactSha256 !== HINDSIGHT_OVERSIZE_MEMBER.artifactSha256
    || rawPath !== HINDSIGHT_OVERSIZE_MEMBER.rawPath
    || type !== HINDSIGHT_OVERSIZE_MEMBER.type
    || size !== HINDSIGHT_OVERSIZE_MEMBER.size) return false;
  return createHash('sha256').update(data).digest('hex') === HINDSIGHT_OVERSIZE_MEMBER.sha256;
}

function tarEntries(input, context) {
  if (input.length > MAX_COMPRESSED_ARTIFACT_BYTES) fail(`compressed artifact exceeds ${MAX_COMPRESSED_ARTIFACT_BYTES} byte limit`, 'resource-limit');
  let archive;
  try {
    archive = input[0] === 0x1f && input[1] === 0x8b
      ? gunzipSync(input, { maxOutputLength: MAX_DECOMPRESSED_TAR_BYTES })
      : input;
  } catch (error) {
    fail(`cannot decompress artifact within ${MAX_DECOMPRESSED_TAR_BYTES} byte limit: ${error.message}`, 'resource-limit');
  }
  if (archive.length > MAX_DECOMPRESSED_TAR_BYTES) fail(`decompressed tar exceeds ${MAX_DECOMPRESSED_TAR_BYTES} byte limit`, 'resource-limit');
  const entries = [];
  let offset = 0;
  let nextPax = {};
  let extractedBytes = 0;
  let memberCount = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    memberCount += 1;
    if (memberCount > MAX_ARCHIVE_MEMBERS) fail(`archive has more than ${MAX_ARCHIVE_MEMBERS} members`, 'resource-limit');
    const type = String.fromCharCode(header[156] || 0);
    const size = octal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) fail('invalid archive entry size', 'archive');
    const base = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const rawName = nextPax.path || (prefix ? `${prefix}/${base}` : base);
    const exactOversize = type === HINDSIGHT_OVERSIZE_MEMBER.type
      && context?.componentId === HINDSIGHT_OVERSIZE_MEMBER.componentId
      && context.artifactSha256 === HINDSIGHT_OVERSIZE_MEMBER.artifactSha256
      && rawName === HINDSIGHT_OVERSIZE_MEMBER.rawPath
      && size === HINDSIGHT_OVERSIZE_MEMBER.size
      && Object.keys(nextPax).length === 0;
    if (size > MAX_MEMBER_BYTES && !exactOversize) fail(`archive member exceeds ${MAX_MEMBER_BYTES} byte limit`, 'resource-limit');
    if (offset + 512 + size > archive.length) fail('invalid archive entry size', 'archive');
    const dataStart = offset + 512;
    const data = archive.subarray(dataStart, dataStart + size);
    if (type === 'x') { nextPax = paxFields(data); }
    else if (type === 'g') { /* global pax metadata is intentionally ignored */ }
    else if (type === 'L' || type === 'K') fail('GNU long-name/link entries are not accepted', 'archive');
    else {
      const name = safeMemberName(rawName);
      const kind = type === '5' ? 'directory' : (type === '0' || type === '\0' || type === '7' ? 'file' : 'unsupported');
      if (kind === 'unsupported') fail(`archive member type is not allowed: ${name}`, 'archive');
      if (exactOversize && !approvedOversizeMember(context, rawName, type, size, data)) fail(`approved oversized member digest mismatch: ${name}`, 'integrity');
      if (kind === 'file') {
        extractedBytes += size;
        if (extractedBytes > MAX_EXTRACTED_BYTES) fail(`archive extracted bytes exceed ${MAX_EXTRACTED_BYTES} byte limit`, 'resource-limit');
      }
      entries.push({ name, kind, data: kind === 'file' ? Buffer.from(data) : null, mode: octal(header, 100, 8) & 0o777 });
      nextPax = {};
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!entries.length) fail('artifact archive is empty', 'archive');
  return entries;
}

function stripArchiveRoot(entries) {
  const first = entries.map((entry) => entry.name.split('/')[0]);
  const root = first[0];
  if (!root || !first.every((item) => item === root)) return entries;
  return entries.map((entry) => ({ ...entry, name: entry.name === root ? '.' : entry.name.slice(root.length + 1) })).filter((entry) => entry.name !== '.');
}

async function extractArtifact(artifactBytes, staging, context) {
  const entries = stripArchiveRoot(tarEntries(artifactBytes, context));
  const names = new Set();
  for (const entry of entries) {
    const name = safeMemberName(entry.name);
    if (names.has(name)) fail(`duplicate archive member: ${name}`, 'archive');
    names.add(name);
    const destination = path.join(staging, name);
    const relative = path.relative(staging, destination);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail(`archive member escapes staging: ${name}`, 'archive');
    if (entry.kind === 'directory') {
      await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    } else {
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, entry.data, { flag: 'wx', mode: entry.mode || 0o600 });
    }
  }
}

async function walkFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const stat = await fs.lstat(child);
    if (stat.isSymbolicLink()) fail(`symlink is not allowed in installed artifact: ${childRelative}`, 'symlink');
    if (stat.isDirectory()) files.push(...await walkFiles(root, childRelative));
    else if (stat.isFile()) files.push({ path: childRelative.split(path.sep).join('/'), sha256: await sha256File(child) });
    else fail(`unsupported filesystem entry in staging: ${childRelative}`, 'filesystem');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function readMarker(target) {
  try {
    const markerPath = path.join(target, MARKER);
    const markerStat = await fs.lstat(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) fail(`install marker is not a regular file: ${markerPath}`, 'symlink');
    const value = JSON.parse((await readBoundedFile(markerPath, MAX_MARKER_BYTES, 'install marker')).toString('utf8'));
    if (!value || value.schemaVersion !== 1 || !validId(value.id) || !validVersion(value.version) || !validSha(value.artifactSha256) || !Array.isArray(value.files)) return null;
    return value;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    fail(`cannot read install marker: ${error.message}`, 'io');
  }
}

function sameFiles(a, b) {
  return a.length === b.length && a.every((item, index) => item.path === b[index].path && item.sha256 === b[index].sha256);
}

async function inspectInstalled(target, entry, artifactSha256) {
  const marker = await readMarker(target);
  if (!marker || marker.id !== entry.id || marker.version !== entry.version || normalizedSha(marker.artifactSha256) !== artifactSha256) return { state: 'conflict' };
  const files = await walkFiles(target);
  const actual = files.filter((file) => file.path !== MARKER);
  if (!sameFiles(actual, marker.files)) return { state: 'conflict' };
  return { state: 'same', marker };
}

function sameRecord(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function sameMeta(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]
      && JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}

function validatePeerToken(name, range) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) fail(`invalid peer package name: ${name}`, 'peer-dependency');
  if (typeof range !== 'string' || !range || /[\0\r\n]/.test(range) || /^(?:-|--)/.test(range)
    || /^(?:file:|git:|git\+|https?:|workspace:|link:|npm:)/i.test(range)
    || /[\\/]/.test(range) || !/^[A-Za-z0-9@._+*<>=~^| -]+$/.test(range)) {
    fail(`invalid peer range for ${name}`, 'peer-dependency');
  }
}

async function readPeerPlan(staging, entry, artifactSha256) {
  const packagePath = path.join(staging, 'package.json');
  const packageBytes = await readBoundedFile(packagePath, 256 * 1024, `${entry.id} package.json`);
  let packageJson;
  try { packageJson = JSON.parse(packageBytes.toString('utf8')); }
  catch (error) { fail(`cannot parse ${entry.id} package.json: ${error.message}`, 'package-manifest'); }
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) fail(`${entry.id} package.json must be an object`, 'package-manifest');
  if (packageJson.workspaces) fail('workspace installs are not allowed in a selected package artifact', 'workspace');
  if (await lstatOrNull(path.join(staging, 'package-lock.json'))) fail('package-lock.json is not allowed in a selected package artifact', 'package-lock');
  const peers = packageJson.peerDependencies === undefined ? {} : packageJson.peerDependencies;
  const meta = packageJson.peerDependenciesMeta === undefined ? {} : packageJson.peerDependenciesMeta;
  if (!peers || typeof peers !== 'object' || Array.isArray(peers) || !meta || typeof meta !== 'object' || Array.isArray(meta)) {
    fail(`${entry.id} peer dependency fields must be objects`, 'peer-dependency');
  }
  for (const [name, value] of Object.entries(meta)) {
    if (!Object.prototype.hasOwnProperty.call(peers, name)) fail(`peer metadata names an undeclared package: ${name}`, 'peer-dependency');
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'optional')
      || (value.optional !== undefined && typeof value.optional !== 'boolean')) {
      fail(`invalid peer metadata for ${name}`, 'peer-dependency');
    }
  }
  const trusted = TRUSTED_PEER_MANIFESTS[entry.id];
  const canonical = trusted && normalizedSha(artifactSha256) === trusted.artifactSha256;
  if (canonical) {
    if (packageJson.name !== trusted.packageName) fail(`canonical package identity mismatch for ${entry.id}`, 'integrity');
    if (packageJson.version !== entry.version) fail(`canonical package version mismatch for ${entry.id}`, 'integrity');
    if (!sameRecord(peers, trusted.peers)) fail(`canonical peer declarations mismatch for ${entry.id}`, 'peer-dependency');
    const actualMeta = Object.fromEntries(Object.entries(meta).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, Object.prototype.hasOwnProperty.call(value, 'optional') ? { optional: value.optional } : {}]));
    if (!sameMeta(actualMeta, trusted.meta || {})) fail(`canonical peer metadata mismatch for ${entry.id}`, 'peer-dependency');
    const pins = trusted.pins || {};
    if (Object.keys(pins).some((name) => !Object.prototype.hasOwnProperty.call(peers, name) || trusted.optional[name] === true)) fail(`canonical peer pins mismatch for ${entry.id}`, 'peer-dependency');
    for (const [name, range] of Object.entries(peers)) {
      validatePeerToken(name, range);
      if (pins[name] !== undefined) validatePeerToken(name, pins[name]);
    }
    const selected = Object.entries(peers).filter(([name]) => trusted.optional[name] !== true).map(([name, range]) => `${name}@${pins[name] || range}`);
    return {
      packageBytes,
      packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
      report: {
        source: 'verified-extracted-package-root',
        packageName: packageJson.name,
        artifactSha256: normalizedSha(artifactSha256),
        declared: Object.fromEntries(Object.entries(peers).sort(([a], [b]) => a.localeCompare(b))),
        pins: Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))),
        optional: Object.keys(trusted.optional).sort(),
        selected,
      },
      specs: selected,
    };
  }
  if (Object.keys(peers).length) fail(`untrusted peer declarations for ${entry.id}`, 'peer-dependency');
  return {
    packageBytes,
    packageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    report: { source: 'package-root-no-peers', packageName: packageJson.name, artifactSha256: normalizedSha(artifactSha256), declared: {}, optional: [], selected: [] },
    specs: [],
  };
}

async function assertPackageManifestUnchanged(staging, peerPlan, expectedBytes = null) {
  const packageBytes = await readBoundedFile(path.join(staging, 'package.json'), 256 * 1024, 'post-install package.json');
  const expected = expectedBytes || peerPlan.packageBytes;
  if (!packageBytes.equals(expected)) fail(`package.json changed during package-manager execution (before ${peerPlan.packageSha256}, after ${createHash('sha256').update(packageBytes).digest('hex')})`, 'package-manifest');
  if (await lstatOrNull(path.join(staging, 'package-lock.json'))) fail('package-lock.json was created despite --package-lock=false', 'package-lock');
  return packageBytes;
}

const DIRECTORY_FLAGS = FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_DIRECTORY | FS_CONSTANTS.O_NOFOLLOW;

function childFdPath(handle, name) { return `/proc/self/fd/${handle.fd}/${name}`; }

async function validateDirectoryHandle(handle, pathname, label) {
  const opened = await handle.stat();
  const current = await fs.lstat(pathname);
  if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
    || opened.dev !== current.dev || opened.ino !== current.ino) fail(`${label} changed during descriptor binding`, 'race');
}

async function openBoundDirectory(pathname, label, childFd) {
  let handle;
  try { handle = await fs.open(pathname, DIRECTORY_FLAGS); }
  catch (error) {
    if (error.code === 'ELOOP') fail(`${label} is a symlink`, 'symlink');
    throw error;
  }
  try {
    await validateDirectoryHandle(handle, pathname, label);
    return { handle, path: `/proc/self/fd/${childFd}` };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function makePrivateNpmCache(anchor, staging, childFd) {
  const cachePath = path.join(anchor.parentPath, `${path.basename(staging)}.npm-cache`);
  await fs.mkdir(cachePath, { mode: 0o700 });
  return openBoundDirectory(cachePath, 'npm cache', childFd);
}

async function makePrivatePeerRoot(anchor, staging, childFd) {
  const rootPath = path.join(anchor.parentPath, `${path.basename(staging)}.peer-root`);
  await fs.mkdir(rootPath, { mode: 0o700 });
  return openBoundDirectory(rootPath, 'peer root', childFd);
}

async function openSourceChild(parent, name) {
  let handle;
  try { handle = await fs.open(childFdPath(parent, name), FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW); }
  catch (error) {
    if (error.code === 'ELOOP') fail(`symlink is not allowed in materialized peer tree: ${name}`, 'symlink');
    throw error;
  }
  const stat = await handle.stat();
  if (!stat.isDirectory() && !stat.isFile()) { await handle.close(); fail(`unsupported materialized peer entry: ${name}`, 'filesystem'); }
  return { handle, stat };
}

async function createDestinationDirectory(parent, name) {
  const pathname = childFdPath(parent, name);
  try { await fs.mkdir(pathname, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail(`destination entry already exists: ${name}`, 'filesystem'); throw error; }
  return openBoundDirectory(pathname, `destination directory ${name}`, parent.fd);
}

async function copyOpenedFile(source, destination, relative) {
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    let offset = 0;
    while (offset < bytesRead) {
      const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, null);
      if (!bytesWritten) fail(`could not copy materialized peer file: ${relative}`, 'io');
      offset += bytesWritten;
    }
  }
}

async function copyPeerDirectory(source, destination, relative = '') {
  for (const entry of await fs.readdir(`/proc/self/fd/${source.fd}`, { withFileTypes: true })) {
    if (!entry.name || entry.name === '.' || entry.name === '..') fail('invalid materialized peer entry name', 'filesystem');
    const child = await openSourceChild(source, entry.name);
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    try {
      if (child.stat.isDirectory()) {
        const target = await createDestinationDirectory(destination, entry.name);
        try { await copyPeerDirectory(child.handle, target.handle, childRelative); }
        finally { await target.handle.close().catch(() => {}); }
      } else {
        const destinationPath = childFdPath(destination, entry.name);
        let target;
        try { target = await fs.open(destinationPath, FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_NOFOLLOW, child.stat.mode & 0o777); }
        catch (error) {
          if (error.code === 'ELOOP') fail(`destination entry is a symlink: ${childRelative}`, 'symlink');
          throw error;
        }
        try {
          const targetStat = await target.stat();
          if (!targetStat.isFile()) fail(`destination entry is not a regular file: ${childRelative}`, 'filesystem');
          await copyOpenedFile(child.handle, target, childRelative);
        } finally { await target.close().catch(() => {}); }
      }
    } finally { await child.handle.close().catch(() => {}); }
  }
}

async function rejectPeerRootLock(peerRoot) {
  try {
    const lock = await fs.open(childFdPath(peerRoot, 'package-lock.json'), FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    await lock.close();
    fail('peer materialization created package-lock.json', 'package-lock');
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error.code === 'ELOOP') fail('peer materialization created a package-lock symlink', 'symlink');
    if (error.code !== 'ENOENT') throw error;
  }
}

async function materializePeerTree(peerRoot, staging) {
  await rejectPeerRootLock(peerRoot);
  const source = await openBoundDirectory(childFdPath(peerRoot, 'node_modules'), 'peer node_modules', 7);
  try {
    const destination = await createDestinationDirectory(staging, 'node_modules');
    try { await copyPeerDirectory(source.handle, destination.handle); }
    finally { await destination.handle.close().catch(() => {}); }
  } finally { await source.handle.close().catch(() => {}); }
}

async function makeStaging(anchor, id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const name = `.${id}.staging-${suffix}`;
    const staging = path.join(anchor.parentPath, name);
    try { await fs.mkdir(staging, { mode: 0o700 }); return staging; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  fail('could not allocate unique retained staging directory', 'staging');
}

function packageManagerPath(options) { return options.packagemanager || process.env.PPC_CLI_PACKAGE_MANAGER || 'npm'; }

function checkExecutable(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function hasGnuNoClobberMv() {
  const result = spawnSync(TRUSTED_GNU_MV, ['--version'], { encoding: 'utf8' });
  return result.status === 0 && /^mv \(GNU coreutils\)/.test(result.stdout);
}

async function runPackageManager(manager, staging, target, anchor, peerPlan) {
  const cwd = await openBoundDirectory(staging, 'package-manager cwd', 6);
  const cache = await makePrivateNpmCache(anchor, staging, 4);
  const peerRoot = peerPlan.specs.length ? await makePrivatePeerRoot(anchor, staging, 5) : null;
  const args = ['install', ...(peerRoot ? ['--prefix', peerRoot.path] : []), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--no-save', '--workspaces=false', '--bin-links=false', '--omit=dev', ...peerPlan.specs];
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^npm_/i.test(key) || /^(NPM_TOKEN|NODE_AUTH_TOKEN|NODE_OPTIONS|NODE_PATH|NODE_NO_WARNINGS|NODE_EXTRA_CA_CERTS|NODE_DEBUG|NODE_V8_COVERAGE)$/i.test(key)) delete childEnv[key];
  }
  childEnv.npm_config_ignore_scripts = 'true';
  childEnv.npm_config_userconfig = '/dev/null';
  childEnv.npm_config_globalconfig = '/nonexistent/pi-durable-extensions-global.npmrc';
  childEnv.npm_config_cache = cache.path;
  childEnv.PPC_INSTALL_TARGET = childProcessPath(anchor, path.basename(target));
  const stdio = ['ignore', 'pipe', 'pipe', anchor.handle.fd, cache.handle.fd, peerRoot?.handle.fd, cwd.handle.fd];
  try {
    const result = spawnSync(manager, args, {
      cwd: cwd.path,
      encoding: 'utf8',
      env: childEnv,
      stdio,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) fail(`package manager could not start: ${result.error.message}`, 'package-manager');
    if (result.status !== 0) fail(`package manager failed with exit ${result.status ?? 'signal'}; retained staging: ${staging}`, 'package-manager');
    if (peerRoot) await materializePeerTree(peerRoot.handle, cwd.handle);
    return { args, cache: childEnv.npm_config_cache, cwd: cwd.path };
  } finally {
    await cwd.handle.close().catch(() => {});
    await cache.handle.close().catch(() => {});
    await peerRoot?.handle.close().catch(() => {});
  }
}

async function buildMarker(staging, entry, artifactSha256, peerPlan, managerRun, packageBytes) {
  const packageJson = JSON.parse(packageBytes.toString('utf8'));
  if (packageJson.workspaces) fail('workspace installs are not allowed in a selected package artifact', 'workspace');
  const files = await walkFiles(staging);
  const marker = {
    schemaVersion: 1,
    id: entry.id,
    version: entry.version,
    artifactSha256,
    installedWith: 'npm install --ignore-scripts --no-audit --no-fund --package-lock=false --no-save --workspaces=false --bin-links=false --omit=dev',
    peerMaterialization: { ...peerPlan.report, npmArgs: managerRun.args, cwd: managerRun.cwd, cache: managerRun.cache },
    files,
  };
  await fs.writeFile(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function publishNoClobber(staging, anchor) {
  const childStaging = childProcessPath(anchor, path.basename(staging));
  const childTarget = childProcessPath(anchor, anchor.name);
  const result = spawnSync(TRUSTED_GNU_MV, ['-nT', '--', childStaging, childTarget], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', anchor.handle.fd],
  });
  if (result.error || result.status !== 0) fail(`no-clobber publish failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}; retained staging: ${staging}`, 'publish');
  if (await lstatOrNull(staging)) fail(`target race prevented publication; retained staging: ${staging}`, 'race');
  const targetStat = await lstatOrNull(anchoredChild(anchor));
  if (!targetStat || !targetStat.isDirectory() || targetStat.isSymbolicLink()) fail(`publication did not create a safe target; retained staging: ${staging}`, 'publish');
}

function runtimeStatus(entry) {
  const required = Number.parseInt(String(entry.testedRuntime?.node || '').match(/\d+/)?.[0] || String(NODE_BASELINE), 10);
  return Number(process.versions.node.split('.')[0]) >= required ? 'supported' : 'blocked';
}

async function commandList(options) {
  const { catalog } = await readCatalog(options.catalog);
  const visible = catalog.components.filter((entry) => entry.status === 'stable' || options.allowExperimental);
  const result = visible.map(({ id, version, status, kind, description }) => ({ id, version, status, kind, description }));
  if (options.json) print(result, true);
  else if (!result.length) print('No stable components are currently cataloged. Use --allow-experimental to show candidates.', false);
  else result.forEach((entry) => print(`${entry.id}\t${entry.version}\t${entry.status}\t${entry.kind}${entry.description ? `\t${entry.description}` : ''}`, false));
}

async function commandInfo(options) {
  const { catalog } = await readCatalog(options.catalog);
  const entry = findEntry(catalog, options.positional[0]);
  print(entry, options.json);
}

async function commandDoctor(options) {
  const { catalog, catalogDir } = await readCatalog(options.catalog);
  const selected = options.positional[0] ? [findEntry(catalog, options.positional[0])] : catalog.components;
  const npm = checkExecutable(packageManagerPath(options));
  const publisher = hasGnuNoClobberMv() ? 'gnu-coreutils-available' : 'gnu-coreutils-required';
  const reports = [];
  for (const entry of selected) {
    const artifact = path.resolve(catalogDir, entry.artifact.path);
    const report = { id: entry.id, version: entry.version, status: entry.status, runtime: runtimeStatus(entry), packageManager: npm ? 'available' : 'missing', publisher, artifact: 'missing', external: 'not-probed', install: 'not-installed' };
    const stat = await lstatOrNull(artifact);
    if (stat?.isFile() && !stat.isSymbolicLink()) {
      report.artifact = (await sha256BoundedFile(artifact, MAX_COMPRESSED_ARTIFACT_BYTES)) === normalizedSha(entry.artifact.sha256) ? 'integrity-ok' : 'integrity-mismatch';
    } else if (stat?.isSymbolicLink()) report.artifact = 'symlink-refused';
    if (options.target) {
      const target = assertAbsoluteTarget(options.target);
      const targetStat = await lstatOrNull(target);
      if (targetStat?.isSymbolicLink()) report.install = 'symlink-refused';
      else if (targetStat?.isDirectory() && report.artifact === 'integrity-ok') report.install = (await inspectInstalled(target, entry, normalizedSha(entry.artifact.sha256))).state;
      else if (targetStat) report.install = 'foreign-target';
    }
    reports.push(report);
  }
  const result = { node: process.versions.node, piDurable: catalog.runtime?.piDurable || 'not-declared', reports };
  print(result, options.json);
  if (reports.some((report) => report.status === 'blocked' || report.runtime === 'blocked' || report.packageManager === 'missing' || report.publisher !== 'gnu-coreutils-available' || report.artifact !== 'integrity-ok' || ['foreign-target', 'conflict', 'symlink-refused'].includes(report.install))) fail('doctor found blocked or unavailable requirements', 'doctor');
}

async function commandInstall(options) {
  const { catalog, catalogPath, catalogDir } = await readCatalog(options.catalog);
  const entry = findEntry(catalog, options.positional[0]);
  if (!validVersion(options.version)) fail('install requires an exact semantic --version', 'version');
  if (entry.version !== options.version) fail(`catalog pins ${entry.id} at ${entry.version}; requested ${options.version} is not selected`, 'version');
  if (entry.status !== 'stable' && !options.allowExperimental) fail(`${entry.id}@${entry.version} is ${entry.status}; add --allow-experimental for explicit opt-in`, 'experimental');
  if (entry.status === 'blocked') fail(`${entry.id} is blocked and cannot be installed`, 'blocked');
  const target = assertAbsoluteTarget(options.target);
  const artifact = path.resolve(catalogDir, entry.artifact.path);
  const artifactStat = await lstatOrNull(artifact);
  if (!artifactStat || !artifactStat.isFile() || artifactStat.isSymbolicLink()) fail(`artifact is missing or not a regular file: ${artifact}`, 'artifact');
  const artifactBytes = await readBoundedFile(artifact, MAX_COMPRESSED_ARTIFACT_BYTES, `${entry.id} artifact`);
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  if (artifactSha256 !== normalizedSha(entry.artifact.sha256)) fail(`artifact integrity mismatch for ${entry.id}@${entry.version}`, 'integrity');
  if (!hasGnuNoClobberMv()) fail('GNU coreutils mv with -nT is required for no-clobber publication', 'publisher');
  const anchor = await openAnchoredParent(target);
  try {
    const anchoredTarget = anchoredChild(anchor);
    const targetState = await assertTargetSafe(anchoredTarget);
    if (targetState.exists) {
      const installed = await inspectInstalled(anchoredTarget, entry, artifactSha256);
      if (installed.state === 'same') {
        print({ action: 'noop', id: entry.id, version: entry.version, target }, options.json);
        return;
      }
      fail(`target already exists and is not the exact selected installation: ${target}`, 'conflict');
    }
    const plan = { action: 'install', id: entry.id, version: entry.version, artifact: path.relative(catalogPath, artifact), artifactSha256, target, packageManager: packageManagerPath(options), scripts: 'disabled', activation: 'manual' };
    if (options.dryRun) { print(plan, options.json); return; }
    const staging = await makeStaging(anchor, entry.id);
    try {
      await extractArtifact(artifactBytes, staging, { componentId: entry.id, artifactSha256 });
      const peerPlan = await readPeerPlan(staging, entry, artifactSha256);
      const managerRun = await runPackageManager(packageManagerPath(options), staging, target, anchor, peerPlan);
      const packageBytes = await assertPackageManifestUnchanged(staging, peerPlan);
      await buildMarker(staging, entry, artifactSha256, peerPlan, managerRun, packageBytes);
      await assertPackageManifestUnchanged(staging, peerPlan, packageBytes);
      await publishNoClobber(staging, anchor);
    } catch (error) {
      if (error instanceof CliError && !error.message.includes('retained staging')) error.message += `; retained staging: ${staging}`;
      throw error;
    }
    print({ ...plan, action: 'installed', staging: `${path.basename(staging)} (published)` }, options.json);
  } finally {
    await anchor.handle.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'list') return commandList(options);
  if (options.command === 'info') return commandInfo(options);
  if (options.command === 'doctor') return commandDoctor(options);
  if (options.command === 'install') return commandInstall(options);
  fail(`unknown command: ${options.command}`);
}

try { await main(); }
catch (error) {
  const result = { ok: false, error: error.code || 'error', message: error.message };
  const json = process.argv.includes('--json');
  if (json) console.error(JSON.stringify(result, null, 2)); else console.error(`Error [${result.error}]: ${result.message}`);
  process.exitCode = 1;
}
