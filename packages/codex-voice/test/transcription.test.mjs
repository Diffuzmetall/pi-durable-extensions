import assert from "node:assert/strict";
import { test } from "node:test";
import {
    AUDIO_BYTES,
    RESPONSE_BYTES,
    TEXT_POINTS,
    createCodexVoice,
    createCodexVoiceForTest,
    transcribe,
} from "../src/index.ts";

const token = `fixture.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
).toString("base64url")}.fixture`;
const clip = () => new Blob(["fixture"], { type: "audio/webm;codecs=opus" });
const reply = (text) => new Response(JSON.stringify({ text }), { headers: { "Content-Type": "application/json" } });
const signal = () => new AbortController().signal;
const models = () => ({
    checkAuth: async () => ({ type: "oauth" }),
    getAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }),
});

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test("construction validates only the explicit host seam", () => {
    let authCalls = 0;
    const host = {
        checkAuth: async () => {
            authCalls++;
            return { type: "oauth" };
        },
        getAuth: async () => {
            authCalls++;
            return { source: "OAuth", auth: { apiKey: token } };
        },
    };
    assert.equal(createCodexVoice({ models: host }).name, "codex-voice");
    assert.equal(authCalls, 0);
    assert.throws(() => createCodexVoice({}), /native Models/);
});

test("explicit test adapter seam routes only through its injected fetcher", async () => {
    let calls = 0;
    const adapter = createCodexVoiceForTest({ models: models() }, async (input) => {
        calls++;
        assert.equal(String(input), "https://chatgpt.com/backend-api/transcribe");
        return reply("test seam result");
    });
    assert.equal(await adapter.voice.transcribe(clip(), signal()), "test seam result");
    assert.equal(calls, 1);
});

test("one fixed subscription POST uses bounded multipart and no prompt", async () => {
    let calls = 0;
    const text = await transcribe(models(), clip(), signal(), async (input, init) => {
        calls++;
        assert.equal(String(input), "https://chatgpt.com/backend-api/transcribe");
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), `Bearer ${token}`);
        assert.equal(headers.get("chatgpt-account-id"), "fixture-account");
        assert.equal(headers.has("content-type"), false);
        const form = init.body;
        assert.equal(form.get("model"), "gpt-transcribe");
        assert.equal(form.has("prompt"), false);
        assert.equal(form.get("file").name, "recording.webm");
        return reply("fixture result");
    });
    assert.equal(text, "fixture result");
    assert.equal(calls, 1);
});

test("API-key, missing OAuth, malformed account and changed auth never fetch", async () => {
    for (const scenario of ["api_key", "missing", "account", "changed", "source"]) {
        const auth = models();
        let checks = 0;
        let calls = 0;
        if (scenario === "api_key") auth.checkAuth = async () => ({ type: "api_key" });
        if (scenario === "missing") auth.checkAuth = async () => undefined;
        if (scenario === "account") auth.getAuth = async () => ({ source: "OAuth", auth: { apiKey: "fixture.invalid.fixture" } });
        if (scenario === "source") auth.getAuth = async () => ({ source: "API_KEY", auth: { apiKey: token } });
        if (scenario === "changed") auth.checkAuth = async () => ({ type: ++checks === 1 ? "oauth" : "api_key" });
        await assert.rejects(
            transcribe(auth, clip(), signal(), async () => {
                calls++;
                return reply("");
            }),
            /OAuth/,
        );
        assert.equal(calls, 0);
    }
});

test("audio bounds reject before auth and malformed responses do not leak text", async () => {
    let authCalls = 0;
    const auth = models();
    auth.checkAuth = async () => {
        authCalls++;
        return { type: "oauth" };
    };
    for (const audio of [
        new Blob([], { type: "audio/webm" }),
        new Blob([new Uint8Array(AUDIO_BYTES + 1)], { type: "audio/webm" }),
        new Blob(["x"], { type: "audio/wav" }),
    ]) {
        await assert.rejects(transcribe(auth, audio, signal(), async () => reply("")));
    }
    assert.equal(authCalls, 0);

    for (const body of ["bad", "{}", JSON.stringify({ text: "x".repeat(TEXT_POINTS + 1) })]) {
        await assert.rejects(transcribe(models(), clip(), signal(), async () => new Response(body)), /failed/);
    }
});

test("cancellation releases voice admission while native refresh continues", async () => {
    const done = deferred();
    const started = deferred();
    const controller = new AbortController();
    let nativeSignal;
    let calls = 0;
    const auth = models();
    auth.getAuth = (_provider, options) => {
        nativeSignal = options.signal;
        started.resolve();
        return done.promise;
    };
    const work = transcribe(auth, clip(), controller.signal, async () => {
        calls++;
        return reply("");
    });
    await started.promise;
    controller.abort();
    await assert.rejects(work, /cancelled/);
    assert.notEqual(nativeSignal, controller.signal);
    assert.equal(nativeSignal.aborted, false);
    done.resolve({ source: "OAuth", auth: { apiKey: token } });
    await Promise.resolve();
    assert.equal(calls, 0);
});

test("streaming response cap cancels the reader and releases its lock", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(RESPONSE_BYTES + 1));
        },
        cancel() {
            cancelled = true;
        },
    }));
    await assert.rejects(transcribe(models(), clip(), signal(), async () => response), /failed/);
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
});

test("provider bodies and credentials never appear in errors, and requests are not retried", async () => {
    for (const status of [401, 403, 429, 500, 200]) {
        let calls = 0;
        const body = `<html>${token} fixture-account private-draft</html>`.repeat(1000);
        const result = transcribe(models(), clip(), signal(), async () => {
            calls++;
            return new Response(body, { status });
        });
        await assert.rejects(result, (error) => {
            assert.equal(error.message.includes(token), false);
            assert.equal(error.message.includes("fixture-account"), false);
            assert.equal(error.message.includes("private-draft"), false);
            assert.equal(error.message.includes("<html>"), false);
            return true;
        });
        assert.equal(calls, 1);
    }
});
