import { type Profile } from "./profile.ts";
export type ProfileSummary = Pick<Profile, "name" | "description" | "model" | "thinking" | "tools">;
export type CatalogEntry = ProfileSummary | {
    name: string;
    error: string;
};
export type ProfileCatalog = {
    directory: string;
    profiles: CatalogEntry[];
};
export declare function readProfile(directory: string, name: string): Promise<Profile>;
/** Build a catalog without failing the whole list when one owner-managed file is malformed. */
export declare function catalogProfiles(directory: string): Promise<ProfileCatalog>;
