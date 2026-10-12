import { readFile, realpath, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const MAX_PROFILE_BYTES = 64 * 1024;
function invalid(message) {
    throw new Error(`Invalid profile${message === "" ? "" : `: ${message}`}`);
}
function nonEmptyString(value, field) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || !value.trim()) {
        invalid(`${field} must be a nonempty string.`);
    }
    return value;
}
function parseTools(value) {
    if (value === undefined) {
        return undefined;
    }
    const tools = typeof value === "string"
        ? value.split(",").map((tool) => tool.trim())
        : Array.isArray(value)
            ? value
            : undefined;
    if (tools === undefined ||
        tools.some((tool) => typeof tool !== "string" || !tool.trim()) ||
        new Set(tools).size !== tools.length) {
        invalid("tools must be a unique string list or comma-separated names.");
    }
    return tools;
}
/** Parse one profile without reading the filesystem or starting a launcher. */
export function parseProfile(text, options = {}) {
    if (Buffer.byteLength(text, "utf8") > MAX_PROFILE_BYTES) {
        invalid(`exceeds ${MAX_PROFILE_BYTES} bytes.`);
    }
    const name = options.name;
    if (name !== undefined && !PROFILE_NAME.test(name)) {
        invalid("name must be a lowercase kebab-case filename, not a path.");
    }
    let settings = {};
    let prompt = text;
    if (/^---\r?\n/.test(text)) {
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
        if (!match) {
            invalid("unclosed YAML frontmatter.");
        }
        const document = parseDocument(match[1], { uniqueKeys: true });
        if (document.errors.length > 0) {
            invalid(`YAML: ${document.errors[0].message}`);
        }
        let value;
        try {
            value = document.toJS({ maxAliasCount: 0 });
        }
        catch (error) {
            invalid(`YAML: ${error.message}`);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            invalid("frontmatter must be a mapping.");
        }
        settings = value;
        prompt = match[2];
    }
    for (const key of Object.keys(settings)) {
        if (!["name", "description", "model", "thinking", "tools"].includes(key)) {
            invalid(`unknown frontmatter field: ${key}`);
        }
    }
    if (name !== undefined && settings.name !== undefined && settings.name !== name) {
        invalid("frontmatter name must match its filename.");
    }
    const description = nonEmptyString(settings.description, "description");
    const model = nonEmptyString(settings.model, "model");
    const thinking = settings.thinking;
    if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) {
        invalid("thinking is not a supported level.");
    }
    const tools = parseTools(settings.tools);
    if (!prompt.trim()) {
        invalid("instructions must not be empty.");
    }
    return {
        name: name ?? settings.name ?? "unnamed",
        ...(options.path === undefined ? {} : { path: options.path }),
        prompt: prompt.trim(),
        ...(description === undefined ? {} : { description }),
        ...(model === undefined ? {} : { model }),
        ...(thinking === undefined ? {} : { thinking: thinking }),
        ...(tools === undefined ? {} : { tools }),
    };
}
/** Read one owner-managed profile file under `directory` with traversal and symlink checks. */
export async function loadProfile(directory, name) {
    if (!PROFILE_NAME.test(name)) {
        throw new Error("Invalid profile: name must be a lowercase kebab-case name, not a path.");
    }
    const base = await realpath(resolve(directory));
    const path = await realpath(join(base, `${name}.md`));
    if (dirname(path) !== base) {
        throw new Error("Invalid profile: symlink must stay inside the profiles directory.");
    }
    const info = await stat(path);
    if (!info.isFile()) {
        throw new Error("Invalid profile: file must be regular.");
    }
    if (info.size > MAX_PROFILE_BYTES) {
        throw new Error(`Invalid profile: exceeds ${MAX_PROFILE_BYTES} bytes.`);
    }
    const text = await readFile(path, "utf8");
    return parseProfile(text, { name, path });
}
/** Return direct Markdown entries, preserving per-file validation errors for the catalog. */
export async function listProfileFiles(directory) {
    const base = await realpath(resolve(directory));
    const entries = await readdir(base, { withFileTypes: true });
    return entries
        .filter((entry) => entry.name.endsWith(".md"))
        .map((entry) => entry.name.slice(0, -3))
        .sort();
}
