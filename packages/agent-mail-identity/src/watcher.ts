import { ConversationBusy, defineTask } from "@earendil-works/pi-durable";
import type { AnyTask, ConversationId, RegistryReader, Task, TaskOutcome, TaskRuntime } from "@earendil-works/pi-durable";
import { initialWatchState, MailWatchDoc, MAIL_WATCH_SCHEMA_VERSION, watchStateOf } from "./durable.ts";
import type { MailWatchMode, MailWatchState } from "./durable.ts";
import {
	backoffDelay,
	classifyWatchFailure,
	createPendingDelivery,
	BACKOFF_MS,
	IDLE_POLL_MS,
	MailWatchError,
	planBatch,
	watchFailureCode,
	MAX_BATCH_BYTES,
	MAX_BATCH_EVENTS,
} from "./delivery.ts";
import type { MailDeliveryEvent, MailDeliveryPage, PendingDelivery } from "./delivery.ts";

/**
 * AM2 watcher: one durable background task per bound conversation polls a read-only delivery stream and admits one
 * batch as a single conversation submission. No timer, daemon, or hidden registry access: the host injects the
 * transport, the live presence source, and the abort capability.
 */

export const MAIL_WATCH_TASK_NAME = "agent-mail-identity.watch";
/** Statuses a watcher task can be in while it may still run: only these count as a live watcher. */
export const WATCH_LIVE_STATUSES = ["pending", "running", "waiting", "completing"] as const;
export { MAIL_WATCH_SCHEMA_VERSION, initialWatchState, watchStateOf, MailWatchDoc } from "./durable.ts";
export type { MailWatchMode, MailWatchState } from "./durable.ts";

/** Why a watcher stopped without an operator command. */
export type MailWatchStopReason = "disabled" | "paused" | "uninstalled" | "aborted" | "stale_binding";

/** Durable input of the watcher task: the binding it may act for, and nothing else. */
export type WatchTaskInput = {
	ownerConversationId: ConversationId;
	bindingId: string;
	projectKey: string;
	agentName: string;
};

export type WatchCheckpoint =
	| { phase: "poll"; round: number }
	| { phase: "prepare"; events: MailDeliveryEvent[]; bytes: number }
	| { phase: "submit"; attempt: number }
	| { phase: "settle" };

export type WatchResult = { reason: string };

export type WatchTuning = {
	/** Poll cadence of an enabled binding with nothing to deliver. */
	idleMs: number;
	maxEvents: number;
	maxBytes: number;
	/** Jitter source for the capped backoff; a fixture supplies a deterministic one. */
	jitter: () => number;
	/** Capped backoff schedule in milliseconds; defaults to the plan's 15/30/60/120/300 seconds. */
	backoff: readonly number[];
};

export function defaultTuning(): WatchTuning {
	return { idleMs: IDLE_POLL_MS, maxEvents: MAX_BATCH_EVENTS, maxBytes: MAX_BATCH_BYTES, jitter: Math.random, backoff: BACKOFF_MS };
}

/* ----------------------------------------------------------------------------------------------------------------
 * Phase port: the only way a phase touches the outer world. The Durable wiring and the unit fixtures implement it.
 * -------------------------------------------------------------------------------------------------------------- */

/** Fields a phase may own. `cursor` and `pending` are always written together, and `watch` only to stop a watch. */
export type WatchField = "watch" | "cursor" | "pending" | "lastError" | "lastPollAt" | "nextPollAt";

export type WatchCommit =
	| { state: MailWatchState; fields: readonly WatchField[]; next: WatchCheckpoint; terminal?: undefined }
	| { state: MailWatchState; fields: readonly WatchField[]; next: WatchCheckpoint; terminal: TaskOutcome<WatchResult> };

export type WatchPort = {
	/** Identity of the invocation running these phases; only the task the state names may act. */
	taskId: string;
	now(): number;
	sleep(until: number): Promise<void>;
	readonly signal: AbortSignal;
	/** Live presence of this watcher implementation in the registry the host supplied. */
	presence(): boolean;
	state(): Promise<MailWatchState>;
	/** Read-only admission check against the host's public submission lookup. Never an external delivery. */
	lookupAdmission(requestId: string): Promise<"admitted" | "absent">;
	/** One external admission attempt with `whenBusy: "reject"`; the payload and the key are reused verbatim. */
	submit(pending: PendingDelivery): Promise<"admitted" | "busy">;
	/** Bounded, read-only page of delivery events after `cursor`. Never marks a message read. */
	poll(target: { projectKey: string; agentName: string }, cursor: string | null): Promise<MailDeliveryPage>;
	/**
	 * One durable transaction: the named fields of the watch state and the next checkpoint, or a terminal outcome,
	 * land together. Fields not named are left as the document currently has them, so an operator command and a phase
	 * can never overwrite each other's data.
	 */
	commit(change: WatchCommit): Promise<void>;
	report(error: unknown): void;
};

function runningFor(state: MailWatchState, input: WatchTaskInput, taskId: string): boolean {
	return state.watch.kind === "running" && state.watch.taskId === taskId &&
		state.watch.bindingId === input.bindingId && state.watch.ownerConversationId === input.ownerConversationId;
}

/** Stop an enabled watch with a fixed public reason: a pause the operator can see, never an uncaught phase throw. */
function pause(state: MailWatchState, code: string, next: WatchCheckpoint): WatchCommit {
	const paused: MailWatchState = { ...state, watch: { kind: "paused", reason: code }, lastError: code, nextPollAt: null };
	return { state: paused, fields: ["watch", "lastError", "nextPollAt"], next, terminal: { status: "failed", error: { message: code } } };
}

/** Guard every phase runs before touching the mailbox: enabled state, owner, binding, and live presence. */
async function guard(port: WatchPort, input: WatchTaskInput, taskId: string): Promise<{ state: MailWatchState; terminal?: TaskOutcome<WatchResult>; fields?: readonly WatchField[] }> {
	let state: MailWatchState;
	try {
		state = await port.state();
	} catch (error) {
		// An unreadable or foreign watch document stops the watch as a pause with a fixed code: it must not fault the
		// task with a bare throw, and the commit that follows rewrites the fields it owns with the current schema
		// version, so the document becomes decodable again.
		const stopped = pause(initialWatchState(), watchFailureCode(error), { phase: "poll", round: 0 });
		return { state: stopped.state, fields: stopped.fields, terminal: stopped.terminal };
	}
	if (!runningFor(state, input, taskId)) {
		const reason: MailWatchStopReason = state.watch.kind === "paused" ? "paused" : "disabled";
		// Nothing to write: the watch already reports why it is not polling, and the task simply ends.
		return { state, fields: [], terminal: { status: "aborted", reason: `watch_${reason}` } };
	}
	if (!port.presence()) {
		const paused: MailWatchState = { ...state, watch: { kind: "paused", reason: "uninstalled" }, lastError: "watch_uninstalled", nextPollAt: null };
		return { state: paused, fields: ["watch", "lastError", "nextPollAt"], terminal: { status: "aborted", reason: "watch_uninstalled" } };
	}
	if (state.pending && state.pending.bindingId !== input.bindingId) {
		const paused: MailWatchState = { ...state, watch: { kind: "paused", reason: "stale_binding" }, lastError: "stale_binding", nextPollAt: null };
		return { state: paused, fields: ["watch", "lastError", "nextPollAt"], terminal: { status: "failed", error: { message: "stale_binding" } } };
	}
	return { state };
}

function guarded(port: WatchPort, result: { state: MailWatchState; terminal?: TaskOutcome<WatchResult>; fields?: readonly WatchField[] }): Promise<void> {
	return port.commit({ state: result.state, fields: result.fields ?? [], next: { phase: "poll", round: 0 }, terminal: result.terminal });
}

/** Transient failure: keep pending, report a fixed code, and schedule a jittered retry. Pause ends the task. */
async function transient(port: WatchPort, state: MailWatchState, next: WatchCheckpoint, attempt: number, error: unknown, delay: number): Promise<void> {
	const code = watchFailureCode(error);
	if (classifyWatchFailure(error) === "pause") {
		port.report(new MailWatchError(code));
		return port.commit(pause(state, code, next));
	}
	port.report(new MailWatchError(code));
	const retried: MailWatchState = { ...state, lastError: code, nextPollAt: port.now() + delay };
	await port.commit({ state: retried, fields: ["lastError", "nextPollAt"], next: { phase: "submit", attempt: attempt + 1 } });
}

/* ----------------------------------------------------------------------------------------------------------------
 * Phases
 * -------------------------------------------------------------------------------------------------------------- */

/** Poll: guards, an in-flight delivery, or one bounded read-only page. */
export async function pollPhase(port: WatchPort, tuning: WatchTuning, input: WatchTaskInput, taskId: string, checkpoint: { phase: "poll"; round: number }): Promise<void> {
	port.signal.throwIfAborted();
	const checked = await guard(port, input, taskId);
	if (checked.terminal) return guarded(port, checked);
	let state = checked.state;
	// Nothing to write here: the in-flight delivery is already durable, so the phase only moves the checkpoint on.
	if (state.pending) return port.commit({ state, fields: [], next: { phase: "settle" } });
	// The first poll after enabling runs at once; later polls keep the idle cadence even when nothing arrives.
	if (checkpoint.round > 0) await port.sleep(port.now() + tuning.idleMs);
	const nextRound = { phase: "poll" as const, round: checkpoint.round + 1 };
	let page: MailDeliveryPage;
	try {
		page = await port.poll({ projectKey: input.projectKey, agentName: input.agentName }, state.cursor);
	} catch (error) {
		if (port.signal.aborted) throw error;
		const code = watchFailureCode(error);
		port.report(new MailWatchError(code));
		if (classifyWatchFailure(error) === "pause") return port.commit(pause(state, code, nextRound));
		const delay = backoffDelay(checkpoint.round, tuning.jitter, tuning.backoff);
		const retried: MailWatchState = { ...state, lastError: code, lastPollAt: port.now(), nextPollAt: port.now() + delay };
		return port.commit({ state: retried, fields: ["lastError", "lastPollAt", "nextPollAt"], next: nextRound });
	}
	const now = port.now();
	if (page.events.length === 0) {
		// A position may only be established by an explicit position-now read, which is the request a null cursor makes.
		// Anything else must report exactly the cursor that was requested, whatever its encoding.
		const reported = page.cursor;
		if (reported !== state.cursor) {
			if (state.cursor !== null || reported === null) return port.commit(pause(state, "watcher_cursor_regression", nextRound));
			state = { ...state, cursor: reported };
		}
		const idle: MailWatchState = { ...state, lastError: null, lastPollAt: now, nextPollAt: now + tuning.idleMs };
		return port.commit({ state: idle, fields: ["cursor", "lastError", "lastPollAt", "nextPollAt"], next: nextRound });
	}
	let plan;
	try {
		plan = planBatch(input, page.events, { maxEvents: tuning.maxEvents, maxBytes: tuning.maxBytes });
	} catch (error) {
		return port.commit(pause(state, watchFailureCode(error), nextRound));
	}
	const ready: MailWatchState = { ...state, lastError: null, lastPollAt: now, nextPollAt: now };
	return port.commit({ state: ready, fields: ["lastError", "lastPollAt", "nextPollAt"], next: { phase: "prepare", events: plan.taken, bytes: plan.bytes } });
}

/** Prepare: build the immutable pending record and the admission key before any external delivery. */
export async function preparePhase(port: WatchPort, tuning: WatchTuning, input: WatchTaskInput, taskId: string, checkpoint: { phase: "prepare"; events: MailDeliveryEvent[]; bytes: number }): Promise<void> {
	port.signal.throwIfAborted();
	const checked = await guard(port, input, taskId);
	if (checked.terminal) return guarded(port, checked);
	const state = checked.state;
	let pending: PendingDelivery;
	try {
		const plan = planBatch(input, checkpoint.events, { maxEvents: tuning.maxEvents, maxBytes: tuning.maxBytes });
		// The carried batch must be reproducible with the same limits, or the key and the payload would drift.
		if (plan.taken.length !== checkpoint.events.length) return port.commit(pause(state, "batch_unstable", { phase: "poll", round: 0 }));
		pending = createPendingDelivery({ bindingId: input.bindingId, conversationId: input.ownerConversationId, cursorBefore: state.cursor, plan, createdAt: port.now() });
	} catch (error) {
		// A batch that cannot be planned or persisted pauses the watch; it never escapes the phase as a fault.
		return port.commit(pause(state, watchFailureCode(error), { phase: "poll", round: 0 }));
	}
	const ready: MailWatchState = { ...state, pending, lastError: null };
	return port.commit({ state: ready, fields: ["pending", "lastError"], next: { phase: "submit", attempt: 0 } });
}

/** Submit: settle a known admission first, otherwise make exactly one external attempt. */
export async function submitPhase(port: WatchPort, tuning: WatchTuning, input: WatchTaskInput, taskId: string, checkpoint: { phase: "submit"; attempt: number }): Promise<void> {
	port.signal.throwIfAborted();
	const checked = await guard(port, input, taskId);
	if (checked.terminal) return guarded(port, checked);
	const state = checked.state;
	const pending = state.pending;
	if (!pending) return port.commit({ state, fields: [], next: { phase: "poll", round: 0 } });
	const delay = backoffDelay(checkpoint.attempt, tuning.jitter, tuning.backoff);
	try {
		if (await port.lookupAdmission(pending.requestId) === "admitted") return port.commit({ state, fields: [], next: { phase: "settle" } });
	} catch (error) {
		if (port.signal.aborted) throw error;
		return transient(port, state, checkpoint, checkpoint.attempt, error, delay);
	}
	// The signal is the last public check available before the call; nothing can prove the absence of a race below it.
	if (port.signal.aborted) return port.commit({ state, fields: [], next: { phase: "poll", round: 0 } });
	try {
		if (await port.submit(pending) === "admitted") return port.commit({ state, fields: [], next: { phase: "settle" } });
		const busy: MailWatchState = { ...state, lastError: "conversation_busy", nextPollAt: port.now() + delay };
		await port.sleep(port.now() + delay);
		return port.commit({ state: busy, fields: ["lastError", "nextPollAt"], next: { phase: "submit", attempt: checkpoint.attempt + 1 } });
	} catch (error) {
		if (port.signal.aborted) throw error;
		await transient(port, state, checkpoint, checkpoint.attempt, error, delay);
	}
}

/** Settle: advance the cursor and clear pending in one transaction, only for a confirmed admission. */
export async function settlePhase(port: WatchPort, tuning: WatchTuning, input: WatchTaskInput, taskId: string, checkpoint: { phase: "settle" }): Promise<void> {
	port.signal.throwIfAborted();
	const checked = await guard(port, input, taskId);
	if (checked.terminal) return guarded(port, checked);
	const state = checked.state;
	const pending = state.pending;
	if (!pending) return port.commit({ state, fields: [], next: { phase: "poll", round: 0 } });
	// Re-verify before advancing: the cursor must never move past a batch that was not admitted.
	const admitted = await port.lookupAdmission(pending.requestId).catch(() => "absent" as const);
	if (admitted !== "admitted") return port.commit({ state, fields: [], next: { phase: "submit", attempt: 0 } });
	// `cursor` and `pending` are written in this one commit and in no other: the cursor never advances while a pending
	// record survives, and a pending record never outlives the cursor that replaces it.
	const settled: MailWatchState = { ...state, cursor: pending.cursorAfter, pending: null, lastError: null, nextPollAt: port.now() + tuning.idleMs };
	return port.commit({ state: settled, fields: ["cursor", "pending", "lastError", "nextPollAt"], next: { phase: "poll", round: 0 } });
}

/* ----------------------------------------------------------------------------------------------------------------
 * Durable task definition
 * -------------------------------------------------------------------------------------------------------------- */

export type MailWatchOptions = {
	/** Read-only delivery source. Its poll must never mark a message read or acknowledged. */
	poll(target: { projectKey: string; agentName: string }, cursor: string | null, signal: AbortSignal): Promise<MailDeliveryPage>;
	/** Live presence of this watcher, read from the host's registry reader or an equivalent capability. */
	presence(): boolean;
	tuning?: Partial<WatchTuning>;
};

/** Presence function over an injected registry reader: installed means the implementation is still resolvable. */
export function registryPresence(reader: Pick<RegistryReader, "snapshot">, name = "agent-mail-identity"): () => boolean {
	return () => reader.snapshot().extension(name) !== undefined;
}

/**
 * Merge the fields a phase owns into the document as it currently is inside this transaction. Fields the phase does not
 * own are left alone, so a concurrent operator command (which owns `watch`) can never be clobbered by a phase, and a
 * phase can only ever stop a running watch: `disabled` or `paused` as the document has it is preserved.
 */
function mergeWatchFields(current: MailWatchState, proposed: MailWatchState, fields: readonly WatchField[], preserveExistingWatch = true): MailWatchState {
	const merged: MailWatchState = { ...current };
	const target = merged as unknown as Record<WatchField, MailWatchState[WatchField]>;
	const source = proposed as unknown as Record<WatchField, MailWatchState[WatchField]>;
	for (const field of fields) target[field] = source[field];
	if (preserveExistingWatch && fields.includes("watch") && current.watch.kind !== "running") merged.watch = current.watch;
	return merged;
}

/**
 * Decode a stored watch document without letting a foreign or corrupt one escape as an uncaught rejection. A document
 * another schema version wrote, or an out-of-band write, is not decodable: the phases must be able to land a commit
 * against it (a pause) instead of faulting, so an undecodable read falls back to the initial state and the commit that
 * follows rewrites every field it owns with the current schema version, which makes the document decodable again.
 */
function decodeWatchDocument(stored: MailWatchState | undefined): { state: MailWatchState; decodable: boolean } {
	try {
		return { state: watchStateOf(stored), decodable: true };
	} catch {
		return { state: initialWatchState(), decodable: false };
	}
}

type WatchRuntime = TaskRuntime<WatchTaskInput, WatchCheckpoint, WatchResult, object>;
/** The invocation context type of a task runtime, named through the API it is passed to. */
type WatchContext = Parameters<WatchRuntime["sleep"]>[1];

function portOf(runtime: WatchRuntime, context: WatchContext, options: MailWatchOptions): WatchPort {
	const conversationId = runtime.conversationId;
	return {
		taskId: String(runtime.taskId),
		now: () => runtime.now(),
		sleep: until => runtime.sleep(until, context),
		signal: runtime.signal,
		presence: () => options.presence(),
		state: async () => watchStateOf((await runtime.snapshot(MailWatchDoc, conversationId, context)) as unknown as MailWatchState | undefined),
		// The public deduplication read lives on the transaction surface; an empty commit is a line read and writes nothing.
		lookupAdmission: async requestId => {
			let found = false;
			await runtime.commit(async tx => {
				found = (await tx.submissionByRequest(conversationId, requestId)) !== undefined;
				return undefined;
			}, context);
			return found ? "admitted" : "absent";
		},
		submit: async pending => {
			const handle = await runtime.conversation(conversationId, context);
			if (!handle) throw new MailWatchError("owner_conversation_missing");
			try {
				await handle.submit({ type: "input", content: pending.payload, requestId: pending.requestId, whenBusy: "reject" }, context);
				return "admitted";
			} catch (error) {
				if (error instanceof ConversationBusy) return "busy";
				throw error;
			}
		},
		poll: (target, cursor) => options.poll(target, cursor, runtime.signal),
		commit: change => runtime.commit(async tx => {
			const doc = await tx.doc(MailWatchDoc, conversationId);
			const decoded = decodeWatchDocument(doc as unknown as MailWatchState | undefined);
			if (!decoded.decodable) {
				// Fail closed: a document this build cannot read (a foreign schema, an out-of-band write) stops the watch as a
				// pause carrying the fixed schema code, written outright against a clean state, so the document becomes
				// decodable again and no foreign cursor, pending payload or watch state is trusted or kept. The task ends here.
				const stopped = pause(initialWatchState(), "watch_schema_incompatible", change.next);
				Object.assign(doc, mergeWatchFields(stopped.state, stopped.state, stopped.fields, false));
				return { status: "terminal" as const, outcome: change.terminal ?? stopped.terminal as TaskOutcome<WatchResult> };
			}
			Object.assign(doc, mergeWatchFields(decoded.state, change.state, change.fields));
			return change.terminal === undefined
				? { status: "running" as const, checkpoint: change.next }
				: { status: "terminal" as const, outcome: change.terminal };
		}, context),
		report: error => runtime.report(error),
	};
}

/** The one watcher definition. It is safe to register repeatedly; the durable task identity is what matters. */
export function createMailWatchTask(options: MailWatchOptions): Task<WatchTaskInput, WatchCheckpoint, WatchResult, object> {
	const tuning: WatchTuning = { ...defaultTuning(), ...options.tuning };
	return defineTask<WatchTaskInput, WatchCheckpoint, WatchResult, object>({
		name: MAIL_WATCH_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "poll", round: 0 }),
		phases: {
			poll: (task, runtime, context) => pollPhase(portOf(runtime, context, options), tuning, task.input, String(task.id), task.state.checkpoint),
			prepare: (task, runtime, context) => preparePhase(portOf(runtime, context, options), tuning, task.input, String(task.id), task.state.checkpoint),
			submit: (task, runtime, context) => submitPhase(portOf(runtime, context, options), tuning, task.input, String(task.id), task.state.checkpoint),
			settle: (task, runtime, context) => settlePhase(portOf(runtime, context, options), tuning, task.input, String(task.id), task.state.checkpoint),
		},
		abort: async (task, runtime, context) => {
			// Abort keeps identity, cursor and pending: only a watch still running is downgraded, so a disable that
			// already committed cannot be overwritten by this handler.
			await runtime.commit(async tx => {
				const doc = await tx.doc(MailWatchDoc, task.input.ownerConversationId);
				const decoded = decodeWatchDocument(doc as unknown as MailWatchState | undefined);
				const current = decoded.state;
				// An undecodable document is left exactly as it is: a schema this build does not understand may belong to a
				// newer one, and aborting a task is not a reason to overwrite it.
				if (decoded.decodable && current.watch.kind === "running") {
					Object.assign(doc, mergeWatchFields(current, { ...current, watch: { kind: "paused", reason: "aborted" }, nextPollAt: null }, ["watch", "nextPollAt"]));
				}
				return { status: "terminal" as const, outcome: { status: "aborted" as const, reason: "watch_aborted" } };
			}, context);
		},
	});
}

/* ----------------------------------------------------------------------------------------------------------------
 * Operator control: enable, pause, resume, disable, status. All of it through public task and document APIs.
 * -------------------------------------------------------------------------------------------------------------- */

export type WatchTaskRecord = {
	status: "pending" | "running" | "waiting" | "completing" | "terminal";
	conversationId: number;
	phase: string | null;
};

export type WatchControl = {
	state(conversationId: ConversationId): Promise<MailWatchState>;
	/**
	 * Operator-owned fields only, written against the document as it is inside the commit. `cursor` and `pending` are
	 * never touched, so a phase finishing at the same time cannot be overwritten and cannot overwrite this.
	 */
	update(conversationId: ConversationId, change: { watch: MailWatchMode; nextPollAt: number | null; lastError?: string | null }): Promise<{ taskId: string | null }>;
	/**
	 * One transaction: adopt a live watcher of this conversation or create one, name it in the state, and set the
	 * cursor only when the operator asked for a start position. `pending` is never touched.
	 */
	ensure(conversationId: ConversationId, input: WatchTaskInput, mode: Omit<Extract<MailWatchMode, { kind: "running" }>, "taskId">, cursorIntent: { cursor: string | null } | null): Promise<{ taskId: string; created: boolean; cursor: string | null }>;
	get(taskId: string): Promise<WatchTaskRecord | undefined>;
	abort(taskId: string): Promise<"marked" | "terminal">;
	wait(taskId: string): Promise<void>;
};

export type WatchStart = { kind: "resume" } | { kind: "now" } | { kind: "cursor"; cursor: string };

export type WatchEnableResult = { taskId: string; created: boolean; cursor: string | null; from: WatchStart["kind"] };

/** Enable or resume. An absent cursor keeps the stored position; `now` deliberately skips the existing backlog. */
export async function enableWatch(control: WatchControl, input: WatchTaskInput, start: WatchStart): Promise<WatchEnableResult> {
	if (start.kind === "cursor" && !validCursor(start.cursor)) throw new MailWatchError("invalid_watch_cursor");
	const state = await control.state(input.ownerConversationId);
	if (state.watch.kind === "running") {
		const live = await control.get(state.watch.taskId);
		if (live && live.status !== "terminal" && live.conversationId === input.ownerConversationId) {
			return { taskId: state.watch.taskId, created: false, cursor: state.cursor, from: "resume" };
		}
	}
	const { taskId, created, cursor } = await control.ensure(
		input.ownerConversationId,
		input,
		{ kind: "running", bindingId: input.bindingId, ownerConversationId: input.ownerConversationId },
		start.kind === "resume" ? null : { cursor: start.kind === "now" ? null : start.cursor },
	);
	return { taskId, created, cursor, from: start.kind };
}

/** A cursor an operator may hand in: non-empty and free of whitespace and control characters. */
export function validCursor(cursor: string): boolean {
	return typeof cursor === "string" && cursor.length > 0 && cursor.length <= 4096 && cursor.trim() === cursor && !/[\x00-\x20]/.test(cursor);
}

/** Stop a running watcher and join it. Returns only after the task is terminal or unreachable. */
export async function stopWatch(control: WatchControl, conversationId: ConversationId, mode: MailWatchMode, reason = "manual"): Promise<{ taskId: string | null; joined: boolean }> {
	const { taskId } = await control.update(conversationId, {
		watch: mode,
		nextPollAt: null,
		// Only the operator's own stop reason; the cursor and any pending delivery stay exactly as the phases left them.
		...(mode.kind === "paused" ? { lastError: reason } : {}),
	});
	if (!taskId) return { taskId: null, joined: false };
	await control.abort(taskId);
	await control.wait(taskId);
	return { taskId, joined: true };
}

export function pauseWatch(control: WatchControl, conversationId: ConversationId, reason = "manual"): Promise<{ taskId: string | null; joined: boolean }> {
	return stopWatch(control, conversationId, { kind: "paused", reason }, reason);
}

export function disableWatch(control: WatchControl, conversationId: ConversationId): Promise<{ taskId: string | null; joined: boolean }> {
	return stopWatch(control, conversationId, { kind: "disabled" });
}

export type WatchStatus = {
	state: "disabled" | "running" | "paused";
	reason: string | null;
	taskId: string | null;
	phase: string | null;
	cursor: string | null;
	pending: { count: 0 | 1; requestId: string; events: number; bytes: number } | null;
	lastError: string | null;
	nextPollAt: number | null;
};

/** Bounded status line: phases, counters and fixed codes. Never a mail body, a token, or an error log. */
export function watchStatus(state: MailWatchState, task?: WatchTaskRecord): WatchStatus {
	const mode = state.watch;
	const pending = state.pending;
	return {
		state: mode.kind,
		reason: mode.kind === "paused" ? mode.reason : null,
		taskId: mode.kind === "running" ? mode.taskId : null,
		phase: task?.phase ?? null,
		cursor: state.cursor,
		pending: pending ? { count: 1, requestId: pending.requestId, events: pending.eventIds.length, bytes: pending.bytes } : null,
		lastError: state.lastError,
		nextPollAt: state.nextPollAt,
	};
}
