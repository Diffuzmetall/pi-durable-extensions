import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const packageIds = ["codemode", "agent-mail", "codex-api", "agent-profiles", "web-tools", "context7", "antigravity-shim", "codex-voice", "hindsight", "agent-mail-identity", "cli"];

function fail(message) { throw new Error(message); }
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function absoluteOutput() {
  const value = option("--output");
  if (!value || !path.isAbsolute(value) || value === path.parse(value).root || value.includes("\0")) {
    fail("usage: node scripts/pack-all.mjs --output /absolute/new/bundle");
  }
  return path.resolve(value);
}
async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function assertFreshDirectory(file, label) {
  const existing = await lstatOrNull(file);
  if (existing) fail(`${label} already exists; choose a new caller-owned path`);
  const parent = path.dirname(file);
  const parentStat = await lstatOrNull(parent);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) fail(`${label} parent must be an existing regular directory`);
  try { await fs.mkdir(file, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") fail(`${label} appeared during creation; refusing reuse`); throw error; }
  await fs.chmod(file, 0o700);
}
async function assertNoSymlinks(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) fail(`source tree contains a symlink: ${path.relative(root, full)}`);
    if (entry.isDirectory()) await assertNoSymlinks(full);
  }
}
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        npm_config_ignore_scripts: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_bin_links: "false",
        npm_config_userconfig: "/dev/null",
        npm_config_globalconfig: "/nonexistent/pi-durable-extensions-global.npmrc",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
function parsePackJson(text, id) {
  try {
    const parsed = JSON.parse(text.trim());
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!record?.filename || !record.name || !record.version || !Array.isArray(record.files)) fail(`npm pack returned incomplete metadata for ${id}`);
    return record;
  } catch (error) {
    fail(`cannot parse npm pack metadata for ${id}: ${error.message}`);
  }
}
async function packageManifest(id) {
  const file = path.join(root, "packages", id, "package.json");
  const manifest = JSON.parse(await fs.readFile(file, "utf8"));
  if (!manifest.name || !manifest.version) fail(`missing name/version in packages/${id}/package.json`);
  return manifest;
}

const output = absoluteOutput();
const artifacts = path.join(output, "artifacts");
await assertFreshDirectory(output, "bundle output");
await fs.mkdir(artifacts, { mode: 0o700 });
await fs.chmod(artifacts, 0o700);

const baseline = JSON.parse(await fs.readFile(path.join(root, "catalog.json"), "utf8"));
if (baseline.schemaVersion !== 1 || !Array.isArray(baseline.components) || !baseline.cli) fail("root catalog baseline is incomplete");
const packed = new Map();
for (const id of packageIds) {
  await assertNoSymlinks(path.join(root, "packages", id));
  const result = await run("npm", ["pack", "--ignore-scripts", "--pack-destination", artifacts, "--json"], path.join(root, "packages", id));
  if (result.code !== 0) fail(`npm pack failed for ${id}: ${result.stderr.trim() || `exit ${result.code}`}`);
  const record = parsePackJson(result.stdout, id);
  const artifact = path.join(artifacts, record.filename);
  const stat = await lstatOrNull(artifact);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail(`npm pack did not create a regular artifact for ${id}`);
  await fs.chmod(artifact, 0o600);
  packed.set(id, { record, artifact, manifest: await packageManifest(id) });
}

const catalog = structuredClone(baseline);
for (const entry of catalog.components) {
  const item = packed.get(entry.id);
  if (!item) fail(`baseline catalog has no packed component: ${entry.id}`);
  if (item.manifest.name !== entry.package) fail(`${entry.id} package name changed: ${item.manifest.name} != ${entry.package}`);
  entry.version = item.manifest.version;
  entry.artifact = {
    path: `artifacts/${item.record.filename}`,
    sha256: await sha256(item.artifact),
    entries: item.record.files.length,
  };
}
const cli = packed.get("cli");
if (cli.manifest.name !== catalog.cli.package) fail(`cli package name changed: ${cli.manifest.name} != ${catalog.cli.package}`);
catalog.cli.version = cli.manifest.version;
catalog.cli.artifact = {
  path: `artifacts/${cli.record.filename}`,
  sha256: await sha256(cli.artifact),
  entries: cli.record.files.length,
};
catalog.bundle = {
  generated: true,
  artifactDirectory: "artifacts",
  generation: "npm pack --ignore-scripts into a new caller-owned bundle",
};
const catalogPath = path.join(output, "catalog.json");
await fs.writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, { flag: "wx", mode: 0o600 });
await fs.chmod(catalogPath, 0o600);
const finalFiles = await fs.readdir(artifacts);
if (finalFiles.length !== packageIds.length) fail(`unexpected bundle artifact count: ${finalFiles.length}`);
console.log(JSON.stringify({ output, catalog: "catalog.json", artifacts: finalFiles.sort(), packageCount: packageIds.length }, null, 2));
