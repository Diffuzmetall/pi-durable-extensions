import { createHash } from 'node:crypto';
import { Type } from '@earendil-works/pi-ai';
import { defineDoc, defineTool, type ConversationId } from '@earendil-works/pi-durable';
import { SubagentsDoc } from './documents.ts';
import { TeamDoc, requireParent } from './supervisor.ts';

type Delivery = { name: string; child: ConversationId; requestId: string; status: 'queued' | 'accepted' | 'failed'; error?: string };
export const MulticastDoc = defineDoc<{ batches: Record<string, { signature: string; deliveries: Delivery[] }> }>({
  kind: 'bb.subagent-multicast', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ batches: {} }),
});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export const multicastTool = defineTool({
  name: 'subagent_send_many', replay: 'unsafe',
  description: 'Parent only: send one message to selected names OR all current group members (including idle). Stable requestId fixes recipients on admission. Repeat resumes queued/failed admissions only; accepted is not completed. mode defaults to followUp. No sibling chat or new permissions.',
  parameters: Type.Object({
    names: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 100 })),
    all: Type.Optional(Type.Boolean()), message: Type.String({ minLength: 1, maxLength: 65536 }),
    mode: Type.Optional(Type.Union([Type.Literal('followUp'), Type.Literal('steer')])),
    requestId: Type.String({ minLength: 1, maxLength: 200 }),
    beadIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100, uniqueItems: true })),
  }, { additionalProperties: false }),
  execute: async (args, api, context) => {
    await requireParent(api, context);
    if ((args.names !== undefined) === (args.all === true)) throw new Error('Choose names or all:true, exclusively');
    if (!args.message.trim()) throw new Error('Multicast message must not be blank');
    const names = args.names === undefined ? undefined : [...new Set(args.names)].sort();
    const beadIds = args.beadIds === undefined ? undefined : [...args.beadIds].sort();
    const mode = args.mode ?? 'followUp';
    const signature = hash({ names, all: args.all === true, message: args.message, mode, beadIds });
    const key = `batch:${args.requestId}`;
    const batch = await api.commit(async tx => {
      const state = await tx.doc(MulticastDoc, api.conversationId);
      const previous = state.batches[key];
      if (previous) {
        if (previous.signature !== signature) throw new Error('Multicast requestId conflicts with original admission');
        return { ...previous, deliveries: previous.deliveries.map(d => ({ ...d })) };
      }
      const agents = (await tx.doc(SubagentsDoc, api.conversationId)).agents;
      const team = await tx.doc(TeamDoc, api.conversationId);
      const targets = names === undefined ? team.members.map(k => agents[k]) : names.map(name => Object.values(agents).find(a => a.name === name));
      const deliveries: Delivery[] = [];
      // Validate every target's actual ownership before any child input is admitted.
      for (const record of targets) {
        if (!record) throw new Error('Unknown or foreign multicast recipient');
        const child = await tx.conversation(record.conversationId);
        if (child?.owner?.conversationId !== api.conversationId || child.owner.taskId !== record.ownerTaskId)
          throw new Error('Multicast recipient ownership mismatch');
        deliveries.push({ name: record.name, child: record.conversationId,
          requestId: `multicast:${hash([api.conversationId, args.requestId, record.conversationId])}`, status: 'queued' });
      }
      state.batches[key] = { signature, deliveries };
      return { signature, deliveries };
    }, context);
    for (const delivery of batch.deliveries) {
      if (delivery.status === 'accepted') continue;
      const result = await api.executeTool('subagent', { action: 'send', name: delivery.name, message: args.message,
        followUp: mode === 'followUp', requestId: delivery.requestId, ...(beadIds === undefined ? {} : { beadIds }) }, context,
      { key: `recipient-${delivery.child}` });
      await api.commit(async tx => {
        const current = (await tx.doc(MulticastDoc, api.conversationId)).batches[key]!.deliveries.find(d => d.child === delivery.child)!;
        current.status = result.isError ? 'failed' : 'accepted';
        if (result.isError) current.error = JSON.stringify(result.structuredOutput ?? result.diagnostics ?? 'Child admission failed').slice(0, 2048);
        else delete current.error;
      }, context);
    }
    const result = (await api.snapshot(MulticastDoc, api.conversationId, context))!.batches[key]!;
    return { output: [{ type: 'text', text: JSON.stringify({ requestId: args.requestId, deliveries: result.deliveries,
      note: 'accepted means durable send admission, not task completion' }) }] };
  },
});
