import { createRegistry, type RegistryReader } from '@earendil-works/pi-durable';
import { createSubagent, type SubagentOptions } from './index.ts';

const HINDSIGHT_CONTROLLER = Symbol.for('pi.durable.hindsight.controller');

/** Host composition only: replace the owner, retain every other extension object (and its guards). */
export default function installSubagents(base: RegistryReader, options: Pick<SubagentOptions, 'resolveModel' | 'origin'> = {}): RegistryReader {
  const snapshot = base.snapshot();
  const hindsight = snapshot.extension('hindsight');
  const controller = (hindsight as unknown as Record<symbol, { admit?: unknown }> | undefined)?.[HINDSIGHT_CONTROLLER];
  if (typeof controller?.admit !== 'function')
    throw new Error('Background subagents require the existing Hindsight admission controller');
  const admit = controller.admit as NonNullable<Parameters<typeof createSubagent>[0]>;
  const registry = createRegistry();
  for (const extension of snapshot.installed()) {
    if (extension.name !== 'subagent') registry.install(extension);
  }
  const available = new Set(snapshot.tools().map(({ tool }) => tool.name));
  const present = (names: string[]) => names.filter(name => available.has(name));
  registry.install(createSubagent((child, requestId, context) => admit.call(controller, child, requestId, context), {
    ...options, maxActive: 20,
    roles: { worker: 'inherit', reviewer: present(['read']) },
  }));
  return registry;
}
