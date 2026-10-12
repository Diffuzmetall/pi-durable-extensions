import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const shimPort = Number(process.env.SHIM_FIXTURE_PORT ?? 19190);
const upstreamPort = Number(process.env.UPSTREAM_FIXTURE_PORT ?? 19191);
const base = `http://127.0.0.1:${shimPort}`;
const upstream = `http://127.0.0.1:${upstreamPort}/events`;

let fake;
let shim;

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture did not start: ${url}`);
}

async function startChildren() {
  fake = spawn(process.execPath, ["tests/fake-upstream.mjs", String(upstreamPort)], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: "ignore",
  });
  shim = spawn(process.execPath, ["run.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      PI_ANTIGRAVITY_DIR: process.env.PI_ANTIGRAVITY_DIR ?? "/home/ubuntu/.pi/agent/npm/node_modules/pi-antigravity",
      NODE_ENV: "test",
      ANTIGRAVITY_SHIM_PORT: String(shimPort),
      ANTIGRAVITY_SHIM_FIXTURE_URL: upstream,
    },
    stdio: "ignore",
  });
  await waitFor(`${base}/healthz`);
}

function stopChildren() {
  // Process termination is test isolation; no files, directories, or service state are deleted.
  fake?.kill("SIGTERM");
  shim?.kill("SIGTERM");
}

test("isolated fake upstream and OpenAI-compatible client path", async (t) => {
  t.after(stopChildren);
  await startChildren();

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.provider, "antigravity-shim");
  assert.ok(health.models > 0);

  const models = await (await fetch(`${base}/v1/models`)).json();
  assert.ok(models.data.some((model) => model.id === "gemini-3.8-flash"));

  const streamResponse = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer ignored" },
    body: JSON.stringify({
      model: "gemini-3.8-flash",
      stream: true,
      messages: [{ role: "user", content: "fixture" }],
      tools: [{ type: "function", function: { name: "clock", parameters: { type: "object" } } }],
    }),
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /fixture-ok/);
  assert.match(streamText, /fixture-call/);
  assert.match(streamText, /tool_calls/);
  assert.match(streamText, /\[DONE\]/);

  const oneShotResponse = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "fixture" }] }),
  });
  assert.equal(oneShotResponse.status, 200);
  const oneShot = await oneShotResponse.json();
  assert.equal(oneShot.choices[0].message.content, "fixture-ok");
  assert.equal(oneShot.choices[0].finish_reason, "tool_calls");
  assert.equal(oneShot.usage.total_tokens, 5);

  const unknown = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "not-a-model", messages: [] }),
  });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.type, "model_not_found");

  const malformed = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error.message, /valid JSON/);
});
