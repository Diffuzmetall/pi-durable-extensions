import { listProfileFiles, loadProfile, type Profile } from "./profile.ts";

export type ProfileSummary = Pick<Profile, "name" | "description" | "model" | "thinking" | "tools">;

export type CatalogEntry = ProfileSummary | { name: string; error: string };

export type ProfileCatalog = {
    directory: string;
    profiles: CatalogEntry[];
};

export async function readProfile(directory: string, name: string): Promise<Profile> {
    return loadProfile(directory, name);
}

/** Build a catalog without failing the whole list when one owner-managed file is malformed. */
export async function catalogProfiles(directory: string): Promise<ProfileCatalog> {
    let names: string[];
    try {
        names = await listProfileFiles(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { directory, profiles: [] };
        }

        throw error;
    }

    const profiles: CatalogEntry[] = [];
    for (const name of names) {
        try {
            const profile = await loadProfile(directory, name);
            profiles.push({
                name: profile.name,
                ...(profile.description === undefined ? {} : { description: profile.description }),
                ...(profile.model === undefined ? {} : { model: profile.model }),
                ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
                ...(profile.tools === undefined ? {} : { tools: profile.tools }),
            });
        } catch (error) {
            profiles.push({ name, error: (error as Error).message });
        }
    }

    return { directory, profiles };
}
