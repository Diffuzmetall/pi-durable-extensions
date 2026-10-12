/** Explicit host seam; the package never discovers Pocket settings or credentials. */
export type VoiceModels = {
    checkAuth(provider: string, options?: { signal?: AbortSignal }): Promise<{ type: string } | undefined>;
    getAuth(
        provider: string,
        options?: { signal?: AbortSignal },
    ): Promise<{ source?: string; auth: { apiKey?: string } } | undefined>;
};

export type VoiceHost = {
    readonly models?: VoiceModels;
};

export type VoiceAdapter = {
    readonly name: "codex-voice";
    readonly voice: {
        transcribe(audio: Blob, signal: AbortSignal): Promise<string>;
    };
};
