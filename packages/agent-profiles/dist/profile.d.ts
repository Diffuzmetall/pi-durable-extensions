export declare const PROFILE_NAME: RegExp;
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export declare const MAX_PROFILE_BYTES: number;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type Profile = {
    name: string;
    path?: string;
    prompt: string;
    description?: string;
    model?: string;
    thinking?: ThinkingLevel;
    tools?: string[];
};
export type ProfileTextOptions = {
    name?: string;
    path?: string;
};
/** Parse one profile without reading the filesystem or starting a launcher. */
export declare function parseProfile(text: string, options?: ProfileTextOptions): Profile;
/** Read one owner-managed profile file under `directory` with traversal and symlink checks. */
export declare function loadProfile(directory: string, name: string): Promise<Profile>;
/** Return direct Markdown entries, preserving per-file validation errors for the catalog. */
export declare function listProfileFiles(directory: string): Promise<string[]>;
