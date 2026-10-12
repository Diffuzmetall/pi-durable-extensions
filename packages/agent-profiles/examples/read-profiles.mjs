import { catalogProfiles, parseProfile, readProfile } from "../dist/index.js";

const example = parseProfile(
    "---\nname: example\ndescription: Inline parser example\n---\nPortable instructions.",
);
console.log(JSON.stringify({ example }, null, 2));

const directory = process.argv[2];
if (directory === undefined) {
    console.log("Pass an owner-managed profile directory to also list its catalog.");
    process.exit(0);
}

const catalog = await catalogProfiles(directory);
console.log(JSON.stringify(catalog, null, 2));
const first = catalog.profiles.find((profile) => !("error" in profile));
if (first !== undefined) {
    console.log(JSON.stringify(await readProfile(directory, first.name), null, 2));
}
