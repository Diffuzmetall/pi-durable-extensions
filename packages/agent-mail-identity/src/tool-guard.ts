import type { IdentityState } from "./identity.ts";
import { bindingFor } from "./identity.ts";

export const AGENT_MAIL_PREFIX = "mcp__mcp_agent_mail__";
const ACTORS: Readonly<Record<string, string>> = Object.freeze({
	send_message: "sender_name", reply_message: "sender_name", respond_contact: "to_agent",
	fetch_inbox: "agent_name", fetch_inbox_events: "agent_name", mark_message_read: "agent_name",
	mark_all_read: "agent_name", acknowledge_message: "agent_name",
	file_reservation_paths: "agent_name", release_file_reservations: "agent_name",
	renew_file_reservations: "agent_name", check_file_reservation_conflicts: "agent_name",
	acquire_build_slot: "agent_name", renew_build_slot: "agent_name", release_build_slot: "agent_name",
	set_contact_policy: "agent_name", macro_file_reservation_cycle: "agent_name",
});
const PROJECT_READS = new Set(["whois", "list_contacts", "list_agents", "fetch_topic", "get_message_delivery_receipt", "summarize_thread", "search_messages"]);
const CREDENTIALS = ["sender_token", "registration_token", "registration_proof", "pane_id", "tmux_socket_path"];

export function guardMailCall(name: string, args: unknown, state: IdentityState | undefined, conversationId: number): string | undefined {
	if (!name.startsWith(AGENT_MAIL_PREFIX)) return undefined;
	const operation = name.slice(AGENT_MAIL_PREFIX.length);
	if (operation === "health_check") return undefined;
	if (!args || typeof args !== "object" || Array.isArray(args)) return "invalid_mail_arguments";
	const values = args as Record<string, unknown>;
	const actor = Object.hasOwn(ACTORS, operation) ? ACTORS[operation] : undefined;
	if (!actor && !PROJECT_READS.has(operation)) return "mail_operation_not_permitted";
	const binding = bindingFor(state, conversationId);
	if (!binding) return "identity_unbound";
	if (values.project_key !== binding.projectKey) return "project_mismatch";
	if (actor && values[actor] !== binding.agentName) return "identity_mismatch";
	if (CREDENTIALS.some(key => values[key] !== undefined && values[key] !== null)) return "model_credentials_not_permitted";
	return undefined;
}

export const MAIL_OPERATION_POLICY = Object.freeze({ actors: ACTORS, projectReads: Object.freeze([...PROJECT_READS]), health: "health_check", otherwise: "deny" });
