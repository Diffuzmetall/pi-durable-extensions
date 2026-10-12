/**
 * The models.json provider block for this shim, on stdout, or merged into
 * ~/.pi/agent/models.json with --write (backing the file up first).
 *
 * Model metadata comes from the installed pi-antigravity catalog, so the offered
 * models stay in step with the extension. Cost is zero: Antigravity is quota-backed,
 * not metered per token.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

register("../hooks.mjs", import.meta.url);

const { PROVIDER_ID, listModels } = await import("../src/antigravity.ts");

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const modelsPath = join(agentDir, "models.json");
const port = process.env.ANTIGRAVITY_SHIM_PORT ?? "18790";

const provider = {
    name: "Antigravity (local shim)",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    api: "openai-completions",
    // The shim holds the Antigravity credentials itself; this only marks the provider as signed in.
    apiKey: "local-shim",
    compat: {
        supportsStore: false,
        supportsDeveloperRole: true,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        supportsFinishReason: true,
        maxTokensField: "max_tokens",
        requiresToolResultName: true,
        thinkingFormat: "openai",
    },
    models: listModels().map((model) => ({
        id: model.id,
        name: `${model.name} (Antigravity shim)`,
        reasoning: model.reasoning,
        input: model.input,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
};

const block = { providers: { [PROVIDER_ID]: provider } };

if (!process.argv.includes("--write")) {
    console.log(JSON.stringify(block, null, 2));
    process.exit(0);
}

if (!existsSync(modelsPath)) {
    throw new Error(`No models.json at ${modelsPath}`);
}

const original = readFileSync(modelsPath, "utf8");
const config = JSON.parse(original);
const backup = `${modelsPath}.bak-antigravity-shim-${new Date().toISOString().replace(/[:.]/g, "")}`;

config.providers = { ...(config.providers ?? {}), [PROVIDER_ID]: provider };
copyFileSync(modelsPath, backup);
writeFileSync(modelsPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`updated ${modelsPath} (${provider.models.length} models), backup at ${backup}`);
