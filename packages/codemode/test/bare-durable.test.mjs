import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const candidate = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const pocket = "/home/ubuntu/Projects/pi-pocket/src/";
let forbiddenAttempts = 0;
const loaded = new Set();
registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith("file:") && fileURLToPath(specifier).startsWith(pocket)) {
            forbiddenAttempts++;
            throw new Error(`FORBIDDEN_POCKET_SRC: ${specifier}`);
        }
        const result = nextResolve(specifier, context);
        if (result.url.startsWith("file:") && fileURLToPath(result.url).startsWith(pocket)) {
            forbiddenAttempts++;
            throw new Error(`FORBIDDEN_POCKET_SRC: ${result.url}`);
        }
        return result;
    },
    load(url, context, nextLoad) {
        if (url.startsWith("file:") && fileURLToPath(url).startsWith(pocket)) {
            forbiddenAttempts++;
            throw new Error(`FORBIDDEN_POCKET_SRC: ${url}`);
        }
        loaded.add(url);
        return nextLoad(url, context);
    },
});

await assert.rejects(
    import(`file://${pocket}__codemode_guard_probe__.ts`),
    /FORBIDDEN_POCKET_SRC/,
);
assert.equal(forbiddenAttempts, 1);
console.log("GUARD positive control: rejected Pocket source import");

const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
const { Type } = await import("@earendil-works/pi-ai");
const { createModels } = await import("@earendil-works/pi-ai/models");
const { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
const { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage, ToolTask } = await import("@earendil-works/pi-durable");
const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
const { default: createCodemode, installCodemode, CodemodeStoreDoc } = await import(candidate);

const echo = defineTool({
    name: "echo",
    description: "Echo text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({ output: [{ type: "text", text: `echo:${args.text}` }] }),
});
const policy = defineExtension({
    name: "policy",
    hooks: [{
        task: "tool",
        handlers: {
            beforeTool: async (call) => call.name === "echo" && call.arguments.text === "blocked" ? { block: "blocked by policy" } : undefined,
        },
    }],
});

await test("real Harness invokes codemode without Pocket imports", async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "echo", tools: [echo] }));
    registry.install(policy);
    installCodemode(registry);
    const models = createModels();
    const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000 }] });
    models.setProvider(faux.provider);
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: 'store("seen", true); return await tools.echo({ text: "hello" });' })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
    ]);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    try {
        const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
        const settled = await (await root.submit({ type: "input", content: "Use codemode." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
        assert.equal(settled.status, "done");
        assert.equal(settled.type, "input");
        const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
        assert.match(JSON.stringify(answer), /done/);
        const snapshot = await root.commit(
            async (tx) => {
                const doc = await tx.doc(CodemodeStoreDoc, root.id);
                return { values: { ...doc.values } };
            },
            BACKGROUND_CONTEXT,
        );
        assert.deepEqual(snapshot.values, { seen: true });
    } finally {
        await harness.close(BACKGROUND_CONTEXT);
    }
});

await test("Pi 1.2 native nested calls preserve structured values, guards and model-visible output", async () => {
    const { CodingTools } = await import("@earendil-works/pi-durable/tools");
    const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(defineExtension({ name: "native-fixtures", tools: [
        defineTool({ name: "typed", parameters: Type.Object({}), structuredOutputSchema: Type.Object({ value: Type.Number() }),
            execute: async () => ({ output: [{ type: "text", text: "human text" }], structuredOutput: { value: 42 } }) }),
        defineTool({ name: "model_only", callers: ["model"], parameters: Type.Object({}),
            execute: async () => { throw new Error("model-only tool must not execute"); } }),
    ], hooks: [{ task: ToolTask.definition.name, handlers: {
        beforeTool: async (call) => call.name === "bash" && call.arguments.command === "blocked" ? { block: "fixture-policy" } : undefined,
    } }] }));
    installCodemode(registry);
    const models = createModels();
    const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000 }] });
    models.setProvider(faux.provider);
    const env = new NodeExecutionEnv({ cwd: process.cwd() });
    let observed = false;
    faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: 'const x = await tools.typed({}); const b = await tools.bash({command:"printf NATIVE_CM_OK"}); const blocked = await tools.bash({command:"blocked"}).catch(e=>e.message); text("CM_TEXT_OK"); console.log("CM_CONSOLE_OK"); return {value:x.value,bash:b.output,blocked,modelOnly:ALL_TOOLS.some(t=>t.name === "model_only")};' })], { stopReason: "toolUse" }),
        turn => {
            const result = turn.messages.findLast(m => m.role === "toolResult");
            assert.equal(result.isError ?? false, false);
            const text = result.content.filter(p => p.type === "text").map(p => p.text).join("\n");
            for (const marker of ["CM_TEXT_OK", "CM_CONSOLE_OK", '"value":42', "NATIVE_CM_OK", "fixture-policy", '"modelOnly":false']) assert.ok(text.includes(marker), text);
            observed = true;
            return fauxAssistantMessage([fauxText("verified")]);
        },
    ]);
    const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, BACKGROUND_CONTEXT);
    try {
        const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
        const settled = await (await root.submit({ type: "input", content: "Verify native nested calls" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
        assert.equal(settled.status, "done", JSON.stringify(await root.entries({}, 20, undefined, BACKGROUND_CONTEXT)));
        assert.ok(observed);
    } finally { await harness.close(BACKGROUND_CONTEXT); await env.cleanup(BACKGROUND_CONTEXT); }
});

await test("unsafe replay and arbitrary collision rejection are explicit", async () => {
    const extension = createCodemode({ toolName: "durable_codemode", extensionName: "portable-codemode" });
    assert.equal(extension.tools?.[0]?.replay, "unsafe");
    const registry = createRegistry();
    const taken = defineTool({
        name: "codemode",
        description: "Taken tool",
        parameters: Type.Object({}),
        execute: async () => ({ output: [{ type: "text", text: "taken" }] }),
    });
    registry.install(defineExtension({ name: "taken", tools: [taken] }));
    assert.throws(() => installCodemode(registry), /already registered: codemode/);
    assert.throws(() => createCodemode({ toolName: "echo", reservedToolNames: ["echo"] }), /already registered: echo/);
});

function fakeApi(tools, extensions = []) {
    const store = { values: {} };
    const codemode = createCodemode().tools[0];
    return {
        store,
        api: {
            taskId: 1,
            conversationId: 42,
            callId: "codemode-test",
            env: undefined,
            registry: { installed: () => [], tools: () => [], sections: () => [], tasks: () => [] },
            models: {},
            agent: async () => ({ tools: [...tools, codemode], extensions, sections: [], thinkingLevel: "off" }),
            output: () => {},
            diagnostic: () => {},
            details: async () => {},
            snapshot: async (doc) => doc === CodemodeStoreDoc ? store : undefined,
            commit: async (change) => change({ doc: async () => store }),
        },
    };
}

const textOf = (result) => (result.output ?? []).filter((part) => part.type === "text").map((part) => part.text).join("");

await test("validation, hooks, nested memo scopes, failure atomicity, and private spill survive", async () => {
    const shell = defineTool({ name: "bash", parameters: Type.Object({ command: Type.String() }), outputLimits: { retain: "tail" },
        execute: async (args, api) => { api.output(`ran ${args.command}`); return args.command === "fail" ? { isError: true } : {}; } });
    const slow = defineTool({ name: "slow", parameters: Type.Object({}), execute: async (_args, _api, context) => new Promise((resolve, reject) => {
        context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "fixtures", tools: [shell, slow], hooks: [{ task: ToolTask.definition.name, handlers: {
        beforeTool: async (call, api, context) => {
            assert.equal(await api.memo("seen", call.id, context), call.id);
            if (call.arguments.command === "block") return { block: "no" };
            if (call.arguments.command === "rewrite") return { arguments: { command: "rewritten" } };
        },
    } }] }));
    installCodemode(registry);
    const models = createModels(); const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000 }] });
    models.setProvider(faux.provider);
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
    try {
        const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
        const run = async code => {
            let result;
            faux.setResponses([fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }), turn => {
                const message = turn.messages.findLast(m => m.role === "toolResult");
                result = { output: message.content, details: message.details, isError: message.isError ?? false };
                return fauxAssistantMessage([fauxText("done")]);
            }]);
            assert.equal((await (await root.submit({ type: "input", content: "probe" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
            assert.ok(result); return result;
        };
        const result = await run(`const outcomes = await Promise.allSettled([tools.bash({ command: "block" }), tools.bash({ command: "rewrite" }), tools.bash({ nope: 1 })]); return outcomes.map(x => x.status === "fulfilled" ? x.value : "ERR " + x.reason.message);`);
        const values = JSON.parse(textOf(result).split("Output:\n")[1]);
        assert.equal(values[0], "ERR Tool call blocked: no"); assert.equal(values[1], "ran rewritten"); assert.match(values[2], /valid|argument/i);
        await run(`store("ok", 1);`);
        const failed = await run(`store("ok", 99); text("partial"); throw new Error("boom");`);
        assert.equal(failed.isError, true); assert.match(textOf(failed), /partial|boom/);
        const stored = await root.commit(async tx => ({ ...(await tx.doc(CodemodeStoreDoc, root.id)).values }), BACKGROUND_CONTEXT);
        assert.deepEqual(stored, { ok: 1 });
        const spill = await run(`// @options: {"max_output_tokens": 2}\ntext("A".repeat(30));`);
        const path = spill.details.fullOutputPath; assert.ok(path);
        assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal((await stat(path.slice(0, path.lastIndexOf("/")))).mode & 0o777, 0o700);
        const cancelled = await run(`// @options: {"timeout_ms": 20}\nawait tools.slow({});`);
        assert.equal(cancelled.isError, true); assert.match(textOf(cancelled), /timed out|aborted|cancelled/i);
    } finally { await harness.close(BACKGROUND_CONTEXT); }
});

await test("image output preserves normal images and bounds cumulative count/decoded bytes", async () => {
    const fake = fakeApi([]);
    const codemode = fake.api.agent && (await fake.api.agent()).tools.at(-1);
    const run = (code) => codemode.execute({ code }, fake.api, BACKGROUND_CONTEXT);
    const normal = await run('text("tinytext"); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" });');
    assert.deepEqual(normal.output.filter((part) => part.type === "image"), [
        { type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" },
    ]);
    assert.match(textOf(normal), /tinytext/);

    const oversizeimage = await run('// @options: {"max_output_tokens": 32}\ntext("tinytext"); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" }); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" }); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" }); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" });');
    assert.equal(oversizeimage.output.filter((part) => part.type === "image").length, 2);
    assert.match(textOf(oversizeimage), /Warning: 2 image output/);
    assert.match(textOf(oversizeimage), /byte budget/);

    const nearBoundary = await run('// @options: {"max_output_tokens": 20}\ntext("tinytext"); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" }); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" }); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" });');
    const returnedText = nearBoundary.output.slice(1).filter((part) => part.type === "text").map((part) => part.text).join("\\n");
    const acceptedImageBytes = nearBoundary.output.filter((part) => part.type === "image").reduce((total, part) => total + Buffer.from(part.data, "base64").byteLength, 0);
    assert.ok(Buffer.byteLength(returnedText, "utf8") + acceptedImageBytes <= 80);
    assert.match(returnedText, /Warning: 3 image output/);

    const malformed = await run('image({ type: "image", data: "not-base64", mimeType: "image/png" });');
    assert.equal(malformed.output.filter((part) => part.type === "image").length, 0);
    assert.equal(malformed.isError, true);
    assert.match(textOf(malformed), /invalid image output|malformed base64/);

    const noncanonicalPadding = await run('image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOx==", mimeType: "image/gif" });');
    assert.equal(noncanonicalPadding.output.filter((part) => part.type === "image").length, 0);
    assert.match(textOf(noncanonicalPadding), /malformed base64/);

    const nonAscii = await run('// @options: {"max_output_tokens": 9}\ntext("€"); image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" });');
    assert.equal(nonAscii.output.filter((part) => part.type === "image").length, 0);
    assert.match(textOf(nonAscii), /Warning: 1 ima/);
    assert.ok(nonAscii.details.fullOutputPath);
    assert.match(await readFile(nonAscii.details.fullOutputPath, "utf8"), /byte budget/);

    const countLimited = await run(`${Array.from({ length: 101 }, () => 'image({ type: "image", data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", mimeType: "image/gif" });').join("\n")}`);
    assert.equal(countLimited.output.filter((part) => part.type === "image").length, 100);
    assert.match(textOf(countLimited), /count cap/);
});

await test("retained SQLite reopens the package-owned store", async () => {
    const rootDir = fileURLToPath(new URL("../test-artifacts/", import.meta.url));
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const dbPath = `${rootDir}restart-${Date.now()}.sqlite`;
    const createHarness = async (code) => {
        const registry = createRegistry();
        registry.install(defineExtension({ name: "echo", tools: [echo] }));
        installCodemode(registry);
        const models = createModels();
        const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000 }] });
        models.setProvider(faux.provider);
        faux.setResponses([
            fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
            fauxAssistantMessage([fauxText("done")]),
        ]);
        const storage = await openNodeSqliteStorage(dbPath);
        return { harness: await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT) };
    };
    const first = await createHarness('store("restart", "persisted");');
    const conversation = await first.harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    assert.equal((await (await conversation.submit({ type: "input", content: "write" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT)).status, "done");
    await first.harness.close(BACKGROUND_CONTEXT);
    const second = await createHarness('return load("restart");');
    const reopened = await second.harness.root(BACKGROUND_CONTEXT);
    const settled = await (await reopened.submit({ type: "input", content: "read" }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
    assert.equal(settled.status, "done");
    const entries = await reopened.entries({ order: "descending" }, 10, undefined, BACKGROUND_CONTEXT);
    assert.match(JSON.stringify(entries.items), /persisted/);
    await second.harness.close(BACKGROUND_CONTEXT);
    console.log(JSON.stringify({ restartDb: dbPath, retained: true }));
});

await test("source is unchanged and no Pocket source was loaded", async () => {
    const hash = createHash("sha256").update(await readFile(candidate)).digest("hex");
    assert.equal(hash.length, 64);
    const pocketLoads = [...loaded].filter((url) => url.startsWith("file:") && fileURLToPath(url).startsWith(pocket));
    assert.deepEqual(pocketLoads, []);
    assert.equal(forbiddenAttempts, 1);
    console.log(JSON.stringify({ candidate, sourceHash: hash, loadedModules: loaded.size, pocketLoads: 0, forbiddenAttempts }));
});
