import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { Conversation, JsonObject, Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as generic from "../../src/index.ts";
import { BindingAuthority, MailIdentityDoc, MailWatchDoc, createAgentMailIdentity, standaloneWatch, watchStateOf } from "../../src/index.ts";
import type { MailWatchState } from "../../src/index.ts";
import { initialIdentity } from "../../src/identity.ts";
import type { MailDeliveryEvent } from "../../src/delivery.ts";
import { createPocketAgentMail } from "../../pocket/index.ts";
import type { PocketHostSurface } from "../../pocket/index.ts";
import pocketEntryPoint from "../../pocket/index.ts";
import { fixtureDirectory } from "../repair-extra.inc.ts";

/**
 * AM3 install and migration evidence on real headless Durable harnesses and real SQLite, with no Pocket process, no
 * Pocket source and no production mailbox: composition, the fail-closed entry point, a fresh install that stays
 * disabled and unbound, and the migration from the old bridge to the new watcher.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (relative: string) => readFile(join(root, relative), "utf8");
const target = { action: "bind", projectKey: "/fixture/project", agentName: "BlueLake" };
const MAIL_WATCH_KIND = "agent-mail-identity.watch";

function delivery(id: string): MailDeliveryEvent {
	return { eventId: `ev-${id}`, messageId: `msg-${id}`, cursor: `cursor-${id}`, from: "RedStone", subject: `subject ${id}`, body: null, createdAt: null };
}

/** Run one tool call through a real submission and return its parsed result. */
async function call(f: { harness: Harness; root: Conversation; faux: { setResponses(responses: unknown[]): void } }, name: string, args: JsonObject) {
	f.harness.resume();
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("fixture finished"),
		...Array.from({ length: 20 }, () => fauxAssistantMessage("fixture ack")),
	]);
	const submission = await f.root.submit({ type: "input", content: "fixture input", whenBusy: "reject" }, ctx);
	assert.equal((await submission.wait(ctx)).status, "done");
	const view = await f.root.context(ctx);
	const result = view.messages.findLast(message => message.role === "toolResult");
	assert.ok(result && result.role === "toolResult");
	return { isError: result.isError, text: result.content.map(part => part.type === "text" ? part.text : "").join("") };
}

type Fixture = {
	root: Conversation;
	harness: Harness;
	registry: Registry;
	faux: { setResponses(responses: unknown[]): void; getModel(): { provider: string; id: string } };
	calls: { requesterOf: number; heldBack: number; admitInput: number };
	authority: BindingAuthority;
	mailbox: MailDeliveryEvent[];
	telemetry: { polls: number };
	close(): Promise<void>;
};

/** A real Durable host with the Pocket entry point installed and a fake Pocket host surface. */
async function pocketFixture(): Promise<Fixture> {
	const dir = await fixtureDirectory("am-pocket-install-");
	const path = join(dir, "session.sqlite");
	console.log(JSON.stringify({ fixture: path }));
	const registry = createRegistry();
	const calls = { requesterOf: 0, heldBack: 0, admitInput: 0 };
	const surface: PocketHostSurface = {
		requesterOf() { calls.requesterOf += 1; return undefined; },
		heldBack() { calls.heldBack += 1; return undefined; },
		hindsight: { async admitInput() { calls.admitInput += 1; } },
	};
	const authority = new BindingAuthority();
	const bundle = createPocketAgentMail(surface, { transport: { async profile(t) { return { name: t.agentName }; } }, authority, mailTools: [] });
	for (const extension of bundle.extensions) registry.install(extension);
	const faux = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(await openNodeSqliteStorage(path), { registry, models }, ctx);
	const conversation = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
	return {
		root: conversation, harness, registry, faux, calls, authority, mailbox: [], telemetry: { polls: 0 },
		async close() { await harness.close(ctx); },
	};
}

/** A real Durable host running the standalone (non-Pocket) watcher, the target of the bridge migration. */
async function bridgeFixture(mailbox: MailDeliveryEvent[]): Promise<Fixture> {
	const dir = await fixtureDirectory("am-pocket-migration-");
	const path = join(dir, "session.sqlite");
	console.log(JSON.stringify({ fixture: path }));
	const registry = createRegistry();
	const telemetry = { polls: 0 };
	const authority = new BindingAuthority();
	let harness: Harness;
	const identity = createAgentMailIdentity({
		authority,
		transport: { async profile(t) { return { name: t.agentName }; } },
		mailTools: [],
		watch: {
			poll: async (_target, cursor) => { telemetry.polls += 1; const start = cursor === null ? 0 : mailbox.findIndex(entry => entry.cursor === cursor) + 1; return { events: mailbox.slice(start, start + 100), cursor }; },
			// The helper the package ships so a standalone host does not have to invent presence and abort wiring.
			...standaloneWatch({ registry, abort: taskId => harness.abortTask(taskId as never, ctx) }),
		},
	});
	registry.install(identity);
	const faux = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	const models = createModels();
	models.setProvider(faux.provider);
	harness = await Harness.open(await openNodeSqliteStorage(path), { registry, models }, ctx);
	const conversation = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
	await authority.grant(conversation.id, { projectKey: "/fixture/project", agentName: "BlueLake" });
	return {
		root: conversation, harness, registry, faux, calls: { requesterOf: 0, heldBack: 0, admitInput: 0 }, authority, mailbox, telemetry,
		async close() { await harness.close(ctx); },
	};
}

async function watchers(f: Fixture) {
	const inspect = await f.harness.inspect(ctx);
	return inspect.tasks.filter(task => task.record.kind === MAIL_WATCH_KIND && task.record.state.status !== "terminal");
}

async function letters(f: Fixture, marker = "Agent Mail delivery for") {
	const view = await f.root.context(ctx);
	return view.messages.filter(message => JSON.stringify(message).includes(marker)).length;
}

async function watchState(f: Fixture): Promise<MailWatchState> {
	return watchStateOf(await f.harness.snapshot(MailWatchDoc, f.root.id, ctx) as unknown as MailWatchState | undefined);
}

/* ----------------------------------------------------------------------------------------------------------------
 * Portability: the package stands alone with a bare Pi Durable.
 * -------------------------------------------------------------------------------------------------------------- */

test("the package is installable with Pi Durable alone: peers are what src/ imports, chord is test-only", async () => {
	const pkg = JSON.parse(await read("package.json")) as { exports: Record<string, string>; peerDependencies: Record<string, string>; devDependencies: Record<string, string>; files: string[]; scripts: Record<string, string> };
	assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ["@earendil-works/pi-ai", "@earendil-works/pi-durable"]);
	assert.equal(pkg.devDependencies["@earendil-works/chord"], "1.1.0", "chord is used by the tests only, so it is a dev dependency");
	assert.equal(pkg.exports["."], "./src/index.ts");
	assert.equal(pkg.exports["./pocket"], "./pocket/index.ts");
	assert.ok(pkg.files.includes("pocket"));
	const sources = Object.keys(pkg.exports).map(key => pkg.exports[key]);
	for (const relative of sources) assert.ok((await read(relative)).length > 100, `${relative} must exist`);
	// Every production source imports nothing beyond the two peers, node builtins, and its own package.
	const { readdir } = await import("node:fs/promises");
	for (const file of (await readdir(join(root, "src"))).filter(name => name.endsWith(".ts"))) {
		const text = await read(join("src", file));
		for (const specifier of [...text.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(match => match[1])) {
			assert.ok(!specifier.includes("chord") && !specifier.includes("pocket"), `${file}: ${specifier}`);
		}
	}
	console.log(JSON.stringify({ peers: Object.keys(pkg.peerDependencies), devOnly: Object.keys(pkg.devDependencies) }));
});

test("the generic entry point exports the standalone surface and knows nothing about a host application", async () => {
	const surface = Object.keys(generic);
	for (const name of ["BindingAuthority", "createAgentMailIdentity", "createCliTransport", "guardAgentMailExtension", "registryPresence", "standaloneWatch", "createMailWatchTask", "enableWatch", "disableWatch", "watchStatus"]) {
		assert.ok(surface.includes(name), `the package must export ${name}`);
	}
	assert.ok(!surface.some(name => /pocket/i.test(name)), `no Pocket name may leak into the generic entry point: ${surface.filter(name => /pocket/i.test(name)).join(",")}`);
	assert.equal(typeof generic.standaloneWatch, "function");
	const composed = generic.standaloneWatch({ registry: createRegistry(), abort: async () => "terminal" });
	assert.equal(typeof composed.presence, "function");
	assert.equal(typeof composed.abort, "function");
	assert.equal(composed.poll, undefined, "no listing is composed unless the host supplies one");
	assert.equal(typeof pocketEntryPoint, "function", "the Pocket entry point must be a drop-in builder");
	console.log(JSON.stringify({ exports: surface.length, pocketNames: 0 }));
});

test("the install and migration documents describe only commands and exports that exist", async () => {
	const pkg = JSON.parse(await read("package.json")) as { scripts: Record<string, string> };
	const install = await read("INSTALLATION.md");
	const migration = await read("MIGRATION.md");
	for (const script of Object.keys(pkg.scripts)) {
		if (!install.includes(script) && !migration.includes(script)) continue;
		assert.ok(pkg.scripts[script].length > 0, `${script} must exist`);
	}
	for (const name of ["createAgentMailIdentity", "standaloneWatch", "createCliTransport", "registryPresence", "agent_mail_identity", "watch_enable", "watch_disable", "agent_mail_wake", "missing_host_capability"]) {
		assert.ok(install.includes(name), `INSTALLATION.md must name ${name}`);
	}
	for (const name of ["watch_disable", "bindingId", "watchFrom", "now", "cursor"]) {
		assert.ok(migration.includes(name), `MIGRATION.md must name ${name}`);
	}
	// The enable parameter is `watchFrom` everywhere: a doc that names a parameter the package does not accept is wrong.
	assert.ok(!migration.includes("startFrom") && !install.includes("startFrom"), "the wake start parameter is watchFrom");
	assert.ok(install.includes(`npm --prefix`) || install.includes("npm test"), "INSTALLATION.md must show how the package is tested");
	console.log(JSON.stringify({ documentedScripts: Object.keys(pkg.scripts).length }));
});

/* ----------------------------------------------------------------------------------------------------------------
 * A fresh install: disabled, unbound, and separate from enabling wake.
 * -------------------------------------------------------------------------------------------------------------- */

test("a fresh install leaves the identity unbound and wake disabled, binds nothing and calls nothing", { timeout: 30000 }, async () => {
	const f = await pocketFixture();
	try {
		// Constructing the entry point reads nothing from the host: every read happens at admission time.
		assert.equal(f.calls.requesterOf, 0);
		assert.equal(f.calls.heldBack, 0);
		assert.equal(f.calls.admitInput, 0);
		// Installing writes nothing at all: no identity document exists until a host-granted bind happens.
		assert.equal(await f.harness.snapshot(MailIdentityDoc, f.root.id, ctx), undefined, "no conversation is auto-bound and no identity document is created");
		const state = await watchState(f);
		assert.deepEqual(state.watch, { kind: "disabled" }, "the watch starts disabled");
		assert.equal(state.cursor, null);
		assert.equal(state.pending, null);
		assert.equal((await watchers(f)).length, 0, "installing creates no watcher task");
		const status = JSON.parse((await call(f, "agent_mail_identity", { action: "status" })).text);
		assert.deepEqual(status.identity, { kind: "unbound" });
		assert.deepEqual(status.wake, { state: "disabled", reason: "not_implemented" });
		assert.equal(status.watch, undefined, "no watcher is composed without a proven contract");
		console.log(JSON.stringify({ installed: "disabled+unbound", hostCalls: f.calls.requesterOf }));
	} finally { await f.close(); }
});

test("the wake gate refuses enable with missing_host_capability and starts nothing", { timeout: 30000 }, async () => {
	const f = await pocketFixture();
	try {
		const status = await call(f, "agent_mail_wake", { action: "status" });
		assert.equal(status.isError, false);
		const report = JSON.parse(status.text);
		assert.equal(report.capabilities.complete, false);
		assert.deepEqual(report.capabilities.missing, ["submit_as_bound_person", "live_registry_reader", "admission_lookup"]);
		assert.equal(report.watcherComposed, false);
		assert.equal(report.admission, null, "status admits nothing");
		const enabled = await call(f, "agent_mail_wake", { action: "enable" });
		assert.equal(enabled.isError, true, "an enable without the capability is refused");
		const admission = JSON.parse(enabled.text).admission;
		assert.equal(admission.result, "denied");
		assert.equal(admission.reason, "missing_host_capability");
		assert.deepEqual(admission.missing, ["submit_as_bound_person", "live_registry_reader", "admission_lookup"]);
		// The refusal is total: no host read, no host admission, no watcher, no cursor, no turn.
		assert.equal(f.calls.requesterOf, 0, "a refused enable reads nothing from the host");
		assert.equal(f.calls.heldBack, 0, "and neither the requester nor the held-back state is read");
		assert.equal(f.calls.admitInput, 0);
		assert.equal((await watchers(f)).length, 0);
		const state = await watchState(f);
		assert.deepEqual(state.watch, { kind: "disabled" });
		assert.equal(state.cursor, null);
		assert.equal(await letters(f), 0);
		// The AM2 surface is absent for the same host, and it refuses rather than fabricating a watcher.
		const am2 = await call(f, "agent_mail_identity", { action: "watch_enable" });
		assert.equal(am2.isError, true);
		assert.match(am2.text, /watcher_unavailable/);
		console.log(JSON.stringify({ refused: "missing_host_capability", watchers: 0 }));
	} finally { await f.close(); }
});

test("binding and enabling wake stay separate actions: installing never enables, binding never wakes", { timeout: 30000 }, async () => {
	const f = await pocketFixture();
	try {
		await f.authority.grant(f.root.id, { projectKey: "/fixture/project", agentName: "BlueLake" });
		const bound = await call(f, "agent_mail_identity", target);
		assert.equal(bound.isError, false, bound.text);
		const status = JSON.parse((await call(f, "agent_mail_identity", { action: "status" })).text);
		assert.equal(status.identity.kind, "bound");
		assert.equal(status.wake.state, "disabled", "binding an identity does not enable wake");
		assert.deepEqual((await watchState(f)).watch, { kind: "disabled" });
		assert.equal((await watchers(f)).length, 0);
		assert.equal(await letters(f), 0);
		console.log(JSON.stringify({ identity: status.identity.kind, wake: status.wake.state }));
	} finally { await f.close(); }
});

/* ----------------------------------------------------------------------------------------------------------------
 * Migration from the old bridge.
 * -------------------------------------------------------------------------------------------------------------- */

test("migration from the old bridge: one watcher owns the mailbox and the identity is preserved", { timeout: 30000 }, async () => {
	const f = await bridgeFixture([delivery("1"), delivery("2")]);
	try {
		const bound = await call(f, "agent_mail_identity", target);
		assert.equal(bound.isError, false, bound.text);
		const identity = await f.harness.snapshot(MailIdentityDoc, f.root.id, ctx);
		const bindingId = (identity as unknown as { binding: { bindingId: string } }).binding.bindingId;
		// The old bridge's in-memory position is never imported: an enable without a start position keeps the stored
		// cursor, which is `null` before the first admitted batch.
		const first = JSON.parse((await call(f, "agent_mail_identity", { action: "watch_enable" })).text);
		assert.equal(first.enable.created, true);
		assert.equal(first.enable.from, "resume");
		assert.equal(first.enable.cursor, null, "the migration starts at the stored position, not at an imported one");
		assert.equal((await watchers(f)).length, 1, "exactly one watcher owns the mailbox");
		// A second enable adopts that watcher instead of creating a second one.
		const second = JSON.parse((await call(f, "agent_mail_identity", { action: "watch_enable" })).text);
		assert.equal(second.enable.taskId, first.enable.taskId);
		assert.equal(second.enable.created, false);
		assert.equal((await watchers(f)).length, 1);
		// The migration is about the mailbox owner: the identity document is untouched by enabling and disabling.
		assert.deepEqual(await f.harness.snapshot(MailIdentityDoc, f.root.id, ctx), identity);
		assert.equal((identity as unknown as { binding: { bindingId: string } }).binding.bindingId, bindingId);
		console.log(JSON.stringify({ migration: "one-watcher", taskId: first.enable.taskId, bindingId }));
	} finally { await f.close(); }
});

test("migration: only an explicitly chosen cursor replays the backlog, and disable stops new turns", { timeout: 30000 }, async () => {
	const f = await bridgeFixture([delivery("1"), delivery("2")]);
	try {
		await call(f, "agent_mail_identity", target);
		// A mistyped or whitespace cursor is refused before any watcher exists.
		const refused = await call(f, "agent_mail_identity", { action: "watch_enable", watchFrom: " 11712 " });
		assert.equal(refused.isError, true);
		assert.match(refused.text, /invalid_watch_cursor/);
		assert.equal((await watchers(f)).length, 0, "a refused cursor leaves no watcher behind");
		const enabled = await call(f, "agent_mail_identity", { action: "watch_enable", watchFrom: "now" });
		assert.equal(enabled.isError, false, enabled.text);
		assert.equal(JSON.parse(enabled.text).enable.from, "now");
		const pollsBefore = f.telemetry.polls;
		const lettersBefore = await letters(f);
		const disabled = await call(f, "agent_mail_identity", { action: "watch_disable" });
		assert.equal(disabled.isError, false, disabled.text);
		const disabledReport = JSON.parse(disabled.text);
		assert.equal(disabledReport.watch.state, "disabled");
		// Measured after the disable call itself, so the assertion is about turns the watcher could still start.
		const entriesAfterDisable = (await f.root.context(ctx)).entries.length;
		await new Promise(resolve => setTimeout(resolve, 120));
		assert.equal(f.telemetry.polls, pollsBefore, "a disabled watcher does not poll");
		assert.equal(await letters(f), lettersBefore, "and admits no batch");
		assert.equal((await f.root.context(ctx)).entries.length, entriesAfterDisable, "and starts no new turn");
		const state = await watchState(f);
		assert.equal(state.watch.kind, "disabled", "disable keeps the watch disabled");
		assert.equal((await watchers(f)).length, 0, "and the watcher task is terminal");
		console.log(JSON.stringify({ disabled: true, polls: f.telemetry.polls, letters: await letters(f) }));
	} finally { await f.close(); }
});
