/** Native Codex image generation and editing, with bounded PNG output and exclusive saves. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { constants } from "node:fs";
import { open, mkdir, realpath, lstat, link } from "node:fs/promises";
import { resolve, relative, basename, dirname, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { inflate, crc32 } from "node:zlib";
import { promisify } from "node:util";
import { makeRuntime, type Host, type CodexRuntime } from "./runtime.ts";

const MAX_BYTES = 20 * 1024 * 1024;
const models = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
const qualities = ["auto", "low", "medium", "high"] as const;
const parameters = Type.Object({
    prompt: Type.String({ minLength: 1, maxLength: 32000 }),
    referenced_paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 5 })),
    num_last_images_to_include: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    size: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    quality: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
    image_model: Type.Optional(Type.Union([Type.Literal("gpt-image-2"), Type.Literal("gpt-image-2.5-flare"), Type.Literal("gpt-image-2.5-sunburst")])),
    output_path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
}, { additionalProperties: false });

type Args = { prompt: string; referenced_paths?: string[]; num_last_images_to_include?: number; size?: string; quality?: string; image_model?: string; output_path?: string };

export function normalizeCodexImageSize(value = "auto") {
    const size = value.trim().toLowerCase();
    if (size === "auto") { return size; }
    const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(size);
    if (!match) { throw new Error("Image size must be auto or WIDTHxHEIGHT."); }
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w % 16 || h % 16 || w > 3840 || h > 3840 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400) {
        throw new Error("Image edges must be divisible by 16, <=3840; aspect 1:3..3:1; area 655360..8294400.");
    }
    return `${w}x${h}`;
}

export async function decodePng(data: unknown): Promise<Buffer> {
    if (typeof data !== "string" || !data.length || data.length > Math.ceil(MAX_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new Error("Image response has missing, oversized or invalid base64 PNG data.");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > MAX_BYTES || bytes.toString("base64") !== data || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        throw new Error("Image response is not a bounded canonical PNG.");
    }
    let offset = 8;
    let header: Buffer | undefined;
    let ended = false;
    let palette = false;
    let chunks = 0;
    let idatEnded = false;
    const compressed: Buffer[] = [];
    while (offset < bytes.length) {
        if (++chunks > 4096) { throw new Error("PNG has too many chunks."); }
        if (offset + 12 > bytes.length) { throw new Error("Truncated PNG chunk."); }
        const length = bytes.readUInt32BE(offset);
        const end = offset + 12 + length;
        if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) { throw new Error("Invalid PNG chunk or checksum."); }
        const kind = bytes.toString("ascii", offset + 4, offset + 8);
        const payload = bytes.subarray(offset + 8, end - 4);
        if (!header && kind !== "IHDR") { throw new Error("Missing PNG header."); }
        if (kind === "IHDR") {
            if (header || length !== 13) { throw new Error("Invalid PNG header."); }
            header = payload;
        } else if (kind === "PLTE") {
            if (palette || compressed.length || !length || length % 3 || length > 768) { throw new Error("Invalid PNG palette."); }
            palette = true;
        } else if (kind === "IDAT") {
            if (idatEnded) { throw new Error("Noncontiguous PNG pixel chunks."); }
            compressed.push(payload);
        } else if (kind === "IEND") {
            if (length || end !== bytes.length) { throw new Error("Invalid PNG ending."); }
            ended = true;
        } else if (!/^[a-z][A-Za-z]{3}$/.test(kind)) { throw new Error("Unsupported critical PNG chunk."); }
        if (compressed.length && kind !== "IDAT") { idatEnded = true; }
        offset = end;
    }
    if (!header || !ended || !compressed.length) { throw new Error("Incomplete PNG."); }
    const w = header.readUInt32BE(0);
    const h = header.readUInt32BE(4);
    const depth = header[8];
    const color = header[9];
    if (color === 3) { throw new Error("Indexed PNG output is unsupported; request RGB or RGBA PNG output instead. No image was saved; do not automatically retry generation."); }
    const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[color];
    const validDepth = color === 0 ? [1,2,4,8,16] : [8,16];
    if (!w || !h || w > 3840 || h > 3840 || w * h > 8294400 || !channels || !validDepth.includes(depth) || header[10] || header[11] || header[12] > 1) { throw new Error("Unsupported or oversized PNG header."); }
    const passes = header[12] ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
    const rows = passes.map(([x,y,dx,dy]) => ({ width: Math.max(0, Math.ceil((w-x)/dx)), height: Math.max(0, Math.ceil((h-y)/dy)) })).filter((p) => p.width && p.height);
    const expected = rows.reduce((n,p) => n + (1 + Math.ceil(p.width * channels * depth / 8)) * p.height, 0);
    let raw: Buffer;
    try { raw = await promisify(inflate)(Buffer.concat(compressed), { maxOutputLength: expected + 1 }); }
    catch { throw new Error("Invalid PNG compressed pixels."); }
    if (raw.length !== expected) { throw new Error("Invalid PNG pixel length."); }
    let pos = 0;
    for (const p of rows) {
        const stride = 1 + Math.ceil(p.width * channels * depth / 8);
        for (let row = 0; row < p.height; row++) {
            if (raw[pos] > 4) { throw new Error("Invalid PNG row filter."); }
            pos += stride;
        }
    }
    return bytes;
}

export async function preflightOutput(cwd: string, requested?: string) {
    const root = await realpath(cwd);
    let target = resolve(root, requested ?? `output/codex-images/${randomUUID()}.png`);
    if (extname(target).toLowerCase() !== ".png") { target += ".png"; }
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) { throw new Error("Output path must stay inside the workspace."); }
    let current = root;
    for (const part of rel.split(sep)) {
        current = resolve(current, part);
        try {
            const info = await lstat(current);
            if (info.isSymbolicLink()) { throw new Error("Output paths must not contain symlinks."); }
            if (current === target) { throw new Error("Refusing to overwrite existing image."); }
            if (!info.isDirectory()) { throw new Error("Output parent is not a directory."); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
    }
    return target;
}

function abort(signal: AbortSignal) {
    if (signal.aborted) { throw new Error("Image call cancelled; remote outcome may be unknown. Do not automatically retry."); }
}

// Linux directory descriptors pin parents and reject symlink traversal.
// The final realpath check cannot guarantee containment against concurrent directory renames.
// Retained pending hardlinks share the published inode; they are not independent backups.
// No deletion is authorized, even on failure.
export async function savePng(cwd: string, requested: string | undefined, bytes: Buffer, signal: AbortSignal) {
    abort(signal);
    const root = await realpath(cwd);
    let target = resolve(root, requested ?? `output/codex-images/${randomUUID()}.png`);
    if (extname(target).toLowerCase() !== ".png") { target += ".png"; }
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) { throw new Error("Output path must stay inside the workspace."); }
    const handles = [await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
    try {
        for (const part of relative(root, dirname(target)).split(sep).filter(Boolean)) {
            abort(signal);
            const path = `/proc/self/fd/${handles.at(-1)!.fd}/${part}`;
            try { await mkdir(path, { mode: 0o700 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") { throw error; } }
            handles.push(await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
        }
        const parent = `/proc/self/fd/${handles.at(-1)!.fd}`;
        const destination = `${parent}/${basename(target)}`;
        try { await lstat(destination); throw new Error("Refusing to overwrite existing image."); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { throw error; } }
        abort(signal);
        const pending = `${parent}/.codex-pending-${randomUUID()}`;
        const file = await open(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try { await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
        abort(signal);
        // link publishes the complete inode atomically and fails if destination exists.
        const pinnedParent = await realpath(parent);
        const pinnedRelative = relative(root, pinnedParent);
        if (pinnedRelative === ".." || pinnedRelative.startsWith(`..${sep}`) || pinnedRelative.startsWith(sep)) { throw new Error("Output directory moved outside workspace."); }
        await link(pending, destination);
        await handles.at(-1)!.sync();
        abort(signal);
        return target;
    } catch {
        throw new Error("PNG save failed or cancelled; no existing asset was overwritten. Remote generation may have completed; do not automatically retry. Pending files are retained.");
    } finally {
        for (const handle of handles.reverse()) { await handle.close(); }
    }
}

export async function executeImage(runtime: CodexRuntime, args: Args) {
    if (!args.prompt?.trim() || args.prompt.length > 32000 || !models.includes((args.image_model ?? "gpt-image-2") as typeof models[number]) || !qualities.includes((args.quality ?? "auto") as typeof qualities[number])) { throw new Error("Invalid image prompt, model or quality."); }
    if (args.referenced_paths !== undefined && (args.num_last_images_to_include !== undefined || !Array.isArray(args.referenced_paths) || !args.referenced_paths.length || args.referenced_paths.length > 5)) { throw new Error("Use 1..5 referenced_paths OR recent images, never both."); }
    if (args.num_last_images_to_include !== undefined && (!Number.isInteger(args.num_last_images_to_include) || args.num_last_images_to_include < 1 || args.num_last_images_to_include > 5)) { throw new Error("Recent image count must be 1..5."); }
    const size = normalizeCodexImageSize(args.size);
    abort(runtime.signal);
    const target = await preflightOutput(runtime.cwd, args.output_path);
    const images = args.referenced_paths !== undefined || args.num_last_images_to_include !== undefined
        ? await runtime.images(args.referenced_paths, args.num_last_images_to_include) : [];
    const body = { prompt: args.prompt, background: "auto", model: args.image_model ?? "gpt-image-2", quality: args.quality ?? "auto", size };
    const result = await runtime.request(images.length ? "images/edits" : "images/generations", images.length ? { ...body, images: images.map((i) => ({ image_url: `data:${i.mimeType};base64,${i.data}` })) } : body);
    abort(runtime.signal);
    const data = (result as { data?: { b64_json?: unknown }[] } | null)?.data?.[0]?.b64_json;
    const bytes = await decodePng(data);
    const savedPath = await savePng(runtime.cwd, target, bytes, runtime.signal);
    return { content: [{ type: "text" as const, text: `${images.length ? "Edited" : "Generated"} image saved to ${savedPath}` }, { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" }], details: { phase: "completed", savedPath } };
}

export function createImageTool(host: Host) {
    return defineTool({ name: "codex_image", description: "Generate or edit a PNG through the Codex subscription. Default image model gpt-image-2; no silent fallback or automatic retry. Save a new workspace path; originals are never overwritten.", parameters, replay: "unsafe", execute: async (args, api, context) => {
        const runtime = await makeRuntime(api, context, host);
        try { return await executeImage(runtime, args); }
        finally { runtime.close(); }
    } });
}
