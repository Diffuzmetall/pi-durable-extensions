/**
 * Portable codemode for Pi Durable: QuickJS scripts call the selected agent tools through the
 * normal validation, hook, cancellation, replay, output-budget, and durable-store paths.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { type ToolCall, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
    defineExtension,
    defineTool,
    type Extension,
    type HookApi,
    type JsonObject,
    section,
    type ToolDiagnostic,
    type ToolExecutionApi,
    type ToolExecutionResult,
    type ToolHooks,
    type ToolRegistration,
    ToolTask,
    type Registry,
} from "@earendil-works/pi-durable";
import {
    type CodemodeResult,
    CodemodeSandbox,
    parseCodemodeSource,
} from "@earendil-works/pi-codemode";
import { describe } from "./errors.ts";
import { CodemodeStoreDoc } from "./store.ts";

export { CodemodeStoreDoc } from "./store.ts";

export const CODEMODE_TOOL = "codemode";
const DEFAULT_EXTENSION = "codemode";
const MAX_OUTPUT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;
const MAX_OUTPUT_IMAGES = 100;
const MAX_NESTED_CHARS = 1_000_000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

export type CodemodeOptions = {
    /** Bare Durable keeps the canonical codemode tool name; Pocket adapters may choose another one. */
    toolName?: string;
    extensionName?: string;
    /** Names already owned by the embedding; collisions are rejected before construction. */
    reservedToolNames?: readonly string[];
    reservedExtensionNames?: readonly string[];
};

const DESCRIPTION = `Run JavaScript that calls your other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level \`await\` and \`return\` work. No Node, file system, network, or timers.
- \`await tools.<name>({ ...args })\` takes the same arguments as calling the tool directly, resolves to its text output, and rejects with an Error when the call fails or is blocked. Calls still running when the script ends are cancelled.
- Each call is checked like a direct call: hooks may block or rewrite it.
- Optional first line: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\`
Globals:
- \`text(value)\`, \`image(dataUrlOrImageBlock)\`, \`console.log(...)\`, and top-level \`return\` add output; \`exit()\` ends the script.
- \`store(key, value)\` and \`load(key)\` keep JSON values across codemode calls in this conversation.
- \`ALL_TOOLS\` lists the tools a script may call.`;

type CallRecord = {
    name: string;
    status: "running" | "ok" | "error" | "cancelled";
    path?: string;
    durationMs?: number;
    error?: string;
};

type CodemodeDetails = { calls: CallRecord[]; fullOutputPath?: string };
type BeforeTool = ToolHooks["beforeTool"];
type AfterTool = ToolHooks["afterTool"];

type OutputItem =
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string };

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodedBase64Bytes(data: unknown): number | undefined {
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0) {
        return undefined;
    }

    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        return undefined;
    }

    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const final = data.slice(-4);
    const finalValue = (character: string): number => BASE64_ALPHABET.indexOf(character);
    if (padding === 2 && (finalValue(final[1]) & 0x0f) !== 0) {
        return undefined;
    }
    if (padding === 1 && (finalValue(final[2]) & 0x03) !== 0) {
        return undefined;
    }

    return (data.length / 4) * 3 - padding;
}

function utf8Bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

function utf8Head(text: string, maxBytes: number): string {
    return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

function utf8Tail(text: string, maxBytes: number): string {
    const encoded = Buffer.from(text, "utf8");
    return encoded.subarray(Math.max(0, encoded.length - maxBytes)).toString("utf8");
}

function toolHooks(extensions: readonly Extension[]): { before: BeforeTool[]; after: AfterTool[] } {
    const before: BeforeTool[] = [];
    const after: AfterTool[] = [];

    for (const extension of extensions) {
        for (const registration of extension.hooks ?? []) {
            if (registration.task !== ToolTask.definition.name) {
                continue;
            }

            const handlers = registration.handlers as Partial<ToolHooks>;

            if (handlers.beforeTool !== undefined) {
                before.push(handlers.beforeTool.bind(handlers));
            }

            if (handlers.afterTool !== undefined) {
                after.push(handlers.afterTool.bind(handlers));
            }
        }
    }

    return { before, after };
}

function resultText(result: ToolExecutionResult, diagnostics: readonly ToolDiagnostic[]): string {
    const parts = (result.content ?? []).flatMap((part) =>
        part.type === "text" ? [part.text] : [],
    );

    for (const diagnostic of [...diagnostics, ...(result.diagnostics ?? [])]) {
        parts.push(diagnostic.message);
    }

    return parts.join("\n");
}

function bound(text: string, retain: "head" | "tail"): string {
    if (text.length <= MAX_NESTED_CHARS) {
        return text;
    }

    const note = `[${text.length - MAX_NESTED_CHARS} characters not shown]`;

    return retain === "tail"
        ? `${note}\n${text.slice(-MAX_NESTED_CHARS)}`
        : `${text.slice(0, MAX_NESTED_CHARS)}\n${note}`;
}

function valueText(value: unknown): string {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function formatError(
    result: Extract<CodemodeResult, { ok: false }>,
    calls: readonly CallRecord[],
): string {
    const { error } = result;
    const head =
        error.kind === "script"
            ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`)
            : error.kind === "timeout"
              ? `Script timed out: ${error.message}`
              : error.kind === "aborted"
                ? `Script aborted: ${error.message}`
                : `Script sandbox failed: ${error.message}`;
    const summary =
        calls.length === 0
            ? "No tool calls were made."
            : `Tool calls made before the failure (they are not undone): ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}`;

    return `${head}\n\n${summary}`;
}

function imageWarning(count: number, reasons: Iterable<string>): string {
    return `Warning: ${count} image output(s) rejected (${[...reasons].join("; ")}).`;
}

async function budget(
    items: OutputItem[],
    maxTokens: number,
): Promise<{ items: OutputItem[]; fullOutputPath?: string }> {
    const limit = maxTokens * CHARS_PER_TOKEN;
    let imageCount = 0;
    let imageBytes = 0;
    let rejectedImageCount = 0;
    const rejectedImageReasons = new Set<string>();
    const rejectImage = (reason: string) => {
        rejectedImageCount++;
        rejectedImageReasons.add(reason);
    };
    const acceptedImages: OutputItem[] = [];
    const retainedTexts = items.flatMap((item) => (item.type === "text" ? [item.text] : []));
    const textBytes = utf8Bytes(retainedTexts.join("\n"));
    const imageItems = items.filter((item): item is Extract<OutputItem, { type: "image" }> => item.type === "image");
    const validImages: { item: Extract<OutputItem, { type: "image" }>; bytes: number }[] = [];

    for (const item of imageItems) {
        if (typeof item.mimeType !== "string" || item.mimeType.length === 0) {
            rejectImage("malformed MIME");
            continue;
        }

        const bytes = decodedBase64Bytes(item.data);
        if (bytes === undefined) {
            rejectImage("malformed base64");
            continue;
        }

        validImages.push({ item, bytes });
    }

    const byteReason = "byte budget";
    const countReason = "count cap";
    const potentialReasons = new Set(rejectedImageReasons);
    const fullImageBytes = validImages.reduce((total, image) => total + image.bytes, 0);
    if (validImages.length > MAX_OUTPUT_IMAGES) potentialReasons.add(countReason);
    if (fullImageBytes > Math.max(0, limit - textBytes)) potentialReasons.add(byteReason);
    // Any warning consumes budget; reserve the byte reason before selecting images so the
    // final warning cannot create a second rejection pass.
    if (potentialReasons.size > 0 && validImages.length > 0) potentialReasons.add(byteReason);
    const potentialWarning = potentialReasons.size === 0
        ? undefined
        : imageWarning(imageItems.length, potentialReasons);
    const warningReserve = potentialWarning === undefined
        ? 0
        : utf8Bytes(potentialWarning) + (retainedTexts.length > 0 ? utf8Bytes("\n") : 0);
    const imageByteLimit = Math.max(0, limit - textBytes - warningReserve);

    for (const { item, bytes } of validImages) {
        if (imageCount >= MAX_OUTPUT_IMAGES) {
            rejectImage(countReason);
            continue;
        }

        if (imageBytes + bytes > imageByteLimit) {
            rejectImage(byteReason);
            continue;
        }

        imageCount++;
        imageBytes += bytes;
        acceptedImages.push(item);
    }
    const warning = rejectedImageCount > 0
        ? imageWarning(rejectedImageCount, rejectedImageReasons)
        : undefined;
    const texts = warning === undefined ? retainedTexts : [...retainedTexts, warning];
    const combined = texts.join("\n");
    const safeItems: OutputItem[] = [
        ...retainedTexts.map((text) => ({ type: "text", text }) as const),
        ...(warning === undefined ? [] : [{ type: "text", text: warning } as const]),
        ...acceptedImages,
    ];

    const combinedBytes = utf8Bytes(combined);
    if (combinedBytes <= limit) {
        return { items: safeItems };
    }

    const head = utf8Head(combined, Math.floor(limit / 2));
    const tail = utf8Tail(combined, limit - utf8Bytes(head));
    const shownBytes = utf8Bytes(head) + utf8Bytes(tail);
    let text = `Warning: output truncated (about ${Math.ceil(combinedBytes / CHARS_PER_TOKEN)} tokens, ${combined.split("\n").length} lines)\n\n${head}\n… ${Math.ceil((combinedBytes - shownBytes) / CHARS_PER_TOKEN)} tokens not shown …\n${tail}`;
    const directory = await mkdtemp(join(tmpdir(), "pi-durable-codemode-"));
    const path = join(directory, `output-${randomBytes(8).toString("hex")}.txt`);

    try {
        await writeFile(path, combined, { flag: "wx", mode: 0o600 });
        // This host-generated pointer remains visible in ToolExecutionResult.content and is excluded from the captured-payload budget.
        text += `\n\n[Full output: ${path} (read it with offset and limit)]`;
    } catch (error) {
        text += `\n\n[Could not save the full output: ${describe(error)}]`;

        return {
            items: [{ type: "text", text }, ...acceptedImages],
        };
    }

    return {
        items: [{ type: "text", text }, ...acceptedImages],
        fullOutputPath: path,
    };
}

function validateOptions(options: CodemodeOptions): Required<Pick<CodemodeOptions, "toolName" | "extensionName">> {
    const toolName = options.toolName ?? CODEMODE_TOOL;
    const extensionName = options.extensionName ?? DEFAULT_EXTENSION;

    if (toolName.length === 0 || extensionName.length === 0) {
        throw new Error("Codemode tool and extension names must not be empty");
    }

    if (options.reservedToolNames?.includes(toolName)) {
        throw new Error(`Codemode tool name is already registered: ${toolName}`);
    }

    if (options.reservedExtensionNames?.includes(extensionName)) {
        throw new Error(`Codemode extension name is already registered: ${extensionName}`);
    }

    return { toolName, extensionName };
}

/** Install codemode only when its extension and tool names are not already occupied. */
export function installCodemode(
    registry: Registry,
    options: CodemodeOptions = {},
): Extension {
    const { toolName, extensionName } = validateOptions(options);
    const snapshot = registry.snapshot();
    const extensionCollision = snapshot.extension(extensionName);
    if (extensionCollision !== undefined) {
        throw new Error(`Codemode extension name is already registered: ${extensionName}`);
    }

    const toolCollision = snapshot.tools().find(({ tool }) => tool.name === toolName);
    if (toolCollision !== undefined) {
        throw new Error(
            `Codemode tool name is already registered: ${toolName} (extension ${toolCollision.extension.name})`,
        );
    }

    const extension = createCodemode(options);
    registry.install(extension);

    return extension;
}

export default function createCodemode(options: CodemodeOptions = {}): Extension {
    const { toolName, extensionName } = validateOptions(options);
    const codemode = defineTool({
        name: toolName,
        description: DESCRIPTION,
        parameters: Type.Object({ code: Type.String({ description: "Raw JavaScript source." }) }),
        // Nested calls can write files or cause external effects and must never be replayed.
        replay: "unsafe",
        execute: async (args, api: ToolExecutionApi<CodemodeDetails>, context) => {
            const started = performance.now();
            const { code, options: sourceOptions } = parseCodemodeSource(args.code);
            const agent = await api.agent(context);
            const callable = agent.tools.filter(
                (tool) => tool.name !== toolName,
            ) as ToolRegistration[];
            const hooks = toolHooks(agent.extensions);
            const calls: CallRecord[] = [];
            const publish = () =>
                void api
                    .details({ calls: calls.map((call) => ({ ...call })) }, context)
                    .catch(() => {});
            let next = 0;

            const nested = async (
                tool: ToolRegistration,
                input: unknown,
                signal: AbortSignal,
            ): Promise<string> => {
                const n = ++next;
                const call: ToolCall = {
                    type: "toolCall",
                    id: `${api.callId}/${n}`,
                    name: tool.name,
                    arguments: (input ?? {}) as JsonObject,
                };
                const record: CallRecord = { name: tool.name, status: "running" };

                calls.push(record);
                publish();
                const callStarted = performance.now();
                const scope = withAbortSignal(signal, context);
                const memo = ((name: string, ...rest: unknown[]) =>
                    (api.memo as (...all: unknown[]) => unknown)(
                        `codemode/${n}/${name}`,
                        ...rest,
                    )) as ToolExecutionApi["memo"];
                const hookApi: HookApi = { ...api, memo };
                const check = (value: unknown): JsonObject =>
                    validateToolArguments(tool, {
                        ...call,
                        arguments: value as JsonObject,
                    }) as JsonObject;

                try {
                    let callArgs = check(
                        tool.prepareArguments === undefined
                            ? call.arguments
                            : tool.prepareArguments(call.arguments),
                    );

                    for (const before of hooks.before) {
                        let decision: Awaited<ReturnType<BeforeTool>>;

                        try {
                            decision = await before(
                                { ...call, arguments: callArgs },
                                hookApi,
                                scope,
                            );
                        } catch (error) {
                            if (scope.abortSignal?.aborted) {
                                throw error;
                            }

                            throw new Error(`Tool call blocked: ${describe(error)}`);
                        }

                        if (decision?.block !== undefined) {
                            throw new Error(`Tool call blocked: ${decision.block}`);
                        }

                        if (decision?.arguments !== undefined) {
                            callArgs = decision.arguments;
                        }
                    }

                    callArgs = check(callArgs);

                    if (typeof callArgs.path === "string") {
                        record.path = callArgs.path;
                    }

                    const decoder = new TextDecoder();
                    const output: string[] = [];
                    const diagnostics: ToolDiagnostic[] = [];
                    const toolApi: ToolExecutionApi = {
                        ...api,
                        callId: call.id,
                        memo,
                        output: (chunk) =>
                            void output.push(
                                typeof chunk === "string"
                                    ? chunk
                                    : decoder.decode(chunk, { stream: true }),
                            ),
                        diagnostic: (diagnostic) => void diagnostics.push(diagnostic),
                        details: async () => {},
                    };
                    let result = await tool.execute(callArgs, toolApi, scope);

                    if (result.content === undefined) {
                        result = {
                            ...result,
                            content: [{ type: "text", text: output.join("") + decoder.decode() }],
                        };
                    }

                    for (const after of hooks.after) {
                        result =
                            (await after(
                                { ...call, arguments: callArgs },
                                result,
                                hookApi,
                                scope,
                            )) ?? result;
                    }

                    const text = bound(
                        resultText(result, diagnostics),
                        tool.outputLimits?.retain ?? "head",
                    );

                    if (result.isError === true) {
                        throw new Error(text || `Tool ${tool.name} failed`);
                    }

                    record.status = "ok";

                    return text;
                } catch (error) {
                    record.status = signal.aborted ? "cancelled" : "error";
                    record.error = describe(error).slice(0, 500);

                    throw error;
                } finally {
                    record.durationMs = Math.round(performance.now() - callStarted);
                    publish();
                }
            };

            const sandbox = new CodemodeSandbox({
                tools: callable.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.parameters as Record<string, unknown>,
                    outputSchema: { type: "string" },
                    execute: (input, { signal }) => nested(tool, input, signal),
                })),
                timeoutMs: sourceOptions.timeoutMs ?? Number.POSITIVE_INFINITY,
                memoryLimitBytes: MEMORY_LIMIT_BYTES,
            });
            const stored =
                (await api.snapshot(CodemodeStoreDoc, api.conversationId, context))?.values ?? {};
            let result: CodemodeResult;

            try {
                result = await sandbox.execute(code, {
                    ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
                    store: stored,
                });
            } finally {
                await sandbox.close();
            }

            for (const call of calls) {
                if (call.status === "running") {
                    call.status = "cancelled";
                }
            }

            const items: OutputItem[] = result.output.map((item) =>
                item.type === "text" ? { type: "text", text: item.text } : item,
            );

            if (result.ok) {
                const { set, delete: removed } = result.storeWrites;

                if (Object.keys(set).length > 0 || removed.length > 0) {
                    await api.commit(async (tx) => {
                        const doc = await tx.doc(CodemodeStoreDoc, api.conversationId);

                        for (const key of removed) {
                            delete doc.values[key];
                        }

                        for (const [key, value] of Object.entries(set)) {
                            doc.values[key] = value as JsonValue;
                        }
                    }, context);
                }

                if (result.value !== undefined) {
                    items.push({ type: "text", text: valueText(result.value) });
                }
            } else {
                items.push({ type: "text", text: `Script error:\n${formatError(result, calls)}` });
            }

            const shown = await budget(items, sourceOptions.maxOutputTokens ?? MAX_OUTPUT_TOKENS);
            const header = `${result.ok ? "Script completed" : "Script failed"}\nWall time ${((performance.now() - started) / 1000).toFixed(1)} seconds\nOutput:\n`;

            return {
                content: [{ type: "text", text: header }, ...shown.items],
                details: {
                    calls,
                    ...(shown.fullOutputPath === undefined
                        ? {}
                        : { fullOutputPath: shown.fullOutputPath }),
                },
                ...(result.ok ? {} : { isError: true }),
            };
        },
    });

    return defineExtension({
        name: extensionName,
        tools: [codemode],
        sections: [
            section("codemode", ({ agent }) => {
                const names = agent.tools
                    .map((tool) => tool.name)
                    .filter((name) => name !== toolName);

                if (
                    !agent.tools.some((tool) => tool.name === toolName) ||
                    names.length === 0
                ) {
                    return undefined;
                }

                return `Use ${toolName} to batch independent tool calls (Promise.allSettled), chain them, or filter large output, instead of making many separate calls. Scripts can call: ${names.join(", ")}.`;
            }),
        ],
    });
}
