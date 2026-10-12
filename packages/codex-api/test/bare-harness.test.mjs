import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const candidateRoot = fileURLToPath(new URL("..", import.meta.url));
const forbiddenRoot = "/home/ubuntu/Projects/pi-pocket/src";
const loaded = new Set();
let forbiddenAttempts = 0;
const isForbidden = (value) => value.includes(forbiddenRoot);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (isForbidden(specifier)) {
      forbiddenAttempts++;
      throw new Error("FORBIDDEN_POCKET_SRC: " + specifier);
    }
    const resolved = nextResolve(specifier, context);
    if (isForbidden(resolved.url)) {
      forbiddenAttempts++;
      throw new Error("FORBIDDEN_POCKET_SRC: " + resolved.url);
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    if (isForbidden(url)) {
      forbiddenAttempts++;
      throw new Error("FORBIDDEN_POCKET_SRC: " + url);
    }
    loaded.add(url);
    return nextLoad(url, context);
  },
});

await assert.rejects(
  import("file:///home/ubuntu/Projects/pi-pocket/src/__portable_guard_probe__.ts"),
  /FORBIDDEN_POCKET_SRC/,
);
assert.equal(forbiddenAttempts, 1);

const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { Harness, MemoryStorage, createRegistry, ToolResultEntry } = await import("@earendil-works/pi-durable");
const { default: createCodexApi } = await import("../src/index.ts");

const fixtureAccess = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const models = createModels({
  credentials: {
    async read() { return { type: "oauth", access: fixtureAccess, refresh: "fixture-refresh", expires: Date.now() + 3600000 }; },
    async list() { return [{ providerId: "openai-codex", type: "oauth" }]; },
    async modify(_provider, fn) { return fn({ type: "oauth", access: fixtureAccess, refresh: "fixture-refresh", expires: Date.now() + 3600000 }); },
    async delete() {},
  },
});
const faux = fauxProvider({ provider: "openai-codex", api: "openai-codex-responses", models: [{ id: "fixture", input: ["text", "image"], reasoning: false }], tokensPerSecond: 100000 });
faux.provider.auth = {
  oauth: {
    name: "Fixture Codex OAuth",
    isSubscription: true,
    async login() { throw new Error("login is not used by this fixture"); },
    async refresh(credential) { return credential; },
    async toAuth() { return { apiKey: fixtureAccess }; },
  },
};
models.setProvider(faux.provider);

const apiCalls = [];
const nativeFetch = globalThis.fetch;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const server = createServer((_req, res) => {
  apiCalls.push(_req.url);
  res.writeHead(200, { "content-type": "application/json" });
  if (_req.url?.endsWith("/wham/usage")) {
    res.end(JSON.stringify({ rate_limit: { primary_window: { used_percent: 7, reset_after_seconds: 30 } } }));
  } else if (_req.url?.endsWith("/images/generations")) {
    res.end(JSON.stringify({ data: [{ b64_json: png }] }));
  } else {
    res.end(JSON.stringify({ output: "fixture search answer", results: [{ ref_id: "turn0search0", title: "Fixture", url: "https://example.org/fixture" }] }));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === "chatgpt.com") {
    return nativeFetch(fixtureOrigin + url.pathname, init);
  }
  return nativeFetch(input, init);
};

const host = { authorize: async () => true };
const extension = createCodexApi(host);
const registry = createRegistry();
registry.install(extension);
assert.deepEqual(extension.tools?.map((tool) => tool.name), ["codex_ask", "codex_search", "codex_image", "codex_usage"]);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
try {
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "openai-codex", modelId: "fixture" }, cwd: candidateRoot } });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codex_search", { search_query: [{ q: "portable fixture" }] })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(result.toolName, "codex_search");
      assert.equal(result.isError, false);
      return fauxAssistantMessage([fauxText("Harness completed a real codex_search tool invocation.")]);
    },
  ]);
  const settled = await (await root.submit({ type: "input", content: "Search the portable fixture." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, "done");
  const entries = (await root.entries({ order: "descending" }, 20, undefined, BACKGROUND_CONTEXT)).items;
  assert(entries.some((entry) => ToolResultEntry.is(entry) && entry.model?.some((message) => message.toolName === "codex_search")));
  assert.equal(apiCalls.length, 1);

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codex_ask", { prompt: "Return the fixture answer." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Codex scripted answer")]),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(result.toolName, "codex_ask");
      assert.equal(result.isError, false);
      return fauxAssistantMessage([fauxText("Harness completed codex_ask through the native Models collection.")]);
    },
  ]);
  const askSettled = await (await root.submit({ type: "input", content: "Ask Codex for a fixture answer." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(askSettled.status, "done");

  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codex_usage", {})], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(result.toolName, "codex_usage");
      assert.equal(result.isError, false);
      assert.match(result.content.map((item) => item.type === "text" ? item.text : "").join(""), /7% used/);
      return fauxAssistantMessage([fauxText("Harness completed codex_usage without exposing account data.")]);
    },
  ]);
  const usageSettled = await (await root.submit({ type: "input", content: "Read subscription usage." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(usageSettled.status, "done");

  const outputPath = `output/harness-image-${Date.now()}.png`;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codex_image", { prompt: "Generate a fixture pixel.", output_path: outputPath })], { stopReason: "toolUse" }),
    (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      assert.equal(result.toolName, "codex_image");
      assert.equal(result.isError, false);
      return fauxAssistantMessage([fauxText("Harness completed codex_image with a retained PNG fixture.")]);
    },
  ]);
  const imageSettled = await (await root.submit({ type: "input", content: "Generate the fixture pixel." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(imageSettled.status, "done");
  assert(apiCalls.some((url) => url?.endsWith("/images/generations")));
  assert(apiCalls.some((url) => url?.endsWith("/wham/usage")));
} finally {
  await harness.close(BACKGROUND_CONTEXT);
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = nativeFetch;
}

const realLoaded = await Promise.all([...loaded].filter((url) => url.startsWith("file:")).map((url) => realpath(fileURLToPath(url))));
assert(!realLoaded.some((path) => path.startsWith(forbiddenRoot)));
console.log(JSON.stringify({ harness: "PASS", tool: "codex_search", fixtureRequests: apiCalls.length, forbiddenPocketImports: forbiddenAttempts, loadedCandidate: realLoaded.filter((path) => path.startsWith(candidateRoot)).length }));
