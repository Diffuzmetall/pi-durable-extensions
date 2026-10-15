import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import createCodemode, { installCodemode } from "../src/index.ts";

const echo = defineTool({
    name: "echo",
    description: "Echo text",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (args) => ({ output: [{ type: "text", text: `echo:${args.text}` }] }),
});
const registry = createRegistry();
registry.install(defineExtension({ name: "example-echo", tools: [echo] }));
installCodemode(registry);
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-1", contextWindow: 100_000 }] });
models.setProvider(faux.provider);
faux.setResponses([
    fauxAssistantMessage([
        fauxToolCall("codemode", { code: 'return await tools.echo({ text: "hello" });' }),
    ], { stopReason: "toolUse" }),
    turn => {
        const message = turn.messages.findLast(m => m.role === "toolResult");
        if (!message?.content?.some(p => p.type === "text" && p.text.includes("echo:hello"))) throw new Error("Nested output did not reach the model");
        return fauxAssistantMessage([fauxText("done")]);
    },
]);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
});
const settled = await (await root.submit({ type: "input", content: "Use codemode to echo hello." }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`Harness did not finish: ${settled.status}`);
}
const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT);
console.log(answer?.model?.[0]);
await harness.close(BACKGROUND_CONTEXT);
