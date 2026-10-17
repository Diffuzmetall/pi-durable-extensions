import type { Context } from "@earendil-works/chord";
import { defineTask, LiveDoc, type ConversationHandle, type Submission, type Task, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { SubagentsDoc, type PendingSubagentReport } from "./documents.ts";

const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;
const GATHER_MS = 50;

type CourierState = { phase: "gather" | "next" | "send" | "hold" };
export type CourierTask = Task<null, CourierState, null, object>;
type Admission = (conversation: ConversationHandle, requestId: string, context: Context) => Promise<void>;

/** Optional host attribution only; this conveys no execution authority or delegation policy. */
export type SubagentOrigin = {
  record(tx: Tx, taskId: TaskId, sources: readonly TaskId[]): void | Promise<void>;
  submit(conversation: ConversationHandle, sources: readonly TaskId[], send: () => Promise<Submission>, context: Context, requestId?: string): Promise<Submission>;
};

/** Report IDs are the native Reporter task IDs. Unknown legacy IDs remain unclassified. */
export function reportSources(reports: readonly PendingSubagentReport[]): TaskId[] {
  const ids = reports.map(report => Number(report.id));
  return ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids as TaskId[] : [];
}

export function courierFor(admit?: Admission, origin?: SubagentOrigin): CourierTask {
	return defineTask<null, CourierState, null>({
		name: "bb.subagent-courier", version: 1,
		initial: () => ({ phase: "gather" }),
		phases: {
			gather: async (_task, runtime, context) => {
				await runtime.sleep(runtime.now() + GATHER_MS, context);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
			next: async (task, runtime, context) => runtime.commit(async (tx) => {
				const state = await tx.doc(SubagentsDoc, runtime.conversationId);
				if (state.deliveryHold !== undefined) return { status: "running", checkpoint: { phase: "hold" } };
				if (state.sending === undefined) {
					const reports = state.outbox ?? [];
					if (reports.length === 0) {
						if (state.courier === task.id) delete state.courier;
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}
					const batch = (state.batchNumber ?? 0) + 1;
					state.batchNumber = batch;
					state.outbox = [];
					state.sending = { requestId: `subagent-batch:${task.id}:${batch}`, reports };
				}
				await origin?.record(tx, task.id, reportSources([...(state.sending?.reports ?? []), ...(state.outbox ?? [])]));
				return { status: "running", checkpoint: { phase: "send" } };
			}, context),
			send: async (task, runtime, context) => {
				const state = await runtime.snapshot(SubagentsDoc, runtime.conversationId, context);
				const sending = state?.sending;
				if (sending === undefined) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				const parent = (await runtime.conversation(runtime.conversationId, context))!;
				try {
					await admit?.(parent, sending.requestId, context);
				} catch (error) {
					if (runtime.signal.aborted || context.abortSignal?.aborted) throw error;
					const reason = error instanceof Error ? error.message : String(error);
					await runtime.commit(async (tx) => {
						const current = await tx.doc(SubagentsDoc, runtime.conversationId);
						if (current.sending?.requestId === sending.requestId) {
							current.deliveryHold = { kind: "admission", requestId: sending.requestId, reason };
						}
						return { status: "running", checkpoint: { phase: "hold" } };
					}, context);
					return;
				}
				const send = () => parent.submit({
					type: "input",
					content: sending.reports.map((report) => report.text).join("\n\n"),
					whenBusy: "followUp",
					requestId: sending.requestId,
				}, context);
				const submission = origin ? await origin.submit(parent, reportSources(sending.reports), send, context, sending.requestId) : await send();
				// A failed foreground run can leave this follow-up queued in an idle inbox.
				// Observe both the initial value and native changes; withdrawing an input
				// that was never placed makes only its report delivery safe to retry.
				const watch = await runtime.watchDoc(LiveDoc, parent.id, context);
				let withdrawing: Promise<unknown> = Promise.resolve();
				let settled;
				const strand = async (live: { run?: unknown } | null) => {
					if (live !== null && live.run === undefined) {
						withdrawing = (async () => {
							if ((await submission.status(context)).status === 'queued') await submission.abort(context);
						})();
						await withdrawing;
					}
				};
				try {
					if (watch) { await strand(watch.value); watch.start(strand); }
					settled = await submission.wait(context);
				} finally {
					await watch?.stop();
					await withdrawing.catch(() => {});
				}
				await runtime.commit(async (tx) => {
					const current = await tx.doc(SubagentsDoc, runtime.conversationId);
					if (current.sending?.requestId !== sending.requestId) {
						return { status: "running", checkpoint: { phase: "next" } };
					}
					let phase: 'next' | 'hold';
					// Delivery acknowledges durable placement, not a successful model response.
					// A placed input remains in history even when its parent run fails.
					if (settled.status === "done" || (settled.type === 'input' && settled.entry !== undefined)) {
						delete current.sending; phase = 'next';
					} else if (settled.type === 'input' && settled.entry === undefined) {
						// Persist the next identity before admission. Reopen reuses it; placed
						// inputs and uncertain external effects never enter this branch.
						const batch = (current.batchNumber ?? 0) + 1;
						current.batchNumber = batch;
						current.sending = { requestId: `subagent-batch:${task.id}:${batch}`, reports: current.sending.reports };
						// Change phase so native progress is observable; an unchanged send
						// checkpoint is not a retry. next reuses the saved sending identity.
						phase = 'next';
					} else {
						current.deliveryHold = { kind: "uncertain", requestId: sending.requestId, reason: `Delivery outcome uncertain: ${settled.status}` };
						phase = 'hold';
					}
					if (current.courier !== undefined) await origin?.record(tx, current.courier,
						reportSources([...(current.sending?.reports ?? []), ...(current.outbox ?? [])]));
					return { status: "running", checkpoint: { phase } };
				}, context);
			},
			hold: async (_task, runtime, context) => {
				// Reconcile historical holds from the SDK receipt, never by replaying
				// the report or assuming that the model read it. Missing receipts stay held.
				let reconciled = false;
				await runtime.commit(async tx => {
					const state = await tx.doc(SubagentsDoc, runtime.conversationId);
					const held = state.deliveryHold;
					if (held?.kind === 'uncertain' && state.sending?.requestId === held.requestId) {
						const receipt = await tx.submissionByRequest(runtime.conversationId, held.requestId);
						if (receipt?.type === 'input' && receipt.entry !== undefined) {
							delete state.sending;
							delete state.deliveryHold;
							reconciled = true;
						}
					}
					return { status: 'running', checkpoint: { phase: reconciled ? 'next' : 'hold' } };
				}, context);
				if (reconciled) return;
				const watch = await runtime.watchDoc(SubagentsDoc, runtime.conversationId, context);
				if (watch === undefined || watch.value?.deliveryHold === undefined) {
					await watch?.stop();
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				try {
					await new Promise<void>((resolve, reject) => {
						watch.start((value) => {
							if (value?.deliveryHold === undefined) resolve();
							return Promise.resolve();
						});
					void watch.closed.then(() => reject(new Error("Courier hold watch ended")));
				});
				} finally {
					await watch.stop();
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
		},
		abort: async (_task, runtime, context) => runtime.commit(() => ({
			status: "terminal", outcome: { status: "aborted" },
		}), context),
	});
}

