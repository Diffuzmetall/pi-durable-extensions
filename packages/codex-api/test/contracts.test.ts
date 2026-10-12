import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import {
  createPocketAdapter,
  createUsageTool,
  makeRuntime,
  usageText,
  type CodexHost,
} from "../src/index.ts";

const model = {
  id: "fixture",
  provider: "openai-codex",
  api: "openai-codex-responses",
  input: ["text", "image"],
};
const access = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;

function fixture(overrides: Record<string, unknown> = {}) {
  const cwd = "/fixture-work";
  const api = {
    conversationId: "fixture-conversation",
    agent: async () => ({ cwd, model }),
    models: {
      getAvailable: async () => [model],
      checkAuth: async () => ({ type: "oauth" }),
      getAuth: async () => ({ auth: { apiKey: access } }),
    },
    ...overrides,
  } as unknown as ToolExecutionApi;
  const host: CodexHost = { authorize: async () => true };
  return { api, host };
}

test("portable runtime denies before models and never reads host configuration", async () => {
  let agentCalls = 0;
  const f = fixture({ agent: async () => { agentCalls++; return { cwd: "/fixture-work", model }; } });
  const denied: CodexHost = { authorize: async () => false };
  await assert.rejects(makeRuntime(f.api, BACKGROUND_CONTEXT, denied), /owner requester/);
  assert.equal(agentCalls, 0);
});

test("explicit upload-root capability permits current uploads and denies siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-portable-upload-"));
  const cwd = join(root, "work");
  const uploads = join(root, "uploads", "fixture-conversation");
  const sibling = join(root, "uploads", "other-conversation");
  await mkdir(cwd, { recursive: true });
  await mkdir(uploads, { recursive: true });
  await mkdir(sibling, { recursive: true });
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(join(uploads, "image.png"), png);
  await writeFile(join(sibling, "image.png"), png);
  const f = fixture({ agent: async () => ({ cwd, model }) });
  const host: CodexHost = { authorize: async () => true, uploadRoot: () => uploads };
  const runtime = await makeRuntime(f.api, BACKGROUND_CONTEXT, host);
  try {
    assert.equal((await runtime.images([uploads + "/image.png"])).length, 1);
    await assert.rejects(runtime.images([sibling + "/image.png"]), /valid bounded image/);
  } finally {
    runtime.close();
  }
});

test("cancelled runtime performs no second request and unsafe usage remains marked", async () => {
  const f = fixture();
  let calls = 0;
  const controller = new AbortController();
  const runtime = await makeRuntime(f.api, withAbortSignal(controller.signal, BACKGROUND_CONTEXT), f.host, {
    fetch: async () => { calls++; return new Promise<Response>(() => {}); },
    deadlineMs: 50,
  });
  controller.abort();
  await assert.rejects(runtime.request("../wham/usage"), /cancelled|timed out/);
  assert.equal(calls, 0);
  runtime.close();
  assert.equal(createUsageTool(f.host).replay, "unsafe");
});

test("usage output is quota-only and redacts account-shaped fields", () => {
  const text = usageText({
    rate_limit: { primary_window: { used_percent: 12.4, reset_after_seconds: 19 } },
    account_id: "secret-account",
    credits: 999,
  });
  assert.match(text, /12\.4% used/);
  assert.doesNotMatch(text, /secret-account|credits/);
});

test("optional Pocket adapter preserves owner semantics without a Pocket import", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "codex-portable-adapter-"));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ users: [{ id: "owner", role: "owner" }, { id: "guest", role: "member" }] }));
  const adapter = createPocketAdapter({ dataDir, requesterOf: () => "owner" });
  assert.equal(await adapter.authorize({ conversationId: 1 as ToolExecutionApi["conversationId"], api: {} as ToolExecutionApi }), true);
  const guest = createPocketAdapter({ dataDir, requesterOf: () => "guest" });
  assert.equal(await guest.authorize({ conversationId: 1 as ToolExecutionApi["conversationId"], api: {} as ToolExecutionApi }), false);
  assert.equal(await adapter.uploadRoot?.("1"), join(dataDir, "uploads", "1"));
});
