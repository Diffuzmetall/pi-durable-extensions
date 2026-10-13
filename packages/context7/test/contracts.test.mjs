import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createContext7 from '../src/context7-mcp.ts';
import { fixture, KEY, UA } from './fixture.mjs';

const args = { libraryId: '/fixture/library/v1', query: 'one question' };
const resolveArgs = { libraryName: 'fixture', query: 'one question' };
const text = result => result.content.map(block => block.text).join('\n');
const call = (extension, value = args, signal, resolve = false) => extension.tools[resolve ? 0 : 1].execute(value, undefined, { abortSignal: signal });
const source = await readFile(new URL('../src/context7-mcp.ts', import.meta.url), 'utf8');
const originalFetch = globalThis.fetch;
const originalEnv = process.env;
const originalKey = process.env.CONTEXT7_API_KEY;
const originalKeyFile = process.env.CONTEXT7_KEY_FILE;

test.after(() => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  if (originalKey === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = originalKey;
  if (originalKeyFile === undefined) delete process.env.CONTEXT7_KEY_FILE; else process.env.CONTEXT7_KEY_FILE = originalKeyFile;
});

test('candidate has no Pocket runtime imports and exposes two unsafe tools', async () => {
  assert.doesNotMatch(source, /(?:PocketApp|src\/server|PI_POCKET)/i);
  assert.doesNotMatch(source, /(?:from|import)\s+[^\n]*pocket/i);
  const extension = createContext7();
  assert.equal(extension.name, 'context7-mcp');
  assert.deepEqual(extension.tools.map(tool => tool.name), ['context7_resolve_library_id', 'context7_query_docs']);
  assert.ok(extension.tools.every(tool => tool.replay === 'unsafe'));
  assert.equal(extension.tools[0].parameters.additionalProperties, false);
  assert.equal(extension.tools[1].parameters.properties.query.maxLength, 8192);
});

test('invalid input and pre-cancel fail before key access or HTTP', async () => {
  let keyReads = 0;
  let requests = 0;
  process.env = new Proxy(process.env, { get(target, key) { if (key === 'CONTEXT7_API_KEY') keyReads++; return target[key]; } });
  globalThis.fetch = async () => { requests++; throw Error('unexpected network'); };
  try {
    const extension = createContext7();
    for (const value of [null, {}, { ...args, query: '' }, { ...args, query: 'x'.repeat(8193) }, { ...args, extra: 'x' }, { ...args, language: undefined }]) {
      const result = await call(extension, value);
      assert.equal(text(result), 'Context7 arguments are invalid');
    }
    assert.equal(text(await call(extension, args, AbortSignal.abort('cancel'))), 'Context7 request cancelled');
    assert.equal(keyReads, 0);
    assert.equal(requests, 0);
  } finally { process.env = originalEnv; }
});

test('missing and malformed credentials fail before initialize, call, or cleanup', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('unexpected network'); };
  delete process.env.CONTEXT7_KEY_FILE;
  for (const key of [undefined, '', ' \t']) {
    if (key === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = key;
    assert.equal(text(await call(createContext7({ credentialFile: join(tmpdir(), 'missing-context7-' + Date.now()) }))), 'Context7 credential is missing');
  }
  for (const key of ['bad\r\nkey', 'a b', 'é']) {
    process.env.CONTEXT7_API_KEY = key;
    assert.equal(text(await call(createContext7())), 'Context7 credential is invalid');
  }
  assert.equal(requests, 0);
  process.env.CONTEXT7_API_KEY = KEY;
});

test('credential files follow option, dataDir, key-file environment, and key-value precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'context7-credentials-'));
  const explicit = join(root, 'explicit.env');
  const dataDir = join(root, 'data');
  const environment = join(root, 'environment.env');
  await mkdir(dataDir);
  await writeFile(explicit, `CONTEXT7_API_KEY=${KEY}\n`);
  await writeFile(join(dataDir, 'context7.env'), `CONTEXT7_API_KEY=${KEY}\n`);
  await writeFile(environment, `CONTEXT7_API_KEY=${KEY}\n`);
  delete process.env.CONTEXT7_API_KEY;
  process.env.CONTEXT7_KEY_FILE = environment;
  for (const options of [{ credentialFile: explicit }, { dataDir }, {}]) {
    const remote = await fixture();
    globalThis.fetch = remote.fetch;
    try { assert.match(text(await call(createContext7(options))), /fixture documentation/); }
    finally { await remote.close(); }
  }
  const envKey = 'environment-wins';
  process.env.CONTEXT7_API_KEY = envKey;
  const remote = await fixture({ expectedKey: envKey });
  globalThis.fetch = remote.fetch;
  try {
    assert.match(text(await call(createContext7({ credentialFile: explicit }))), /fixture documentation/);
    assert.ok(remote.trace.every(entry => entry.authorized));
  } finally { await remote.close(); }
  process.env.CONTEXT7_API_KEY = KEY;
});

for (const sse of [false, true]) test(`real installed MCP client maps resolve/query via ${sse ? 'SSE' : 'JSON'}`, async () => {
  const remote = await fixture({ sse });
  globalThis.fetch = remote.fetch;
  process.env.CONTEXT7_API_KEY = KEY;
  try {
    assert.equal(text(await call(createContext7(), resolveArgs, undefined, true)), '/fixture/library/v1');
    assert.match(text(await call(createContext7())), /fixture documentation/);
    assert.ok(remote.trace.every(entry => entry.authorized && entry.ua === UA));
    assert.deepEqual(remote.trace.map(entry => entry.method), ['initialize', 'notifications/initialized', 'tools/call', 'DELETE', 'initialize', 'notifications/initialized', 'tools/call', 'DELETE']);
  } finally { await remote.close(); }
});

test('HTTP errors, redirects and remote MCP errors are sanitized without retries', async () => {
  for (const [status, expected] of [[401, /authentication rejected/], [403, /access denied/], [429, /rate\/quota/], [500, /transport failure/]]) {
    const remote = await fixture({ respond({ res, method }) {
      if (method !== 'tools/call') return false;
      res.writeHead(status, { location: 'http://127.0.0.1:1/secret' }); res.end('Authorization: Bearer ' + KEY + ' private body'); return true;
    } });
    globalThis.fetch = remote.fetch; process.env.CONTEXT7_API_KEY = KEY;
    try { const result = await call(createContext7()); assert.match(text(result), expected); assert.equal(text(result).includes(KEY), false); assert.equal(remote.trace.filter(entry => entry.method === 'tools/call').length, 1); }
    finally { await remote.close(); }
  }
  const redirect = await fixture({ respond({ res, method }) {
    if (method !== 'tools/call') return false;
    res.writeHead(302, { location: 'http://127.0.0.1:1/refused' }); res.end(); return true;
  } });
  globalThis.fetch = redirect.fetch; process.env.CONTEXT7_API_KEY = KEY;
  try {
    assert.equal(text(await call(createContext7())), 'Context7 redirect refused');
    assert.equal(redirect.trace.filter(entry => entry.method === 'tools/call').length, 1);
  } finally { await redirect.close(); }

  const remote = await fixture({ respond({ res, rpc, method }) {
    if (method !== 'tools/call') return false;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: KEY, data: { private: KEY } } })); return true;
  } });
  globalThis.fetch = remote.fetch; process.env.CONTEXT7_API_KEY = KEY;
  try { assert.equal(text(await call(createContext7())), 'Context7 MCP/server-tool error'); }
  finally { await remote.close(); }
});

test('rendering preserves isError, redaction, binary omission, and 6144/512 bounds', async () => {
  const remote = await fixture({ result: { isError: true, content: [{ type: 'text', text: 'secret ' + KEY + ' ' + '🙂'.repeat(10000) }, { type: 'image', data: KEY, mimeType: 'image/png' }] } });
  globalThis.fetch = remote.fetch; process.env.CONTEXT7_API_KEY = KEY;
  try {
    const result = await call(createContext7());
    assert.equal(result.isError, true);
    assert.equal(text(result).includes(KEY), false);
    assert.ok(text(result).endsWith('[Context7 output truncated]'));
    assert.ok(Buffer.byteLength(text(result)) <= 6144);
    assert.ok(text(result).split('\n').length <= 512);
    assert.equal(text(result).includes('�'), false);
  } finally { await remote.close(); }
});

test('line bounding keeps the marker within 512 logical lines', async () => {
  const remote = await fixture({ result: { content: [{ type: 'text', text: Array.from({ length: 700 }, (_, index) => `line-${index}`).join('\n') }] } });
  globalThis.fetch = remote.fetch; process.env.CONTEXT7_API_KEY = KEY;
  try {
    const rendered = text(await call(createContext7()));
    assert.ok(rendered.endsWith('[Context7 output truncated]'));
    assert.ok(rendered.split('\n').length <= 512);
    assert.ok(Buffer.byteLength(rendered) <= 6144);
  } finally { await remote.close(); }
});

test('caller cancellation is controlled and cleanup is attempted', async () => {
  const remote = await fixture({ respond({ res, method }) { if (method === 'tools/call') return true; return false; } });
  globalThis.fetch = remote.fetch; process.env.CONTEXT7_API_KEY = KEY;
  const controller = new AbortController();
  try {
    const pending = call(createContext7(), args, controller.signal);
    for (let attempt = 0; attempt < 100 && !remote.trace.some(entry => entry.method === 'tools/call'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    controller.abort('test cancellation');
    assert.equal(text(await pending), 'Context7 request cancelled');
    assert.ok(remote.trace.some(entry => entry.method === 'tools/call'));
  } finally { await remote.close(); }
});
