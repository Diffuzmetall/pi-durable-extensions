import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawn } from "node:child_process";

function fail(message) { throw new Error(message); }
function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function requiredAbsolute(name) {
  const value = option(name);
  if (!value || !path.isAbsolute(value) || value === path.parse(value).root || value.includes("\0")) {
    fail(`usage: node scripts/manual-route-proof.mjs --bundle /absolute/bundle --output /absolute/new/proof`);
  }
  return path.resolve(value);
}
async function lstatOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function newDirectory(file, label) {
  const existing = await lstatOrNull(file);
  if (existing) fail(`${label} already exists; choose a new path`);
  const parent = path.dirname(file);
  const parentStat = await lstatOrNull(parent);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) fail(`${label} parent must be an existing regular directory`);
  try { await fs.mkdir(file, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") fail(`${label} appeared during creation`); throw error; }
  await fs.chmod(file, 0o700);
}
async function ensureDirectory(file) {
  const existing = await lstatOrNull(file);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) fail(`unsafe directory path: ${file}`);
    return;
  }
  await fs.mkdir(file, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe directory path: ${file}`);
}
function parseOctal(buffer) {
  const text = buffer.toString("ascii").replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}
function tarName(header) {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}
function safeMember(member) {
  if (!member.startsWith("package/")) fail(`archive member outside package root: ${member}`);
  const relative = member.slice("package/".length);
  if (!relative || relative.includes("\\") || relative.includes("\0") || path.posix.isAbsolute(relative)) fail(`unsafe archive member: ${member}`);
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`unsafe archive member: ${member}`);
  return relative;
}
function auditAndExtract(bytes, target) {
  const tar = gunzipSync(bytes);
  const seen = new Set();
  let offset = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const entries = [];
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = tarName(header);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const size = parseOctal(header.subarray(124, 136));
    if (!Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024) fail(`archive member too large: ${name}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) fail(`truncated archive member: ${name}`);
    const relative = safeMember(name);
    if (seen.has(relative)) fail(`duplicate archive member: ${relative}`);
    seen.add(relative);
    if (type !== "0" && type !== "5") fail(`non-regular archive member rejected: ${name} (type ${type})`);
    entries.push({ relative, type, data: tar.subarray(dataStart, dataEnd) });
    if (type === "0") { fileCount += 1; totalBytes += size; }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (offset > tar.length || fileCount === 0 || totalBytes > 64 * 1024 * 1024) fail("invalid or oversized regular-only archive");
  return (async () => {
    for (const entry of entries) {
      const destination = path.join(target, entry.relative);
      if (entry.type === "5") {
        await ensureDirectory(destination);
      } else {
        await ensureDirectory(path.dirname(destination));
        await fs.writeFile(destination, entry.data, { flag: "wx", mode: 0o600 });
        await fs.chmod(destination, 0o600);
      }
    }
    return { members: entries.length, files: fileCount, bytes: totalBytes };
  })();
}
async function auditTree(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) fail(`symlink found in manual target: ${full}`);
    if (entry.isDirectory()) count += await auditTree(full);
    else if (!stat.isFile()) fail(`non-regular manual target entry: ${full}`);
    else count += 1;
  }
  return count;
}
const CONTROLLED_ENV_KEYS = new Set([
  "PATH", "LANG", "LC_ALL", "TZ", "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR",
  "npm_config_ignore_scripts", "npm_config_audit", "npm_config_fund", "npm_config_bin_links",
  "npm_config_omit", "npm_config_workspaces", "npm_config_userconfig", "npm_config_globalconfig",
  "npm_config_cache", "npm_config_global", "HINDSIGHT_EXAMPLE_DIR",
]);
function controlledEnvironment(workspace, cache, fixture = {}, sourceEnv = process.env) {
  const env = {
    PATH: sourceEnv.PATH || "/usr/bin:/bin",
    HOME: path.join(workspace, "home"),
    XDG_CONFIG_HOME: path.join(workspace, "xdg-config"),
    XDG_CACHE_HOME: path.join(workspace, "xdg-cache"),
    TMPDIR: path.join(workspace, "tmp"),
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_bin_links: "false",
    npm_config_omit: "dev",
    npm_config_workspaces: "false",
    npm_config_userconfig: "/dev/null",
    npm_config_globalconfig: "/nonexistent/pi-durable-extensions-global.npmrc",
    npm_config_cache: cache,
    npm_config_global: "false",
  };
  for (const key of ["LANG", "LC_ALL", "TZ"]) if (sourceEnv[key]) env[key] = sourceEnv[key];
  if (fixture.HINDSIGHT_EXAMPLE_DIR) env.HINDSIGHT_EXAMPLE_DIR = fixture.HINDSIGHT_EXAMPLE_DIR;
  return env;
}
function assertControlledEnvironment(env, workspace) {
  const unexpected = Object.keys(env).filter((key) => !CONTROLLED_ENV_KEYS.has(key));
  if (unexpected.length) fail(`manual child environment contains non-whitelisted keys: ${unexpected.join(",")}`);
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR"]) {
    if (!env[key]?.startsWith(`${workspace}${path.sep}`)) fail(`manual child ${key} is not private`);
  }
  if (env.npm_config_userconfig !== "/dev/null" || env.npm_config_globalconfig !== "/nonexistent/pi-durable-extensions-global.npmrc") fail("manual child npm config is uncontrolled");
}
function run(command, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
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
async function writeNew(file, content) {
  await fs.writeFile(file, content, { flag: "wx", mode: 0o600 });
  await fs.chmod(file, 0o600);
}
async function sha256(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
async function loggedRun(results, logDir, cwd, label, command, args, env) {
  const result = await run(command, args, cwd, env);
  await writeNew(path.join(logDir, `${label}.log`), `${result.stdout}${result.stderr}`);
  results.push({ label, command: [command, ...args].join(" "), exit: result.code, signal: result.signal ?? null });
  return result.code === 0;
}

const bundle = requiredAbsolute("--bundle");
const output = requiredAbsolute("--output");
const catalogPath = path.join(bundle, "catalog.json");
const catalogStat = await lstatOrNull(catalogPath);
if (!catalogStat?.isFile() || catalogStat.isSymbolicLink()) fail("bundle catalog must be a regular file");
const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.components) || !catalog.cli) fail("bundle catalog schema is unsupported");
await newDirectory(output, "proof output");
const canaryWorkspace = path.join(output, "env-canary");
const canaryCache = path.join(canaryWorkspace, "cache");
await newDirectory(canaryWorkspace, "environment canary workspace");
await newDirectory(canaryCache, "environment canary cache");
await newDirectory(path.join(canaryWorkspace, "home"), "environment canary HOME");
await newDirectory(path.join(canaryWorkspace, "xdg-config"), "environment canary XDG config");
await newDirectory(path.join(canaryWorkspace, "xdg-cache"), "environment canary XDG cache");
await newDirectory(path.join(canaryWorkspace, "tmp"), "environment canary TMPDIR");
const syntheticParent = { PATH: process.env.PATH || "/usr/bin:/bin", LANG: process.env.LANG || "C", NPM_TOKEN: "synthetic-canary", NODE_AUTH_TOKEN: "synthetic-canary", NODE_OPTIONS: "--require=synthetic-canary", NODE_EXTRA_CA_CERTS: "/synthetic-canary", OPENAI_API_KEY: "synthetic-canary", ANTHROPIC_API_KEY: "synthetic-canary" };
const canaryEnv = controlledEnvironment(canaryWorkspace, canaryCache, {}, syntheticParent);
assertControlledEnvironment(canaryEnv, canaryWorkspace);
const canary = await run("node", ["--input-type=module", "-e", "for (const key of ['NPM_TOKEN','NODE_AUTH_TOKEN','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','OPENAI_API_KEY','ANTHROPIC_API_KEY']) if (process.env[key]) process.exit(1); if (!process.env.HOME || !process.env.XDG_CONFIG_HOME || !process.env.TMPDIR) process.exit(2);"], canaryWorkspace, canaryEnv);
if (canary.code !== 0) fail(`environment canary failed with exit ${canary.code ?? "signal"}`);
const entries = [...catalog.components.map((entry) => ({ ...entry, id: entry.id })), { ...catalog.cli, id: "cli" }];
const proof = { bundle, output, node: process.versions.node, envCanary: "PASS; synthetic token/config/node-injector variables were omitted without reading or logging real values", npmRoute: "npm install may download anonymous public dependencies from the npm registry; no --offline claim; faux/local examples make no live provider/backend/service calls", nodeModulesTsImport: "unsupported by Node 24; proof imports unpacked target-root source instead", packages: [] };
const importCommands = {
  codemode: ["--experimental-strip-types", "--input-type=module", "-e", "await import('./src/index.ts'); console.log('target-root-import-ok')"],
  "agent-mail": ["--experimental-strip-types", "--input-type=module", "-e", "await import('./src/index.ts'); console.log('target-root-import-ok')"],
  "codex-api": ["--experimental-strip-types", "--input-type=module", "-e", "await import('./src/index.ts'); console.log('target-root-import-ok')"],
  "agent-profiles": ["--input-type=module", "-e", "await import('./dist/index.js'); console.log('target-root-import-ok')"],
  "web-tools": ["--experimental-strip-types", "--input-type=module", "-e", "await import('./src/web-tools.ts'); console.log('target-root-import-ok')"],
  "antigravity-shim": ["--experimental-strip-types", "--input-type=module", "-e", "await import('./src/index.mjs'); console.log('target-root-import-ok')"],
  "codex-voice": ["--experimental-strip-types", "--input-type=module", "-e", "await import('./src/index.ts'); console.log('target-root-import-ok')"],
  hindsight: ["--input-type=module", "-e", "await import('./src/adapter.mjs'); console.log('target-root-import-ok')"],
};
const examples = {
  codemode: { args: ["--experimental-strip-types", "examples/bare-durable.mjs"] },
  "agent-mail": { args: ["--experimental-strip-types", "examples/bare-durable.mjs"] },
  "codex-api": { args: ["--experimental-strip-types", "examples/bare-harness.mjs"] },
  "agent-profiles": { args: ["examples/read-profiles.mjs"] },
  "web-tools": { args: ["--experimental-strip-types", "examples/bare-durable.mjs"] },
  "codex-voice": { args: ["--experimental-strip-types", "examples/harness.mjs"] },
  hindsight: { args: ["examples/bare-durable.mjs"] },
};
for (const entry of entries) {
  const artifact = path.resolve(bundle, entry.artifact.path);
  const artifactStat = await lstatOrNull(artifact);
  if (!artifactStat?.isFile() || artifactStat.isSymbolicLink()) fail(`artifact is not a regular file: ${entry.id}`);
  const actualHash = await sha256(artifact);
  if (actualHash !== entry.artifact.sha256) fail(`artifact hash mismatch: ${entry.id}`);
  const workspace = path.join(output, entry.id);
  const target = path.join(workspace, "target");
  const cache = path.join(workspace, "cache");
  await newDirectory(workspace, `${entry.id} proof workspace`);
  await newDirectory(target, `${entry.id} unpack target`);
  await newDirectory(cache, `${entry.id} npm cache`);
  await newDirectory(path.join(workspace, "home"), `${entry.id} private HOME`);
  await newDirectory(path.join(workspace, "xdg-config"), `${entry.id} private XDG config`);
  await newDirectory(path.join(workspace, "xdg-cache"), `${entry.id} private XDG cache`);
  await newDirectory(path.join(workspace, "tmp"), `${entry.id} private TMPDIR`);
  const childEnv = controlledEnvironment(workspace, cache);
  const packageBytes = await fs.readFile(artifact);
  const archive = await auditAndExtract(packageBytes, target);
  const results = [];
  const installOk = await loggedRun(results, workspace, workspace, "npm-install", "npm", ["install", "--prefix", target, "--ignore-scripts", "--no-audit", "--no-fund", "--bin-links=false", "--omit=dev", "--workspaces=false", "--cache", cache, "--userconfig", "/dev/null", "--globalconfig", "/nonexistent/pi-durable-extensions-global.npmrc", artifact], childEnv);
  let treeFiles = 0;
  let importOk = false;
  let exampleOk = null;
  if (installOk) {
    treeFiles = await auditTree(target);
    importOk = entry.id === "cli"
      ? await loggedRun(results, workspace, target, "cli-list", "node", ["src/index.mjs", "list", "--catalog", catalogPath, "--allow-experimental"], childEnv)
      : await loggedRun(results, workspace, target, "target-import", "node", importCommands[entry.id], childEnv);
    const example = examples[entry.id];
    if (example) {
      const fixture = entry.id === "hindsight" ? { HINDSIGHT_EXAMPLE_DIR: path.join(workspace, "example-data") } : {};
      await ensureDirectory(path.join(workspace, "example-data")).catch(() => {});
      exampleOk = await loggedRun(results, workspace, target, "packed-example", "node", example.args, controlledEnvironment(workspace, cache, fixture));
    }
  }
  proof.packages.push({ id: entry.id, version: entry.version, artifact: entry.artifact.path, sha256: actualHash, archive, installExit: installOk ? 0 : results.find((result) => result.label === "npm-install")?.exit ?? 1, targetFiles: treeFiles, targetImportExit: importOk ? 0 : 1, exampleExit: exampleOk === null ? "not-run-live-only-or-cli" : exampleOk ? 0 : 1, results });
}
await writeNew(path.join(output, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
const failures = proof.packages.flatMap((item) => [item.installExit, item.targetImportExit, item.exampleExit === "not-run-live-only-or-cli" ? 0 : item.exampleExit]).filter((value) => value !== 0);
console.log(JSON.stringify({ output, packages: proof.packages.length, failures: failures.length, proof: "proof.json" }, null, 2));
if (failures.length) process.exitCode = 1;
