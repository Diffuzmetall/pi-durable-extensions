/** Standalone Codex second opinions through Pocket's native model runtime. */
import { randomUUID } from "node:crypto";
import { Type, contentText } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { Check } from "typebox/value";
import { makeRuntime, type Host } from "./runtime.ts";

const parameters = Type.Object(
    {
        prompt: Type.String({ minLength: 1, maxLength: 131072 }),
        model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        reasoning: Type.Optional(
            Type.Union([
                Type.Literal("off"),
                Type.Literal("minimal"),
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
                Type.Literal("xhigh"),
                Type.Literal("max"),
            ]),
        ),
        verbosity: Type.Optional(
            Type.Union([
                Type.Literal("auto"),
                Type.Literal("low"),
                Type.Literal("medium"),
                Type.Literal("high"),
            ]),
        ),
        image_paths: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
                minItems: 1,
                maxItems: 5,
            }),
        ),
        num_last_images_to_include: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
        max_output_tokens: Type.Optional(
            Type.Integer({
                minimum: 1,
                maximum: 32768,
                description:
                    "Unsupported by the installed native Codex provider; omit this control. Only visible result text is bounded.",
            }),
        ),
    },
    { additionalProperties: false },
);

const systemPrompt = `You are Codex answering a standalone request delegated by another Pi agent.
Answer directly and accurately using only the prompt and images supplied here.
You have no access to the surrounding conversation, repository, files, or tools.
If required context is missing, say exactly what is needed.`;

export function createAskTool(host: Host) {
    return defineTool({
        name: "codex_ask",
        description:
            "Ask the Codex subscription for an explicit standalone text/vision second opinion. Use only when the user requests consultation or delegates a specific task to Codex; never automatically or recursively. Include all needed context in prompt; the surrounding conversation/workspace is not forwarded. Omit model unless an exact available Codex ID is requested. Choose image_paths OR recent images, not both.",
        parameters,
        replay: "unsafe",
        outputLimits: { maxBytes: 262144, maxLines: 4000 },
        async execute(args, api, context) {
            if (
                !Check(parameters, args) ||
                !args.prompt.trim() ||
                (args.model !== undefined && !args.model.trim())
            ) {
                throw new Error(
                    "Invalid codex_ask arguments; supply a nonempty standalone prompt and valid controls.",
                );
            }

            if (args.image_paths !== undefined && args.num_last_images_to_include !== undefined) {
                throw new Error("Provide only one of image_paths or num_last_images_to_include.");
            }

            if (args.max_output_tokens !== undefined) {
                throw new Error(
                    "max_output_tokens is unsupported by the installed native Codex provider. Omit it to use the provider output limit; only visible result text is bounded.",
                );
            }

            const runtime = await makeRuntime(api, context, host);

            try {
                const model = await runtime.model(args.model);

                if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
                    throw new Error("Select a native openai-codex subscription text model.");
                }

                const images = await runtime.images(
                    args.image_paths,
                    args.num_last_images_to_include,
                );

                runtime.signal.throwIfAborted();

                if (images.length && !model.input.includes("image")) {
                    throw new Error(
                        "The selected Codex model does not accept images; select a vision model.",
                    );
                }

                if (
                    args.reasoning &&
                    args.reasoning !== "off" &&
                    (!model.reasoning || model.thinkingLevelMap?.[args.reasoning] === null)
                ) {
                    throw new Error(
                        "The selected Codex model does not support that reasoning control.",
                    );
                }

                let response;

                try {
                    response = await runtime.models.complete(
                        model,
                        {
                            systemPrompt,
                            messages: [
                                {
                                    role: "user",
                                    timestamp: Date.now(),
                                    content: [
                                        { type: "text", text: args.prompt },
                                        ...images.map((image) => ({
                                            type: "image" as const,
                                            ...image,
                                        })),
                                    ],
                                },
                            ],
                        },
                        {
                            signal: runtime.signal,
                            fetch: runtime.fetch,
                            cacheRetention: "none",
                            sessionId: randomUUID(),
                            maxRetries: 0,
                            transport: "sse",
                            reasoningEffort: args.reasoning === "off" ? "none" : args.reasoning,
                            textVerbosity: args.verbosity === "auto" ? undefined : args.verbosity,
                        },
                    );
                } catch {
                    throw new Error(
                        runtime.signal.aborted
                            ? "Codex request cancelled or deadline exceeded."
                            : "Codex request failed; check subscription sign-in and model availability. No automatic retry was made.",
                    );
                }

                if (runtime.signal.aborted || response.stopReason === "aborted") {
                    throw new Error("Codex request cancelled or deadline exceeded.");
                }

                if (response.stopReason === "error") {
                    throw new Error(
                        "Codex returned an error; check subscription sign-in and model availability. No automatic retry was made.",
                    );
                }

                const answer = contentText(response.content).trim();

                if (!answer) {
                    throw new Error("Codex returned no text answer.");
                }

                const truncated = answer.length > 60000;
                const suffix = truncated
                    ? "\n\n[Answer truncated to the visible result limit]"
                    : response.stopReason === "length"
                      ? "\n\n[Codex stopped at the provider output limit]"
                      : "";

                return {
                    content: [{ type: "text" as const, text: answer.slice(0, 60000) + suffix }],
                    details: {
                        model: model.id,
                        imageCount: images.length,
                        stopReason: response.stopReason,
                        truncated,
                    },
                    usage: response.usage,
                };
            } finally {
                runtime.close();
            }
        },
    });
}
