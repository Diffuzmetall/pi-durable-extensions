import { defineDoc, type TaskId } from '@earendil-works/pi-durable';

// Separate receipts keep the shipped bb.subagents v1 schema byte-for-byte intact.
export type RequestReceipt = {
  action: 'spawn' | 'send';
  key: string;
  task: string;
  background: boolean;
  followUp: boolean;
  selection: string;
  requestId: string;
  ownerTaskId: TaskId;
  reporter?: TaskId;
  stopped?: boolean;
};
export const RequestsDoc = defineDoc<{ requests: Record<string, RequestReceipt>; stopped: Record<string, boolean> }>({
  kind: 'bb.subagent-requests', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ requests: {}, stopped: {} }),
});
