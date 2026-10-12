import { listProfileFiles, loadProfile } from "./profile.js";
export async function readProfile(directory, name) {
    return loadProfile(directory, name);
}
/** Build a catalog without failing the whole list when one owner-managed file is malformed. */
export async function catalogProfiles(directory) {
    let names;
    try {
        names = await listProfileFiles(directory);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { directory, profiles: [] };
        }
        throw error;
    }
    const profiles = [];
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
        }
        catch (error) {
            profiles.push({ name, error: error.message });
        }
    }
    return { directory, profiles };
}
