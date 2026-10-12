import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    Type,
    createModels,
    fauxAssistantMessage,
    fauxProvider,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import {
    Harness,
    MemoryStorage,
    createRegistry,
    defineExtension,
    defineTool,
} from "@earendil-works/pi-durable";
import { createCodexVoiceForTest } from "../src/index.ts";

const token = `fixture.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
).toString("base64url")}.fixture`;

function fixtureModels() {
    return {
        checkAuth: async () => ({ type: "oauth" }),
        getAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }),
    };
}

function fixtureFetcher(input, init) {
    if (String(input) !== "https://chatgpt.com/backend-api/transcribe") {
        throw new Error("unexpected URL");
    }

    if (init?.method !== "POST" || !(init.body instanceof FormData)) {
        throw new Error("unexpected request shape");
    }

    return Promise.resolve(new Response(JSON.stringify({ text: "fixture transcript" }), {
        headers: { "Content-Type": "application/json" },
    }));
}

/** Invoke the candidate through a real in-memory Pi Durable Harness with only deterministic fixtures. */
export async function runHarnessProbe() {
    let invocations = 0;
    let fixtureCalls = 0;
    let globalFetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        globalFetchCalls++;
        throw new Error("GLOBAL_FETCH_FORBIDDEN_IN_FIXTURE_HARNESS");
    };
    let harness;
    try {
        const fixtureFetch = (input, init) => {
            fixtureCalls++;
            return fixtureFetcher(input, init);
        };
    const adapter = createCodexVoiceForTest({ models: fixtureModels() }, fixtureFetch);
    const probe = defineTool({
        name: "codex_voice_probe",
        description: "Invoke the deterministic codex-voice fixture.",
        parameters: Type.Object({}),
        replay: "unsafe",
        execute: async (_args, _api, context) => {
            invocations++;
            const signal = context.abortSignal ?? new AbortController().signal;
            const text = await adapter.voice.transcribe(
                new Blob(["fixture audio"], { type: "audio/webm;codecs=opus" }),
                signal,
            );
            return { content: [{ type: "text", text }] };
        },
    });

    const registry = createRegistry();
    registry.install(defineExtension({ name: "codex-voice-harness-fixture", tools: [probe] }));

    const faux = fauxProvider({ provider: "fixture-provider", models: [{ id: "fixture-model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall("codex_voice_probe", {}, { id: "fixture-call" }), { stopReason: "toolUse" }),
        fauxAssistantMessage("fixture harness complete"),
    ]);

        harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
        const root = await harness.root(BACKGROUND_CONTEXT, {
            agent: {
                model: { provider: faux.provider.id, modelId: "fixture-model" },
            },
        });
        const submission = await root.submit({ type: "input", content: "invoke fixture" }, BACKGROUND_CONTEXT);
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status !== "done") {
            throw new Error(`fixture harness did not settle: ${settled.status}`);
        }
        const entries = await root.entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
        if (fixtureCalls !== 1 || globalFetchCalls !== 0) {
            throw new Error(`fixture routing failure: fixture=${fixtureCalls}, global=${globalFetchCalls}`);
        }
        return {
            settled: settled.status,
            invocations,
            fixtureCalls,
            globalFetchCalls,
            response: "fixture harness complete",
            kinds: entries.items.map((entry) => entry.kind),
        };
    } finally {
        if (harness) {
            await harness.close(BACKGROUND_CONTEXT);
        }
        globalThis.fetch = realFetch;
    }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(JSON.stringify(await runHarnessProbe()));
}
