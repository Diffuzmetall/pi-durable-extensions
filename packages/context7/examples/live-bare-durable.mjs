import assert from 'node:assert/strict';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import createContext7 from '../src/context7-mcp.ts';

assert.ok(process.env.CONTEXT7_KEY_FILE, 'CONTEXT7_KEY_FILE must name the credential file');
assert.equal(process.env.CONTEXT7_API_KEY, undefined, 'supply only CONTEXT7_KEY_FILE for this proof');

const model = fauxProvider({ tokensPerSecond: 100000, models: [{ id: 'context7-live' }] });
const models = createModels();
models.setProvider(model.provider);
const registry = createRegistry();
registry.install(createContext7());
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);

async function invoke(toolName, args) {
  model.setResponses([
    () => fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: 'toolUse' }),
    () => fauxAssistantMessage([fauxText(`${toolName} completed`)]),
  ]);
  const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'context7-live' } } });
  const settled = await (await conversation.submit({ type: 'input', content: toolName }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, 'done');
  const view = await conversation.context(BACKGROUND_CONTEXT);
  const result = view.messages.findLast(message => message.role === 'toolResult' && message.toolName === toolName);
  assert.ok(result, `${toolName} did not run through the Harness`);
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

try {
  const resolved = await invoke('context7_resolve_library_id', {
    libraryName: 'Next.js',
    query: 'Find the official Next.js documentation library ID.',
  });
  const libraryId = resolved.match(/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?/)?.[0];
  assert.ok(libraryId, 'the live resolve result did not contain a Context7 library ID');

  const documentation = await invoke('context7_query_docs', {
    libraryId,
    query: 'Give one concise App Router example and include a real source URL.',
    language: 'javascript',
  });
  const sourceLink = documentation.match(/https?:\/\/[^\s)\]}>"']+/)?.[0];
  assert.ok(sourceLink, 'the live documentation result did not contain a source link');
  console.log(JSON.stringify({
    status: 'PASS',
    harness: 'plain @earendil-works/pi-durable Harness + MemoryStorage',
    tools: ['context7_resolve_library_id', 'context7_query_docs'],
    realContext7Content: true,
    libraryId,
    sourceLink,
  }));
} finally {
  await harness.close(BACKGROUND_CONTEXT);
}
