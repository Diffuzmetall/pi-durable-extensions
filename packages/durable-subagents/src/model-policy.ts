import type { SubagentOptions } from './index.ts';

/** Explicit opt-in for hosts that permit every model in their authenticated picker. */
export const resolveAvailableModel: NonNullable<SubagentOptions['resolveModel']> = async (selection, api) => {
  const separator = selection.indexOf('/');
  if (selection !== selection.trim() || separator < 1 || separator === selection.length - 1)
    throw Error('Subagent model must use an exact provider/model ID');
  const provider = selection.slice(0, separator);
  const modelId = selection.slice(separator + 1);
  const available = await api.models.getAvailable(provider);
  if (!available.some(model => model.provider === provider && model.id === modelId))
    throw Error('Subagent model is unavailable or provider is not authenticated');
  return { provider, modelId };
};
