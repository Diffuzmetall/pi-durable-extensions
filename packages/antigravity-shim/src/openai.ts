/**
 * OpenAI Chat Completions ⇄ Pi's own message model, for the Antigravity shim.
 *
 * In:  an OpenAI request body (messages, tools, tool_calls, tool results, images as data URLs).
 * Out: SSE chunks and a final completion, as Pi's OpenAI client reads them.
 *
 * Nothing here talks to a provider: it is the translation layer the shim needs because
 * Pi Pocket registers these models through models.json as an OpenAI-compatible endpoint.
 */
import { randomUUID } from "node:crypto";

type Json = Record<string, any>;

const TEXT_LIMIT_NOTE = "[image omitted: only data: URLs are supported]";

/** The pi-ai context one OpenAI request becomes. */
export function toPiContext(body: Json): { context: Json; warnings: string[] } {
    const warnings: string[] = [];
    const systemParts: string[] = [];
    const messages: Json[] = [];
    const toolNames = new Map<string, string>();

    for (const raw of asArray(body.messages)) {
        const role = raw?.role;

        if (role === "system" || role === "developer") {
            const text = textOf(raw.content);
            if (text !== "") {
                systemParts.push(text);
            }
            continue;
        }

        if (role === "user") {
            messages.push({
                role: "user",
                content: contentParts(raw.content, warnings),
                timestamp: Date.now(),
            });
            continue;
        }

        if (role === "assistant") {
            const content: Json[] = [];
            const text = textOf(raw.content);

            if (text !== "") {
                content.push({ type: "text", text });
            }

            for (const call of asArray(raw.tool_calls)) {
                const fn = call?.function ?? {};
                const id = typeof call?.id === "string" && call.id !== "" ? call.id : `call_${randomUUID()}`;

                if (typeof fn.name === "string") {
                    toolNames.set(id, fn.name);
                }

                content.push({
                    type: "toolCall",
                    id,
                    name: typeof fn.name === "string" ? fn.name : "unknown_tool",
                    arguments: parseArguments(fn.arguments, warnings),
                });
            }

            messages.push({
                role: "assistant",
                content,
                api: "antigravity-api",
                provider: "antigravity",
                model: typeof body.model === "string" ? body.model : "",
                timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
                stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
            });
            continue;
        }

        if (role === "tool") {
            const toolCallId = typeof raw.tool_call_id === "string" ? raw.tool_call_id : "";
            const named = typeof raw.name === "string" && raw.name !== "" ? raw.name : undefined;

            messages.push({
                role: "toolResult",
                toolCallId,
                toolName: named ?? toolNames.get(toolCallId) ?? "tool",
                content: contentParts(raw.content, warnings),
                isError: raw.is_error === true,
                timestamp: Date.now(),
            });
        }
    }

    const tools = asArray(body.tools)
        .filter((tool) => tool?.type === "function" && typeof tool.function?.name === "string")
        .map((tool) => ({
            name: tool.function.name,
            description: typeof tool.function.description === "string" ? tool.function.description : "",
            parameters: tool.function.parameters ?? { type: "object", properties: {} },
        }));

    return {
        context: {
            ...(systemParts.length === 0 ? {} : { systemPrompt: systemParts.join("\n\n") }),
            messages,
            ...(tools.length === 0 ? {} : { tools }),
        },
        warnings,
    };
}

function asArray(value: unknown): Json[] {
    return Array.isArray(value) ? (value as Json[]) : [];
}

/** Plain text of an OpenAI content value (string, or the text parts of an array). */
function textOf(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    return content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
}

/** An OpenAI content value as Pi content blocks; images must arrive as data URLs. */
function contentParts(content: unknown, warnings: string[]): Json[] {
    if (typeof content === "string") {
        return [{ type: "text", text: content }];
    }

    const parts: Json[] = [];

    for (const part of asArray(content)) {
        if (part?.type === "text" && typeof part.text === "string") {
            parts.push({ type: "text", text: part.text });
            continue;
        }

        if (part?.type === "image_url") {
            const url = part.image_url?.url;
            const image = dataUrl(url);

            if (image === undefined) {
                if (typeof url === "string" && url !== "") {
                    warnings.push(`image_url is not a data URL (${url.slice(0, 12)}…) — dropped`);
                    parts.push({ type: "text", text: TEXT_LIMIT_NOTE });
                }
                continue;
            }

            parts.push(image);
        }
    }

    return parts.length === 0 ? [{ type: "text", text: "" }] : parts;
}

/** "data:image/png;base64,AAA" as a Pi image block. */
function dataUrl(url: unknown): Json | undefined {
    if (typeof url !== "string") {
        return undefined;
    }

    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);

    return match === null
        ? undefined
        : { type: "image", mimeType: match[1]!, data: match[2]!.replace(/\s/g, "") };
}

function parseArguments(value: unknown, warnings: string[]): Json {
    if (typeof value !== "string" || value.trim() === "") {
        return {};
    }

    try {
        const parsed = JSON.parse(value);

        return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
        warnings.push("a tool_call argument was not valid JSON — sent as an empty object");
        return {};
    }
}

/** Request options the shim passes to the Antigravity stream. */
export function streamOptions(body: Json): Json {
    const maxTokens = numberOrUndefined(body.max_tokens) ?? numberOrUndefined(body.max_completion_tokens);
    const effort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined;

    return {
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(numberOrUndefined(body.temperature) === undefined
            ? {}
            : { temperature: numberOrUndefined(body.temperature) }),
        ...(effort === undefined ? {} : { reasoning: mapEffort(effort) }),
        ...(body.tool_choice === undefined ? {} : { toolChoice: mapToolChoice(body.tool_choice) }),
    };
}

function numberOrUndefined(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mapEffort(effort: string): string {
    const value = effort.toLowerCase();

    if (value === "none" || value === "off") return "off";
    if (value === "minimal") return "minimal";
    if (value === "low" || value === "medium" || value === "high") return value;
    if (value === "xhigh" || value === "max") return "high";

    return "medium";
}

function mapToolChoice(choice: unknown): string {
    if (typeof choice === "string") {
        return choice === "required" || choice === "any" ? "any" : choice === "none" ? "none" : "auto";
    }

    const name = (choice as Json | undefined)?.function?.name;

    return typeof name === "string" ? "any" : "auto";
}

const FINISH_REASONS: Record<string, string> = {
    stop: "stop",
    length: "length",
    toolUse: "tool_calls",
    deferred: "stop",
};

function usageOf(usage: Json | undefined): Json {
    const input = usage?.input ?? 0;
    const output = usage?.output ?? 0;
    const cacheRead = usage?.cacheRead ?? 0;
    const cacheWrite = usage?.cacheWrite ?? 0;
    const prompt = input + cacheRead + cacheWrite;

    return {
        prompt_tokens: prompt,
        completion_tokens: output,
        total_tokens: usage?.totalTokens ?? prompt + output,
        prompt_tokens_details: { cached_tokens: cacheRead },
    };
}

type FrameState = {
    id: string;
    model: string;
    created: number;
    includeUsage: boolean;
    roleSent: boolean;
    tools: Map<number, number>;
};

function chunkFrame(state: FrameState, delta: Json, finishReason: string | null): string {
    const payload = {
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    };

    return `data: ${JSON.stringify(payload)}\n\n`;
}

function usageFrame(state: FrameState, usage: Json): string {
    return `data: ${JSON.stringify({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [],
        usage: usageOf(usage),
    })}\n\n`;
}

/**
 * One Antigravity event stream as OpenAI SSE frames, ending with [DONE].
 * A failure before any content is the caller's to turn into an HTTP error; a failure
 * after content is reported as an error frame, so a broken run never looks complete.
 */
export async function* toOpenAiFrames(
    events: AsyncIterable<Json>,
    options: { id?: string; model: string; includeUsage: boolean },
): AsyncGenerator<string> {
    const state: FrameState = {
        id: options.id ?? `chatcmpl-${randomUUID()}`,
        model: options.model,
        created: Math.floor(Date.now() / 1000),
        includeUsage: options.includeUsage,
        roleSent: false,
        tools: new Map(),
    };

    for await (const event of events) {
        if (!state.roleSent && event.type !== "error") {
            state.roleSent = true;
            yield chunkFrame(state, { role: "assistant", content: "" }, null);
        }

        if (event.type === "text_delta" && typeof event.delta === "string") {
            yield chunkFrame(state, { content: event.delta }, null);
            continue;
        }

        if (event.type === "thinking_delta" && typeof event.delta === "string") {
            yield chunkFrame(state, { reasoning_content: event.delta }, null);
            continue;
        }

        if (event.type === "toolcall_start") {
            const block = event.partial?.content?.[event.contentIndex] ?? {};
            const index = state.tools.size;

            state.tools.set(event.contentIndex, index);
            yield chunkFrame(
                state,
                {
                    tool_calls: [
                        {
                            index,
                            id: block.id ?? `call_${randomUUID()}`,
                            type: "function",
                            function: { name: block.name ?? "unknown_tool", arguments: "" },
                        },
                    ],
                },
                null,
            );
            continue;
        }

        if (event.type === "toolcall_delta") {
            const index = state.tools.get(event.contentIndex);
            if (index !== undefined && typeof event.delta === "string") {
                yield chunkFrame(
                    state,
                    { tool_calls: [{ index, function: { arguments: event.delta } }] },
                    null,
                );
            }
            continue;
        }

        if (event.type === "done") {
            const message = event.message ?? {};
            yield chunkFrame(state, {}, FINISH_REASONS[message.stopReason] ?? "stop");

            if (state.includeUsage) {
                yield usageFrame(state, message.usage);
            }

            yield "data: [DONE]\n\n";
            return;
        }

        if (event.type === "error") {
            const message = event.error?.errorMessage ?? event.message?.errorMessage ?? "stream failed";

            yield `data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`;
            yield "data: [DONE]\n\n";
            return;
        }
    }
}

/** A whole response (no streaming) from the events of one Antigravity run. */
export function toCompletion(
    message: Json | undefined,
    options: { id?: string; model: string },
): Json {
    const content = message?.content ?? [];
    const text = content
        .filter((block: Json) => block.type === "text")
        .map((block: Json) => block.text)
        .join("");
    const calls = content.filter((block: Json) => block.type === "toolCall");

    return {
        id: options.id ?? `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: options.model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content: text === "" ? null : text,
                    ...(calls.length === 0
                        ? {}
                        : {
                              tool_calls: calls.map((block: Json, index: number) => ({
                                  index,
                                  id: block.id,
                                  type: "function",
                                  function: {
                                      name: block.name,
                                      arguments: JSON.stringify(block.arguments ?? {}),
                                  },
                              })),
                          }),
                },
                finish_reason: FINISH_REASONS[message?.stopReason] ?? "stop",
            },
        ],
        usage: usageOf(message?.usage),
    };
}
