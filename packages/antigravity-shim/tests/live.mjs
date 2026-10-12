/**
 * Live end-to-end check of the shim: starts it on a scratch port, then drives the real
 * Antigravity channel through its OpenAI endpoint. Uses one linked account and a few
 * tokens; run it by hand when the credentials or the package change.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.LIVE_PORT ?? 18799);
const base = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ["run.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ANTIGRAVITY_SHIM_PORT: String(PORT) },
    stdio: ["ignore", "inherit", "inherit"],
});

let failed = false;

function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
    if (!ok) failed = true;
}

async function waitForHealth() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const response = await fetch(`${base}/healthz`);

            if (response.ok) return await response.json();
        } catch {
            // not up yet
        }

        await sleep(250);
    }

    throw new Error("shim did not start");
}

async function frames(body) {
    const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const text = await response.text();

    return text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice(6))
        .filter((payload) => payload !== "[DONE]")
        .map((payload) => JSON.parse(payload));
}

try {
    const health = await waitForHealth();
    check("shim answers /healthz", health.ok === true, `${health.models} models`);

    const models = await (await fetch(`${base}/v1/models`)).json();
    check("model list is not empty", Array.isArray(models.data) && models.data.length > 0, `${models.data.length} models`);

    const chunks = await frames({
        model: "gemini-3.8-flash",
        stream: true,
        stream_options: { include_usage: true },
        messages: [
            { role: "system", content: "Answer with the literal word requested and nothing else." },
            { role: "user", content: "Reply with exactly: OK" },
        ],
    });
    const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("");
    check("streamed text arrives", text.trim() !== "", JSON.stringify(text.slice(0, 60)));
    check("usage is reported", chunks.some((chunk) => chunk.usage !== undefined), JSON.stringify(chunks.find((c) => c.usage)?.usage ?? {}));
    check("stream ends with a finish reason", chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop"));

    const toolChunks = await frames({
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "What time is it in UTC? Call the clock tool." }],
        tools: [
            {
                type: "function",
                function: {
                    name: "clock",
                    description: "The current time in a time zone.",
                    parameters: {
                        type: "object",
                        properties: { zone: { type: "string", description: "IANA zone" } },
                        required: ["zone"],
                    },
                },
            },
        ],
    });
    const calls = toolChunks.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []);
    const args = calls.map((call) => call.function?.arguments ?? "").join("");
    check("a tool call comes back", calls.length > 0 && calls[0].id !== undefined, `${calls.length} call chunks`);
    check("tool call arguments parse as JSON", (() => {
        try {
            const parsed = JSON.parse(args);
            return typeof parsed === "object" && parsed.zone !== undefined;
        } catch {
            return false;
        }
    })(), args.slice(0, 80));
    check("finish reason is tool_calls", toolChunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "tool_calls"));

    const oneShot = await (await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: "gemini-3.8-flash",
            messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }),
    })).json();
    check("a non-streaming answer comes back", typeof oneShot.choices?.[0]?.message?.content === "string", JSON.stringify(oneShot.choices?.[0]?.message?.content ?? null));
    check("the non-streaming answer reports usage", oneShot.usage?.prompt_tokens > 0, JSON.stringify(oneShot.usage));

    const rejected = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] }),
    });
    check("an unknown model is refused", rejected.status === 400, `HTTP ${rejected.status}`);
} catch (error) {
    check("live check ran", false, error instanceof Error ? error.message : String(error));
} finally {
    child.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);
