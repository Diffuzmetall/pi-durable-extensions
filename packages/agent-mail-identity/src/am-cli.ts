import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { MailWatchError } from "./delivery.ts";
import type { MailDeliveryEvent, MailDeliveryPage } from "./delivery.ts";
import { IdentityError, validateTarget } from "./identity.ts";
import type { IdentityTarget, MailTransport } from "./identity.ts";

export type CliOptions = { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv };

/** Highest number of delivery events one listing page may request; the CLI accepts 1 through 1000. */
export const CLI_PAGE_LIMIT_MAX = 1000;
/** Default page size for a read-only delivery listing. */
export const CLI_PAGE_LIMIT = 100;

/** Environment variable names a Mail CLI child inherits from this process. Nothing else is forwarded. */
const ENV_ALLOWLIST = Object.freeze(["PATH", "HOME"]);
/** Prefix of the Mail CLI's own configuration variables, forwarded from this process when present. */
const ENV_PREFIX = "AGENT_MAIL_";

/**
 * Narrow child environment: an explicit allowlist, the Mail CLI's own variables, then the caller's overrides.
 * `process.env` is never spread wholesale into a subprocess. Throws `cli_spawn_failed` for unreadable overrides.
 */
export function childEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	try {
		const env: NodeJS.ProcessEnv = {};
		for (const name of ENV_ALLOWLIST) {
			const value = process.env[name];
			if (typeof value === "string") env[name] = value;
		}
		for (const name of Object.keys(process.env)) {
			if (!name.startsWith(ENV_PREFIX)) continue;
			const value = process.env[name];
			if (typeof value === "string") env[name] = value;
		}
		for (const name of Object.keys(overrides ?? {})) {
			const value = overrides?.[name];
			if (typeof value === "string") env[name] = value;
			else delete env[name];
		}
		return env;
	} catch {
		throw new IdentityError("cli_spawn_failed");
	}
}

export function runJsonCli(executable: string, args: readonly string[], options: CliOptions = {}): Promise<unknown> {
	if (!isAbsolute(executable)) throw new IdentityError("invalid_executable");
	if (process.platform === "win32") throw new IdentityError("unsupported_cli_platform");
	const timeoutMs = options.timeoutMs ?? 5000;
	const maxBytes = options.maxBytes ?? 256 * 1024;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024) throw new IdentityError("invalid_cli_limits");
	if (options.signal?.aborted) return Promise.reject(new IdentityError("cli_aborted"));
	return new Promise((resolve, reject) => {
		const child = (() => {
			try { return spawn(executable, [...args], { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], env: childEnvironment(options.env) }); }
			catch { return undefined; }
		})();
		if (!child) { reject(new IdentityError("cli_spawn_failed")); return; }
		const output: Buffer[] = [];
		let bytes = 0;
		let failure: string | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		let settled = false;
		let closed = false;
		let cleanupReady = false;
		const groupExists = () => {
			if (!child.pid) return false;
			try { process.kill(-child.pid, 0); return true; }
			catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
		};
		const signalGroup = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try { process.kill(-child.pid, signal); } catch {}
		};
		const finishFailure = () => {
			if (closed && cleanupReady) finish(new IdentityError(groupExists() ? "cli_cleanup_unverified" : failure!));
		};
		const cancel = (code: string) => {
			if (settled || failure) return;
			failure = code;
			signalGroup("SIGTERM");
			killTimer = setTimeout(() => {
				signalGroup("SIGKILL");
				cleanupReady = true;
				finishFailure();
				if (!settled) drainTimer = setTimeout(() => {
					child.stdout.destroy();
					child.stderr.destroy();
					finish(new IdentityError("cli_cleanup_unverified"));
				}, 200);
			}, 100);
		};
		const abort = () => cancel("cli_aborted");
		const timer = setTimeout(() => cancel("cli_timeout"), timeoutMs);
		const finish = (error?: Error, value?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (drainTimer) clearTimeout(drainTimer);
			options.signal?.removeEventListener("abort", abort);
			if (error) reject(error); else resolve(value);
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) cancel("cli_output_limit");
			else if (!failure) output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > maxBytes) cancel("cli_output_limit");
		});
		child.on("error", () => {
			if (!child.pid) finish(new IdentityError("cli_spawn_failed"));
			else cancel("cli_process_failed");
		});
		child.on("exit", (code) => {
			if (failure || settled) return;
			if (code !== 0) cancel("cli_exit_failed");
			else if (groupExists()) cancel("cli_descendant_detected");
		});
		child.on("close", (code) => {
			closed = true;
			if (failure) return finishFailure();
			if (code !== 0) return cancel("cli_exit_failed");
			if (groupExists()) return cancel("cli_descendant_detected");
			try { finish(undefined, JSON.parse(Buffer.concat(output).toString("utf8"))); }
			catch { finish(new IdentityError("cli_invalid_json")); }
		});
	});
}

export function createCliTransport(executable: string, options: Omit<CliOptions, "signal"> & { pageLimit?: number } = {}): MailTransport {
	if (!isAbsolute(executable)) throw new IdentityError("invalid_executable");
	const pageLimit = options.pageLimit ?? CLI_PAGE_LIMIT;
	if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > CLI_PAGE_LIMIT_MAX) throw new IdentityError("invalid_cli_limits");
	const { pageLimit: _pageLimit, ...cli } = options;
	return {
		async profile(target: IdentityTarget, signal?: AbortSignal) {
			const checked = validateTarget(target);
			const raw = await runJsonCli(executable, ["agents", "show", "--project", checked.projectKey, "--json", checked.agentName], { ...cli, signal });
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IdentityError("invalid_profile");
			const root = raw as Record<string, unknown>;
			const agent = root.agent ?? root;
			if (!agent || typeof agent !== "object" || Array.isArray(agent) || (agent as Record<string, unknown>).name !== checked.agentName) throw new IdentityError("identity_mismatch");
			const profile = agent as Record<string, unknown>;
			if (profile.retired === true || profile.is_active === false || profile.status === "retired" || profile.status === "inactive") throw new IdentityError("identity_inactive");
			return { name: checked.agentName };
		},
		/**
		 * Read-only delivery listing over `am inbox-events`. The contract was read from the live CLI: `--after` is a
		 * delivery cursor (not a message ID), `--limit` accepts 1 through 1000, and `--position-now` returns the durable
		 * tail cursor with no events. Only fields of that contract are read. The project and agent are always explicit, so
		 * no environment default is ever consulted, and no read-marking subcommand is ever invoked.
		 */
		async poll(target: IdentityTarget, cursor: string | null, signal?: AbortSignal): Promise<MailDeliveryPage> {
			const checked = validateTarget(target);
			if (cursor !== null && positionOf(cursor) === null) throw new MailWatchError("invalid_watch_cursor");
			const args = ["inbox-events", "--project", checked.projectKey, "--agent", checked.agentName, "--json"];
			if (cursor === null) args.push("--position-now");
			else args.push("--after", cursor, "--limit", String(pageLimit));
			return readDeliveryPage(await runJsonCli(executable, args, { ...cli, signal }), cursor);
		},
	};
}

/** A non-negative integer delivery position, from a JSON number or a decimal string. `null` when it is neither. */
function positionOf(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function textOf(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new MailWatchError("invalid_delivery_page");
	return value;
}

function timeOf(value: unknown): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new MailWatchError("invalid_delivery_page");
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Read one successful listing page, or fail closed on malformed/non-monotone output. Retention is checked by the
 * daemon/CLI against the GLOBAL ledger; its nonzero exits remain `cli_exit_failed` and pause the watcher. A recipient's
 * `oldest_available_cursor` is its minimum event, not a retention floor: gaps can be other recipients' traffic.
 */
export function readDeliveryPage(raw: unknown, requested: string | null): MailDeliveryPage {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MailWatchError("invalid_delivery_page");
	const page = raw as Record<string, unknown>;
	if (!Array.isArray(page.events)) throw new MailWatchError("invalid_delivery_page");
	const requestedPosition = requested === null ? null : positionOf(requested);
	if (requested !== null && requestedPosition === null) throw new MailWatchError("invalid_watch_cursor");
	let previous = requestedPosition;
	const events: MailDeliveryEvent[] = [];
	for (const entry of page.events) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new MailWatchError("invalid_delivery_page");
		const record = entry as Record<string, unknown>;
		const position = positionOf(record.cursor);
		const messageId = positionOf(record.message_id);
		if (position === null || messageId === null) throw new MailWatchError("invalid_delivery_page");
		if (previous !== null && position <= previous) throw new MailWatchError("invalid_delivery_page");
		previous = position;
		events.push({
			eventId: String(position),
			messageId: String(messageId),
			cursor: String(position),
			from: textOf(record.from),
			subject: textOf(record.subject),
			// The listing contract carries no body, so a wake batch never claims one.
			body: null,
			createdAt: timeOf(record.delivered_ts),
		});
	}
	const oldest = positionOf(page.oldest_available_cursor);
	// Keep the native response shape strict, but never infer expiration from a recipient-local minimum. In particular,
	// position-now on an empty mailbox commits 0 and its first event can have ANY later global seq (upstream GH#238).
	// Only the server knows whether global history was pruned; runJsonCli rejects its error exit before reaching here.
	if (events.length > 0 && oldest === null) throw new MailWatchError("invalid_delivery_page");
	const next = positionOf(page.next_cursor);
	if (events.length > 0) return { events, cursor: String(previous) };
	if (next === null) return { events, cursor: requested };
	if (requestedPosition !== null && next < requestedPosition) throw new MailWatchError("invalid_delivery_page");
	// An empty page may still adopt a position: an explicit position-now read reports the durable tail.
	return { events, cursor: String(next) };
}
