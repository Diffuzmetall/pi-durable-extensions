import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MailWatchError } from "./delivery.ts";
import type { PendingDelivery } from "./delivery.ts";
import type { IdentityState } from "./identity.ts";
import { initialIdentity } from "./identity.ts";

/** AM1: the immutable identity binding of one conversation. */
export const MailIdentityDoc = defineDoc<IdentityState>({
	kind: "agent-mail-identity.binding", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: initialIdentity,
});

export const MAIL_WATCH_SCHEMA_VERSION = 1;

/** Why the watcher is not polling, when it is not. */
export type MailWatchMode =
	| { kind: "disabled" }
	| { kind: "running"; taskId: string; bindingId: string; ownerConversationId: ConversationId }
	| { kind: "paused"; reason: string };

/** AM2: delivery state of one conversation, separate from the immutable identity above. */
export type MailWatchState = {
	schemaVersion: 1;
	watch: MailWatchMode;
	/** Durable cursor of the last batch admitted on this binding; `null` before the first admitted batch. */
	cursor: string | null;
	/** At most one delivery is in flight; advanced and cleared in one transaction after a confirmed admission. */
	pending: PendingDelivery | null;
	lastError: string | null;
	lastPollAt: number | null;
	nextPollAt: number | null;
};

export function initialWatchState(): MailWatchState {
	return { schemaVersion: MAIL_WATCH_SCHEMA_VERSION, watch: { kind: "disabled" }, cursor: null, pending: null, lastError: null, lastPollAt: null, nextPollAt: null };
}

/** Normalize a stored value; a foreign schema is reported instead of guessed. */
export function watchStateOf(stored: MailWatchState | undefined): MailWatchState {
	if (!stored) return initialWatchState();
	if (stored.schemaVersion !== MAIL_WATCH_SCHEMA_VERSION) throw new MailWatchError("watch_schema_incompatible");
	return stored;
}

/** A fork starts with a disabled watcher and no cursor, whatever the source conversation was watching. */
export const MailWatchDoc = defineDoc<MailWatchState>({
	kind: "agent-mail-identity.watch", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: initialWatchState,
});
