import type { AssistantMessage } from '@earendil-works/pi-ai';
import { AssistantEntry, type ConversationId, type EntryId, type Tx } from '@earendil-works/pi-durable';

/** New results reference the SDK entry; text is retained only for lifecycle/legacy results. */
export type SavedAnswer = { answerRef?: string; text?: string };

export async function canonicalAnswer(tx: Tx, child: ConversationId, reference: string) {
  const match = /^durable:(\d+):(\d+)$/.exec(reference);
  const id = Number(match?.[2]) as EntryId;
  if (!match || Number(match[1]) !== child || !Number.isSafeInteger(id) || id <= 0)
    throw new Error('Subagent answer ownership mismatch');
  const entry = await tx.entry(AssistantEntry, id);
  if (!entry) return undefined;
  if (entry.conversationId !== child) throw new Error('Subagent answer ownership mismatch');
  const message = entry.model?.[0] as AssistantMessage | undefined;
  return { id, text: (message?.content ?? []).flatMap(part => part.type === 'text' ? [part.text] : []).join('') };
}

export async function savedAnswerText(tx: Tx, child: ConversationId, saved: SavedAnswer): Promise<string> {
  if (saved.answerRef !== undefined)
    return (await canonicalAnswer(tx, child, saved.answerRef))?.text ?? `Canonical answer unavailable: ${saved.answerRef}`;
  return `Saved result without canonical answer reference:\n${saved.text ?? '(unavailable)'}`;
}

// Notification presentation only. Canonical data stays intact; the SDK separately bounds model-facing tool output.
const display = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function answerNotification(name: string, requestId: string, reference: string, answer: string): string {
  return `Subagent ${display(JSON.stringify(name))} requestId=${display(JSON.stringify(requestId))} Details=${display(JSON.stringify(reference))}\n${display(answer)}`;
}
