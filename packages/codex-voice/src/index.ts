/** Bounded Codex subscription transcription transport with an explicit native Models adapter. */
import { transcribe } from "./transcription.ts";
import type { Fetcher } from "./transcription.ts";
import type { VoiceAdapter, VoiceHost } from "./types.ts";

export { AUDIO_BYTES, MIME, RESPONSE_BYTES, TEXT_POINTS, transcribe, wait } from "./transcription.ts";
export type { Fetcher } from "./transcription.ts";
export type { VoiceAdapter, VoiceHost, VoiceModels } from "./types.ts";

function createAdapter(host: VoiceHost, fetcher: Fetcher): VoiceAdapter {
    const models = host.models;

    if (!models || typeof models.checkAuth !== "function" || typeof models.getAuth !== "function") {
        throw new Error("Codex voice needs a native Models host capability.");
    }

    return {
        name: "codex-voice",
        voice: {
            transcribe: (audio, signal) => transcribe(models, audio, signal, fetcher),
        },
    };
}

/**
 * Create the production host adapter. It keeps the fixed endpoint and global fetch transport; construction does not read
 * auth or call the network. A host may install this result in its existing microphone lifecycle, but this package adds no
 * recording UI.
 */
export function createCodexVoice(host: VoiceHost): VoiceAdapter {
    return createAdapter(host, globalThis.fetch);
}

/** Test-only capability: requires an explicit fetcher and has no global-fetch default. */
export function createCodexVoiceForTest(host: VoiceHost, fetcher: Fetcher): VoiceAdapter {
    return createAdapter(host, fetcher);
}

export default createCodexVoice;
