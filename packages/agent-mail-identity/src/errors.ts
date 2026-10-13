import { MailWatchError } from "./delivery.ts";
import { IdentityError } from "./identity.ts";

const PUBLIC_CODES = new Set([
	"binding_aborted", "binding_not_authorized", "missing_binding_target", "schema_unsupported",
	"identity_owner_mismatch", "identity_mismatch", "identity_unbound", "project_mismatch",
	"invalid_project_key", "invalid_agent_name", "invalid_mail_arguments", "mail_operation_not_permitted",
	"model_credentials_not_permitted", "identity_extension_not_selected", "mail_execution_guard_required",
	"cli_aborted", "cli_timeout", "cli_spawn_failed", "cli_exit_failed", "cli_output_limit", "cli_invalid_json",
	"invalid_executable", "invalid_cli_limits", "invalid_profile", "identity_inactive", "cli_cleanup_unverified",
	"cli_process_failed", "cli_descendant_detected", "unsupported_cli_platform", "profile_unavailable",
	"watcher_unavailable", "watcher_not_enabled", "watcher_not_paused", "invalid_watch_cursor",
	"watch_auth_failed", "watch_schema_incompatible", "watch_transport_unavailable", "watcher_join_unverified",
]);

export function publicError(error: unknown, fallback: string): IdentityError {
	try {
		// Only this package's own two error classes are consulted, and only for a code on the fixed allowlist; a
		// foreign error, or one with a throwing accessor, always falls back.
		if (error instanceof IdentityError || error instanceof MailWatchError) {
			const code = error.code;
			if (PUBLIC_CODES.has(code)) return new IdentityError(code);
		}
	} catch {}
	return new IdentityError(fallback);
}
