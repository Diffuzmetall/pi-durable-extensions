import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
    catalogProfiles,
    loadProfile,
    MAX_PROFILE_BYTES,
    parseProfile,
    readProfile,
} from "../src/index.ts";

const candidateRoot = resolve(dirname(new URL(import.meta.url).pathname), "..");
const artifacts = await mkdtemp(join(candidateRoot, "test-artifacts-"));
const profiles = join(artifacts, "profiles");
await mkdir(profiles);

const valid = `---\nname: reviewer\ndescription: Read-only reviewer\nmodel: faux/faux-2\nthinking: high\ntools: [read, write]\n---\nReview only; never edit.`;
await writeFile(join(profiles, "reviewer.md"), valid);
await writeFile(join(profiles, "plain.md"), "Plain instructions.");

// Retained test artifacts are intentional: this candidate never runs cleanup or deletion.

test("portable parser and catalog execute without Pocket", async () => {
    const parsed = parseProfile(valid, { name: "reviewer" });
    assert.equal(parsed.name, "reviewer");
    assert.equal(parseProfile(valid).name, "reviewer");
    assert.equal(parsed.model, "faux/faux-2");
    assert.deepEqual(parsed.tools, ["read", "write"]);
    assert.match(parsed.prompt, /never edit/);

    const plain = await readProfile(profiles, "plain");
    assert.equal(plain.prompt, "Plain instructions.");

    const catalog = await catalogProfiles(profiles);
    assert.deepEqual(
        catalog.profiles.map((profile) => profile.name),
        ["plain", "reviewer"],
    );
});

test("owner root rejects traversal, escaped symlink and oversized files", async () => {
    await writeFile(join(artifacts, "outside.md"), "outside");
    await symlink(join(artifacts, "outside.md"), join(profiles, "escape.md"));
    await writeFile(join(profiles, "large.md"), "x".repeat(MAX_PROFILE_BYTES + 1));

    await assert.rejects(() => loadProfile(profiles, "../outside"), /lowercase kebab-case|path/);
    await assert.rejects(() => loadProfile(profiles, "escape"), /symlink|directory/);
    await assert.rejects(() => loadProfile(profiles, "large"), /64 KiB|bytes/);
});

test("malformed frontmatter is represented as a catalog error and never launches anything", async () => {
    await writeFile(join(profiles, "bad.md"), "---\nunknown: true\n---\nrole");
    await writeFile(join(profiles, "duplicate.md"), "---\nmodel: one\nmodel: two\n---\nrole");
    await writeFile(join(profiles, "empty.md"), "   ");
    await writeFile(join(profiles, "bad-name.md"), "---\nname: other\n---\nrole");

    const catalog = await catalogProfiles(profiles);
    const errors = catalog.profiles.filter((profile) => "error" in profile);
    assert.deepEqual(
        errors.map((profile) => profile.name).sort(),
        ["bad", "bad-name", "duplicate", "empty", "escape", "large"],
    );
    assert.ok(errors.every((profile) => "error" in profile && profile.error.length > 0));
});

test("parser preserves safe validation boundaries", async () => {
    assert.throws(() => parseProfile("---\nthinking: magical\n---\nrole"), /thinking/);
    assert.throws(() => parseProfile("---\ntools: [read, read]\n---\nrole"), /unique/);
    assert.throws(() => parseProfile("---\nmodel: '   '\n---\nrole"), /model/);
    assert.throws(() => parseProfile("---\nfoo: bar\n---\nrole"), /unknown/);
    assert.throws(() => parseProfile("---\nrole"), /unclosed/);
    assert.throws(() => parseProfile("\n\n"), /instructions/);
});

test("candidate has no Pocket launcher or workspace imports", async () => {
    const source = await readFile(join(candidateRoot, "src", "profile.ts"), "utf8");
    const catalog = await readFile(join(candidateRoot, "src", "catalog.ts"), "utf8");
    const index = await readFile(join(candidateRoot, "src", "index.ts"), "utf8");
    const all = `${source}\n${catalog}\n${index}`;
    assert.doesNotMatch(all, /PocketHost|SubagentsDoc|src\/server\/docs|src\/server\/extensions|pi-pocket\/src/);
    assert.doesNotMatch(all, /home\/ubuntu|node_modules\s*\/.*pi-pocket/);
    assert.equal(resolve(candidateRoot), candidateRoot);
});

test("manifest exposes only the portable package surface", async () => {
    const manifest = JSON.parse(await readFile(join(candidateRoot, "package.json"), "utf8")) as {
        files: string[];
        exports: { ".": { import: string; types: string } };
        xCandidateStatus: string;
    };
    assert.deepEqual(manifest.files, ["dist/", "src/", "examples/", "README.md", "NOTICE.md"]);
    assert.equal(manifest.files.includes("profiles/"), false);
    assert.equal(manifest.exports["."].import, "./dist/index.js");
    assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
});
