import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import createAgentMailMcp, { AGENT_MAIL_TOOL_NAMES } from "../src/index.ts";

const EXPECTED_TOOL_NAMES = [
  "health_check", "ensure_project", "register_agent", "create_agent_identity", "retire_agent",
  "unretire_agent", "deregister_agent", "whois", "resolve_pane_identity", "cleanup_pane_identities",
  "list_agents", "send_message", "reply_message", "fetch_inbox", "fetch_topic", "fetch_inbox_events",
  "mark_message_read", "mark_all_read", "acknowledge_message", "get_message_delivery_receipt",
  "request_contact", "respond_contact", "list_contacts", "set_contact_policy",
  "check_file_reservation_conflicts", "file_reservation_paths", "release_file_reservations",
  "renew_file_reservations", "force_release_file_reservation", "install_precommit_guard",
  "uninstall_precommit_guard", "search_messages", "summarize_thread", "macro_start_session",
  "macro_prepare_thread", "macro_file_reservation_cycle", "macro_contact_handshake", "ensure_product",
  "products_link", "search_messages_product", "fetch_inbox_product", "summarize_thread_product",
  "acquire_build_slot", "renew_build_slot", "release_build_slot",
];

type RequestRecord = { method: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

async function startFixture(delayMs = 0) {
  const requests: RequestRecord[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp/" || request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    requests.push({ method: String(body.method), headers: request.headers, body });
    const id = body.id;
    const method = body.method;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (method === "initialize") {
      respond(response, { jsonrpc: "2.0", id, result: {
        protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "retained-fixture", version: "1.0.0" },
      }});
      return;
    }
    if (method === "notifications/initialized") {
      response.writeHead(202).end();
      return;
    }
    if (method === "tools/call") {
      const params = body.params as { name?: string };
      respond(response, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `fixture:${params.name}` }] } });
      return;
    }
    respond(response, { jsonrpc: "2.0", id, result: {} });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, requests, endpoint: `http://127.0.0.1:${address.port}/mcp/` };
}

function respond(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function writeConfig(agentDir: string, endpoint: string, headers?: Record<string, string>): void {
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({
    mcpServers: { "mcp-agent-mail": { url: endpoint, ...(headers === undefined ? {} : { headers }) } },
  }));
}

test("catalog, extension name, import guard and replay policy are exact", async () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["'][^"']*pocket/i);
  assert.doesNotMatch(source, /\/home\/ubuntu\/Projects\/pi-pocket/);
  assert.doesNotMatch(source, /User-Agent|XaiImageApiFetch|OpenAI File Downloader/);

  assert.equal(AGENT_MAIL_TOOL_NAMES.length, 45);
  assert.deepEqual(AGENT_MAIL_TOOL_NAMES, EXPECTED_TOOL_NAMES);
  const extension = createAgentMailMcp({ agentDir: mkdtempSync(join(tmpdir(), "agent-mail-contract-")) });
  assert.equal(extension.name, "agent-mail-mcp-health");
  const tools = extension.tools ?? [];
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_TOOL_NAMES.map((name) => `mcp__mcp_agent_mail__${name}`));
  assert.equal((tools.find((tool) => tool.name.endsWith("health_check")) as { replay: string }).replay, "safe");
  assert.ok(tools.filter((tool) => tool.name.endsWith("health_check") === false).every((tool) => (tool as { replay: string }).replay === "unsafe"));
});

test("real Harness invokes health_check through an isolated loopback MCP fixture", async (t) => {
  const fixture = await startFixture();
  t.after(async () => fixture.server.close());
  const agentDir = mkdtempSync(join(tmpdir(), "agent-mail-harness-"));
  writeConfig(agentDir, fixture.endpoint);

  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("mcp__mcp_agent_mail__health_check", {})], { stopReason: "toolUse" }),
    turn => {
      const message = turn.messages.findLast(m => m.role === "toolResult");
      assert.ok(message?.role === "toolResult");
      assert.match(message.content.map(part => part.type === "text" ? part.text : "").join(""), /fixture:health_check/);
      return fauxAssistantMessage([fauxText("fixture complete")]);
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(createAgentMailMcp({ agentDir, endpoint: fixture.endpoint }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
  t.after(async () => harness.close(BACKGROUND_CONTEXT));
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  const settled = await (await root.submit({ type: "input", content: "check health" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);

  assert.equal(settled.status, "done");
  assert.deepEqual(fixture.requests.map((request) => request.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.equal((fixture.requests.at(-1)?.body.params as { name: string }).name, "health_check");
  assert.equal(fixture.requests.at(-1)?.headers["x-agent-mail-test"], undefined);
});

test("cancellation and transport failures are bounded and redact response/config data", async (t) => {
  const fixture = await startFixture(250);
  t.after(async () => fixture.server.close());
  const agentDir = mkdtempSync(join(tmpdir(), "agent-mail-cancel-"));
  writeConfig(agentDir, fixture.endpoint);
  const health = (createAgentMailMcp({ agentDir, endpoint: fixture.endpoint }).tools ?? []).find((tool) => tool.name.endsWith("health_check"));
  assert.ok(health);
  const controller = new AbortController();
  setTimeout(() => controller.abort("test cancellation"), 10);
  await assert.rejects(
    () => health.execute({}, {} as never, { abortSignal: controller.signal } as never),
    (error: unknown) => error instanceof Error && error.message === "Agent Mail MCP call timed out or was cancelled." && !error.message.includes("fixture"),
  );

  const unavailableDir = mkdtempSync(join(tmpdir(), "agent-mail-unavailable-"));
  writeConfig(unavailableDir, "http://127.0.0.1:1/mcp/");
  const unavailable = (createAgentMailMcp({ agentDir: unavailableDir, endpoint: "http://127.0.0.1:1/mcp/" }).tools ?? []).find((tool) => tool.name.endsWith("health_check"));
  assert.ok(unavailable);
  await assert.rejects(
    () => unavailable.execute({}, {} as never, { abortSignal: undefined } as never),
    (error: unknown) => error instanceof Error && error.message === "Agent Mail MCP call failed; its external effect may be unknown. Inspect server state before retrying.",
  );
});

test("endpoint and header guards fail closed without leaking config", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "agent-mail-guard-"));
  writeConfig(agentDir, "http://127.0.0.1:8765/mcp/", { Authorization: "secret-do-not-leak" });
  const extension = createAgentMailMcp({ agentDir });
  const health = (extension.tools ?? []).find((tool) => tool.name.endsWith("health_check"));
  assert.ok(health);
  await assert.rejects(
    () => health.execute({}, {} as never, { abortSignal: undefined } as never),
    (error: unknown) => error instanceof Error && error.message.includes("without custom headers") && !error.message.includes("secret"),
  );

  const wrongEndpointDir = mkdtempSync(join(tmpdir(), "agent-mail-endpoint-"));
  writeConfig(wrongEndpointDir, "http://127.0.0.1:8766/mcp/");
  const wrongEndpoint = (createAgentMailMcp({ agentDir: wrongEndpointDir }).tools ?? []).find((tool) => tool.name.endsWith("health_check"));
  assert.ok(wrongEndpoint);
  await assert.rejects(
    () => wrongEndpoint.execute({}, {} as never, { abortSignal: undefined } as never),
    (error: unknown) => error instanceof Error && error.message.includes("http://127.0.0.1:8765/mcp/") && !error.message.includes("8766"),
  );
});
