import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, section, ToolTask, wrapTool, type ConversationId, type RegistryReader, type TaskId, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { BindingAuthority } from "./authority.ts";
import { MailIdentityDoc, MailWatchDoc, watchStateOf } from "./durable.ts";
import type { MailWatchState } from "./durable.ts";
import { MailWatchError } from "./delivery.ts";
import type { MailDeliveryPage } from "./delivery.ts";
import { bindingFor, bindIdentity, IdentityError, validateTarget } from "./identity.ts";
import type { IdentityState, IdentityStatus, MailTransport } from "./identity.ts";
import { AGENT_MAIL_PREFIX, guardMailCall } from "./tool-guard.ts";
import { guardAgentMailExtension } from "./execution-guard.ts";
import { publicError } from "./errors.ts";
import { createMailWatchTask, disableWatch, enableWatch, MAIL_WATCH_TASK_NAME, pauseWatch, registryPresence, watchStatus, WATCH_LIVE_STATUSES } from "./watcher.ts";
import type { WatchControl, WatchEnableResult, WatchResult, WatchStart, WatchStatus, WatchTaskInput, WatchTaskRecord, WatchTuning } from "./watcher.ts";

/** Host-supplied AM2 composition. Without it the identity tool keeps the AM1 surface: no watcher, wake disabled. */
export type WatchComposition = {
	/**
	 * Read-only delivery source. Omitted means the transport's own `poll`; the packaged CLI transport supplies one
	 * over the verified `am inbox-events` contract. Only a transport without any listing capability refuses.
	 */
	poll?(target: { projectKey: string; agentName: string }, cursor: string | null, signal: AbortSignal): Promise<MailDeliveryPage>;
	/** Live presence of this extension, normally `registryPresence(registry)`. */
	presence(): boolean;
	/** Public abort capability of the host for the watcher task, normally `id => harness.abortTask(id, ctx)`. */
	abort(taskId: string): Promise<"marked" | "terminal">;
	tuning?: Partial<WatchTuning>;
};

export type IdentityOptions = {
	transport: MailTransport;
	authority?: BindingAuthority;
	mailTools?: readonly ToolRegistration[];
	watch?: WatchComposition;
};

/** What a standalone Durable host must supply for the watcher: a live presence source and a public abort. */
export type StandaloneWatchHost = {
	/** Live presence, read from the same registry reader the harness itself reads. */
	registry: Pick<RegistryReader, "snapshot">;
	/** The harness's public abort operation for a watcher task, e.g. `id => harness.abortTask(id as never, context)`. */
	abort(taskId: string): Promise<"marked" | "terminal">;
	/** Read-only listing; omitted means the transport's own `poll`. */
	poll?: NonNullable<WatchComposition["poll"]>;
	tuning?: Partial<WatchTuning>;
};

/**
 * The watcher composition a standalone Durable host needs, so it does not have to invent the wiring itself: presence
 * comes from the registry reader the harness uses (so uninstalling the extension stops the watcher), and abort is the
 * harness's own public operation. No host application is involved in any way.
 */
export function standaloneWatch(host: StandaloneWatchHost): WatchComposition {
	return {
		presence: registryPresence(host.registry),
		abort: host.abort,
		...(host.poll === undefined ? {} : { poll: host.poll }),
		...(host.tuning === undefined ? {} : { tuning: host.tuning }),
	};
}

export type WakeStatus = { state: "disabled" | "running" | "paused"; reason: string };

export type IdentityStatusReport = {
	identity: IdentityStatus["identity"];
	wake: WakeStatus;
	/** Present only when the host composed a watcher. */
	watch?: WatchStatus;
	/** Present on the call that enabled or resumed the watcher. */
	enable?: WatchEnableResult;
};

type ToolApi = ToolExecutionApi;
type ToolContext = Parameters<ToolApi["commit"]>[1];

export function createAgentMailIdentity(options: IdentityOptions) {
	const authority = options.authority;
	const transport = options.transport;
	if (authority && Object.getPrototypeOf(authority) !== BindingAuthority.prototype) throw new IdentityError("invalid_binding_authority");
	const admit = authority ? BindingAuthority.prototype.admit.bind(authority) : undefined;
	const mailTools = guardAgentMailExtension({ name: "mail-input", tools: options.mailTools ?? [] }).tools ?? [];
	if (mailTools.some(tool => !tool.name.startsWith(AGENT_MAIL_PREFIX))) throw new IdentityError("invalid_mail_tool");
	const guardedNames = new Set(mailTools.map(tool => tool.name));
	const composition = options.watch;
	const listing = composition?.poll ?? transport.poll?.bind(transport);
	// One definition instance per composition: the registry resolves watcher tasks by this name. A transport with no
	// read-only listing leaves the watcher uncomposed, and `watch_*` then refuses instead of fabricating one.
	const watchTask = composition === undefined || listing === undefined ? undefined : createMailWatchTask({
		poll: (target, cursor, signal) => listing(target, cursor, signal),
		presence: () => composition.presence(),
		tuning: composition.tuning,
	});

	async function identityState(api: ToolApi, context: ToolContext): Promise<IdentityState | undefined> {
		return await api.snapshot(MailIdentityDoc, api.conversationId, context) as IdentityState | undefined;
	}

	async function boundBinding(api: ToolApi, context: ToolContext) {
		const binding = bindingFor(await identityState(api, context), api.conversationId);
		if (!binding) throw new IdentityError("identity_unbound");
		return binding;
	}

	async function readWatch(api: ToolApi, conversationId: ConversationId, context: ToolContext): Promise<MailWatchState> {
		const stored = await api.snapshot(MailWatchDoc, conversationId, context);
		return watchStateOf(stored as unknown as MailWatchState | undefined);
	}

	function controlOf(api: ToolApi, context: ToolContext): WatchControl {
		if (composition === undefined || watchTask === undefined) throw new MailWatchError("watcher_unavailable");
		return {
			state: conversationId => readWatch(api, conversationId, context),
			// Operator-owned fields only, written against the document as this transaction sees it. `cursor` and
			// `pending` are never touched here: they belong to the phases.
			update: async (conversationId, change) => await api.commit(async tx => {
				const doc = await tx.doc(MailWatchDoc, conversationId);
				const current = watchStateOf(doc as unknown as MailWatchState | undefined);
				const taskId = current.watch.kind === "running" ? current.watch.taskId : null;
				Object.assign(doc, {
					watch: change.watch,
					nextPollAt: change.nextPollAt,
					...(change.lastError === undefined ? {} : { lastError: change.lastError }),
				});
				return { taskId };
			}, context),
			ensure: async (conversationId, input, mode, cursorIntent) => await api.commit(async tx => {
				const doc = await tx.doc(MailWatchDoc, conversationId);
				const current = watchStateOf(doc as unknown as MailWatchState | undefined);
				// Only a live task is adopted. Each live status is asked for directly, so a conversation whose terminal
				// watcher records exceed one listing page still finds its live watcher instead of adding a second one.
				let live: TaskId<WatchResult> | undefined;
				for (const status of WATCH_LIVE_STATUSES) {
					const page = await tx.scanTasks({ conversationId, kind: MAIL_WATCH_TASK_NAME, background: true, status }, 1, undefined);
					const found = page.items[0];
					if (found !== undefined) { live = found.id as TaskId<WatchResult>; break; }
				}
				const taskId = live ?? await tx.createTask(watchTask, input, { ownership: { kind: "conversation" }, background: true });
				const cursor = cursorIntent === null ? current.cursor : cursorIntent.cursor;
				Object.assign(doc, {
					watch: { ...mode, taskId: String(taskId) },
					lastError: null,
					nextPollAt: null,
					...(cursorIntent === null ? {} : { cursor }),
				});
				return { taskId: String(taskId), created: live === undefined, cursor };
			}, context),
			get: async taskId => {
				const record = await api.getTask(taskId as unknown as TaskId<WatchResult>, context);
				if (!record) return undefined;
				const state = record.state;
				const phase = "checkpoint" in state && state.checkpoint !== undefined
					? String((state.checkpoint as { phase?: unknown }).phase ?? "") || null
					: null;
				const found: WatchTaskRecord = { status: state.status, conversationId: Number(record.conversationId), phase };
				return found;
			},
			abort: taskId => composition.abort(taskId),
			// `Harness.waitForTask` can resolve before the task is terminal (observed on a live abort), so a disable
			// verifies the terminal record instead of trusting one wait, and reports when it cannot verify it.
			wait: async taskId => {
				const id = taskId as unknown as TaskId<WatchResult>;
				for (let attempt = 0; attempt < 200; attempt += 1) {
					const record = await api.getTask(id, context);
					if (!record || record.state.status === "terminal") return;
					// The public wait can resolve before the task is terminal, so it is used as a wake-up and the
					// record is re-read; the bounded delay keeps this a verification, not a busy spin.
					await api.waitForTask(id, context).catch(() => undefined);
					await new Promise(resolve => setTimeout(resolve, 10));
				}
				throw new MailWatchError("watcher_join_unverified");
			},
		};
	}

	async function statusOf(api: ToolApi, context: ToolContext, composed: boolean): Promise<IdentityStatusReport> {
		const binding = bindingFor(await identityState(api, context), api.conversationId);
		const identity: IdentityStatus["identity"] = binding
			? { kind: "bound", projectKey: binding.projectKey, agentName: binding.agentName }
			: { kind: "unbound" };
		if (!composed) return { identity, wake: { state: "disabled", reason: "not_implemented" } };
		const state = await readWatch(api, api.conversationId, context);
		const record = state.watch.kind === "running"
			? await controlOf(api, context).get(state.watch.taskId)
			: undefined;
		const wake: WakeStatus = state.watch.kind === "running"
			? { state: "running", reason: "enabled" }
			: state.watch.kind === "paused" ? { state: "paused", reason: state.watch.reason } : { state: "disabled", reason: "disabled" };
		return { identity, wake, watch: watchStatus(state, record) };
	}

	const tool = defineTool({
		name: "agent_mail_identity",
		description: "Read identity and watcher status, explicitly bind an existing host-granted Agent Mail identity, or control the durable mail watcher. Identity is immutable after binding. Monitoring reads delivery events read-only and admits one bounded batch into an idle conversation; it never marks a message read or acknowledged. No registration occurs.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("status"), Type.Literal("bind"), Type.Literal("disable"),
				Type.Literal("watch_enable"), Type.Literal("watch_pause"), Type.Literal("watch_resume"), Type.Literal("watch_disable"),
			]),
			projectKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
			agentName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			watchFrom: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		}, { additionalProperties: false }),
		replay: "unsafe",
		async execute(args, api, context) {
			try {
				if (args.action === "bind") {
					if (!args.projectKey || !args.agentName) throw new IdentityError("missing_binding_target");
					const target = Object.freeze(validateTarget({ projectKey: args.projectKey, agentName: args.agentName }));
					if (!admit) throw new IdentityError("binding_not_authorized");
					await admit(api.conversationId, target, async () => {
						const before = await api.snapshot(MailIdentityDoc, api.conversationId, context);
						const binding = bindingFor(before, api.conversationId);
						if (binding && (binding.projectKey !== target.projectKey || binding.agentName !== target.agentName)) throw new IdentityError("identity_mismatch");
						if (!binding) {
							try {
								const profile = await transport.profile(target, context.abortSignal);
								if (profile.name !== target.agentName) throw new IdentityError("identity_mismatch");
							} catch (error) {
								throw publicError(error, "profile_unavailable");
							}
							await api.commit(async tx => {
								if (context.abortSignal?.aborted) throw new IdentityError("binding_aborted");
								const doc = await tx.doc(MailIdentityDoc, api.conversationId);
								Object.assign(doc, bindIdentity(doc, api.conversationId, target, randomUUID()));
							}, context);
						}
					}, context.abortSignal);
				}
				if (args.action === "disable" || args.action === "watch_disable") {
					if (composition === undefined || watchTask === undefined) throw new IdentityError("watcher_unavailable");
					await boundBinding(api, context);
					await disableWatch(controlOf(api, context), api.conversationId);
				}
				if (args.action === "watch_pause") {
					if (composition === undefined || watchTask === undefined) throw new IdentityError("watcher_unavailable");
					await boundBinding(api, context);
					if ((await readWatch(api, api.conversationId, context)).watch.kind !== "running") throw new IdentityError("watcher_not_enabled");
					await pauseWatch(controlOf(api, context), api.conversationId);
				}
				let enable: WatchEnableResult | undefined;
				if (args.action === "watch_enable" || args.action === "watch_resume") {
					if (composition === undefined || watchTask === undefined) throw new IdentityError("watcher_unavailable");
					if (!admit) throw new IdentityError("binding_not_authorized");
					const binding = await boundBinding(api, context);
					const started = await readWatch(api, api.conversationId, context);
					if (args.action === "watch_resume" && started.watch.kind !== "paused") throw new IdentityError("watcher_not_paused");
					const start: WatchStart = args.watchFrom === undefined ? { kind: "resume" } : args.watchFrom === "now" ? { kind: "now" } : { kind: "cursor", cursor: args.watchFrom };
					const target = Object.freeze(validateTarget({ projectKey: binding.projectKey, agentName: binding.agentName }));
					const input: WatchTaskInput = { ownerConversationId: api.conversationId, bindingId: binding.bindingId, projectKey: binding.projectKey, agentName: binding.agentName };
					await admit(api.conversationId, target, async () => {
						enable = await enableWatch(controlOf(api, context), input, start);
					}, context.abortSignal);
				}
				const status = await statusOf(api, context, composition !== undefined && watchTask !== undefined);
				const report: IdentityStatusReport = enable === undefined ? status : { ...status, enable };
				return { content: [{ type: "text" as const, text: JSON.stringify(report) }], details: report };
			} catch (error) { throw publicError(error, "identity_unavailable"); }
		},
	});
	return defineExtension({
		name: "agent-mail-identity", tools: [tool, ...mailTools],
		...(watchTask === undefined ? {} : { tasks: [watchTask] }),
		wraps: mailTools.map(registered => wrapTool(registered, current =>
			guardAgentMailExtension({ name: "resolved-mail", tools: [current] }).tools![0],
		)),
		hooks: [hook(ToolTask, {
			async beforeTool(call, api, context) {
				if (!call.name.startsWith(AGENT_MAIL_PREFIX)) return undefined;
				try {
					if (!guardedNames.has(call.name)) return { block: "mail_execution_guard_required" };
					const state = await api.snapshot(MailIdentityDoc, api.conversationId, context);
					const block = guardMailCall(call.name, call.arguments, state, api.conversationId);
					return block ? { block } : undefined;
				} catch (error) { return { block: publicError(error, "identity_unavailable").code }; }
			},
		})],
		sections: [section("agent-mail-identity", async (input, context) => {
			try {
				const state = await input.read.snapshot(MailIdentityDoc, input.conversationId, context);
				const binding = bindingFor(state, input.conversationId);
				if (!binding) return "Agent Mail identity is unbound. Ask the host to grant an existing identity before calling agent_mail_identity bind. Do not register or invent a new identity. Automatic wake is disabled.";
				const watch = composition === undefined || listing === undefined ? undefined : watchStatus(watchStateOf(await input.read.snapshot(MailWatchDoc, input.conversationId, context) as unknown as MailWatchState | undefined));
				const wake = watch === undefined || watch.state === "disabled"
					? "Automatic wake is disabled."
					: watch.state === "running"
						? "Automatic wake is enabled: delivery events are read read-only and one bounded batch wakes an idle turn."
						: `Automatic wake is paused (${watch.reason ?? "unknown"}).`;
				return `Agent Mail identity is ${JSON.stringify(binding.agentName)} in project ${JSON.stringify(binding.projectKey)}. Use this identity for acting fields, not recipient or lookup fields. ${wake}`;
			} catch { return "Agent Mail identity is unavailable. Mail calls are denied. Automatic wake is disabled."; }
		})],
	});
}

export { BindingAuthority } from "./authority.ts";
export { MailIdentityDoc, MailWatchDoc, initialWatchState, watchStateOf } from "./durable.ts";
export { createCliTransport, childEnvironment, runJsonCli } from "./am-cli.ts";
export { IdentityError } from "./identity.ts";
export { MailWatchError } from "./delivery.ts";
export { guardAgentMailExtension } from "./execution-guard.ts";
export { MAIL_OPERATION_POLICY } from "./tool-guard.ts";
export { createMailWatchTask, disableWatch, enableWatch, pauseWatch, registryPresence, watchStatus, MAIL_WATCH_TASK_NAME } from "./watcher.ts";
export type { IdentityState, IdentityTarget, MailTransport } from "./identity.ts";
export type { MailWatchMode, MailWatchState } from "./durable.ts";
export type { MailDeliveryEvent, PendingDelivery } from "./delivery.ts";
export type { WatchControl, WatchEnableResult, WatchResult, WatchStatus, WatchTaskInput, WatchTaskRecord, WatchTuning } from "./watcher.ts";
