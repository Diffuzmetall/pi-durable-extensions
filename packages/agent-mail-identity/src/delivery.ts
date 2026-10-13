import { createHash } from "node:crypto";

/**
 * Pure delivery planning for the AM2 watcher. No host, clock, or transport dependency: the batches, the admission key,
 * the backoff and the error classification are decided here and reused by the durable task and by its unit fixtures.
 */

/** Highest number of delivery events one batch may carry. */
export const MAX_BATCH_EVENTS = 50;
/** Highest rendered payload size, in UTF-8 bytes, one batch and one pending delivery may carry. */
export const MAX_BATCH_BYTES = 8 * 1024;
/** Cap applied to a single event body so one oversized letter cannot exhaust the batch budget by itself. */
export const MAX_EVENT_BODY_BYTES = 4 * 1024;
/** Cap applied to a single subject line. The listing contract bounds neither subject nor sender. */
export const MAX_EVENT_SUBJECT_BYTES = 1024;
/** Cap applied to a single sender name. */
export const MAX_EVENT_FROM_BYTES = 256;
/** Poll cadence of an enabled binding whose mailbox produced no delivery event. */
export const IDLE_POLL_MS = 15_000;
/** Capped retry schedule applied to transient transport and admission failures, before jitter. */
export const BACKOFF_MS: readonly number[] = Object.freeze([15_000, 30_000, 60_000, 120_000, 300_000]);
/** Fraction of the nominal backoff used as full jitter around the schedule value. */
export const BACKOFF_JITTER = 0.2;

/** One delivery event as a strictly read-only transport reports it, with the cursor position it establishes. */
export type MailDeliveryEvent = {
	/** Stable event identity defined by the mailbox; part of the batch boundary and of the admission key. */
	eventId: string;
	/** Message this event belongs to. Monitoring never marks it read or acknowledged. */
	messageId: string;
	/** Position immediately after this event in the delivery stream. */
	cursor: string;
	/** Sender, as reported by the read-only listing. */
	from: string | null;
	/** Subject line, as reported by the read-only listing. */
	subject: string | null;
	/** Body text, as reported by the read-only listing. */
	body: string | null;
	/** Mailbox-reported delivery time, when given. */
	createdAt: number | null;
};

/**
 * One bounded, read-only page of delivery events. `cursor` is the position the page establishes as durable: the last
 * event's cursor when events were returned, and otherwise the position the listing itself reported (an explicit
 * `--position-now` read reports the durable tail, so an empty page can still adopt a starting position).
 */
export type MailDeliveryPage = {
	events: MailDeliveryEvent[];
	cursor: string | null;
};

/** One immutable, never-mutated delivery attempt: the only unit the watcher may admit. */
export type PendingDelivery = {
	schemaVersion: 1;
	/** Binding the batch was read for; a different binding must never replay this payload. */
	bindingId: string;
	/** Conversation-scoped admission key. A repeat reuses this exact value. */
	requestId: string;
	/** Cursor the batch was read from; `null` starts at the position the enabling call selected. */
	cursorBefore: string | null;
	/** Cursor after the last event of the batch. Written only after a confirmed admission. */
	cursorAfter: string;
	eventIds: string[];
	messageIds: string[];
	/** Rendered batch content, byte-identical on every replay. */
	payload: string;
	/** UTF-8 size of `payload`. */
	bytes: number;
	createdAt: number;
};

/** A planned batch: the events taken, their rendered payload, and how many events stayed for the next poll. */
export type BatchPlan = {
	taken: MailDeliveryEvent[];
	dropped: number;
	payload: string;
	bytes: number;
	/** True when a single event body had to be shortened to fit the batch budget. */
	truncated: boolean;
};

export type BatchLimits = {
	maxEvents?: number;
	maxBytes?: number;
	maxEventBodyBytes?: number;
	maxEventSubjectBytes?: number;
	maxEventFromBytes?: number;
};

/**
 * Codes that make an enabled watcher stop polling instead of retrying: an authentication or schema failure, a cursor
 * the mailbox can no longer serve, and a listing whose output cannot be trusted.
 */
const PAUSE_CODES = new Set([
	"watch_auth_failed", "watch_schema_incompatible", "auth_failed", "incompatible_schema", "schema_unsupported",
	"watch_cursor_expired", "cli_invalid_json", "invalid_delivery_page", "cli_exit_failed",
	// A cursor the operator typed that neither the listing nor the transport accepts must stop the watch, not retry it.
	"invalid_watch_cursor",
]);

export class MailWatchError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "MailWatchError";
		this.code = code;
	}
}

/** Read a fixed string code off an unknown thrown value without trusting a getter. */
function errorCode(error: unknown): string {
	try {
		if (error instanceof MailWatchError) return error.code;
		if (error && typeof error === "object") {
			const code = (error as { code?: unknown }).code;
			if (typeof code === "string") return code;
		}
	} catch {}
	return "watch_transport_unavailable";
}

/** `pause` for authentication and incompatible-schema failures; `retry` for everything transient or unknown. */
export function classifyWatchFailure(error: unknown): "pause" | "retry" {
	return PAUSE_CODES.has(errorCode(error)) ? "pause" : "retry";
}

/** Public, bounded code for the watcher status line; never an error body. */
export function watchFailureCode(error: unknown): string {
	return errorCode(error);
}

function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0.5;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/** Nominal capped backoff for a zero-based attempt, spread by full jitter in `[1-j, 1+j]`. */
export function backoffDelay(attempt: number, jitter: () => number = Math.random, schedule: readonly number[] = BACKOFF_MS): number {
	if (schedule.length === 0) throw new MailWatchError("invalid_batch_limits");
	const index = Math.max(0, Math.min(Math.trunc(attempt), schedule.length - 1));
	const nominal = schedule[index];
	const spread = 0.8 + 2 * BACKOFF_JITTER * clampUnit(jitter());
	return Math.round(nominal * spread);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Cut text to at most `maxBytes` UTF-8 bytes without emitting a partial code point. */
function truncateUtf8(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

/** Shorten one field to its cap, reporting whether anything was cut. */
function clip(value: string | null, maxBytes: number): { text: string; truncated: boolean } {
	if (value === null || value === undefined) return { text: "", truncated: false };
	const text = truncateUtf8(value, maxBytes);
	return { text, truncated: byteLength(text) < byteLength(value) };
}

/**
 * Render one event. Every unbounded field is clipped, so a single letter with an oversized sender, subject, or body
 * can never exceed the batch budget by itself; a clipped field is marked `[truncated]` in the payload.
 */
function renderEvent(event: MailDeliveryEvent, limits: { bodyBytes: number; subjectBytes: number; fromBytes: number }): { block: string; truncated: boolean } {
	const from = clip(event.from, limits.fromBytes);
	const subject = clip(event.subject, limits.subjectBytes);
	const body = clip(event.body, limits.bodyBytes);
	const truncated = from.truncated || subject.truncated || body.truncated;
	return {
		block: [
			`event ${event.eventId} message ${event.messageId}`,
			`from ${from.text.length === 0 ? "unknown" : from.text}${from.truncated ? " [truncated]" : ""}`,
			`subject ${subject.text.length === 0 ? "(none)" : subject.text}${subject.truncated ? " [truncated]" : ""}`,
			`body ${event.body === null ? "(no body)" : body.text.length === 0 ? "(empty)" : body.text}${body.truncated ? " [truncated]" : ""}`,
		].join("\n"),
		truncated,
	};
}

/**
 * Longest prefix of a read-only page that fits one batch, rendered. The budget counts the header, every block, and the
 * newline that separates them, so the returned payload is guaranteed to fit `maxBytes`; an event is never silently
 * skipped, and one that cannot fit is shortened and marked instead of dropped when it is the first of the batch.
 */
export function planBatch(target: { projectKey: string; agentName: string }, events: readonly MailDeliveryEvent[], limits: BatchLimits = {}): BatchPlan {
	const maxEvents = Math.min(limits.maxEvents ?? MAX_BATCH_EVENTS, MAX_BATCH_EVENTS);
	const maxBytes = Math.min(limits.maxBytes ?? MAX_BATCH_BYTES, MAX_BATCH_BYTES);
	const fieldLimits = {
		bodyBytes: limits.maxEventBodyBytes ?? MAX_EVENT_BODY_BYTES,
		subjectBytes: limits.maxEventSubjectBytes ?? MAX_EVENT_SUBJECT_BYTES,
		fromBytes: limits.maxEventFromBytes ?? MAX_EVENT_FROM_BYTES,
	};
	if (maxEvents < 1 || maxBytes < 1) throw new MailWatchError("invalid_batch_limits");
	const header = `Agent Mail delivery for ${target.agentName} in project ${target.projectKey}`;
	const taken: MailDeliveryEvent[] = [];
	const blocks: string[] = [];
	let bytes = byteLength(header);
	let truncated = false;
	for (const event of events) {
		if (taken.length >= maxEvents) break;
		const rendered = renderEvent(event, fieldLimits);
		let block = rendered.block;
		// One separator per block, counted here: the payload is `header + "\n" + blocks.join("\n")`.
		let cost = 1 + byteLength(block);
		if (bytes + cost > maxBytes) {
			if (taken.length > 0) break;
			// The first event of a page must still be delivered: shorten the block, keep the marker, and stay in budget.
			const budget = maxBytes - bytes - 1;
			const marker = " [truncated]";
			const room = budget - byteLength(marker);
			if (room <= 0) break;
			block = `${truncateUtf8(block, room)}${marker}`;
			cost = 1 + byteLength(block);
			if (bytes + cost > maxBytes) break;
			truncated = true;
		}
		taken.push(event);
		blocks.push(block);
		bytes += cost;
		if (rendered.truncated) truncated = true;
	}
	// Belt and braces: whatever the per-field caps did, the rendered payload never exceeds the byte budget.
	while (taken.length > 1 && byteLength(blocks.join("\n")) + 1 + byteLength(header) > maxBytes) {
		taken.pop();
		blocks.pop();
		truncated = true;
	}
	const payload = blocks.length === 0 ? header : `${header}\n${blocks.join("\n")}`;
	if (byteLength(payload) > maxBytes) throw new MailWatchError("invalid_batch_limits");
	return { taken, dropped: Math.max(0, events.length - taken.length), payload, bytes: byteLength(payload), truncated };
}

/** Stable, bounded admission key: conversation, binding and the batch boundary the batch was read at. */
export function deriveRequestId(conversationId: number, bindingId: string, cursorBefore: string | null, eventIds: readonly string[]): string {
	const digest = createHash("sha256")
		.update(`${conversationId}|${bindingId}|${cursorBefore ?? ""}|${eventIds.join(",")}`, "utf8")
		.digest("hex");
	return `am2:${digest}`;
}

/** Build the immutable pending record for one planned batch. */
export function createPendingDelivery(input: {
	bindingId: string;
	conversationId: number;
	cursorBefore: string | null;
	plan: BatchPlan;
	createdAt: number;
}): PendingDelivery {
	const { plan } = input;
	// Pure assertions: a planned batch is always non-empty and always inside the byte budget of `planBatch`.
	if (plan.taken.length === 0) throw new MailWatchError("empty_batch");
	if (plan.bytes > MAX_BATCH_BYTES || byteLength(plan.payload) !== plan.bytes) throw new MailWatchError("batch_too_large");
	const eventIds = plan.taken.map(event => event.eventId);
	const pending: PendingDelivery = {
		schemaVersion: 1,
		bindingId: input.bindingId,
		requestId: deriveRequestId(input.conversationId, input.bindingId, input.cursorBefore, eventIds),
		cursorBefore: input.cursorBefore,
		cursorAfter: plan.taken[plan.taken.length - 1].cursor,
		eventIds,
		messageIds: plan.taken.map(event => event.messageId),
		payload: plan.payload,
		bytes: plan.bytes,
		createdAt: input.createdAt,
	};
	return Object.freeze(pending);
}
