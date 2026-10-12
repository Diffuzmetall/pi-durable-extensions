import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

function modeOf(stat) {
  return stat.mode & 0o777;
}

function runtimeCapabilities() {
  return { platform: process.platform, hasGetuid: typeof process.getuid === 'function', hasNoFollow: typeof constants.O_NOFOLLOW === 'number' };
}

export function assertPrivateFsCapabilities(capabilities = runtimeCapabilities()) {
  if (capabilities.platform !== 'linux' || !capabilities.hasGetuid || !capabilities.hasNoFollow) {
    throw new Error('Private filesystem trust boundary requires Linux, process.getuid(), and O_NOFOLLOW');
  }
}

function ownerUid() {
  return process.getuid();
}

function assertOwner(stat, path) {
  const uid = ownerUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Private path is not owned by the current user: ${path}`);
}

function assertDirectory(stat, path) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Private directory path is not a directory: ${path}`);
  assertOwner(stat, path);
  if (modeOf(stat) !== PRIVATE_DIRECTORY_MODE) throw new Error(`Private directory has insecure mode (expected 0700): ${path}`);
}

function assertFile(stat, path) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Private file path is not a regular file: ${path}`);
  assertOwner(stat, path);
  if (modeOf(stat) !== PRIVATE_FILE_MODE) throw new Error(`Private file has insecure mode (expected 0600): ${path}`);
}

async function existing(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Reject symlinked ancestors before creating anything. The post-create checks in
// the public helpers close the ordinary race where an absent path is replaced.
async function assertNoSymlinkAncestors(path) {
  const absolute = isAbsolute(path) ? path : resolve(path);
  const root = resolve(sep);
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = `${current}${sep}${part}`;
    const stat = await existing(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`Private path has a symlink ancestor: ${current}`);
  }
}

export async function ensurePrivateDirectory(path) {
  assertPrivateFsCapabilities();
  if (typeof path !== 'string' || !path) throw new Error('Private directory path is required');
  const absolute = isAbsolute(path) ? path : resolve(path);
  await assertNoSymlinkAncestors(dirname(absolute));
  const before = await existing(absolute);
  if (before) {
    assertDirectory(before, absolute);
    return absolute;
  }
  await mkdir(absolute, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertNoSymlinkAncestors(absolute);
  const after = await existing(absolute);
  if (!after) throw new Error(`Private directory was not created: ${absolute}`);
  assertDirectory(after, absolute);
  return absolute;
}

export async function ensurePrivateFile(path) {
  assertPrivateFsCapabilities();
  if (typeof path !== 'string' || !path) throw new Error('Private file path is required');
  const absolute = isAbsolute(path) ? path : resolve(path);
  await ensurePrivateDirectory(dirname(absolute));
  const before = await existing(absolute);
  if (before) {
    assertFile(before, absolute);
    return absolute;
  }
  let handle;
  try {
    handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  } finally {
    await handle?.close();
  }
  await assertNoSymlinkAncestors(absolute);
  const after = await existing(absolute);
  if (!after) throw new Error(`Private file was not created: ${absolute}`);
  assertFile(after, absolute);
  return absolute;
}

export async function writePrivateFileExclusive(path, content) {
  assertPrivateFsCapabilities();
  if (typeof path !== 'string' || !path) throw new Error('Private file path is required');
  const absolute = isAbsolute(path) ? path : resolve(path);
  await ensurePrivateDirectory(dirname(absolute));
  let handle;
  try {
    handle = await open(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    await handle.writeFile(content);
  } finally {
    await handle?.close();
  }
  await assertNoSymlinkAncestors(absolute);
  const after = await existing(absolute);
  if (!after) throw new Error(`Private file was not created: ${absolute}`);
  assertFile(after, absolute);
  return absolute;
}

export async function readPrivateFile(path, { maxBytes, encoding = 'utf8' } = {}) {
  assertPrivateFsCapabilities();
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > PRIVATE_CACHE_MAX_BYTES) throw new Error(`maxBytes must be between 0 and ${PRIVATE_CACHE_MAX_BYTES}`);
  if (typeof path !== 'string' || !path) throw new Error('Private file path is required');
  const absolute = isAbsolute(path) ? path : resolve(path);
  await assertNoSymlinkAncestors(dirname(absolute));
  let handle;
  try {
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    assertFile(stat, absolute);
    if (stat.size > maxBytes) throw new Error(`Private file exceeds the maximum size (${maxBytes} bytes): ${absolute}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error(`Private file exceeded the maximum size while reading: ${absolute}`);
    return buffer.subarray(0, offset).toString(encoding);
  } finally {
    await handle?.close();
  }
}

export const privateModes = Object.freeze({ directory: PRIVATE_DIRECTORY_MODE, file: PRIVATE_FILE_MODE });
export const privateLimits = Object.freeze({ cacheBytes: PRIVATE_CACHE_MAX_BYTES });
