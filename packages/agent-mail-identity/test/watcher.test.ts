import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createCliTransport } from "../src/am-cli.ts";
import type { Conversation, JsonObject, Registry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BindingAuthority, MailIdentityDoc, MailWatchDoc, createAgentMailIdentity, initialWatchState, registryPresence, watchStateOf } from "../src/index.ts";
import type { MailWatchState } from "../src/index.ts";
import type { IdentityOptions } from "../src/index.ts";
import type { MailDeliveryEvent } from "../src/delivery.ts";
import { createPendingDelivery, deriveRequestId, planBatch, IDLE_POLL_MS } from "../src/delivery.ts";
import { writeFile, readFile } from "node:fs/promises";
import { barrier, fixtureDirectory } from "./repair-extra.inc.ts";

/**
 * AM2 watcher on a real headless Durable harness with real SQLite: durable task creation, one watcher per binding,
 * disable, pause, abort, uninstall, empty polls, paging, a busy race and pending recovery. The mailbox is an
 * in-process read-only fixture; no live Mail project, cloud worker, screenshot, video, or paid model is involved.
 */

const target = { action: "bind", projectKey: "/fixture/project", agentName: "BlueLake" };
const MAIL_WATCH_KIND = "agent-mail-identity.watch";

function delivery(id: string): MailDeliveryEvent {
	return { eventId: `ev-${id}`, messageId: `msg-${id}`, cursor: `cursor-${id}`, from: "RedStone", subject: `subject ${id}`, body: `body ${id}`, createdAt: null };
}

async function watchFixture(options: { mailbox?: MailDeliveryEvent[]; pageLimit?: number; idleMs?: number; present?: boolean; cli?: boolean } = {}) {
	const dir = await fixtureDirectory("am-watch-");
	const path = join(dir, "session.sqlite");
	console.log(JSON.stringify({ fixture: path }));
	const mailbox = options.mailbox ?? [];
	const telemetry = { polls: 0, pageLimit: options.pageLimit ?? 100, present: options.present ?? true, targets: [] as string[], inPoll: false, gateArmed: false, gate: barrier() };
	const registry = createRegistry();
	let harness: Harness;
	const listingLog = join(dir, "effects.log");
	const listingPage = join(dir, "mailbox.json");
	const cliTransport = options.cli === true
		? createCliTransport(fileURLToPath(new URL("./fixtures/am-fixture.mjs", import.meta.url)), { pageLimit: options.pageLimit ?? 100, env: { AM_FIXTURE_MAILBOX: listingPage, AM_FIXTURE_EFFECT_LOG: listingLog } })
		: undefined;
	const transport = { async profile(t: { agentName: string }) { return { name: t.agentName }; } };
	const watch = {
		async poll(target: { projectKey: string; agentName: string }, cursor: string | null, signal: AbortSignal) {
			telemetry.polls += 1;
			telemetry.targets.push(`${target.projectKey}|${target.agentName}`);
			if (telemetry.gateArmed) {
				telemetry.gateArmed = false;
				telemetry.inPoll = true;
				await telemetry.gate.promise;
				telemetry.inPoll = false;
			}
			signal.throwIfAborted();
			const start = cursor === null ? 0 : mailbox.findIndex(entry => entry.cursor === cursor) + 1;
			return { events: mailbox.slice(start, start + telemetry.pageLimit), cursor };
		},
		presence: () => telemetry.present && registryPresence(registry)(),
		abort: async (taskId: string) => harness.abortTask(taskId as never, ctx),
		tuning: { idleMs: options.idleMs ?? 5, jitter: () => 0.5, backoff: [10, 20, 40] },
	};
	// With `cli`, no poll is composed: the watcher must reach the packaged CLI transport, whose own read-only
	// listing over the verified `am inbox-events` contract is the only source.
	const settings: IdentityOptions = options.cli === true
		? { transport: cliTransport!, authority: new BindingAuthority(), mailTools: [], watch: { presence: watch.presence, abort: watch.abort, tuning: watch.tuning } }
		: { transport, authority: new BindingAuthority(), mailTools: [], watch };
	const identity = createAgentMailIdentity(settings);
	registry.install(identity);
	const faux = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 100000 });
	const models = createModels();
	models.setProvider(faux.provider);
	const reports: unknown[] = [];
	harness = await Harness.open(await openNodeSqliteStorage(path), { registry, models, onReport: error => reports.push(error) }, ctx);
	const root = await harness.root(ctx, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
	await settings.authority!.grant(root.id, { projectKey: "/fixture/project", agentName: "BlueLake" });
	const holds = barrier();
	const hold = defineTool({
		name: "fixture_hold",
		description: "Fixture tool that keeps a run active until the test releases it.",
		parameters: Type.Object({}),
		async execute() { await holds.promise; return { content: [{ type: "text" as const, text: "released" }] }; },
	});
	registry.install(defineExtension({ name: "fixture-hold", tools: [hold] }));
	const f = {
		root, harness, identity, registry: registry as Registry, faux, telemetry, holds, mailbox, reports, listingLog, listingPage,
		armGate() { telemetry.gateArmed = true; },
		releaseGate() { telemetry.gate.resolve(); },
		async seedListing(events: Array<{ cursor: number; message_id: number }>, extra: { oldest_available_cursor?: number; tail_cursor?: number; global_oldest_cursor?: number } = {}) {
			const tail = extra.tail_cursor ?? (events.length === 0 ? 0 : events[events.length - 1].cursor);
			const oldest = extra.oldest_available_cursor ?? (events.length === 0 ? 0 : events[0].cursor);
			await writeFile(listingPage, JSON.stringify({ events: events.map(entry => ({ ...entry, kind: "to", delivered_ts: "2026-10-12T16:56:12.035902Z", subject: `subject ${entry.cursor}`, from: "FrostyRobin", importance: "normal", ack_required: false })), tail_cursor: tail, oldest_available_cursor: oldest, global_oldest_cursor: extra.global_oldest_cursor }));
		},
		async listingEffects(): Promise<string[]> {
			try { return (await readFile(listingLog, "utf8")).trim().split("\n"); } catch { return []; }
		},
		/** Bounded wait for a durable terminal record: `waitForTask` alone can return a non-terminal one. */
		async terminal(taskId: string) {
			const deadline = Date.now() + 8000;
			for (;;) {
				const record = await harness.getTask(taskId as never, ctx);
				if (record && record.state.status === "terminal") return record;
				if (Date.now() > deadline) throw new Error(`task ${taskId} is not terminal: ${JSON.stringify(record?.state)}`);
				await new Promise(resolve => setTimeout(resolve, 10));
			}
		},
		watchState: async () => watchStateOf(await harness.snapshot(MailWatchDoc, root.id, ctx) as unknown as MailWatchState | undefined),
		inspect: () => harness.inspect(ctx),
		watchers: async () => (await harness.inspect(ctx)).tasks.filter(task => task.record.kind === MAIL_WATCH_KIND),
		binding: async () => {
			const value = await harness.snapshot(MailIdentityDoc, root.id, ctx) as unknown as { binding: { bindingId: string } };
			return value.binding.bindingId;
		},
		/** Deliveries are durable messages carrying the rendered batch header, one per admitted batch. */
		letters: async (marker = "Agent Mail delivery for") => (await root.context(ctx)).messages.filter(message => JSON.stringify(message).includes(marker)).length,
		/** Public transaction read of the host deduplication key, the same lookup the watcher uses. */
		admitted: async (requestId: string) => await harness.commit(async tx => (await tx.submissionByRequest(root.id, requestId)) !== undefined, ctx),
		expectedRequestId: async (cursorBefore: string | null, eventIds: string[]) => deriveRequestId(root.id, await f.binding(), cursorBefore, eventIds),
		async waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const value = await check();
				if (value !== undefined) return value;
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
				await new Promise(resolve => setTimeout(resolve, 10));
			}
		},
		async close() { holds.resolve(); await harness.close(ctx); },
	};
	topUp(f);
	return f;
}

/** Keep plain fixture answers available so a watcher-triggered generation never runs an empty queue. */
function topUp(f: { faux: { setResponses(responses: unknown[]): void } }, count = 20) {
	f.faux.setResponses(Array.from({ length: count }, () => fauxAssistantMessage("fixture ack")));
}

/** Run one tool call through a real submission and return its parsed result. */
async function call(f: Awaited<ReturnType<typeof watchFixture>>, name: string, args: JsonObject) {
	f.harness.resume();
	f.faux.setResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("fixture finished"),
		...Array.from({ length: 20 }, () => fauxAssistantMessage("fixture ack")),
	]);
	const deadline = Date.now() + 8000;
	let submission;
	for (;;) {
		try {
			submission = await f.root.submit({ type: "input", content: "fixture input", whenBusy: "reject" }, ctx);
			break;
		} catch (error) {
			// The watcher may be delivering at the same time; a busy conversation is retried, never steered.
			if (!(error instanceof Error) || error.name !== "ConversationBusy" || Date.now() > deadline) throw error;
			await new Promise(resolve => setTimeout(resolve, 20));
		}
	}
	const settled = await submission.wait(ctx);
	assert.equal(settled.status, "done");
	const view = await f.root.context(ctx);
	const result = view.messages.findLast(message => message.role === "toolResult");
	assert.ok(result && result.role === "toolResult");
	return { isError: result.isError, text: result.content.map(part => part.type === "text" ? part.text : "").join("") };
}

async function bind(f: Awaited<ReturnType<typeof watchFixture>>) {
	const result = await call(f, "agent_mail_identity", target);
	assert.equal(result.isError, false, result.text);
	return result;
}

type StatusReport = { identity: { kind: string }; wake: { state: string; reason: string }; watch: { state: string; reason: string | null; taskId: string | null; phase: string | null; lastError: string | null; cursor: string | null; pending: { requestId: string; events: number; bytes: number } | null }; enable?: { taskId: string; created: boolean; cursor: string | null; from: string } };

async function enable(f: Awaited<ReturnType<typeof watchFixture>>, extra: JsonObject = {}) {
	const result = await call(f, "agent_mail_identity", { action: "watch_enable", ...extra });
	assert.equal(result.isError, false, result.text);
	return JSON.parse(result.text) as StatusReport;
}

test("enable persists cursor and intent in one transaction; one letter admits exactly one submission", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")] });
	try {
		await bind(f);
		const first = await enable(f);
		assert.equal(first.enable!.created, true);
		assert.equal(first.enable!.from, "resume");
		assert.equal(first.watch.cursor, null);
		assert.equal(first.wake.state, "running");
		await f.waitFor("the batch to settle", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		const state = await f.watchState();
		assert.equal(state.pending, null, "pending is cleared after the confirmed admission");
		const watchers = await f.watchers();
		assert.equal(watchers.length, 1, "exactly one watcher task exists");
		assert.equal(watchers[0].record.background, true, "the watcher is a background task");
		assert.equal(watchers[0].record.state.status === "terminal" ? null : "live", "live");
		assert.equal(await f.letters(), 1, "the letter reached the conversation exactly once");
		const expected = await f.expectedRequestId(null, ["ev-1"]);
		assert.equal(await f.admitted(expected), true, "the admission key is the deterministically derived batch key");
		console.log(JSON.stringify({ phase: "wake", cursor: state.cursor, taskId: first.enable!.taskId, requestId: expected }));
	} finally { await f.close(); }
});

test("an empty mailbox creates no turn, no submission and no read-marking, and polls only on the idle cadence", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [] });
	try {
		await bind(f);
		await enable(f);
		const before = (await f.root.context(ctx)).entries.at(-1)?.id;
		const deadline = Date.now() + 400;
		while (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
		const polls = f.telemetry.polls;
		assert.equal(await f.letters(), 0, "an empty poll admits nothing");
		const after = await f.root.context(ctx);
		assert.equal(after.entries.at(-1)?.id, before, `an empty poll writes no entry and starts no model turn: ${JSON.stringify(after.entries.map(entry => entry.kind))}`);
		const state = await f.watchState();
		assert.equal(state.cursor, null);
		assert.equal(state.pending, null);
		assert.ok(polls >= 1, "the enabled watcher does poll");
		// One poll per idle interval: the fixture compresses the cadence to 5 ms, so the count is bounded by that.
		assert.ok(polls <= Math.ceil(500 / 5), `an idle binding polls once per idle interval, saw ${polls}`);
		assert.equal(IDLE_POLL_MS, 15_000, "the production idle cadence is the plan's 15 seconds, at most four polls a minute");
		console.log(JSON.stringify({ phase: "empty", polls, idleMs: 5, productionPollsPerMinute: 60_000 / IDLE_POLL_MS, lastEntry: before }));
	} finally { await f.close(); }
});

test("repeated enable keeps exactly one watcher and a later page continues from the stored cursor", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1"), delivery("2")], pageLimit: 1 });
	try {
		await bind(f);
		const first = await enable(f);
		await f.waitFor("the first batch", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		// The stored cursor moves on its own as pages are read; the mailbox drains and then the cursor is stable.
		await f.waitFor("the second page", async () => (await f.watchState()).cursor === "cursor-2" ? true : undefined);
		const second = await enable(f);
		assert.equal(second.enable!.taskId, first.enable!.taskId, "a second enable must not create a second watcher");
		assert.equal(second.enable!.created, false);
		assert.equal(second.enable!.from, "resume");
		assert.equal(second.enable!.cursor, "cursor-2", "a repeat enable reports and keeps the stored cursor");
		assert.equal((await f.watchers()).length, 1);
		assert.equal(await f.letters(), 2, "each event was delivered exactly once across the two pages");
		const third = await enable(f, { watchFrom: "now" });
		assert.equal(third.enable!.taskId, first.enable!.taskId, "an explicit now on a live watcher still does not duplicate it");
		console.log(JSON.stringify({ phase: "repeat", taskId: first.enable!.taskId, cursor: (await f.watchState()).cursor, letters: await f.letters() }));
	} finally { await f.close(); }
});

test("a crash between admission and the cursor commit does not deliver the batch twice", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")], pageLimit: 1 });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("the batch to settle", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		const requestId = await f.expectedRequestId(null, ["ev-1"]);
		assert.equal(await f.admitted(requestId), true, "the batch was admitted under the derived key");
		assert.equal(await f.letters(), 1);
		// Public document write: pending is durable again and the cursor is rolled back, exactly the state a crash
		// between the admission and the settle commit leaves behind.
		const bindingId = await f.binding();
		const restored = createPendingDelivery({ bindingId, conversationId: f.root.id, cursorBefore: null, plan: planBatch({ projectKey: "/fixture/project", agentName: "BlueLake" }, [delivery("1")]), createdAt: 0 });
		assert.equal(restored.requestId, requestId, "the replayed batch derives the same admission key");
		await f.harness.commit(async tx => {
			const doc = await tx.doc(MailWatchDoc, f.root.id);
			Object.assign(doc, { ...watchStateOf(doc as unknown as MailWatchState | undefined), cursor: null, pending: restored });
		}, ctx);
		await f.waitFor("the replayed batch to settle", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		assert.equal(await f.admitted(requestId), true);
		assert.equal(await f.letters(), 1, "recovery settles the known submission instead of delivering again");
		console.log(JSON.stringify({ phase: "pending-recovery", requestId }));
	} finally { await f.close(); }
});

test("a busy conversation is never steered: pending waits for idle and then admits once", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [] });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("a first poll", async () => f.telemetry.polls > 0 ? true : undefined);
		// Hold an active run and queue work behind it, then make a letter appear: a reject-capable submit must be refused.
		f.faux.setResponses([fauxAssistantMessage([fauxToolCall("fixture_hold", {})], { stopReason: "toolUse" }), fauxAssistantMessage("released"), ...Array.from({ length: 20 }, () => fauxAssistantMessage("fixture ack"))]);
		const busy = await f.root.submit({ type: "input", content: "hold the conversation", whenBusy: "reject" }, ctx);
		const queued = await f.root.submit({ type: "input", content: "queued behind the active turn", whenBusy: "followUp" }, ctx);
		f.mailbox.push(delivery("1"));
		const state = await f.waitFor("a durable pending delivery", async () => (await f.watchState()).pending !== null ? await f.watchState() : undefined);
		assert.equal(state.cursor, null, "a busy conversation does not advance the cursor");
		await new Promise(resolve => setTimeout(resolve, 120));
		assert.equal(await f.letters(), 0, "the watcher must not queue behind or steer the active turn");
		assert.equal((await f.watchState()).pending !== null, true, "the delivery stays pending while the conversation is busy");
		assert.equal((await f.watchers()).length, 1);
		assert.equal((await queued.status(ctx)).status, "queued", "the active turn and its queue are untouched by the watcher");
		f.faux.setResponses([fauxAssistantMessage("released"), ...Array.from({ length: 40 }, () => fauxAssistantMessage("fixture ack"))]);
		f.holds.resolve();
		assert.equal((await busy.wait(ctx)).status, "done");
		await f.waitFor("the delivery after idle", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined, 10000);
		assert.equal(await f.letters(), 1, "the batch is admitted exactly once, after the active turn finished");
		console.log(JSON.stringify({ phase: "busy", deliveries: 1, polls: f.telemetry.polls }));
	} finally { await f.close(); }
});

test("disable stops the watcher, keeps identity and cursor, and a later enable resumes from the stored cursor", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")] });
	try {
		await bind(f);
		const first = await enable(f);
		await f.waitFor("the first delivery", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		const disabled = await call(f, "agent_mail_identity", { action: "disable" });
		assert.equal(disabled.isError, false, disabled.text);
		const report = JSON.parse(disabled.text) as StatusReport;
		assert.equal(report.watch.state, "disabled");
		assert.equal(report.watch.cursor, "cursor-1", "disable keeps the durable cursor");
		assert.equal(report.watch.reason, null);
		await f.waitFor("the watcher task to end", async () => (await f.watchers()).length === 0 ? true : undefined);
		const settled = await f.harness.waitForTask(first.enable!.taskId as never, ctx);
		assert.equal(settled.state.outcome.status, "aborted");
		const polls = f.telemetry.polls;
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(f.telemetry.polls, polls, "a disabled watcher does not poll");
		const refused = await call(f, "agent_mail_identity", { action: "watch_resume" });
		assert.equal(refused.isError, true);
		assert.match(refused.text, /watcher_not_paused/);
		const identity = JSON.parse((await call(f, "agent_mail_identity", { action: "status" })).text) as StatusReport;
		assert.equal(identity.identity.kind, "bound", "disable preserves the binding");
		const again = await enable(f);
		assert.equal(again.enable!.created, true);
		assert.equal(again.enable!.cursor, "cursor-1", "re-enabling resumes the stored cursor instead of restarting at now");
		console.log(JSON.stringify({ phase: "disable", cursor: again.enable!.cursor, taskId: again.enable!.taskId }));
	} finally { await f.close(); }
});

test("pause keeps the cursor and resume continues from it", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")], pageLimit: 1 });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("the first batch", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		const paused = await call(f, "agent_mail_identity", { action: "watch_pause" });
		assert.equal(paused.isError, false, paused.text);
		const pausedReport = JSON.parse(paused.text) as StatusReport;
		assert.equal(pausedReport.watch.state, "paused");
		assert.equal(pausedReport.watch.reason, "manual");
		assert.equal(pausedReport.watch.cursor, "cursor-1", "pause keeps the durable cursor");
		const polls = f.telemetry.polls;
		await new Promise(resolve => setTimeout(resolve, 60));
		assert.equal(f.telemetry.polls, polls, "a paused watcher does not poll");
		const resumed = await call(f, "agent_mail_identity", { action: "watch_resume" });
		assert.equal(resumed.isError, false, resumed.text);
		f.mailbox.push(delivery("2"));
		await f.waitFor("the next batch after resume", async () => (await f.watchState()).cursor === "cursor-2" ? true : undefined);
		assert.equal(await f.letters(), 2, "resume continues from the stored cursor, delivering each event once");
		console.log(JSON.stringify({ phase: "pause-resume", cursor: (await f.watchState()).cursor }));
	} finally { await f.close(); }
});

test("an aborted background task keeps cursor state and a later enable continues from it", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")], pageLimit: 1 });
	try {
		await bind(f);
		const enabled = await enable(f);
		const abortResult = await f.harness.abortTask(enabled.enable!.taskId as never, ctx);
		assert.equal(abortResult, "marked", abortResult);
		const settled = await f.terminal(enabled.enable!.taskId);
		const state = await f.watchState();
		assert.equal(state.watch.kind, "paused", "an aborted watcher reports paused, not running");
		assert.equal(state.cursor, null, "the aborted watcher never advanced the cursor");
		const again = await enable(f);
		assert.equal(again.enable!.created, true);
		await f.waitFor("delivery after the restart", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		assert.equal(await f.letters(), 1);
		console.log(JSON.stringify({ phase: "abort-resume", cursor: (await f.watchState()).cursor }));
	} finally { await f.close(); }
});

test("losing live presence stops the old implementation from polling or delivering", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")] });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("the first delivery", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined);
		const delivered = await f.letters();
		f.telemetry.present = false;
		await f.waitFor("the watcher to stop", async () => (await f.watchers()).length === 0 ? true : undefined);
		const state = await f.watchState();
		assert.equal(state.watch.kind, "paused");
		assert.equal(state.watch.kind === "paused" ? state.watch.reason : null, "uninstalled");
		assert.equal(state.cursor, "cursor-1", "the cursor survives an uninstall");
		const polls = f.telemetry.polls;
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(f.telemetry.polls, polls, "the old implementation must not poll after losing presence");
		assert.equal(await f.letters(), delivered, "and must not deliver");
		console.log(JSON.stringify({ phase: "presence-loss", polls }));
	} finally { await f.close(); }
});

test("removing the extension from the registry stops the live watcher through its presence source", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [] });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("a first poll", async () => f.telemetry.polls > 0 ? true : undefined);
		// Presence is the injected registry reader: uninstalling the extension is what an uninstall looks like to it.
		f.registry.uninstall(f.identity);
		const state = await f.waitFor("the watcher to stop", async () => (await f.watchState()).watch.kind === "paused" ? await f.watchState() : undefined, 10000);
		assert.equal(state.watch.kind === "paused" ? state.watch.reason : null, "uninstalled");
		const polls = f.telemetry.polls;
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal(f.telemetry.polls, polls, "the old implementation must not poll after the uninstall");
		assert.equal(await f.letters(), 0, "and must not deliver");
		assert.equal((await f.watchers()).length, 0, "the watcher task is terminal");
		// The task itself was never aborted by Durable: with the definition gone it keeps running under the stored
		// definition until the presence check stops it. That is the A1 limit, reported here as evidence.
		const reported = f.reports.map(String).filter(message => message.includes("keeps running under its old"));
		console.log(JSON.stringify({ phase: "uninstall", polls, retirementReports: reported.length }));
	} finally { await f.close(); }
});

test("registryPresence reads the injected registry reader instead of a phase snapshot", () => {
	const registry = createRegistry();
	const extension = defineExtension({ name: "agent-mail-identity" });
	const present = registryPresence(registry);
	assert.equal(present(), false, "an uninstalled extension is absent");
	registry.install(extension);
	assert.equal(present(), true);
	registry.uninstall(extension);
	assert.equal(present(), false, "removal is visible through the same reader immediately");
});

test("a pending delivery of a foreign binding pauses the watcher instead of delivering it", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")] });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("a first poll", async () => f.telemetry.polls > 0 ? true : undefined);
		// Pause first so no in-flight phase can overwrite the injected record, then resume with it in place.
		await call(f, "agent_mail_identity", { action: "watch_pause" });
		await f.harness.commit(async tx => {
			const doc = await tx.doc(MailWatchDoc, f.root.id);
			Object.assign(doc, {
				...watchStateOf(doc as unknown as MailWatchState | undefined),
				pending: { schemaVersion: 1, bindingId: "foreign-binding", requestId: "am2:foreign", cursorBefore: null, cursorAfter: "cursor-x", eventIds: ["ev-9"], messageIds: ["msg-9"], payload: "foreign", bytes: 7, createdAt: 0 },
			});
		}, ctx);
		const resumed = await call(f, "agent_mail_identity", { action: "watch_resume" });
		assert.equal(resumed.isError, false, resumed.text);
		await f.waitFor("the watch to pause", async () => (await f.watchState()).watch.kind === "paused" ? true : undefined, 5000);
		const state = await f.watchState();
		assert.equal(state.watch.kind === "paused" ? state.watch.reason : null, "stale_binding");
		assert.equal(state.pending?.bindingId, "foreign-binding", "the foreign pending record is preserved, not replayed");
		assert.equal(await f.letters(), 0);
		console.log(JSON.stringify({ phase: "stale-binding", reason: "stale_binding" }));
	} finally { await f.close(); }
});

test("the AM2 live gate is fail-closed: unavailable is exit 2 with a stated reason", { timeout: 20000 }, async () => {
	const script = fileURLToPath(new URL("./live-am2.ts", import.meta.url));
	const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "" } });
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", code => resolve({ code, stderr }));
	});
	assert.equal(result.code, 2, `the live gate must report unavailable, saw ${result.code}`);
	assert.match(result.stderr, /UNAVAILABLE: live-am2/);
	assert.match(result.stderr, /not live acceptance/);
	assert.match(result.stderr, /Pocket wake stays blocked/);
	console.log(JSON.stringify({ phase: "live-gate", exit: result.code }));
});

test("an enabled watcher reads its page through the packaged CLI transport and delivers it once", { timeout: 30000 }, async () => {
	const f = await watchFixture({ cli: true, idleMs: 5 });
	try {
		await bind(f);
		// The mailbox still keeps the position the watcher resumes from, so the backlog page is served.
		await f.seedListing([{ cursor: 11713, message_id: 8244 }], { oldest_available_cursor: 11712 });
		// An explicit cursor reads the backlog; `now` would deliberately start at the durable tail instead.
		const first = await enable(f, { watchFrom: "11712" });
		assert.equal(first.enable!.created, true);
		await f.waitFor("the CLI page to be admitted", async () => (await f.watchState()).cursor === "11713" ? true : undefined, 10000);
		const state = await f.watchState();
		assert.equal(state.pending, null);
		assert.equal(await f.letters(), 1, "the CLI page reached the conversation exactly once");
		const requestId = await f.expectedRequestId("11712", ["11713"]);
		assert.equal(await f.admitted(requestId), true, "the admission key comes from the delivery cursor of the page");
		const effects = await f.listingEffects();
		assert.ok(effects.length >= 1 && effects.every(name => name.startsWith("inbox-events:")), `only read-only listings may run: ${JSON.stringify(effects)}`);
		assert.ok(!effects.some(name => name.includes("mark-read")), "monitoring must never mark mail read");
		// The same page cannot be admitted twice: the durable cursor already passed it.
		const before = await f.letters();
		await new Promise(resolve => setTimeout(resolve, 120));
		assert.equal(await f.letters(), before);
		console.log(JSON.stringify({ phase: "cli-poll", cursor: state.cursor, requestId, effects: effects.length }));
	} finally { await f.close(); }
});

test("a cursor the mailbox can no longer serve pauses the CLI-backed watcher instead of skipping events", { timeout: 30000 }, async () => {
	const f = await watchFixture({ cli: true, idleMs: 5 });
	try {
		await bind(f);
		await f.seedListing([{ cursor: 11713, message_id: 8244 }], { oldest_available_cursor: 11712 });
		await enable(f, { watchFrom: "11712" });
		await f.waitFor("the first delivery", async () => (await f.watchState()).cursor === "11713" ? true : undefined, 10000);
		// Actual retention is a GLOBAL-ledger fact, not merely a recipient-local gap. The native CLI rejects it.
		await f.seedListing([{ cursor: 11800, message_id: 8300 }], { oldest_available_cursor: 11800, tail_cursor: 11800, global_oldest_cursor: 11800 });
		await f.waitFor("the watcher to pause", async () => (await f.watchState()).watch.kind === "paused" ? true : undefined, 10000);
		const state = await f.watchState();
		assert.equal(state.watch.kind === "paused" ? state.watch.reason : null, "cli_exit_failed");
		assert.equal(state.cursor, "11713", "the cursor stays where the last admitted batch ended");
		assert.equal(await f.letters(), 1, "no event was skipped into the conversation");
		assert.equal((await f.watchers()).length, 0, "the paused watcher task ended");
		console.log(JSON.stringify({ phase: "cursor-expired", reason: "cli_exit_failed" }));
	} finally { await f.close(); }
});

test("a disable that lands while a phase is running ends disabled, not paused", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [delivery("1")] });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("the first delivery", async () => (await f.watchState()).cursor === "cursor-1" ? true : undefined, 10000);
		// Hold the next poll phase open, disable while it is in flight, then let the phase finish and commit.
		f.armGate();
		await f.waitFor("a poll to be held", async () => f.telemetry.inPoll ? true : undefined, 10000);
		const disabling = call(f, "agent_mail_identity", { action: "disable" });
		await f.waitFor("the disable state to commit", async () => (await f.watchState()).watch.kind === "disabled" ? true : undefined, 10000);
		f.releaseGate();
		const disabled = await disabling;
		assert.equal(disabled.isError, false, disabled.text);
		const state = await f.watchState();
		assert.equal(state.watch.kind, "disabled", "a phase finishing after a disable must not resurrect or downgrade the watch");
		assert.equal(state.cursor, "cursor-1", "and it must not move the cursor while doing so");
		assert.equal(await f.letters(), 1, "no further delivery");
		// The abort handler saw `disabled` and left it alone; the task itself is terminal.
		assert.equal((await f.watchers()).length, 0);
		console.log(JSON.stringify({ phase: "disable-mid-phase", watch: state.watch.kind }));
	} finally { await f.close(); }
});

test("more terminal watcher records than one listing page still leave exactly one live watcher", { timeout: 60000 }, async () => {
	const f = await watchFixture({ mailbox: [], idleMs: 10_000 });
	try {
		await bind(f);
		// 34 enable/disable cycles leave 34 terminal watcher records, more than a single 32-record scan page.
		for (let cycle = 0; cycle < 34; cycle += 1) {
			await enable(f);
			const disabled = await call(f, "agent_mail_identity", { action: "disable" });
			assert.equal(disabled.isError, false, disabled.text);
		}
		const last = await enable(f);
		const watchers = await f.watchers();
		assert.equal(watchers.length, 1, "exactly one live watcher exists after the cycles");
		assert.equal(last.watch.taskId, String(watchers[0].record.id), "and the durable state names that watcher");
		assert.equal((await f.watchState()).watch.kind, "running");
		console.log(JSON.stringify({ phase: "many-terminal-records", cycles: 34, live: watchers.length }));
	} finally { await f.close(); }
});

test("a foreign watch document pauses the watcher instead of escaping as an uncaught phase fault", { timeout: 30000 }, async () => {
	const f = await watchFixture({ mailbox: [] });
	try {
		await bind(f);
		await enable(f);
		await f.waitFor("a first poll", async () => f.telemetry.polls > 0 ? true : undefined);
		// Out of band: a document written by a schema this build does not know, exactly what a future
		// MAIL_WATCH_SCHEMA_VERSION bump against stored v1 documents leaves behind. The guard must land its pause
		// instead of the phase rejecting uncaught and the watcher retrying a document nobody can decode.
		await f.harness.commit(async tx => {
			const doc = await tx.doc(MailWatchDoc, f.root.id);
			Object.assign(doc, { ...(doc as unknown as MailWatchState), schemaVersion: 2 });
		}, ctx);
		assert.throws(() => watchStateOf({ ...initialWatchState(), schemaVersion: 2 } as unknown as MailWatchState), /watch_schema_incompatible/);
		const state = await f.waitFor("the watch to pause", async () => {
			try { const value = await f.watchState(); return value.watch.kind === "paused" ? value : undefined; }
			catch { return undefined; }
		}, 10000);
		assert.equal(state.watch.kind === "paused" ? state.watch.reason : null, "watch_schema_incompatible");
		assert.equal(state.lastError, "watch_schema_incompatible");
		assert.equal(state.schemaVersion, 1, "the pause rewrites the document with the current schema, so it decodes again");
		assert.equal(state.cursor, null, "a cursor written by an undecodable document is not trusted or kept");
		assert.equal(state.pending, null, "and neither is a pending payload");
		assert.equal((await f.watchers()).length, 0, "the watcher task ended instead of retrying a foreign document forever");
		assert.equal(await f.letters(), 0, "no delivery came out of the undecodable document");
		// The operator surface still reports the same fixed public code rather than an error body.
		const status = await call(f, "agent_mail_identity", { action: "status" });
		assert.equal(status.isError, false, status.text);
		assert.equal((JSON.parse(status.text) as StatusReport).watch.state, "paused");
		console.log(JSON.stringify({ phase: "foreign-schema", reason: "watch_schema_incompatible" }));
	} finally { await f.close(); }
});

test("the AM3 Pocket live gate is fail-closed: unavailable is exit 2 with a stated reason", { timeout: 20000 }, async () => {
	const script = fileURLToPath(new URL("./pocket/live-pocket.ts", import.meta.url));
	const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", script], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH ?? "" } });
		let stderr = "";
		child.stderr.on("data", chunk => { stderr += String(chunk); });
		child.on("error", reject);
		child.on("close", code => resolve({ code, stderr }));
	});
	assert.equal(result.code, 2, `the Pocket live gate must report unavailable, saw ${result.code}`);
	assert.match(result.stderr, /UNAVAILABLE: live-pocket/);
	assert.match(result.stderr, /missing_host_capability/);
	assert.match(result.stderr, /not live acceptance/);
	console.log(JSON.stringify({ phase: "live-pocket-gate", exit: result.code }));
});

test("a cursor the listing refuses pauses the watch instead of retrying it forever", { timeout: 30000 }, async () => {
	const f = await watchFixture({ cli: true, idleMs: 5 });
	try {
		await bind(f);
		await f.seedListing([{ cursor: 11713, message_id: 8244 }], { oldest_available_cursor: 11712 });
		// The enable accepts any non-empty cursor; the packaged listing then refuses a non-integer one.
		const enabled = await enable(f, { watchFrom: "cursor-one" });
		assert.equal(enabled.enable!.created, true);
		await f.waitFor("the watch to pause", async () => (await f.watchState()).watch.kind === "paused" ? true : undefined, 10000);
		const state = await f.watchState();
		assert.equal(state.watch.kind === "paused" ? state.watch.reason : null, "invalid_watch_cursor");
		assert.equal(state.lastError, "invalid_watch_cursor");
		assert.equal((await f.watchers()).length, 0, "a mistyped cursor must not leave a retrying watcher behind");
		const polls = (await f.listingEffects()).length;
		await new Promise(resolve => setTimeout(resolve, 80));
		assert.equal((await f.listingEffects()).length, polls, "and it must not keep polling");
		console.log(JSON.stringify({ phase: "bad-cursor", reason: state.watch.kind === "paused" ? state.watch.reason : state.watch.kind }));
	} finally { await f.close(); }
});
