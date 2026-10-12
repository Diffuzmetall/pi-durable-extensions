/**
 * Unit tests for the shim's OpenAI ⇄ Pi translation. No network, no credentials.
 */
import { describe, expect, test } from "bun:test";
import { streamOptions, toCompletion, toOpenAiFrames, toPiContext } from "../src/openai.ts";

describe("toPiContext", () => {
    test("system prompt, user text, and tools reach Pi's shape", () => {
        const { context } = toPiContext({
            model: "gemini-3.8-flash",
            messages: [
                { role: "system", content: "be brief" },
                { role: "user", content: "hello" },
            ],
            tools: [
                {
                    type: "function",
                    function: { name: "clock", description: "time", parameters: { type: "object" } },
                },
            ],
        });

        expect(context.systemPrompt).toBe("be brief");
        expect(context.messages).toHaveLength(1);
        expect(context.messages[0]).toMatchObject({
            role: "user",
            content: [{ type: "text", text: "hello" }],
        });
        expect(context.tools).toEqual([
            { name: "clock", description: "time", parameters: { type: "object" } },
        ]);
    });

    test("a tool round trip becomes toolCall and toolResult blocks with the right name", () => {
        const { context } = toPiContext({
            messages: [
                { role: "user", content: "what time is it?" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_1",
                            type: "function",
                            function: { name: "clock", arguments: '{"zone":"UTC"}' },
                        },
                    ],
                },
                { role: "tool", tool_call_id: "call_1", content: "12:00" },
            ],
        });

        expect(context.messages[1]).toMatchObject({
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "call_1", name: "clock", arguments: { zone: "UTC" } }],
        });
        expect(context.messages[2]).toMatchObject({
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "clock",
            content: [{ type: "text", text: "12:00" }],
            isError: false,
        });
    });

    test("a data URL image becomes a Pi image block; another URL is dropped with a warning", () => {
        const { context, warnings } = toPiContext({
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "look" },
                        { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
                        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
                    ],
                },
            ],
        });

        expect(context.messages[0].content).toEqual([
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: "AAAB" },
            { type: "text", text: expect.stringContaining("image omitted") },
        ]);
        expect(warnings).toHaveLength(1);
    });

    test("an unparseable tool call argument does not throw", () => {
        const { context, warnings } = toPiContext({
            messages: [
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "c", function: { name: "clock", arguments: "{oops" } }],
                },
            ],
        });

        expect(context.messages[0].content[0].arguments).toEqual({});
        expect(warnings).toHaveLength(1);
    });
});

describe("streamOptions", () => {
    test("maps token limit, temperature, effort and tool choice", () => {
        expect(
            streamOptions({
                max_tokens: 2048,
                temperature: 0.2,
                reasoning_effort: "low",
                tool_choice: "required",
            }),
        ).toEqual({ maxTokens: 2048, temperature: 0.2, reasoning: "low", toolChoice: "any" });
    });

    test("an empty body asks for nothing", () => {
        expect(streamOptions({})).toEqual({});
    });
});

async function* events(list) {
    for (const event of list) {
        yield event;
    }
}

async function collect(frames) {
    const out = [];

    for await (const frame of frames) {
        out.push(frame);
    }

    return out;
}

const payloads = (frames) =>
    frames.map((frame) => JSON.parse(frame.replace(/^data: /, "").trim()));

describe("toOpenAiFrames", () => {
    test("text and a tool call become deltas, then a finish reason, usage and [DONE]", async () => {
        const frames = await collect(
            toOpenAiFrames(
                events([
                    { type: "start", partial: { content: [] } },
                    { type: "text_start", contentIndex: 0, partial: { content: [{ type: "text", text: "" }] } },
                    { type: "text_delta", contentIndex: 0, delta: "Hel" },
                    { type: "text_delta", contentIndex: 0, delta: "lo" },
                    {
                        type: "toolcall_start",
                        contentIndex: 1,
                        partial: { content: [{ type: "text", text: "Hello" }, { type: "toolCall", id: "call_9", name: "clock" }] },
                    },
                    { type: "toolcall_delta", contentIndex: 1, delta: '{"zone"' },
                    { type: "toolcall_delta", contentIndex: 1, delta: ':"UTC"}' },
                    {
                        type: "done",
                        message: {
                            stopReason: "toolUse",
                            content: [],
                            usage: { input: 10, output: 3, cacheRead: 4, cacheWrite: 0, totalTokens: 13 },
                        },
                    },
                ]),
                { id: "chatcmpl-test", model: "gemini-3.8-flash", includeUsage: true },
            ),
        );

        expect(frames.at(-1)).toBe("data: [DONE]\n\n");

        const chunks = payloads(frames.slice(0, -1));
        expect(chunks[0].choices[0].delta).toEqual({ role: "assistant", content: "" });
        expect(chunks.filter((c) => c.choices?.[0]?.delta?.content === "Hel")).toHaveLength(1);
        expect(chunks.some((c) => c.choices?.[0]?.delta?.content === "lo")).toBe(true);

        const callStart = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls);
        expect(callStart.choices[0].delta.tool_calls[0]).toMatchObject({
            index: 0,
            id: "call_9",
            type: "function",
            function: { name: "clock", arguments: "" },
        });

        const args = chunks
            .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
            .map((call) => call.function.arguments)
            .join("");
        expect(args).toBe('{"zone":"UTC"}');

        const finish = chunks.find((c) => c.choices?.[0]?.finish_reason !== null && c.choices?.[0]?.finish_reason !== undefined);
        expect(finish.choices[0].finish_reason).toBe("tool_calls");

        const usage = chunks.find((c) => c.usage);
        expect(usage.usage).toEqual({
            prompt_tokens: 14,
            completion_tokens: 3,
            total_tokens: 13,
            prompt_tokens_details: { cached_tokens: 4 },
        });
    });

    test("thinking deltas ride along as reasoning_content", async () => {
        const frames = await collect(
            toOpenAiFrames(
                events([
                    { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
                    { type: "text_delta", contentIndex: 1, delta: "done" },
                    { type: "done", message: { stopReason: "stop", content: [], usage: {} } },
                ]),
                { model: "gemini-3.8-flash", includeUsage: false },
            ),
        );

        const chunks = payloads(frames.slice(0, -1));
        expect(chunks.some((c) => c.choices[0].delta.reasoning_content === "hmm")).toBe(true);
        expect(chunks.some((c) => c.usage !== undefined)).toBe(false);
    });

    test("an error event is reported, never as a silent success", async () => {
        const frames = await collect(
            toOpenAiFrames(
                events([{ type: "error", error: { errorMessage: "quota wall" } }]),
                { model: "gemini-3.8-flash", includeUsage: true },
            ),
        );

        expect(frames).toHaveLength(2);
        expect(JSON.parse(frames[0].replace(/^data: /, ""))).toEqual({
            error: { message: "quota wall", type: "upstream_error" },
        });
        expect(frames[1]).toBe("data: [DONE]\n\n");
    });
});

describe("toCompletion", () => {
    test("text, tool calls and usage come back in the non-streaming shape", () => {
        const completion = toCompletion(
            {
                stopReason: "toolUse",
                content: [
                    { type: "text", text: "sure" },
                    { type: "toolCall", id: "call_1", name: "clock", arguments: { zone: "UTC" } },
                ],
                usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 7 },
            },
            { id: "chatcmpl-1", model: "gemini-3.8-flash" },
        );

        expect(completion.choices[0].message.content).toBe("sure");
        expect(completion.choices[0].message.tool_calls[0]).toEqual({
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "clock", arguments: '{"zone":"UTC"}' },
        });
        expect(completion.choices[0].finish_reason).toBe("tool_calls");
        expect(completion.usage.prompt_tokens).toBe(6);
    });
});
