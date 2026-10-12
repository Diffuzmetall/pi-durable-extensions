import assert from "node:assert/strict";
import test from "node:test";
import { streamOptions, toCompletion, toOpenAiFrames, toPiContext } from "../src/openai.ts";

async function* events(list) {
  yield* list;
}

async function collect(iterable) {
  const output = [];
  for await (const value of iterable) output.push(value);
  return output;
}

function payload(frame) {
  return JSON.parse(frame.replace(/^data: /, "").trim());
}

test("OpenAI messages translate to Pi context with tool and data-image blocks", () => {
  const result = toPiContext({
    model: "gemini-3.8-flash",
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } }] },
      { role: "assistant", tool_calls: [{ id: "call_1", function: { name: "clock", arguments: '{"zone":"UTC"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "12:00" },
    ],
    tools: [{ type: "function", function: { name: "clock", parameters: { type: "object" } } }],
  });
  assert.equal(result.context.systemPrompt, "be brief");
  assert.deepEqual(result.context.messages[0].content[1], { type: "image", mimeType: "image/png", data: "AAAB" });
  assert.equal(result.context.messages[1].content[0].type, "toolCall");
  assert.equal(result.context.messages[2].toolName, "clock");
  assert.deepEqual(result.context.tools[0].parameters, { type: "object" });
});

test("request options preserve bounded translation", () => {
  assert.deepEqual(streamOptions({ max_tokens: 2048, temperature: 0.2, reasoning_effort: "low", tool_choice: "required" }), {
    maxTokens: 2048,
    temperature: 0.2,
    reasoning: "low",
    toolChoice: "any",
  });
});

test("events become OpenAI SSE with usage and terminal marker", async () => {
  const frames = await collect(toOpenAiFrames(events([
    { type: "text_delta", delta: "hello" },
    { type: "done", message: { stopReason: "stop", usage: { input: 3, output: 2, totalTokens: 5 } } },
  ]), { id: "chatcmpl-test", model: "gemini-3.8-flash", includeUsage: true }));
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  assert.equal(payload(frames[1]).choices[0].delta.content, "hello");
  assert.equal(payload(frames[2]).choices[0].finish_reason, "stop");
  assert.equal(payload(frames[3]).usage.total_tokens, 5);
});

test("upstream error is explicit and completion preserves tool calls", async () => {
  const errorFrames = await collect(toOpenAiFrames(events([{ type: "error", error: { errorMessage: "quota wall" } }]), {
    model: "gemini-3.8-flash",
    includeUsage: true,
  }));
  assert.deepEqual(payload(errorFrames[0]), { error: { message: "quota wall", type: "upstream_error" } });
  const completion = toCompletion({
    stopReason: "toolUse",
    content: [{ type: "text", text: "sure" }, { type: "toolCall", id: "call_1", name: "clock", arguments: { zone: "UTC" } }],
    usage: { input: 5, output: 2, totalTokens: 7 },
  }, { id: "chatcmpl-1", model: "gemini-3.8-flash" });
  assert.equal(completion.choices[0].finish_reason, "tool_calls");
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{"zone":"UTC"}');
});
