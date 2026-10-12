/**
 * The Antigravity shim: an OpenAI-compatible endpoint that Pi and Pi Pocket reach
 * through ~/.pi/agent/models.json, backed by the Antigravity protocol of the installed
 * npm:pi-antigravity extension.
 *
 * It holds the Antigravity credentials itself, so the models.json apiKey is a placeholder
 * and no client secret ever crosses this boundary. It binds to the loopback address.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PROVIDER_ID, currentApiKey, fixtureEnabled, listModels, streamModel } from "./antigravity.ts";
import { streamOptions, toCompletion, toOpenAiFrames, toPiContext } from "./openai.ts";

const HOST = process.env.ANTIGRAVITY_SHIM_HOST ?? "127.0.0.1";
const PORT = Number(process.env.ANTIGRAVITY_SHIM_PORT ?? 18790);
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function log(message: string): void {
    process.stderr.write(`[${new Date().toISOString()}] antigravity-shim: ${message}\n`);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);

    response.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
    });
    response.end(text);
}

function sendError(response: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
    sendJson(response, status, { error: { message, type, code: status } });
}

async function readJson(request: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        size += (chunk as Buffer).length;

        if (size > MAX_BODY_BYTES) {
            throw new Error("request body too large");
        }

        chunks.push(chunk as Buffer);
    }

    const text = Buffer.concat(chunks).toString("utf8");

    if (text.trim() === "") {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new Error("request body is not valid JSON");
    }
}

function modelIds(): string[] {
    return listModels().map((model) => model.id);
}

async function handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    let body: any;

    try {
        body = await readJson(request);
    } catch (error) {
        sendError(response, 400, error instanceof Error ? error.message : "bad request");
        return;
    }

    const model = typeof body.model === "string" ? body.model : "";
    const streaming = body.stream === true;
    const includeUsage = body.stream_options?.include_usage === true || streaming;

    if (model === "" || !modelIds().includes(model)) {
        sendError(
            response,
            400,
            `Unknown model "${model}". Available: ${modelIds().join(", ")}`,
            "model_not_found",
        );
        return;
    }

    const { context, warnings } = toPiContext(body);
    const options = streamOptions(body);

    for (const warning of warnings) {
        log(`${model}: ${warning}`);
    }

    try {
        if (!fixtureEnabled()) {
            await currentApiKey();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "no credentials";
        log(`credentials failed: ${message}`);
        sendError(response, 502, `Antigravity credentials unavailable: ${message}`, "authentication_error");
        return;
    }

    const controller = new AbortController();
    request.on("close", () => controller.abort());

    let events: AsyncIterable<Record<string, any>>;

    try {
        events = await streamModel(model, context, { ...options, signal: controller.signal });
    } catch (error) {
        sendError(response, 400, error instanceof Error ? error.message : "stream failed");
        return;
    }

    if (!streaming) {
        let final: any;

        try {
            for await (const event of events) {
                if (event.type === "done") {
                    final = event.message;
                } else if (event.type === "error") {
                    throw new Error(event.error?.errorMessage ?? "Antigravity stream failed");
                }
            }
        } catch (error) {
            log(`${model}: ${error instanceof Error ? error.message : "failed"}`);
            sendError(response, 502, error instanceof Error ? error.message : "Antigravity failed", "upstream_error");
            return;
        }

        if (final === undefined) {
            sendError(response, 502, "Antigravity ended without a result", "upstream_error");
            return;
        }

        sendJson(response, 200, toCompletion(final, { model }));
        log(`${model}: 200 (no stream) in ${Date.now() - started}ms`);
        return;
    }

    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
    });

    let failed = false;

    try {
        for await (const frame of toOpenAiFrames(events, {
            id: `chatcmpl-${randomUUID()}`,
            model,
            includeUsage,
        })) {
            response.write(frame);
        }
    } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : "stream failed";
        log(`${model}: stream failed: ${message}`);
        response.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`);
        response.write("data: [DONE]\n\n");
    }

    response.end();
    log(`${model}: ${failed ? "stream error" : "200"} in ${Date.now() - started}ms`);
}

const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];

    if (request.method === "GET" && path === "/healthz") {
        sendJson(response, 200, {
            ok: true,
            provider: PROVIDER_ID,
            models: modelIds().length,
        });
        return;
    }

    if (request.method === "GET" && path === "/v1/models") {
        const created = Math.floor(Date.now() / 1000);

        sendJson(response, 200, {
            object: "list",
            data: listModels().map((model) => ({
                id: model.id,
                object: "model",
                created,
                owned_by: PROVIDER_ID,
            })),
        });
        return;
    }

    if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        void handleChat(request, response).catch((error: unknown) => {
            log(`request failed: ${error instanceof Error ? error.message : String(error)}`);

            if (!response.headersSent) {
                sendError(response, 500, "internal shim error", "internal_error");
            } else {
                response.end();
            }
        });
        return;
    }

    sendError(response, 404, `No such route: ${request.method} ${path}`, "not_found");
});

server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}/v1 (${modelIds().length} models)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        log(`${signal} received, closing`);
        server.close(() => process.exit(0));
    });
}
