import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import createCodexApi from "../src/index.ts";

// This example intentionally uses a scripted provider and an explicit policy.
// It does not resolve OAuth or call a real Codex subscription.
const faux = fauxProvider({ provider: "fixture", models: [{ id: "fixture" }] });
faux.setResponses([fauxAssistantMessage([fauxText("No live Codex call was made.")])]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(createCodexApi({ authorize: () => false }));
const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
console.log("Candidate registered without Pocket; enable a real host policy before offering Codex tools.", Boolean(harness));
await harness.close(BACKGROUND_CONTEXT);
