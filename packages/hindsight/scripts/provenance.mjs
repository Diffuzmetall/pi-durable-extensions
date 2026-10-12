import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const vendor = new URL('../src/vendor/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const p = JSON.parse(await readFile(new URL('provenance.json', vendor), 'utf8'));
const bundle = await readFile(new URL('pi.mjs', vendor));
assert.equal(p.version, '0.8.0');
assert.equal(hash(bundle), p.vendoredSha256);
assert.equal(hash(bundle.subarray(0, p.patchedPrefixBytes)), p.patchedPrefixSha256);
let restored = bundle.subarray(0, p.patchedPrefixBytes).toString();
for (const patch of [...p.localPatches].reverse()) {
  assert.equal(restored.split(patch.to).length, 2, `Unique reversible patch: ${patch.scope}`);
  restored = restored.replace(patch.to, patch.from);
}
assert.equal(Buffer.byteLength(restored), p.sourceBytes);
assert.equal(hash(restored), p.sourceSha256);
for (const [name, digest] of Object.entries(p.companions)) assert.equal(hash(await readFile(new URL(name, vendor))), digest, name);
const core = JSON.parse(await readFile(new URL('../provenance.json', import.meta.url), 'utf8'));
assert.equal(hash(await readFile(new URL('../LICENSE', import.meta.url))), core.licenseSha256);
for (const file of core.files) assert.equal(hash(await readFile(new URL(`../${file.destination}`, import.meta.url))), file.extractedSha256, file.destination);
const manifest = core.contentManifest;
assert.equal(manifest.current, true);
assert.equal(manifest.pointer, 'provenance.json#contentManifest');
const canonical = [];
for (const file of manifest.files) {
  const bytes = await readFile(new URL(`../${file.path}`, import.meta.url));
  assert.equal(bytes.length, file.bytes, file.path);
  assert.equal(hash(bytes), file.sha256, file.path);
  canonical.push(`${file.path}\t${file.bytes}\t${file.sha256}\n`);
}
assert.equal(manifest.fileCount, manifest.files.length);
assert.equal(hash(Buffer.from(canonical.join(''))), manifest.canonicalSha256);
console.log(`Provenance OK: ${p.sourceSha256} -> ${p.vendoredSha256}; content manifest ${manifest.canonicalSha256}`);
