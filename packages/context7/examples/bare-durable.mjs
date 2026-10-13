// Run with Node >=22.19 from this package after npm install --ignore-scripts.
// The HTTP server is a retained loopback fixture; no live Context7 request is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import createContext7 from '../src/context7-mcp.ts';

const source = await readFile(new URL('../src/context7-mcp.ts', import.meta.url), 'utf8');
const forbidden = /(?:PocketApp|src\/server|PI_POCKET)/i;
assert.equal(forbidden.test(source), false, 'extension contains a Pocket-only import/reference');
assert.throws(() => { if (forbidden.test("import { PocketApp } from '/home/pi-pocket/src/server/app.ts'")) throw Error('forbidden import'); }, /forbidden import/);

const key = 'synthetic-context7-fixture-key';
const userAgent = 'pi-durable-context7/0.1.0-candidate.1';
const trace = [];
let session = 0;
const server = createServer(async (request, response) => {
  let input = '';
  for await (const chunk of request) input += chunk;
  const rpc = input ? JSON.parse(input) : undefined;
  const method = rpc?.method ?? request.method;
  trace.push({ method, authorized: request.headers.authorization === `Bearer ${key}`, ua: request.headers['user-agent'] });
  if (request.method === 'DELETE' || rpc?.id === undefined) { response.writeHead(202); response.end(); return; }
  const result = method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'loopback-context7', version: '1' } }
    : { content: [{ type: 'text', text: 'fixture documentation https://example.invalid/source' }] };
  if (method === 'initialize') response.setHeader('Mcp-Session-Id', `fixture-${++session}`);
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
const nativeFetch = globalThis.fetch;
const originalKey = process.env.CONTEXT7_API_KEY;
globalThis.fetch = async (input, init = {}) => {
  assert.equal(String(input), 'https://mcp.context7.com/mcp');
  assert.equal(init.redirect, 'error');
  assert.equal(new Headers(init.headers).get('User-Agent'), userAgent);
  return nativeFetch(endpoint, init);
};
process.env.CONTEXT7_API_KEY = key;

const model = fauxProvider({ tokensPerSecond: 2000, models: [{ id: 'context7-fixture' }] });
model.setResponses([
  () => fauxAssistantMessage([fauxToolCall('context7_query_docs', { libraryId: '/fixture/library/v1', query: 'one question' })], { stopReason: 'toolUse' }),
  request => fauxAssistantMessage([fauxText('harness-result:' + JSON.stringify(request.messages.at(-1)?.content))]),
]);
const registry = createRegistry();
registry.install(createContext7());
const models = createModels();
models.setProvider(model.provider);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
try {
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'context7-fixture' } } });
  const settled = await (await conversation.submit({ type: 'input', content: 'docs' }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, 'done');
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const toolResult = view.messages.findLast(message => message.role === 'toolResult');
  assert.ok(toolResult, 'real Harness did not invoke the extension tool');
  assert.match(JSON.stringify(toolResult.content), /fixture documentation/);
  assert.ok(trace.some(entry => entry.method === 'tools/call'));
  assert.ok(trace.every(entry => entry.authorized && entry.ua === userAgent));
  console.log(JSON.stringify({ status: 'PASS', harness: 'real @earendil-works/pi-durable Harness', tool: toolResult.toolName, pocketImportGuard: 'positive-control-and-extension-pass', methods: trace.map(entry => entry.method) }));
} finally {
  await harness.close(BACKGROUND_CONTEXT);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  globalThis.fetch = nativeFetch;
  if (originalKey === undefined) delete process.env.CONTEXT7_API_KEY; else process.env.CONTEXT7_API_KEY = originalKey;
}
