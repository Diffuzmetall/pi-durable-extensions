// Run with Node >=22.19 from this package after npm install --ignore-scripts.
// The HTTP server is a retained loopback fixture; no live network is used.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable';
import createWebTools from '../src/web-tools.ts';

const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>Portable fixture</title></head><body><article><h1>Portable fixture</h1><p>Fetched through a real bare Durable Harness.</p></article></body></html>');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
server.unref();
const url = `http://127.0.0.1:${server.address().port}/article`;

const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100000, models: [{ id: 'faux-1', contextWindow: 100000 }] });
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(createWebTools());
const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, cwd: process.cwd() } });
const resultText = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
faux.setResponses([
    fauxAssistantMessage([fauxToolCall('web_fetch', { url, format: 'text', maxChars: 4000 })], { stopReason: 'toolUse' }),
    (turn) => fauxAssistantMessage([fauxText(resultText(turn.messages.findLast((message) => message.role === 'toolResult')))]),
]);
const settled = await (await root.submit({ type: 'input', content: `Fetch ${url}` }, context)).wait(context);
console.log(JSON.stringify({ status: settled.status, tool: 'web_fetch', url, harness: 'bare Durable + MemoryStorage', liveNetwork: false }, null, 2));
