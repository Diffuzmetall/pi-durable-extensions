/**
 * Bounded Codex subscription transcription transport. It receives explicit native Models and fetch capabilities only;
 * it never reads Pocket settings, credentials, audio files, user data, or a workspace path.
 *
 * Derived from get-bb/bb desktop-v0.46.0 commit 4c87fdec7b7effc022ff2ee31ec95c0a09c9ee62,
 * plugins/provider-codex/src/ai/chatgpt-client.ts. See ../NOTICE.md.
 */
import type { VoiceModels } from "./types.ts";

export const AUDIO_BYTES = 20 * 1024 * 1024;
export const RESPONSE_BYTES = 1024 * 1024;
export const TEXT_POINTS = 32_768;
export const MIME = new Map([
    ["audio/webm;codecs=opus", "webm"],
    ["audio/webm", "webm"],
    ["audio/mp4", "mp4"],
    ["audio/ogg;codecs=opus", "ogg"],
]);

export type { VoiceModels } from "./types.ts";
export type Fetcher = typeof fetch;

const CANCELLED = "Codex dictation was cancelled or timed out.";
const AUTH = "Codex OAuth is unavailable. Sign in through native Models.";

/** Stop waiting without interrupting a native OAuth refresh's credential persistence. */
export function wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void operation.catch(() => undefined);
        return Promise.reject(new Error(CANCELLED));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        const finishResolve = (value: T) => {
            if (settled) {
                return;
            }

            settled = true;
            signal.removeEventListener("abort", abort);
            resolve(value);
        };
        const finishReject = (error: unknown) => {
            if (settled) {
                return;
            }

            settled = true;
            signal.removeEventListener("abort", abort);
            reject(error instanceof Error ? error : new Error("operation failed"));
        };
        const abort = () => finishReject(new Error(CANCELLED));

        signal.addEventListener("abort", abort, { once: true });
        void operation.then(finishResolve, finishReject);
    });
}

function account(token: string): string {
    if (token.length > 32_768) {
        throw new Error(AUTH);
    }

    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
        const value = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
        if (typeof value === "string" && /^[\w-]{1,256}$/.test(value)) {
            return value;
        }
    } catch {
        throw new Error(AUTH);
    }

    throw new Error(AUTH);
}

/** Stream caps also apply without Content-Length, with no raw error-body inspection/output. */
async function responseText(response: Response, signal: AbortSignal): Promise<string> {
    const cap = response.ok ? RESPONSE_BYTES : 4096;
    const reader = response.body?.getReader();
    if (!reader) {
        return "";
    }

    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let bytes = 0;
    let finished = false;

    try {
        if (response.ok && Number(response.headers.get("content-length") ?? 0) > cap) {
            throw new Error("large");
        }

        while (true) {
            const next = await wait(reader.read(), signal);
            if (next.done) {
                finished = true;
                break;
            }

            bytes += next.value.byteLength;
            if (bytes > cap) {
                if (response.ok) {
                    throw new Error("large");
                }
                break;
            }

            if (response.ok) {
                chunks.push(decoder.decode(next.value, { stream: true }));
            }
        }

        return chunks.join("") + decoder.decode();
    } finally {
        if (!finished) {
            void reader.cancel().catch(() => undefined);
        }
        reader.releaseLock();
    }
}

/**
 * Invoke exactly one fixed Codex subscription request after validating audio and native OAuth. The optional fetcher is
 * a deterministic fixture seam for tests; production callers use the global fetch and cannot change the URL.
 */
export async function transcribe(
    models: VoiceModels,
    audio: Blob,
    signal: AbortSignal,
    fetcher: Fetcher = globalThis.fetch,
): Promise<string> {
    try {
        signal.throwIfAborted();
        const mime = audio.type.toLowerCase();
        if (!audio.size || audio.size > AUDIO_BYTES || !MIME.has(mime)) {
            throw new Error("audio");
        }

        if ((await wait(models.checkAuth("openai-codex", { signal }), signal))?.type !== "oauth") {
            throw new Error(AUTH);
        }

        signal.throwIfAborted();
        const resolved = await wait(
            models.getAuth("openai-codex", { signal: AbortSignal.timeout(65_000) }),
            signal,
        );
        signal.throwIfAborted();
        if (resolved?.source !== "OAuth" || !resolved.auth.apiKey) {
            throw new Error(AUTH);
        }

        if ((await wait(models.checkAuth("openai-codex", { signal }), signal))?.type !== "oauth") {
            throw new Error(AUTH);
        }

        const token = resolved.auth.apiKey;
        const headers = new Headers({
            Authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": account(token),
            originator: "pi",
            Accept: "application/json",
            "User-Agent": "OpenAI File Downloader, XaiImageApiFetch/1.0",
        });
        const form = new FormData();
        form.set("file", audio, `recording.${MIME.get(mime)}`);
        form.set("model", "gpt-transcribe");

        signal.throwIfAborted();
        const response = await wait(
            fetcher("https://chatgpt.com/backend-api/transcribe", {
                method: "POST",
                headers,
                body: form,
                signal,
                redirect: "error",
            }),
            signal,
        );
        const raw = await responseText(response, signal);
        signal.throwIfAborted();

        if (!response.ok) {
            const status = response.status;
            throw new Error(
                status === 401 || status === 403
                    ? "Codex subscription access was rejected."
                    : status === 429
                      ? "Codex subscription quota is unavailable."
                      : "Codex transcription service is unavailable.",
            );
        }

        const value = JSON.parse(raw);
        if (typeof value?.text !== "string") {
            throw new Error("response");
        }

        const text = value.text.trim();
        if ([...text].length > TEXT_POINTS) {
            throw new Error("response");
        }
        return text;
    } catch (error) {
        if (signal.aborted) {
            throw new Error(CANCELLED);
        }

        const safe = error instanceof Error ? error.message : "";
        if (
            [
                AUTH,
                "Codex subscription access was rejected.",
                "Codex subscription quota is unavailable.",
                "Codex transcription service is unavailable.",
            ].includes(safe)
        ) {
            throw new Error(safe);
        }

        throw new Error("Codex dictation failed. Check sign-in, audio format and service availability.");
    }
}
