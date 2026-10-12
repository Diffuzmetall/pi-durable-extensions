// Deterministic bare-Harness proof. The search engine is a loopback fixture, never live network.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';

const out = fileURLToPath(new URL('../', import.meta.url));
const target = fileURLToPath(new URL('../src/web-tools.ts', import.meta.url));
const retained = process.env.RETAINED_EVIDENCE ?? join(out, 'evidence', 'bare-' + process.pid);
await mkdir(retained, { recursive: true, mode: 0o700 });
process.env.TMPDIR ??= join(retained, 'tmp');
await mkdir(process.env.TMPDIR, { recursive: true, mode: 0o700 });
const forbidden = process.env.FORBIDDEN_SRC ?? '/home/ubuntu/Projects/pi-pocket/';
const hidden = new Set((process.env.HIDE_PACKAGES ?? '').split(',').filter(Boolean));
const blocked = [];
const loaded = new Set();
let forbiddenAttempts = 0;
const isHidden = (name) => [...hidden].some((pkg) => name === pkg || name.startsWith(pkg + '/') || name.includes('/node_modules/' + pkg + '/'));
const guard = (url) => {
    if (forbidden && url.startsWith('file:') && fileURLToPath(url).startsWith(forbidden)) {
        forbiddenAttempts++;
        throw new Error('FORBIDDEN_POCKET_SRC: ' + url);
    }
};
registerHooks({
    resolve(specifier, context, nextResolve) {
        guard(specifier);
        if (isHidden(specifier)) { blocked.push(specifier); throw new Error('HIDDEN_PACKAGE: ' + specifier); }
        const result = nextResolve(specifier, context);
        guard(result.url);
        if (isHidden(result.url)) { blocked.push(specifier); throw new Error('HIDDEN_PACKAGE: ' + specifier); }
        return result;
    },
    load(url, context, nextLoad) {
        guard(url);
        loaded.add(url);
        return nextLoad(url, context);
    },
});

await assert.rejects(import('file://' + forbidden + '__bare_guard_probe__.ts'), /FORBIDDEN_POCKET_SRC/);
assert.equal(forbiddenAttempts, 1);
console.log('GUARD positive control: rejected forbidden Pocket source import');

const sourceHash = () => readFile(target).then((bytes) => createHash('sha256').update(bytes).digest('hex'));
const before = await sourceHash();
const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
const { createModels } = await import('@earendil-works/pi-ai/models');
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import('@earendil-works/pi-ai/providers/faux');
const { Harness, MemoryStorage, createRegistry, AssistantEntry, ToolResultEntry } = await import('@earendil-works/pi-durable');
const { default: createWebTools } = await import(target);
assert.equal(createWebTools.length, 0);
const extension = createWebTools();
const registry = createRegistry();
registry.install(extension);
assert.deepEqual(extension.tools.map((tool) => tool.name), ['web_search', 'web_fetch', 'batch_web_fetch']);
assert.equal(extension.sections.length, 1);

const paragraph = 'Bare Durable loopback fixture has real HTTP transport and readable article content. '.repeat(40);
const server = createServer((request, response) => {
    if ((request.url ?? '').startsWith('/search')) {
        const article = `http://127.0.0.1:${server.address().port}/article`;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<html><body><div class="result"><a class="result__a" href="${article}">Deterministic local article</a><a class="result__snippet">Loopback search preview</a></div></body></html>`);
        return;
    }
    if (request.url === '/article') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(`<!doctype html><html><head><title>Loopback fixture</title></head><body><nav>poison navigation</nav><article><h1>Loopback fixture</h1><p>${paragraph}</p></article><footer>poison footer</footer></body></html>`);
        return;
    }
    response.writeHead(404);
    response.end('not found');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
const nativeFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (input, options = {}) => {
    const url = String(input);
    networkCalls++;
    if (url.startsWith('https://html.duckduckgo.com/html/')) {
        return nativeFetch(`${base}/search${new URL(url).search}`, options);
    }
    return nativeFetch(input, options);
};

const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100000, models: [{ id: 'faux-1', contextWindow: 100000 }] });
models.setProvider(faux.provider);
const textOf = (message) => message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' }, cwd: out } });

faux.setResponses([
    fauxAssistantMessage([fauxToolCall('web_search', { searches: ['deterministic local fixture'] })], { stopReason: 'toolUse' }),
    (context) => {
        const result = context.messages.findLast((message) => message.role === 'toolResult');
        assert.equal(result.toolName, 'web_search');
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /Deterministic local article/);
        const article = [...textOf(result).matchAll(/\((http:\/\/127\.0\.0\.1:[^\s)]+\/article)\)/g)][0]?.[1];
        assert(article);
        return fauxAssistantMessage([fauxToolCall('web_fetch', { url: article, maxChars: 1000 })], { stopReason: 'toolUse' });
    },
    (context) => {
        const result = context.messages.findLast((message) => message.role === 'toolResult');
        assert.equal(result.toolName, 'web_fetch');
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /Loopback fixture/);
        assert.match(textOf(result), /full text is at/);
        return fauxAssistantMessage([fauxText('Deterministic fixture search and fetch completed.')]);
    },
]);
const settled = await (await root.submit({ type: 'input', content: 'Search the deterministic fixture, then fetch the returned article.' }, ctx)).wait(ctx);
assert.equal(settled.status, 'done');
const entries = [];
let cursor;
do {
    const page = await root.entries({ order: 'ascending' }, 100, cursor, ctx);
    entries.push(...page.items);
    cursor = page.next;
} while (cursor !== undefined);
assert.equal(entries.filter((entry) => ToolResultEntry.is(entry)).length, 2);
const answer = await root.commit((transaction) => transaction.entry(AssistantEntry, settled.answer), ctx);
assert(AssistantEntry.is(answer));
const system = JSON.stringify(entries.filter((entry) => entry.kind === 'pi.system'));
assert(system.includes('web_tools'));
assert(system.includes('Your memory of the web goes stale'));

const fetched = entries.filter((entry) => ToolResultEntry.is(entry))[1];
const fetchedText = textOf(fetched.model[0]);
const spill = /full text is at ([^\s)]+)/.exec(fetchedText)?.[1];
assert(spill?.startsWith(join(process.env.TMPDIR, 'pi-durable-web-tools') + '/'));
assert((await readFile(spill, 'utf8')).includes('Bare Durable loopback fixture'));

faux.setResponses([
    fauxAssistantMessage([fauxToolCall('batch_web_fetch', { requests: [{ url: `${base}/article`, maxChars: 40000 }, { url: `${base}/article`, format: 'text', maxChars: 40000 }] })], { stopReason: 'toolUse' }),
    (context) => {
        const result = context.messages.findLast((message) => message.role === 'toolResult');
        assert.equal(result.toolName, 'batch_web_fetch');
        assert.equal(result.isError, false, textOf(result));
        assert.match(textOf(result), /## Page 2:/);
        assert.doesNotMatch(textOf(result), /Error:/);
        return fauxAssistantMessage('Batch loopback fixture completed.');
    },
]);
const batch = await (await root.submit({ type: 'input', content: 'Fetch two deterministic fixture representations.' }, ctx)).wait(ctx);
assert.equal(batch.status, 'done');
assert(networkCalls > 0);
assert.equal(await sourceHash(), before, 'candidate source changed during Harness run');
for (const packageName of hidden) assert(blocked.some((name) => name === packageName || name.startsWith(packageName + '/')), `hidden package was not attempted: ${packageName}`);

await writeFile(join(retained, 'modules.json'), JSON.stringify([...loaded].sort(), null, 2) + '\n');
await writeFile(join(retained, 'run.json'), JSON.stringify({
    node: process.version,
    sourceSha256: before,
    forbiddenPocketAttempts: forbiddenAttempts,
    pocketSourceLoaded: 0,
    hiddenAttempts: blocked,
    fixtureNetworkCalls: networkCalls,
    liveSearch: false,
    harness: 'real Harness + MemoryStorage + faux provider',
}, null, 2) + '\n');
console.log('PASS deterministic loopback web_search -> web_fetch -> spill -> batch; no live search; no Pocket source; source hash unchanged');
