/**
 * Bridge to the installed npm:pi-antigravity extension: its login store, its model
 * catalog, and its Antigravity stream implementation, so the protocol lives in one
 * place (the Pi CLI extension) instead of being copied here.
 *
 * Loaded by run.mjs, whose loader hooks resolve the package's .ts sources.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The provider id this shim registers in Pi/Pi Pocket's models.json. Distinct from
 * the CLI's "antigravity" so no stored OAuth credential of that provider is used. */
export const PROVIDER_ID = "antigravity-shim";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PACKAGE_DIR =
    process.env.PI_ANTIGRAVITY_DIR ?? join(AGENT_DIR, "npm", "node_modules", "pi-antigravity");
const SRC = join(PACKAGE_DIR, "src");
const FIXTURE_URL =
    process.env.NODE_ENV === "test" ? process.env.ANTIGRAVITY_SHIM_FIXTURE_URL : undefined;

if (!existsSync(SRC)) {
    throw new Error(
        `pi-antigravity sources not found at ${SRC}. Install it (pi install npm:pi-antigravity) or set PI_ANTIGRAVITY_DIR.`,
    );
}

const [stream, auth, client, types, models] = await Promise.all([
    import(join(SRC, "stream/index.js")),
    import(join(SRC, "auth/index.js")),
    import(join(SRC, "client/index.js")),
    import(join(SRC, "types/types.js")),
    import(join(SRC, "models/models.js")),
]);

type StoredAccount = {
    access: string;
    refresh: string;
    expires: number;
    projectId?: string;
    email?: string;
};

export type ShimModel = {
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap?: Record<string, string | null>;
};

/** The models the installed extension offers, as Pi model definitions. */
export function listModels(): ShimModel[] {
    return (models.getCurrentAntigravityModels() as ShimModel[]).map((model) => ({ ...model }));
}

/** True only for a local deterministic fixture supplied by the candidate tests. */
export function fixtureEnabled(): boolean {
    return FIXTURE_URL !== undefined && FIXTURE_URL !== "";
}

/** Every catalog entry as a full Pi model, ready for the extension's stream. */
function modelFor(modelId: string) {
    const found = (models.getCurrentAntigravityModels() as Record<string, unknown>[]).find(
        (model) => model.id === modelId,
    );

    if (found === undefined) {
        return undefined;
    }

    return {
        ...found,
        provider: "antigravity",
        api: types.ANTIGRAVITY_API,
        baseUrl: client.DEFAULT_ENDPOINT,
    };
}

type CachedKey = { apiKey: string; account: string; expires: number };

let cached: CachedKey | undefined;

function accountsFile(): string {
    return join(AGENT_DIR, "antigravity-accounts.json");
}

function readAccounts(): { activeAccountId?: string; accounts: Record<string, StoredAccount> } {
    const path = accountsFile();

    if (!existsSync(path)) {
        throw new Error(`No Antigravity accounts at ${path}. Run \"/login antigravity\" in Pi.`);
    }

    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        activeAccountId?: string;
        accounts?: Record<string, StoredAccount>;
    };

    if (parsed.accounts === undefined || Object.keys(parsed.accounts).length === 0) {
        throw new Error(`No Antigravity account in ${path}. Run \"/login antigravity\" in Pi.`);
    }

    return { activeAccountId: parsed.activeAccountId, accounts: parsed.accounts };
}

function labelOf(account: StoredAccount): string {
    return account.email ?? "linked account";
}

/**
 * The apiKey string the extension's stream expects: its own JSON shape of
 * { token, projectId }. Refreshed in memory only — the CLI's own store is left alone.
 */
export async function currentApiKey(): Promise<CachedKey> {
    if (cached !== undefined && cached.expires > Date.now() + 60_000) {
        return cached;
    }

    const { activeAccountId, accounts } = readAccounts();
    const id = activeAccountId ?? Object.keys(accounts)[0]!;
    let account = accounts[id] ?? Object.values(accounts)[0]!;

    if (account.access === "" || account.expires <= Date.now() + 5 * 60_000) {
        account = { ...account, ...(await auth.refreshAntigravityToken(account)) };
    }

    const apiKey = auth.getApiKey({
        type: "oauth",
        access: account.access,
        refresh: account.refresh,
        expires: account.expires,
        projectId: account.projectId,
        email: account.email,
    });

    cached = {
        apiKey,
        account: labelOf(account),
        expires: account.expires > 0 ? account.expires : Date.now() + 5 * 60_000,
    };

    return cached;
}

export type StreamOptions = {
    reasoning?: string;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    toolChoice?: string;
};

async function* fixtureEvents(
    modelId: string,
    context: unknown,
    options: StreamOptions,
): AsyncIterable<Record<string, any>> {
    if (FIXTURE_URL === undefined || FIXTURE_URL === "") {
        throw new Error("fixture URL is not configured");
    }

    const parsed = new URL(FIXTURE_URL);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
        throw new Error("fixture URL must use loopback");
    }

    const response = await fetch(FIXTURE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, context, options }),
        signal: options.signal,
    });

    if (!response.ok) {
        throw new Error(`fixture upstream returned HTTP ${response.status}`);
    }

    const events = await response.json();
    if (!Array.isArray(events)) {
        throw new Error("fixture upstream returned a non-array event stream");
    }

    for (const event of events) {
        if (event === null || typeof event !== "object") {
            throw new Error("fixture upstream returned an invalid event");
        }
        yield event as Record<string, any>;
    }
}

/** Stream one completion from Antigravity. Throws when the model is unknown. */
export async function streamModel(
    modelId: string,
    context: unknown,
    options: StreamOptions = {},
): Promise<AsyncIterable<Record<string, any>>> {
    const model = modelFor(modelId);

    if (model === undefined) {
        throw new Error(
            `Antigravity model ${modelId} is not known. Available: ${listModels()
                .map((entry) => entry.id)
                .join(", ")}`,
        );
    }

    if (fixtureEnabled()) {
        return fixtureEvents(modelId, context, options);
    }

    const { apiKey } = await currentApiKey();

    return stream.streamAntigravity(model, context, {
        apiKey,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    }) as AsyncIterable<Record<string, any>>;
}
