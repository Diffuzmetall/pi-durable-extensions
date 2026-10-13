import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ConversationId, Extension, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { BindingAuthority, createAgentMailIdentity } from "../src/index.ts";
import type { IdentityOptions, MailTransport } from "../src/index.ts";
import type { MailDeliveryPage } from "../src/delivery.ts";
import type { WatchTuning } from "../src/watcher.ts";

/**
 * AM3: the Pocket entry point of this package, and the wake admission that guards it.
 *
 * This module is a *host adapter*, not a second implementation. It imports no Pocket source, no Pocket application and
 * no Pocket database module, and it does not read Pocket's internal user or driver tables: everything it knows about
 * the host arrives through the structural surface below, which the current `PocketHost` satisfies without any change to
 * Pocket.
 *
 * The current `PocketHost` publishes no submit-as-bound-person operation with live person, steer-role, visibility and
 * driver validation (A6) and no live `RegistryReader` (A1). A mandatory capability that is missing is never replaced
 * by a permissive fallback: the entry point refuses to enable wake with `missing_host_capability`, starts no watcher,
 * binds no conversation and writes nothing. A positive wake is reachable only through an already-public embedding
 * contract (`WakeAdmissionContract`) that the host itself proves — see CONTRACT.md and INSTALLATION.md.
 *
 * The domain part (`WakeFacts`, `revalidateWake`) knows nothing about Pocket users or spend documents: it is a pure
 * function over plain facts, and the host adapter decides the rights and limits it reports.
 */

/* ----------------------------------------------------------------------------------------------------------------
 * Domain: admission results, reasons, and the pure revalidation every admission runs.
 * -------------------------------------------------------------------------------------------------------------- */

/** Schema version of the watch state this build admits. A document of another schema denies poll and submit. */
export const WAKE_SCHEMA_VERSION = 1;

/** Capabilities the wake path needs from the host. A missing one is a refusal, never a degraded mode. */
export type PocketCapability = "submit_as_bound_person" | "live_registry_reader" | "admission_lookup";

export type PocketCapabilities = {
	complete: boolean;
	present: readonly PocketCapability[];
	missing: readonly PocketCapability[];
};

/** Fixed public reasons. `registration_failed` belongs to the vocabulary but no path produces it: this package never registers. */
export type PocketWakeReason =
	| "missing_host_capability"
	| "held_back"
	| "budget_denied"
	| "identity_mismatch"
	| "registration_failed"
	| "extension_removed"
	| "schema_unsupported"
	| "requester_unbound"
	| "admission_unproven"
	| "host_read_failed";

/** Result of one wake admission: `allowed` may proceed, `busy` retries, `paused` waits, `denied` does not. */
export type HostAdmission =
	| { result: "allowed"; requestId: string | null }
	| { result: "busy"; requestId: string; retryAfterMs: number }
	| { result: "paused"; reason: PocketWakeReason; missing?: readonly PocketCapability[] }
	| { result: "denied"; reason: PocketWakeReason; missing?: readonly PocketCapability[] };

/** Public lookup of the host input binding written for one request id. */
export type BindingLookup = { state: "bound"; owner: string } | { state: "absent" } | { state: "unknown" };

/** Plain facts of one admission. No Pocket user object, no spend document: opaque ids and strings only. */
export type WakeFacts = {
	capabilities: PocketCapabilities;
	/** Schema version of the stored watch state this admission would write to. */
	schemaVersion: number;
	/** Live presence of this extension in the host's registry, read at admission time. */
	extensionPresent: boolean;
	/** Who Pi works for in this conversation right now, or `null` when nobody does. */
	requester: string | null;
	/** Person existence, steer role, visibility and current driver, each read at admission time. */
	personExists: boolean;
	requesterMaySteer: boolean;
	requesterSeesConversation: boolean;
	currentDriver: string | null;
	/** Spend limits: `heldBack` (work with nobody asking) and the admitted limit check. */
	heldBack: string | null;
	limitReached: string | null;
	/** Host input binding for this request id, when the host composes a hindsight admission. */
	binding: BindingLookup;
	hindsightAdmission: boolean;
	/** Admission key of the pending delivery this admission is for; `null` for a plain enable. */
	requestId: string | null;
};

/**
 * Revalidate every right and limit *at admission time*, never earlier: requester presence, the person's existence,
 * steer role, visibility, the current driver, `heldBack`, the spend limit, and — when the host writes a hindsight input
 * binding — the binding's owner and proof. `requesterOf` alone proves none of these.
 */
export function revalidateWake(facts: WakeFacts): HostAdmission {
	if (!facts.capabilities.complete) return { result: "denied", reason: "missing_host_capability", missing: facts.capabilities.missing };
	if (facts.schemaVersion !== WAKE_SCHEMA_VERSION) return { result: "denied", reason: "schema_unsupported" };
	if (!facts.extensionPresent) return { result: "paused", reason: "extension_removed" };
	if (facts.requester === null) return { result: "denied", reason: "requester_unbound" };
	// A person who no longer exists, no longer steers here, can no longer see the conversation, or no longer drives it
	// is a revoked right, not a transient condition.
	if (!facts.personExists || !facts.requesterMaySteer || !facts.requesterSeesConversation || facts.currentDriver !== facts.requester) {
		return { result: "denied", reason: "identity_mismatch" };
	}
	if (facts.binding.state === "bound" && facts.binding.owner !== facts.requester) return { result: "denied", reason: "identity_mismatch" };
	if (facts.heldBack !== null) return { result: "paused", reason: "held_back" };
	if (facts.limitReached !== null) return { result: "denied", reason: "budget_denied" };
	// An input binding this contract cannot prove is not admitted: the delivery stays pending instead of being
	// submitted under an unproven owner or an unproven budget booking. A plain enable carries no request id and is not
	// subject to the binding check.
	if (facts.hindsightAdmission && facts.requestId !== null && facts.binding.state === "unknown") return { result: "paused", reason: "admission_unproven" };
	return { result: "allowed", requestId: facts.requestId };
}

/** The wake path's capability list, given the host surface and the injected embedding contract. */
export function pocketCapabilities(host: PocketHostSurface, authority?: WakeAdmissionContract): PocketCapabilities {
	const present: PocketCapability[] = [];
	if (authority !== undefined && typeof authority.submitAsBoundPerson === "function") present.push("submit_as_bound_person");
	if (authority !== undefined && typeof authority.extensionPresent === "function") present.push("live_registry_reader");
	if (authority !== undefined && typeof authority.admissionOf === "function") present.push("admission_lookup");
	const required: PocketCapability[] = host.hindsight === undefined
		? ["submit_as_bound_person", "live_registry_reader"]
		: ["submit_as_bound_person", "live_registry_reader", "admission_lookup"];
	const missing = required.filter(capability => !present.includes(capability));
	return { complete: missing.length === 0, present, missing };
}

/* ----------------------------------------------------------------------------------------------------------------
 * Host adapter: the structural view of the host, and the injected public embedding contract.
 * -------------------------------------------------------------------------------------------------------------- */

type ToolApi = ToolExecutionApi;
/** The invocation context type, named through the public API it is passed to (no chord import). */
export type PocketContext = Parameters<ToolApi["commit"]>[1];

/** Who the host must publish for a safe wake. Every member is an existing public operation, never a new method. */
export type WakeAdmissionContract = {
	/** Live presence of the installed extension, from a real registry reader. */
	extensionPresent(): boolean;
	/** The person Pi works for exists right now. */
	personExists(personId: string): boolean;
	/** That person may still steer here (not a viewer). */
	maySteer(personId: string, conversationId: ConversationId): boolean;
	/** That person may still see this conversation. */
	canSee(personId: string, conversationId: ConversationId): boolean;
	/** Who drives the conversation right now. */
	currentDriver(conversationId: ConversationId): string | undefined;
	/** The spend limit that blocks work with nobody asking, if one does. */
	limitReached(conversationId: ConversationId): string | undefined;
	/** Public lookup of the host input binding written for a request id. */
	admissionOf(conversationId: ConversationId, requestId: string): BindingLookup;
	/** Schema version of the stored watch state, when the host can report it. A foreign one denies poll and submit. */
	watchSchemaVersion?(conversationId: ConversationId): number | undefined;
	/** Submit an input as the bound person. The host performs this inside its own submit path. */
	submitAsBoundPerson(conversationId: ConversationId, input: { content: string; requestId: string; personId: string }): Promise<"admitted" | "busy">;
	/** Optional: the read-only listing, abort and tuning needed to run the AM2 watcher on this host. */
	watch?: {
		poll?(target: { projectKey: string; agentName: string }, cursor: string | null, signal: AbortSignal): Promise<MailDeliveryPage>;
		abort(taskId: string): Promise<"marked" | "terminal">;
		tuning?: Partial<WatchTuning>;
	};
};

/**
 * The part of `PocketHost` this entry point reads, structurally. Constructing the adapter performs no call; every read
 * happens at admission time. `hindsight` matches the host's own `HindsightAdmission` shape.
 */
export type PocketHostSurface = {
	requesterOf(conversationId: ConversationId): string | undefined;
	heldBack(conversationId: ConversationId): string | undefined;
	onLimitsChanged?(listener: () => void): () => void;
	hindsight?: { admitInput(conversationId: ConversationId, requestId: string, context: PocketContext): Promise<void> };
	notice?(level: "info" | "warning" | "error", message: string): void;
};

/** Read one host fact, failing closed: a host read that throws denies the admission instead of crashing the caller. */
function read<T>(fact: () => T, fallback: T): T {
	try {
		const value = fact();
		return value === undefined ? fallback : value;
	} catch {
		return fallback;
	}
}

export type WakeRequest = { conversationId: ConversationId; requestId?: string };

export type WakeDelivery = WakeRequest & { requestId: string; payload: string };

/** The admission surface. Nothing here writes a document or starts a task; it decides, and refuses. */
export type PocketWakeAdmission = {
	capabilities(): PocketCapabilities;
	/** Admit or refuse enabling wake for a conversation. A refusal writes nothing and starts nothing. */
	enable(request: WakeRequest): Promise<HostAdmission>;
	/** Admit one pending delivery: revalidate, bind the input, revalidate again, then submit. */
	submit(delivery: WakeDelivery, context: PocketContext): Promise<HostAdmission>;
};

export type PocketWakeOptions = { authority?: WakeAdmissionContract; retryAfterMs?: number };

export function createPocketWakeAdmission(host: PocketHostSurface, options: PocketWakeOptions = {}): PocketWakeAdmission {
	const authority = options.authority;
	const retryAfterMs = options.retryAfterMs ?? 15_000;
	const factsFor = (request: WakeRequest): WakeFacts => {
		const capabilities = pocketCapabilities(host, authority);
		const requestId = request.requestId ?? null;
		const requester = read(() => host.requesterOf(request.conversationId) ?? null, null);
		const person = requester;
		return {
			capabilities,
			schemaVersion: authority?.watchSchemaVersion === undefined
				? WAKE_SCHEMA_VERSION
				: read(() => authority.watchSchemaVersion!(request.conversationId) ?? WAKE_SCHEMA_VERSION, WAKE_SCHEMA_VERSION),
			extensionPresent: authority === undefined ? false : read(() => authority.extensionPresent(), false),
			requester,
			personExists: person === null || authority === undefined ? false : read(() => authority.personExists(person), false),
			requesterMaySteer: person === null || authority === undefined ? false : read(() => authority.maySteer(person, request.conversationId), false),
			requesterSeesConversation: person === null || authority === undefined ? false : read(() => authority.canSee(person, request.conversationId), false),
			currentDriver: authority === undefined ? null : read(() => authority.currentDriver(request.conversationId) ?? null, null),
			heldBack: read(() => host.heldBack(request.conversationId) ?? null, null),
			limitReached: authority === undefined ? null : read(() => authority.limitReached(request.conversationId) ?? null, null),
			binding: authority === undefined || requestId === null ? { state: "unknown" } : read(() => authority.admissionOf(request.conversationId, requestId), { state: "unknown" } as BindingLookup),
			hindsightAdmission: host.hindsight !== undefined,
			requestId,
		};
	};
	return {
		capabilities: () => pocketCapabilities(host, authority),
		async enable(request) {
			// The capability check comes first: a host that cannot prove the admission is not read at all, and nothing is
			// written, started or submitted after a refusal.
			const capabilities = pocketCapabilities(host, authority);
			if (!capabilities.complete) return { result: "denied", reason: "missing_host_capability", missing: capabilities.missing };
			try {
				return revalidateWake(factsFor(request));
			} catch {
				return { result: "paused", reason: "host_read_failed" };
			}
		},
		async submit(delivery, context) {
			const capabilities = pocketCapabilities(host, authority);
			if (!capabilities.complete) return { result: "denied", reason: "missing_host_capability", missing: capabilities.missing };
			let facts: WakeFacts;
			try {
				facts = factsFor(delivery);
			} catch {
				return { result: "paused", reason: "host_read_failed" };
			}
			const decision = revalidateWake(facts);
			if (decision.result !== "allowed") return decision;
			// The host input binding is its own side effect: it is repeated with the same request id as the pending
			// delivery and the submit, and only when the public lookup proves it is not already recorded, so a crash
			// between the binding and the submit neither books the budget twice nor changes the input's owner.
			if (host.hindsight !== undefined && facts.binding.state === "absent") {
				try {
					await host.hindsight.admitInput(delivery.conversationId, delivery.requestId, context);
				} catch {
					return { result: "paused", reason: "admission_unproven" };
				}
			}
			const confirmFacts = factsFor(delivery);
			const confirm = revalidateWake(confirmFacts);
			if (confirm.result !== "allowed") return confirm;
			// The confirming read is what the submit is based on: the identity it validated is the identity the input is
			// submitted for, and an identity that changed between the two reads cancels the admission (the same rule the plan
			// sets for a change of driver, role, visibility, heldBack or limit) instead of submitting as the earlier person.
			if (confirmFacts.requester !== facts.requester) return { result: "denied", reason: "identity_mismatch" };
			const outcome = await authority!.submitAsBoundPerson(delivery.conversationId, {
				content: delivery.payload,
				requestId: delivery.requestId,
				personId: confirmFacts.requester!,
			});
			return outcome === "busy"
				? { result: "busy", requestId: delivery.requestId, retryAfterMs }
				: { result: "allowed", requestId: delivery.requestId };
		},
	};
}

/* ----------------------------------------------------------------------------------------------------------------
 * Entry point: the extensions this package contributes to a Pocket host.
 * -------------------------------------------------------------------------------------------------------------- */

export type PocketEntryOptions = {
	transport: MailTransport;
	mailTools?: readonly ToolRegistration[];
	/** The AM1/AM2 host grant authority: binding and enabling stay host-granted even on Pocket. */
	authority?: BindingAuthority;
	/** The public embedding contract. Without it the wake gate refuses with `missing_host_capability`. */
	wakeAuthority?: WakeAdmissionContract;
	retryAfterMs?: number;
};

export type PocketAgentMail = {
	capabilities: PocketCapabilities;
	wake: PocketWakeAdmission;
	/** The identity extension (AM1/AM2) plus the wake gate. Installing this binds nothing and wakes nothing. */
	extensions: readonly Extension[];
};

type WakeAdmissionReport = { result: "allowed" | "busy" | "paused" | "denied"; requestId?: string | null; reason?: string; retryAfterMs?: number; missing?: string[] };

type WakeReport = {
	action: string;
	admission: WakeAdmissionReport | null;
	capabilities: { complete: boolean; present: string[]; missing: string[] };
	/** Whether a proven contract let this entry point compose the AM2 watcher. */
	watcherComposed: boolean;
};

/** A JSON-safe view of one admission: fixed codes and plain lists, never an error body. */
function reportOf(admission: HostAdmission | null): WakeAdmissionReport | null {
	if (admission === null) return null;
	if (admission.result === "allowed") return { result: "allowed", requestId: admission.requestId };
	if (admission.result === "busy") return { result: "busy", requestId: admission.requestId, retryAfterMs: admission.retryAfterMs };
	return { result: admission.result, reason: admission.reason, missing: [...(admission.missing ?? [])] };
}

export function createPocketAgentMail(host: PocketHostSurface, options: PocketEntryOptions): PocketAgentMail {
	const capabilities = pocketCapabilities(host, options.wakeAuthority);
	const wake = createPocketWakeAdmission(host, { authority: options.wakeAuthority, retryAfterMs: options.retryAfterMs });
	const watch = options.wakeAuthority?.watch;
	const identity = createAgentMailIdentity({
		authority: options.authority,
		transport: options.transport,
		mailTools: options.mailTools,
		// The AM2 watcher is composed only from a proven public contract: without a live presence source and a public
		// abort operation there is no safe watcher to create, so `watch_*` refuses instead of fabricating one.
		...(watch === undefined ? {} : {
			watch: {
				presence: () => options.wakeAuthority!.extensionPresent(),
				abort: taskId => watch.abort(taskId),
				...(watch.poll === undefined ? {} : { poll: watch.poll }),
				...(watch.tuning === undefined ? {} : { tuning: watch.tuning }),
			} satisfies NonNullable<IdentityOptions["watch"]>,
		}),
	});
	const tool = defineTool({
		name: "agent_mail_wake",
		description: "Report and request automatic Agent Mail wake for this conversation. Enable revalidates the person's existence, steer role, visibility, the current driver, the spend limit and any held-back work at admission time; a missing host capability refuses with missing_host_capability and starts nothing. This tool never registers an identity, never binds a conversation, and never marks mail read.",
		parameters: Type.Object({ action: Type.Union([Type.Literal("status"), Type.Literal("enable")]) }, { additionalProperties: false }),
		replay: "unsafe",
		async execute(args, api): Promise<{ content: { type: "text"; text: string }[]; details: WakeReport; isError?: boolean }> {
			const admission = args.action === "enable" ? await wake.enable({ conversationId: api.conversationId }) : null;
			const report: WakeReport = {
				action: args.action,
				admission: reportOf(admission),
				capabilities: { complete: capabilities.complete, present: [...capabilities.present], missing: [...capabilities.missing] },
				watcherComposed: watch !== undefined,
			};
			return { content: [{ type: "text", text: JSON.stringify(report) }], details: report, ...(admission === null || admission.result === "allowed" ? {} : { isError: true }) };
		},
	});
	return { capabilities, wake, extensions: [identity, defineExtension({ name: "agent-mail-wake", tools: [tool] })] };
}

/**
 * The drop-in Pocket entry point: a host builds it and returns the extensions. Registering it binds no conversation and
 * enables no wake; `agent_mail_wake enable` is a separate, admitted action.
 */
export default function pocketEntryPoint(host: PocketHostSurface, options: PocketEntryOptions): readonly Extension[] {
	return createPocketAgentMail(host, options).extensions;
}
