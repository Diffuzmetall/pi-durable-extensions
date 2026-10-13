import type { MailDeliveryPage } from "./delivery.ts";

export type IdentityTarget = { projectKey: string; agentName: string };
export type MailBinding =
	| { kind: "unbound" }
	| { kind: "bound"; ownerConversationId: number; bindingId: string; projectKey: string; agentName: string };
export type IdentityState = {
	schemaVersion: 1;
	binding: MailBinding;
	wake: { state: "disabled"; reason: "not_implemented" };
};
export type IdentityStatus = {
	identity: { kind: "bound"; projectKey: string; agentName: string } | { kind: "unbound" };
	wake: { state: "disabled"; reason: "not_implemented" };
};
export type AgentProfile = { name: string };
export interface MailTransport {
	profile(target: IdentityTarget, signal?: AbortSignal): Promise<AgentProfile>;
	/**
	 * Bounded, read-only page of delivery events after `cursor`; `null` asks the mailbox for its current position
	 * instead of a backlog. A transport without a verified read-only listing omits it, and monitoring then refuses.
	 * Polling must never mark a message read or acknowledged.
	 */
	poll?(target: IdentityTarget, cursor: string | null, signal?: AbortSignal): Promise<MailDeliveryPage>;
}

export class IdentityError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.name = "IdentityError";
		this.code = code;
	}
}

export function validateTarget(target: IdentityTarget): IdentityTarget {
	if (typeof target.projectKey !== "string" || target.projectKey.length > 4096 ||
		!target.projectKey || target.projectKey.trim() !== target.projectKey || /[\x00-\x1f]/.test(target.projectKey) ||
		target.projectKey.startsWith("-")) {
		// A leading dash would be read as an option by any CLI the project key is passed to.
		throw new IdentityError("invalid_project_key");
	}
	if (typeof target.agentName !== "string" || target.agentName.length > 128 ||
		!/^[A-Z][a-z]+[A-Z][A-Za-z]+$/.test(target.agentName)) {
		throw new IdentityError("invalid_agent_name");
	}
	return { projectKey: target.projectKey, agentName: target.agentName };
}

export function initialIdentity(): IdentityState {
	return { schemaVersion: 1, binding: { kind: "unbound" }, wake: { state: "disabled", reason: "not_implemented" } };
}

export function bindingFor(state: IdentityState | undefined, conversationId: number): Extract<MailBinding, {kind: "bound"}> | undefined {
	if (!state) return undefined;
	if (state.schemaVersion !== 1) throw new IdentityError("schema_unsupported");
	return state.binding.kind === "bound" && state.binding.ownerConversationId === conversationId ? state.binding : undefined;
}

export function bindIdentity(state: IdentityState, conversationId: number, target: IdentityTarget, bindingId: string): IdentityState {
	if (state.schemaVersion !== 1) throw new IdentityError("schema_unsupported");
	if (state.binding.kind === "bound") {
		if (state.binding.ownerConversationId !== conversationId) throw new IdentityError("identity_owner_mismatch");
		if (state.binding.projectKey !== target.projectKey || state.binding.agentName !== target.agentName) throw new IdentityError("identity_mismatch");
		return state;
	}
	return {
		...state,
		binding: { kind: "bound", ownerConversationId: conversationId, bindingId, ...target },
	};
}
