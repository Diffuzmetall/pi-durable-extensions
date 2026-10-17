// Anchor/Reporter ownership ported from pi-pocket src/server/extensions/subagents.ts.
// Origin license: MIT, Copyright (c) 2026 Tanner Middleton; see LICENSE.pocket.
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantEntry, LiveDoc, defineTask, type ConversationHandle, type ConversationId,
	type EntryId, type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { SubagentsDoc } from "./documents.ts";
import { RequestsDoc } from "./requests.ts";
import { type CourierTask, type SubagentOrigin } from "./delivery.ts";
import { TeamDoc, cancelRequests } from './supervisor.ts';
import { answerNotification, savedAnswerText } from './reports.ts';

export type SubagentAdmission = (child: ConversationHandle, requestId: string, context: Context) => Promise<void>;
export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

export const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "bb.subagent-anchor", version: 1,
	initial: () => ({ phase: "done" }),
	phases: { done: (_task, runtime, context) => runtime.commit(
		() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context) },
	abort: (_task, runtime, context) => runtime.commit(
		() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export async function answerText(
	api: Pick<ToolExecutionApi, "commit">, answer: EntryId, context: Context,
): Promise<string> {
	const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
	const message = entry?.model?.[0] as AssistantMessage | undefined;
	return message?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
}

type ReporterInput = { key: string; conversationId: ConversationId; task: string; requestId: string; execution?: string; whenBusy?: 'steer' | 'followUp' };
type ReporterState = { phase: "deliver" } | { phase: "report"; text?: string; answerRef?: string; urgent?: boolean; notify?: boolean };

export function reporterFor(_legacyCourier: CourierTask, admit?: SubagentAdmission, origin?: SubagentOrigin) {
	return defineTask<ReporterInput, ReporterState, null>({
		name: "bb.subagent-reporter", version: 1,
		initial: () => ({ phase: "deliver" }),
		phases: {
			deliver: async (task, runtime, context) => {
				const child = (await runtime.conversation(task.input.conversationId, context))!;
				await admit?.(child, task.input.requestId, context);
				const requests = await runtime.snapshot(RequestsDoc, runtime.conversationId, context);
				if (requests?.stopped[task.input.requestId]) {
					await runtime.commit(async tx => {
						const text = `Subagent request stopped before submission: ${task.input.requestId}`;
						const record = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[task.input.key]!;
						record.report = text;
						record.settled = true;
						if (task.input.execution !== undefined) {
							const run = (await tx.doc(TeamDoc, runtime.conversationId)).executions[task.input.execution];
							if (run) run.done = { text };
							await cancelRequests(tx, runtime.conversationId, task.input.conversationId, task.input.execution);
						}
						return { status: 'running', checkpoint: { phase: 'report', text } };
					}, context);
					return;
				}
				const send = () => child.submit({ type: "input", content: task.input.task,
					requestId: task.input.requestId, ...(task.input.whenBusy === undefined ? {} : { whenBusy: task.input.whenBusy }) }, context);
				const submission = origin ? await origin.submit(child, [task.id], send, context, task.input.requestId) : await send();
				// A failed run leaves queued follow-ups in the SDK inbox. Withdraw only a still-queued
				// submission once idle; otherwise this reporter (and its admission slot) waits forever.
				const watch = await runtime.watchDoc(LiveDoc, child.id, context);
				let withdrawing: Promise<unknown> = Promise.resolve();
				let settled;
				const strand = async (live: { run?: unknown } | null) => {
					if (live !== null && live.run === undefined) {
						withdrawing = submission.abort(context);
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
					const record = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[task.input.key]!;
					let text: string | undefined = `Subagent ${record.name} failed: ${settled.status}`;
					let answerRef: string | undefined;
					if (settled.status === "unanswered") text += ` (${settled.reason})`;
					if (settled.status === "done" && settled.type === "input") {
						const entry = await tx.entry(AssistantEntry, settled.answer);
						if (entry?.conversationId !== task.input.conversationId) throw new Error('Subagent answer ownership mismatch');
						answerRef = `durable:${task.input.conversationId}:${settled.answer}`;
						text = undefined;
					}
					if (text === undefined) delete record.report; else record.report = text;
					record.settled = true;
					const run = task.input.execution === undefined ? undefined :
						(await tx.doc(TeamDoc, runtime.conversationId)).executions[task.input.execution];
					if (task.input.execution !== undefined) {
						if (run) run.done = answerRef === undefined ? { text } : { answerRef };
						await cancelRequests(tx, runtime.conversationId, task.input.conversationId, task.input.execution);
					}
					let notify: boolean | undefined;
					if (settled.status === 'done' && settled.type === 'input') {
						notify = (!run || run.background || !!run.attentionReturned) && !(record.reported ?? []).includes(settled.answer);
						// False suppresses only this Reporter, not future foreground restart handback.
						// Only a claimed answer is added to reported, with its owner's checkpoint.
						if (notify) record.reported = [...(record.reported ?? []), settled.answer];
					}
					return { status: "running", checkpoint: { phase: "report", ...(answerRef === undefined ? { text } : { answerRef }), ...(notify === undefined ? {} : { notify }) } };
				}, context);
			},
			report: async (task, runtime, context) => {
				// All new completion reports share the native urgent path. Courier v1 remains
				// registered solely to recover already-persisted legacy deliveries.
				const run = task.input.execution === undefined ? undefined :
					(await runtime.snapshot(TeamDoc, runtime.conversationId, context))?.executions[task.input.execution];
				if (task.state.checkpoint.notify !== false && (!run || run.background || run.attentionReturned)) {
					const parent = (await runtime.conversation(runtime.conversationId, context))!;
					// Preserve v1 urgent identities, including submit-before-terminal recovery.
					const requestId = `subagent-urgent:${task.id}`;
					await admit?.(parent, requestId, context);
					let content = task.state.checkpoint.text ?? '';
					if (task.state.checkpoint.answerRef !== undefined) {
						const answerRef = task.state.checkpoint.answerRef;
						await runtime.commit(async tx => {
							const record = (await tx.doc(SubagentsDoc, runtime.conversationId)).agents[task.input.key]!;
							content = answerNotification(record.name, task.input.requestId, answerRef,
								await savedAnswerText(tx, task.input.conversationId, { answerRef }));
							return undefined;
						}, context);
					}
					const send = () => parent.submit({ type: 'input', content, whenBusy: 'steer', requestId }, context);
					if (origin) await origin.submit(parent, [task.id], send, context, requestId); else await send();
				}
				await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context);

			},
		},
		abort: (_task, runtime, context) => runtime.commit(
			() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}
