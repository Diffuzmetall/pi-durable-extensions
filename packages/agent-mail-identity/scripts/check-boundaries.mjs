import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFile(join(root, path), "utf8");
const specifiersOf = (text) => [...text.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(match => match[1]);
/** Imports a package source file may use: a relative path inside the package, or a node builtin. */
const insidePackage = (specifier) => (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.startsWith("../..");

const files = (await readdir(join(root, "src"))).filter(name => name.endsWith(".ts"));
for (const file of files) {
	const text = await read(join("src", file));
	assert.ok(!/import\s*\(/.test(text), `${file}: no dynamic production imports`);
	const imports = specifiersOf(text);
	for (const specifier of imports) {
		assert.ok(insidePackage(specifier) || specifier.startsWith("node:") || ["@earendil-works/pi-ai", "@earendil-works/pi-durable"].includes(specifier), `${file}: unsupported import ${specifier}`);
		assert.ok(!specifier.includes("pocket") && !specifier.includes("/dist/") && !specifier.includes("sqlite"), `${file}: host internal import`);
	}
	assert.ok(!/setInterval|shell:\s*true|register_agent|create_agent_identity/.test(text), `${file}: forbidden wake, shell, or registration`);
	if (["identity.ts", "authority.ts", "tool-guard.ts", "errors.ts"].includes(file)) {
		assert.ok(imports.every(specifier => specifier.startsWith("./")), `${file}: policy imports framework`);
		assert.ok(!/process\.|node:|sqlite|pi-durable|pi-pocket/.test(text), `${file}: policy crosses host boundary`);
	}
}

// AM2: the delivery planner is pure, and the watcher keeps its polling inside the durable task runtime.
const delivery = await read(join("src", "delivery.ts"));
assert.ok(!/pi-durable|pi-pocket|process\.|sqlite/.test(delivery), "delivery.ts: the batch planner must stay host-free");
assert.deepEqual(specifiersOf(delivery).filter(specifier => !specifier.startsWith("node:")), [], "delivery.ts: only node builtins may be imported");
const watcher = await read(join("src", "watcher.ts"));
assert.ok(!/setInterval|setTimeout|spawn|child_process/.test(watcher), "watcher.ts: no timer, daemon, or subprocess in the watcher");
assert.ok(/runtime\.sleep\(/.test(watcher), "watcher.ts: waiting must go through the durable sleep");
assert.ok(/tx\.submissionByRequest\(/.test(watcher), "watcher.ts: admission must be checked through the public submission lookup");
assert.ok(/whenBusy: "reject"/.test(watcher), "watcher.ts: a busy conversation must be rejected, never steered");
assert.ok(/background: true/.test(await read(join("src", "index.ts"))), "index.ts: the watcher task must be created as a background task");
assert.ok(!/mark-all-read|mark_all_read|acknowledge_message|"mail"|'mail'/.test(delivery + watcher), "the watcher must not carry a read-marking call");

// AM2: the packaged CLI listing is read-only, explicit, and bounded.
const cli = await read(join("src", "am-cli.ts"));
assert.ok(/"inbox-events"/.test(cli), "am-cli.ts: the delivery listing must use the verified inbox-events contract");
assert.ok(/"--position-now"/.test(cli) && /"--after"/.test(cli) && /"--limit"/.test(cli), "am-cli.ts: listing must use --after, --limit and --position-now");
assert.ok(/"--project", checked\.projectKey, "--agent", checked\.agentName/.test(cli), "am-cli.ts: the project and agent must always be explicit, never an environment default");
// The real read-marking commands are `am mark-all-read`, `am mail ack` and `am mail read`; none may appear here.
assert.ok(!/mark-all-read|mark_all_read|acknowledge_message|"mail"|'mail'/.test(cli), "am-cli.ts: monitoring must never invoke a read-marking command");
assert.ok(cli.includes('"agents", "show"') && cli.includes('"inbox-events"'), "am-cli.ts: only the profile lookup and the read-only listing may be invoked");
assert.ok(/watch_cursor_expired/.test(cli) && /invalid_delivery_page/.test(cli), "am-cli.ts: an unservable cursor and an unexpected page must fail closed");
assert.ok(/CLI_PAGE_LIMIT_MAX = 1000/.test(cli), "am-cli.ts: the listing page limit must stay inside the CLI's accepted range");
assert.ok(/events\.length > 0 && oldest === null/.test(cli), "am-cli.ts: a page with events but no usable oldest position must fail closed");

// AM2 standalone portability: the shipped watcher composition is the host's own wiring, and Pocket is optional.
const entry = await read(join("src", "index.ts"));
assert.ok(/export function standaloneWatch\(/.test(entry), "index.ts: a standalone Durable host must have a composition helper");
assert.ok(!/pocket/i.test(entry) && !/PocketApp/.test(entry), "index.ts: the generic entry point must not know Pocket at all");

// AM3: a separate Pocket entry point, inside the package and free of any Pocket source or internal table.
const pocket = await read(join("pocket", "index.ts"));
assert.ok(/import type \{ ConversationId/.test(pocket) || /ConversationId/.test(pocket), "pocket/index.ts: the host surface must be structural, not an imported Pocket type");
for (const specifier of specifiersOf(pocket)) {
	assert.ok(insidePackage(specifier) || specifier.startsWith("node:") || ["@earendil-works/pi-ai", "@earendil-works/pi-durable"].includes(specifier), `pocket/index.ts: unsupported import ${specifier}`);
	assert.ok(!/pocket-app|PocketApp/.test(specifier), `pocket/index.ts: no Pocket application import ${specifier}`);
}
assert.ok(/from "\.\.\/src\/index\.ts"/.test(pocket), "pocket/index.ts: the Pocket entry point reuses the generic factory instead of reimplementing it");
assert.ok(!/import\s*\(/.test(pocket), "pocket/index.ts: no dynamic imports");
assert.ok(!/PocketApp|pi-pocket|\/dist\/|sqlite|\.sqlite|userById|driverById|config\.user/i.test(pocket), "pocket/index.ts: no Pocket application, database or internal table access");
assert.ok(!/setInterval|shell:\s*true|register_agent|create_agent_identity/.test(pocket), "pocket/index.ts: forbidden timer, shell, or registration");
assert.ok(!/require\s*\(|readFileSync|writeFileSync/.test(pocket), "pocket/index.ts: no filesystem access of its own");
assert.ok(!/heldBank|spendDoc|spend_doc/i.test(pocket), "pocket/index.ts: the domain part must not know spend documents");
for (const result of ["allowed", "busy", "paused", "denied"]) {
	assert.ok(new RegExp(`result: "${result}"`).test(pocket), `pocket/index.ts: HostAdmission must carry the ${result} result`);
}
for (const reason of ["missing_host_capability", "held_back", "budget_denied", "identity_mismatch", "registration_failed", "extension_removed", "schema_unsupported"]) {
	assert.ok(pocket.includes(`"${reason}"`), `pocket/index.ts: the ${reason} diagnostic must exist`);
}
assert.ok(/missing_host_capability/.test(pocket), "pocket/index.ts: a missing mandatory capability must refuse");
const pocketTests = (await readdir(join(root, "test", "pocket"))).filter(name => name.endsWith(".ts"));
assert.ok(pocketTests.includes("admission.test.ts") && pocketTests.includes("install.test.ts") && pocketTests.includes("live-pocket.ts"), "the AM3 Pocket tests must exist");

const pkg = JSON.parse(await read(join("package.json")));
assert.equal(pkg.exports["."], "./src/index.ts");
assert.equal(pkg.exports["./pocket"], "./pocket/index.ts", "the Pocket entry point must be a package export");
assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), ["@earendil-works/pi-ai", "@earendil-works/pi-durable"], "only what src/ imports may be a peer dependency");
assert.ok(pkg.devDependencies?.["@earendil-works/chord"] !== undefined, "chord is a test-only dependency and belongs in devDependencies");
assert.ok(pkg.files.includes("pocket"), "the published files must include the Pocket entry point");
assert.match(pkg.scripts.test, /test\/pocket\/\*\.test\.ts/, "the package test script must run the Pocket tests");
assert.match(pkg.scripts["test:live:pocket"], /test\/pocket\/live-pocket\.ts/, "the Pocket live gate must run the honest unavailable script");
for (const doc of ["README.md", "CONTRACT.md", "INSTALLATION.md", "MIGRATION.md"]) assert.ok((await read(join(doc))).length > 100, `missing ${doc}`);
assert.ok(Object.values(pkg.scripts).every(command => !/\brm\b|unlink|rmdir|npm install|curl|wget/.test(command)), "unsafe package script");
assert.match(pkg.scripts["test:live:am2"], /test\/live-am2\.ts/, "the AM2 live gate must run the honest unavailable script");

// The package must stay installable next to a bare Durable host: no author-absolute paths in shipped sources.
for (const path of [...files.map(file => join("src", file)), join("pocket", "index.ts")]) {
	const text = await read(path);
	assert.ok(!/\/home\/|\/Users\/|[A-Za-z]:\\\\/.test(text), `${path}: no absolute author path may be shipped`);
}

// AM1 evidence stays frozen: the manifest is present, unchanged in shape, and never rewritten.
const manifest = await read(join("test", "evidence", "candidate.sha256"));
assert.equal(manifest.trim().split("\n").length, 22, "the AM1 candidate manifest must keep its recorded entries");
assert.ok(manifest.includes("packages/agent-mail-identity/src/index.ts"), "the AM1 manifest records its own candidate files");
const am2 = await read(join("test", "evidence", "am2-candidate.sha256"));
const am2Entries = am2.split("\n").filter(line => /^[0-9a-f]{64} {2}\S/.test(line));
assert.equal(am2Entries.length, 27, "the AM2 manifest must list exactly its candidate files");
assert.ok(am2Entries.some(line => line.endsWith("src/watcher.ts")) && am2Entries.some(line => line.endsWith("src/delivery.ts")), "the AM2 manifest must cover the new sources");
assert.ok(am2Entries.every(line => !line.includes("test/evidence/")), "the AM2 manifest must not hash any manifest or evidence file");
const am3 = await read(join("test", "evidence", "am3-candidate.sha256"));
const am3Entries = am3.split("\n").filter(line => /^[0-9a-f]{64} {2}\S/.test(line));
assert.ok(am3Entries.length >= 20, "the AM3 manifest must record its candidate files");
assert.ok(am3Entries.some(line => line.endsWith("pocket/index.ts")), "the AM3 manifest must cover the Pocket entry point");
assert.ok(am3Entries.some(line => line.endsWith("test/pocket/admission.test.ts")) && am3Entries.some(line => line.endsWith("test/pocket/install.test.ts")), "the AM3 manifest must cover the Pocket tests");
assert.ok(am3Entries.every(line => !line.includes("test/evidence/")), "the AM3 manifest must not hash any manifest or evidence file");

console.log(`Static boundary checks passed: ${files.length} source files, AM2 watcher and delivery, AM3 Pocket entry point included. This is not live acceptance.`);
