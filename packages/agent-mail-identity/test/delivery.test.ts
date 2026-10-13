import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runJsonCli } from "../src/am-cli.ts";
import { initialWatchState, watchStateOf } from "../src/durable.ts";
import type { MailWatchState } from "../src/durable.ts";
import { MailWatchError, MAX_BATCH_BYTES, MAX_BATCH_EVENTS, MAX_EVENT_BODY_BYTES, MAX_EVENT_FROM_BYTES, MAX_EVENT_SUBJECT_BYTES, backoffDelay, classifyWatchFailure, createPendingDelivery, deriveRequestId, planBatch } from "../src/delivery.ts";
import type { MailDeliveryEvent } from "../src/delivery.ts";
import { pollPhase, preparePhase, settlePhase, submitPhase } from "../src/watcher.ts";
import type { WatchCheckpoint, WatchField, WatchPort, WatchResult, WatchTaskInput, WatchTuning } from "../src/watcher.ts";
import { barrier, fixtureDirectory } from "./repair-extra.inc.ts";

/**
 * Unit-level delivery evidence. The port below is a tiny in-test durable model: it stores one watch document, records
 * every admission attempt, and can be told to fail at one named operation, which is exactly a process crash at that
 * point. No Durable harness, transport, or clock is involved; watcher.test.ts covers the real harness wiring.
 */

type Store = {
	doc: MailWatchState;
	admissions: { requestId: string; payload: string }[];
	polls: number;
	commits: number;
	lookups: number;
	reports: string[];
	sleeps: number[];
	/** One entry per commit: the fields it wrote and the resulting cursor/pending pair. */
	commitLog: { fields: readonly string[]; cursor: string | null; pending: string | null }[];
};

class SimulatedCrash extends Error {}

const CONVERSATION = 7;
const INPUT: WatchTaskInput = { ownerConversationId: CONVERSATION as WatchTaskInput["ownerConversationId"], bindingId: "binding-one", projectKey: "/fixture/project", agentName: "BlueLake" };
const TASK = "task-one";
const TUNING: WatchTuning = { idleMs: 15_000, maxEvents: 50, maxBytes: 8 * 1024, jitter: () => 0.5, backoff: [15_000, 30_000, 60_000, 120_000, 300_000] };

function event(id: string, body = "hello"): MailDeliveryEvent {
	return { eventId: `ev-${id}`, messageId: `msg-${id}`, cursor: `cursor-${id}`, from: "RedStone", subject: `subject ${id}`, body, createdAt: null };
}

function running(cursor: string | null = null, bindingId = INPUT.bindingId): MailWatchState {
	return { ...initialWatchState(), watch: { kind: "running", taskId: TASK, bindingId, ownerConversationId: INPUT.ownerConversationId }, cursor };
}

function storeOf(doc: MailWatchState): Store {
	return { doc, admissions: [], polls: 0, commits: 0, lookups: 0, reports: [], sleeps: [], commitLog: [] };
}

type Fail = { at: "commit" | "poll" | "lookup" | "submit" | "submitAfter"; when?: (change: { state: MailWatchState; next: WatchCheckpoint }) => boolean; once?: boolean } | undefined;

function port(store: Store, mailbox: MailDeliveryEvent[], fail?: Fail | Fail[], pageLimit = 100) {
	const box: { next?: WatchCheckpoint; terminal?: { status: string } } = {};
	const failures = (Array.isArray(fail) ? fail : fail === undefined ? [] : [fail]).filter(entry => entry !== undefined);
	const spent = new Set<Fail>();
	const fires = (at: string): boolean => {
		for (const entry of failures) {
			if (entry.at !== at || spent.has(entry)) continue;
			spent.add(entry);
			return true;
		}
		return false;
	};
	const candidate: WatchPort & { box: typeof box } = {
		taskId: TASK,
		now: () => 1_000,
		sleep: async until => { store.sleeps.push(until); },
		signal: new AbortController().signal,
		presence: () => true,
		state: async () => JSON.parse(JSON.stringify(store.doc)) as MailWatchState,
		lookupAdmission: async requestId => {
			store.lookups += 1;
			if (fires("lookup")) throw new SimulatedCrash("lookup");
			return store.admissions.some(admission => admission.requestId === requestId) ? "admitted" : "absent";
		},
		submit: async pending => {
			if (fires("submit")) throw new SimulatedCrash("submit");
			store.admissions.push({ requestId: pending.requestId, payload: pending.payload });
			if (fires("submitAfter")) throw new SimulatedCrash("lost response");
			return "admitted";
		},
		poll: async (_target, cursor) => {
			store.polls += 1;
			if (fires("poll")) throw new SimulatedCrash("poll");
			const start = cursor === null ? 0 : mailbox.findIndex(entry => entry.cursor === cursor) + 1;
			if (cursor !== null && start === 0) throw new MailWatchError("unknown_cursor");
			return { events: mailbox.slice(start, start + pageLimit), cursor };
		},
		// The fake applies exactly the fields the phase owns to the document as it is, like the real port does, so a
		// phase cannot overwrite data it does not own.
		commit: async change => {
			for (const entry of failures) {
				if (entry.at !== "commit" || spent.has(entry)) continue;
				if (entry.when !== undefined && !entry.when(change)) continue;
				spent.add(entry);
				throw new SimulatedCrash("commit");
			}
			const merged: MailWatchState = { ...store.doc };
			const target = merged as unknown as Record<WatchField, MailWatchState[WatchField]>;
			const source = change.state as unknown as Record<WatchField, MailWatchState[WatchField]>;
			for (const field of change.fields) target[field] = source[field];
			if (change.fields.includes("watch") && store.doc.watch.kind !== "running") merged.watch = store.doc.watch;
			store.commits += 1;
			store.doc = JSON.parse(JSON.stringify(merged)) as MailWatchState;
			store.commitLog.push({ fields: [...change.fields], cursor: store.doc.cursor, pending: store.doc.pending?.requestId ?? null });
			box.next = change.next;
			box.terminal = change.terminal;
		},
		report: error => { store.reports.push(error instanceof MailWatchError ? error.code : "unknown"); },
		box,
	};
	return candidate;
}

/** Run phases exactly as the durable scheduler does: one committed checkpoint per phase. */
async function drive(portInstance: ReturnType<typeof port>, start: WatchCheckpoint, options: { limit?: number; stop?: (checkpoint: WatchCheckpoint) => boolean } = {}): Promise<{ terminal?: string; checkpoint: WatchCheckpoint; steps: number }> {
	const limit = options.limit ?? 40;
	let checkpoint = start;
	for (let steps = 0; steps < limit; steps += 1) {
		const phase = checkpoint.phase;
		portInstance.box.next = undefined;
		if (phase === "poll") await pollPhase(portInstance, TUNING, INPUT, TASK, checkpoint);
		else if (phase === "prepare") await preparePhase(portInstance, TUNING, INPUT, TASK, checkpoint);
		else if (phase === "submit") await submitPhase(portInstance, TUNING, INPUT, TASK, checkpoint);
		else await settlePhase(portInstance, TUNING, INPUT, TASK, checkpoint);
		if (portInstance.box.next === undefined) throw new Error(`phase ${phase} committed nothing`);
		checkpoint = portInstance.box.next;
		if (portInstance.box.terminal !== undefined) return { terminal: portInstance.box.terminal.status, checkpoint, steps: steps + 1 };
		if (options.stop?.(checkpoint)) return { checkpoint, steps: steps + 1 };
	}
	return { checkpoint, steps: limit };
}

/** Real phases up to a durable pending delivery, which is what the crash windows and the race tests start from. */
async function toPending(store: Store, mailbox_: MailDeliveryEvent[], pageLimit = 100) {
	const instance = port(store, mailbox_, undefined, pageLimit);
	await pollPhase(instance, TUNING, INPUT, TASK, { phase: "poll", round: 0 });
	const next = instance.box.next;
	if (next?.phase !== "prepare") throw new Error(`expected a prepare checkpoint, got ${next?.phase}`);
	await preparePhase(instance, TUNING, INPUT, TASK, next);
	const pending = store.doc.pending;
	if (!pending) throw new Error("prepare did not persist a pending delivery");
	return { instance, pending };
}

async function survive(fn: () => Promise<unknown>): Promise<string> {
	try { await fn(); } catch (error) { return error instanceof Error ? error.message : "unknown"; }
	throw new Error("expected the simulated crash");
}

const mailbox = [event("1"), event("2")];

test("batch planning caps events and bytes, never silently dropping a letter", () => {
	const many = Array.from({ length: 60 }, (_, index) => event(String(index + 1)));
	const first = planBatch(INPUT, many);
	assert.equal(first.taken.length, 50);
	assert.equal(first.dropped, 10);
	assert.ok(first.bytes <= 8 * 1024);
	const second = planBatch(INPUT, many.slice(50));
	assert.equal(second.taken.length, 10);
	const fat = [event("huge", "x".repeat(20_000)), event("next")];
	const truncated = planBatch(INPUT, fat);
	assert.equal(truncated.taken.length, 2, "a single oversized body is shortened, the event is still delivered");
	assert.equal(truncated.truncated, true);
	assert.ok(truncated.bytes <= 8 * 1024);
	assert.match(truncated.payload, /ev-huge/);
	assert.match(truncated.payload, /\[truncated\]/);
	assert.equal(truncated.dropped, 0);
	const bodies = [event("a", "y".repeat(5000)), event("b", "z".repeat(5000)), event("c", "w".repeat(5000))];
	const byBytes = planBatch(INPUT, bodies);
	assert.ok(byBytes.bytes <= 8 * 1024);
	assert.equal(byBytes.taken.length, 1);
	assert.deepEqual(byBytes.taken.map(entry => entry.eventId), ["ev-a"]);
	console.log(JSON.stringify({ events: first.taken.length, bytes: first.bytes, byteCapTaken: byBytes.taken.length }));
});

test("one event with an oversized subject or sender is delivered inside the budget with a truncation marker", () => {
	// Regression for the batch budget: the payload is `header + "\n" + blocks.join("\n")`, so every separator must be
	// counted, or a full-byte payload overflows and `createPendingDelivery` refuses a batch the phase cannot escape.
	const caps = { subject: MAX_EVENT_SUBJECT_BYTES, from: MAX_EVENT_FROM_BYTES, body: MAX_EVENT_BODY_BYTES } as const;
	for (const size of [0, 100, 255, 256, 257, 1000, 1023, 1024, 1025, 4096, 8060, 8070, 8192, 8193, 20_000, 100_000]) {
		for (const field of ["subject", "from", "body"] as const) {
			const oversized = { ...event("1"), [field]: "s".repeat(size) };
			const plan = planBatch(INPUT, [oversized]);
			assert.ok(plan.bytes <= MAX_BATCH_BYTES, `${field} ${size}: payload is ${plan.bytes} bytes`);
			assert.equal(plan.bytes, Buffer.byteLength(plan.payload, "utf8"), `${field} ${size}: byte count must match the payload`);
			assert.equal(plan.taken.length, 1, `${field} ${size}: the event must still be delivered`);
			assert.equal(plan.dropped, 0, `${field} ${size}: nothing may be dropped from a single-event page`);
			if (size > caps[field]) {
				assert.equal(plan.truncated, true, `${field} ${size}: a clipped field must be reported`);
				assert.match(plan.payload, /\[truncated\]/, `${field} ${size}: the payload must carry the marker`);
			}
			const pending = createPendingDelivery({ bindingId: "binding-one", conversationId: CONVERSATION, cursorBefore: null, plan, createdAt: 1 });
			assert.equal(pending.bytes, plan.bytes);
		}
	}
	const many = Array.from({ length: 12 }, (_, index) => ({ ...event(String(index + 1)), subject: "t".repeat(700), body: "b".repeat(700) }));
	const plan = planBatch(INPUT, many);
	assert.ok(plan.bytes <= MAX_BATCH_BYTES);
	assert.equal(plan.bytes, Buffer.byteLength(plan.payload, "utf8"));
	assert.ok(plan.taken.length >= 1 && plan.taken.length <= MAX_BATCH_EVENTS);
	console.log(JSON.stringify({ oversized: "subject/from/body", maxPayloadBytes: plan.bytes }));
});

test("admission key is a pure function of conversation, binding, cursor and batch boundary", () => {
	const ids = mailbox.map(entry => entry.eventId);
	const one = deriveRequestId(CONVERSATION, "binding-one", null, ids);
	assert.equal(one, deriveRequestId(CONVERSATION, "binding-one", null, [...ids]));
	assert.notEqual(one, deriveRequestId(CONVERSATION, "binding-two", null, ids));
	assert.notEqual(one, deriveRequestId(CONVERSATION, "binding-one", "cursor-x", ids));
	assert.notEqual(one, deriveRequestId(CONVERSATION, "binding-one", null, ids.slice(0, 1)));
	assert.match(one, /^am2:[0-9a-f]{64}$/);
	const pending = createPendingDelivery({ bindingId: "binding-one", conversationId: CONVERSATION, cursorBefore: null, plan: planBatch(INPUT, mailbox), createdAt: 1 });
	assert.equal(pending.requestId, one);
	assert.equal(pending.cursorAfter, "cursor-2");
	assert.ok(Object.isFrozen(pending));
});

test("capped backoff schedule and failure classification", () => {
	assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(attempt => backoffDelay(attempt, () => 0.5)), [15000, 30000, 60000, 120000, 300000, 300000, 300000]);
	assert.equal(backoffDelay(0, () => 0), 12000);
	assert.equal(backoffDelay(0, () => 1), 18000);
	assert.equal(classifyWatchFailure(new MailWatchError("watch_auth_failed")), "pause");
	assert.equal(classifyWatchFailure(new MailWatchError("watch_schema_incompatible")), "pause");
	assert.equal(classifyWatchFailure(new MailWatchError("invalid_watch_cursor")), "pause", "a cursor the operator mistyped must stop the watch, not retry it");
	assert.equal(classifyWatchFailure(new MailWatchError("watch_cursor_expired")), "pause");
	assert.equal(classifyWatchFailure(new MailWatchError("cli_invalid_json")), "pause");
	assert.equal(classifyWatchFailure(new MailWatchError("invalid_delivery_page")), "pause");
	assert.equal(classifyWatchFailure(new Error("socket hang up")), "retry");
	assert.equal(classifyWatchFailure(new MailWatchError("cli_timeout")), "retry");
	const throwing = { get code(): never { throw new Error("SENTINEL"); } };
	assert.equal(classifyWatchFailure(throwing), "retry");
	assert.equal(classifyWatchFailure(undefined), "retry");
});

test("crash window A: interrupted before pending is written replays the same key and admits once", async () => {
	const store = storeOf(running());
	const first = await survive(() => drive(port(store, mailbox, { at: "commit", when: change => change.next.phase === "prepare" }), { phase: "poll", round: 0 }));
	assert.equal(first, "commit");
	assert.equal(store.doc.pending, null);
	assert.equal(store.doc.cursor, null);
	assert.equal(store.admissions.length, 0);
	const recovery = port(store, mailbox);
	await drive(recovery, { phase: "poll", round: 0 });
	assert.equal(store.admissions.length, 1);
	assert.equal(store.admissions[0].requestId, deriveRequestId(CONVERSATION, INPUT.bindingId, null, mailbox.map(entry => entry.eventId)));
	assert.equal(store.doc.cursor, "cursor-2");
	assert.equal(store.doc.pending, null);
	console.log(JSON.stringify({ window: "before_pending", requestId: store.admissions[0].requestId, admissions: store.admissions.length }));
});

test("the settle recheck moves nothing when the batch was never admitted", async () => {
	const store = storeOf(running());
	const seeded = await toPending(store, mailbox);
	const instance = port(store, mailbox);
	await settlePhase(instance, TUNING, INPUT, TASK, { phase: "settle" });
	assert.deepEqual(instance.box.next, { phase: "submit", attempt: 0 }, "an unadmitted batch goes back to submit");
	assert.equal(store.doc.cursor, null, "the cursor must not advance without a confirmed admission");
	assert.equal(store.doc.pending?.requestId, seeded.pending.requestId, "pending survives the refused settle");
	assert.equal(store.commitLog.filter(entry => entry.fields.includes("cursor")).length, 0, "no settle commit may have run");
});

test("the settle recheck is load-bearing: without it a host that does not deduplicate would deliver twice", async () => {
	// The fake host does not deduplicate by request ID; only the recheck through the public lookup stands between a
	// recovery and a second delivery, so a lookup that lies is the exact failure mode this asserts.
	const store = storeOf(running());
	const seeded = await toPending(store, mailbox);
	const blind = port(store, mailbox);
	blind.lookupAdmission = async () => "absent";
	await drive(blind, { phase: "submit", attempt: 0 }, { limit: 4 });
	assert.equal(store.admissions.length, 2, "a wrong 'absent' answer produces a second delivery");
	assert.equal(store.admissions[1].requestId, seeded.pending.requestId, "and it reuses the same admission key");
	assert.equal(store.doc.cursor, null, "while the cursor still never advances without a confirmed admission");
	// With an honest lookup the same recovery settles instead.
	const honest = storeOf(running());
	const second = await toPending(honest, mailbox);
	await drive(port(honest, mailbox, [{ at: "submitAfter", once: true }]), { phase: "submit", attempt: 0 }, { limit: 2 });
	assert.equal(honest.admissions.length, 1);
	await drive(port(honest, mailbox), { phase: "submit", attempt: 1 });
	assert.equal(honest.admissions.length, 1, "an honest lookup settles the known submission instead of delivering again");
	assert.equal(honest.doc.cursor, second.pending.cursorAfter);
	console.log(JSON.stringify({ blindAdmissions: 2, honestAdmissions: 1 }));
});

test("the settle commit writes the cursor and clears pending in one transaction", async () => {
	const store = storeOf(running());
	const seeded = await toPending(store, mailbox);
	const instance = port(store, mailbox);
	const before = store.commitLog.length;
	await submitPhase(instance, TUNING, INPUT, TASK, { phase: "submit", attempt: 0 });
	await settlePhase(instance, TUNING, INPUT, TASK, { phase: "settle" });
	const touching = store.commitLog.slice(before).filter(entry => entry.fields.includes("cursor") || entry.fields.includes("pending"));
	assert.equal(touching.length, 1, "cursor and pending must be written by exactly one commit");
	assert.deepEqual([...touching[0].fields].filter(field => field === "cursor" || field === "pending").sort(), ["cursor", "pending"]);
	assert.equal(touching[0].pending, null, "pending is cleared in that commit");
	assert.equal(touching[0].cursor, seeded.pending.cursorAfter, "and the cursor advances in the same commit");
	// No commit may ever leave an advanced cursor beside a surviving pending record, or pending cleared before it.
	for (const entry of store.commitLog) assert.ok(!(entry.cursor === seeded.pending.cursorAfter && entry.pending !== null));
	console.log(JSON.stringify({ settleCommits: touching.length, fields: touching[0].fields }));
});

test("crash window B: a process that died after pending and before submit resubmits the stored key once", async () => {
	const store = storeOf(running());
	// Real phases reach the durable pending delivery; the process then dies before any delivery attempt exists.
	const seeded = await toPending(store, mailbox);
	assert.equal(store.admissions.length, 0);
	assert.equal(store.doc.cursor, null, "the cursor is untouched before the batch is admitted");
	const stored = seeded.pending;
	const recovery = port(store, mailbox);
	await drive(recovery, { phase: "submit", attempt: 0 });
	assert.equal(store.admissions.length, 1);
	assert.equal(store.admissions[0].requestId, stored.requestId);
	assert.equal(store.admissions[0].payload, stored.payload);
	assert.equal(store.doc.cursor, stored.cursorAfter);
	assert.equal(store.doc.pending, null);
	console.log(JSON.stringify({ window: "after_pending", requestId: stored.requestId, admissions: store.admissions.length }));
});

test("crash window C: interrupted after admission and before settle settles the known submission without a second delivery", async () => {
	const store = storeOf(running());
	// A lost response, then the process dies while recording the retry: the host admitted the batch, this process did not learn it.
	await survive(() => drive(port(store, mailbox, [
		{ at: "submitAfter", once: true },
		{ at: "commit", once: true, when: change => change.next.phase === "submit" && store.admissions.length > 0 },
	]), { phase: "poll", round: 0 }));
	const stored = store.doc.pending;
	assert.ok(stored);
	assert.equal(store.admissions.length, 1, "the first attempt did reach the host");
	assert.equal(store.doc.cursor, null, "the cursor must not advance on an unconfirmed settle");
	const recovery = port(store, mailbox);
	await drive(recovery, { phase: "submit", attempt: 1 });
	assert.equal(store.admissions.length, 1, "recovery must not deliver a second time");
	assert.equal(store.admissions[0].requestId, stored.requestId);
	assert.equal(store.doc.cursor, stored.cursorAfter);
	assert.equal(store.doc.pending, null);
	console.log(JSON.stringify({ window: "after_admission", requestId: stored.requestId, admissions: store.admissions.length }));
});

test("crash window D: the settle write is one atomic transaction, so it is the same durable boundary as C", async () => {
	const store = storeOf(running());
	const first = await survive(() => drive(port(store, mailbox, { at: "commit", when: change => change.next.phase === "poll" && change.state.cursor !== null }), { phase: "poll", round: 0 }));
	assert.equal(first, "commit");
	assert.ok(store.commits > 0);
	assert.equal(store.admissions.length, 1, "the batch was already admitted");
	assert.equal(store.doc.cursor, null, "a lost settle commit advances neither the cursor ...");
	assert.ok(store.doc.pending, "... nor clears pending");
	const recovery = port(store, mailbox);
	await drive(recovery, { phase: "submit", attempt: 0 });
	assert.equal(store.admissions.length, 1);
	assert.equal(store.doc.cursor, "cursor-2");
	assert.equal(store.doc.pending, null);
});

test("a page larger than the batch cap is drained in order across several batches", async () => {
	const many = Array.from({ length: 120 }, (_, index) => event(String(index + 1), "body-" + index));
	const store = storeOf(running());
	// One page carries all 120 events, twice the 50-event batch cap: paging must continue from the per-event cursor.
	await drive(port(store, many, undefined, 200), { phase: "poll", round: 0 }, { limit: 400, stop: checkpoint => checkpoint.phase === "poll" && store.doc.cursor === "cursor-120" });
	const delivered = store.admissions.flatMap(admission => [...admission.payload.matchAll(/ev-(\d+)/g)].map(match => Number(match[1])));
	assert.deepEqual(delivered, Array.from({ length: 120 }, (_, index) => index + 1), "every event exactly once, in order");
	assert.deepEqual(store.admissions.map(admission => [...admission.payload.matchAll(/ev-(\d+)/g)].length), [50, 50, 20]);
	assert.equal(new Set(store.admissions.map(admission => admission.requestId)).size, 3);
	assert.equal(store.doc.cursor, "cursor-120");
	assert.equal(store.doc.pending, null);
	console.log(JSON.stringify({ page: 120, batches: [50, 50, 20], cursor: store.doc.cursor }));
});

test("an empty poll sleeps the idle cadence, admits nothing and writes no batch state", async () => {
	const store = storeOf(running());
	const recovery = port(store, []);
	const result = await drive(recovery, { phase: "poll", round: 0 }, { limit: 1 });
	assert.equal(result.terminal, undefined);
	assert.equal(result.checkpoint.phase, "poll");
	assert.equal((result.checkpoint as { round: number }).round, 1);
	assert.equal(store.polls, 1);
	assert.equal(store.admissions.length, 0);
	assert.equal(store.sleeps.length, 0);
	const second = port(store, []);
	await drive(second, result.checkpoint, { limit: 1 });
	assert.deepEqual(store.sleeps, [1000 + TUNING.idleMs], "later polls wait one idle interval");
	assert.equal(store.doc.pending, null);
	assert.equal(store.doc.cursor, null);
	assert.equal(store.doc.lastPollAt, 1000);
});

test("an unplannable page pauses the watch instead of escaping the phase as a fault", async () => {
	// A degenerate byte budget makes the plan itself refuse; the phase must turn that into a pause, not a task fault.
	const store = storeOf(running());
	const instance = port(store, mailbox);
	await pollPhase(instance, { ...TUNING, maxBytes: 10 }, INPUT, TASK, { phase: "poll", round: 0 });
	assert.equal(instance.box.terminal?.status, "failed");
	assert.equal(store.doc.watch.kind, "paused");
	assert.equal(store.doc.watch.kind === "paused" ? store.doc.watch.reason : null, "invalid_batch_limits");
	assert.equal(store.doc.cursor, null, "no cursor movement on a refused plan");
	assert.equal(store.admissions.length, 0);
	// A carried batch that cannot be reproduced with the current limits is refused the same way.
	const second = storeOf(running());
	const carried = port(second, mailbox);
	await preparePhase(carried, { ...TUNING, maxEvents: 1 }, INPUT, TASK, { phase: "prepare", events: mailbox, bytes: 0 });
	assert.equal(carried.box.terminal?.status, "failed");
	assert.equal(second.doc.watch.kind === "paused" ? second.doc.watch.reason : null, "batch_unstable");
	assert.equal(second.doc.pending, null, "no pending record survives a refused prepare");
	console.log(JSON.stringify({ paused: ["invalid_batch_limits", "batch_unstable"], faults: 0 }));
});

test("busy conversation keeps pending, backs off, and admits on the retry", async () => {
	const store = storeOf(running());
	let busy = true;
	const seeded = await toPending(store, mailbox);
	const instance = port(store, mailbox);
	instance.submit = async pending => { if (busy) return "busy"; store.admissions.push({ requestId: pending.requestId, payload: pending.payload }); return "admitted"; };
	const stored = seeded.pending;
	await submitPhase(instance, TUNING, INPUT, TASK, { phase: "submit", attempt: 0 });
	assert.equal(store.doc.pending?.requestId, stored.requestId, "a busy race must keep pending");
	assert.equal(store.admissions.length, 0);
	assert.deepEqual(store.sleeps, [1000 + 15000], "the retry waits the first backoff step before its next checkpoint");
	assert.deepEqual(instance.box.next, { phase: "submit", attempt: 1 });
	busy = false;
	await submitPhase(instance, TUNING, INPUT, TASK, { phase: "submit", attempt: 1 });
	assert.deepEqual(store.admissions.map(admission => admission.requestId), [stored.requestId]);
	assert.equal(instance.box.next?.phase, "settle");
	const settling = port(store, mailbox);
	await settlePhase(settling, TUNING, INPUT, TASK, { phase: "settle" });
	assert.equal(store.doc.cursor, stored.cursorAfter);
	assert.equal(store.doc.pending, null);
});

test("a disable that lands before the submit phase prevents the admission and keeps pending", async () => {
	const store = storeOf(running());
	await toPending(store, mailbox);
	const instance = port(store, mailbox);
	store.doc = { ...store.doc, watch: { kind: "disabled" } };
	await submitPhase(instance, TUNING, INPUT, TASK, { phase: "submit", attempt: 0 });
	assert.equal(store.admissions.length, 0, "no admission after a completed disable");
	assert.equal(instance.box.terminal?.status, "aborted");
	assert.equal(store.doc.pending?.bindingId, INPUT.bindingId, "disable preserves the pending delivery");
	assert.equal(store.doc.cursor, null);
});

test("the residual disable race is a real window: a submit already past its guard still delivers", async () => {
	// This is the window no public API can close, so it is demonstrated rather than promised.
	const store = storeOf(running());
	const entered = barrier(), release = barrier();
	await toPending(store, mailbox);
	const instance = port(store, mailbox);
	const original = instance.lookupAdmission;
	instance.lookupAdmission = async requestId => { entered.resolve(); await release.promise; return original(requestId); };
	const running_ = submitPhase(instance, TUNING, INPUT, TASK, { phase: "submit", attempt: 0 });
	await entered.promise;
	store.doc = { ...store.doc, watch: { kind: "disabled" } };
	release.resolve();
	const before = store.admissions.length;
	await running_;
	assert.equal(store.admissions.length, before + 1, "a delivery already past its guard is not revocable through public APIs");
	console.log(JSON.stringify({ residualWindow: "submit-already-past-guard", admissions: store.admissions.length }));
});

test("a pending delivery of another binding pauses instead of being delivered", async () => {
	const state = running(null, "binding-one");
	const other = createPendingDelivery({ bindingId: "binding-two", conversationId: CONVERSATION, cursorBefore: null, plan: planBatch(INPUT, mailbox), createdAt: 1 });
	const store = storeOf({ ...state, pending: other });
	const instance = port(store, mailbox);
	await drive(instance, { phase: "submit", attempt: 0 });
	assert.equal(store.admissions.length, 0);
	assert.equal(store.doc.watch.kind, "paused");
	assert.equal(store.doc.pending?.bindingId, "binding-two");
	assert.equal(instance.box.terminal?.status, "failed");
});

test("authentication and incompatible schema pause the watcher; a timeout only retries", async () => {
	for (const [code, terminal] of [["watch_auth_failed", "failed"], ["watch_schema_incompatible", "failed"], ["cli_timeout", undefined]] as const) {
		const store = storeOf(running());
		const instance = port(store, mailbox, { at: "poll" });
		instance.poll = async () => { throw new MailWatchError(code); };
		await pollPhase(instance, TUNING, INPUT, TASK, { phase: "poll", round: 0 });
		assert.equal(instance.box.terminal?.status, terminal, code);
		if (terminal) {
			assert.equal(store.doc.watch.kind, "paused");
			assert.equal(store.doc.watch.kind === "paused" ? store.doc.watch.reason : null, code);
		} else {
			assert.equal(store.doc.watch.kind, "running");
			assert.equal(store.doc.lastError, code);
			assert.deepEqual(store.reports, [code]);
		}
	}
	const foreign = { ...initialWatchState(), schemaVersion: 2 as unknown as 1 };
	assert.throws(() => watchStateOf(foreign), /watch_schema_incompatible/);
});

test("paged reads deliver every event across batches without skipping a boundary", async () => {
	const many = Array.from({ length: 60 }, (_, index) => event(String(index + 1), "body-" + index));
	const store = storeOf(running());
	await drive(port(store, many, undefined, 25), { phase: "poll", round: 0 }, { limit: 200, stop: checkpoint => checkpoint.phase === "poll" && store.doc.cursor === "cursor-60" });
	// A transport page of 25 and a batch cap of 50 produce three deliveries; every event is delivered exactly once, in order.
	const delivered = store.admissions.flatMap(admission => [...admission.payload.matchAll(/ev-(\d+)/g)].map(match => Number(match[1])));
	assert.deepEqual(delivered, Array.from({ length: 60 }, (_, index) => index + 1));
	assert.equal(store.admissions.length, 3);
	assert.deepEqual(store.admissions.map(admission => [...admission.payload.matchAll(/ev-(\d+)/g)].length), [25, 25, 10]);
	assert.equal(new Set(store.admissions.map(admission => admission.requestId)).size, 3);
	assert.equal(store.doc.cursor, "cursor-60");
	assert.equal(store.doc.pending, null);
	console.log(JSON.stringify({ batches: store.admissions.length, batches_events: [25, 25, 10], cursor: store.doc.cursor }));
});

test("a pending delivery short-circuits the poll: the page of an in-flight batch is not read again", async () => {
	// What this proves is the short circuit, not the deduplication of a page the mailbox re-serves: while a batch is
	// pending the phase never reaches the mailbox, so no second pending record can be planned for that page and the
	// admission key stays the one the batch was read at. The deduplication of a re-served page at the same boundary is
	// proven by the crash-window A test above (the page is read again only after the interrupted run left no pending).
	const store = storeOf(running());
	const seeded = await toPending(store, mailbox);
	const polls = store.polls;
	const replay = port(store, mailbox);
	const first = await drive(replay, { phase: "poll", round: 0 }, { limit: 1 });
	assert.deepEqual(first.checkpoint, { phase: "settle" }, "an in-flight batch goes straight to settle");
	assert.equal(store.polls, polls, "the mailbox is not read again while a batch is in flight");
	assert.equal(store.doc.pending?.requestId, seeded.pending.requestId, "the key of the in-flight batch is unchanged");
	assert.equal(store.admissions.length, 0);
	// Settling that batch admits it exactly once, under the stored key.
	await drive(port(store, mailbox), first.checkpoint, { limit: 40 });
	assert.equal(store.admissions.length, 1, "settling the in-flight batch admits it exactly once");
	assert.equal(store.admissions[0].requestId, seeded.pending.requestId);
	assert.equal(store.doc.cursor, "cursor-2");
	assert.equal(store.doc.pending, null);
	// A conforming transport refuses a page that repeats positions at or before the requested cursor
	// (test/am-cli.test.ts), which is why the phase never has to deduplicate one.
	console.log(JSON.stringify({ shortCircuitedPoll: true, admissions: store.admissions.length }));
});

test("a duplicate event inside one page is read, not dropped, and does not stall the cursor", async () => {
	const duplicated = [event("1"), event("1"), event("2")];
	const second = storeOf(running());
	await drive(port(second, duplicated), { phase: "poll", round: 0 });
	assert.equal(second.admissions.length, 1);
	assert.equal(second.doc.cursor, "cursor-2");
	assert.equal((second.admissions[0].payload.match(/ev-1/g) ?? []).length, 2, "a repeated event is read, not dropped silently");
	console.log(JSON.stringify({ duplicateEvents: 2, cursor: second.doc.cursor }));
});

test("only an explicit position-now read may establish a position; any other page must echo the requested cursor", async () => {
	// A null stored cursor is exactly the position-now request, so the reported tail becomes the durable cursor.
	const store = storeOf(running(null));
	const instance = port(store, []);
	instance.poll = async (_target, cursor) => { store.polls += 1; return { events: [], cursor: cursor === null ? "11902" : cursor }; };
	await drive(instance, { phase: "poll", round: 0 }, { limit: 1 });
	assert.equal(store.doc.cursor, "11902", "an explicit position-now page establishes the starting cursor");
	assert.equal(store.admissions.length, 0);
	assert.equal(instance.box.terminal, undefined, "establishing a position is not a failure");
	const adopted = port(store, []);
	await drive(adopted, { phase: "poll", round: 0 }, { limit: 1 });
	assert.equal(store.doc.cursor, "11902", "the adopted cursor is durable and is echoed by later pages");
	assert.equal(adopted.box.terminal, undefined);
	// Anything else — a higher position, a lower one, or a foreign encoding — pauses without moving the cursor.
	for (const reported of ["11700", "11900", "cursor-x"]) {
		const held = running("11902");
		const regressed = storeOf(held);
		const portInstance = port(regressed, []);
		portInstance.poll = async () => ({ events: [], cursor: reported });
		await drive(portInstance, { phase: "poll", round: 0 }, { limit: 1 });
		assert.equal(portInstance.box.terminal?.status, "failed", `page cursor ${reported}`);
		assert.equal(regressed.doc.cursor, "11902", `page cursor ${reported} must not move the durable cursor`);
		assert.equal(regressed.doc.watch.kind, "paused");
		assert.equal(regressed.doc.watch.kind === "paused" ? regressed.doc.watch.reason : null, "watcher_cursor_regression");
	}
	console.log(JSON.stringify({ position: "now-adoption", refused: 3 }));
});

test("the read-only listing contract reaches the fixture CLI and never marks mail read", async () => {
	const dir = await fixtureDirectory("am-delivery-cli-");
	const log = join(dir, "effects.log");
	const mailboxFile = join(dir, "mailbox.json");
	const call = (mode: string[]) => runJsonCli(process.execPath, [fileURLToPath(new URL("./fixtures/am-fixture.mjs", import.meta.url)), ...mode], { env: { AM_FIXTURE_EFFECT_LOG: log, AM_FIXTURE_MAILBOX: mailboxFile } });
	const page = { events: [{ cursor: 11713, message_id: 8244, kind: "to", delivered_ts: "2026-10-12T16:56:12.035902Z", subject: "s", from: "FrostyRobin", importance: "normal", ack_required: false }], tail_cursor: 11713, oldest_available_cursor: 11713 };
	await writeFile(mailboxFile, JSON.stringify(page));
	assert.deepEqual(await call(["inbox-events", "--after", "11712", "--limit", "5", "--json"]), { events: page.events, next_cursor: 11713, has_more: false, oldest_available_cursor: 11713, tail_cursor: 11713 });
	assert.deepEqual(await call(["inbox-events", "--position-now", "--json"]), { events: [], next_cursor: 11713, has_more: false, oldest_available_cursor: 11713, tail_cursor: 11713 });
	const readOnly = (await readFile(log, "utf8")).trim().split("\n");
	assert.deepEqual(readOnly, ["inbox-events:after=11712:limit=5", "inbox-events:position-now:limit=100"], "the delivery listing records no read-marking effect");
	assert.ok(!readOnly.some(effect => effect.startsWith("mark-read")));
	// The detector is not vacuous: the fixture records a real read-marking command when one is issued.
	assert.deepEqual(await call(["mark-all-read", "--project", "p", "--agent", "a"]), { marked: true });
	assert.deepEqual(await call(["mail", "ack", "--project", "p", "--agent", "a", "8244"]), { marked: true });
	const after = (await readFile(log, "utf8")).trim().split("\n");
	assert.deepEqual(after.slice(readOnly.length), ["mark-all-read---project-p---agent-a", "mail-ack---project-p---agent-a-8244"]);
	console.log(JSON.stringify({ fixture: dir, readOnlyEffects: readOnly.length }));
});
