import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const packages = ["codemode", "agent-mail", "codex-api", "agent-profiles", "web-tools", "antigravity-shim", "codex-voice", "hindsight", "cli"];
const forbiddenNames = new Set(["node_modules", ".verification", "profiles", "verification.json", "progress.md", "EVIDENCE.md", "DELIVERY.md"]);
const errors = [];

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (forbiddenNames.has(entry.name) || rel.includes(`${path.sep}test-artifacts${path.sep}`) || rel.includes(`${path.sep}retained-test-`)) {
      errors.push(`forbidden public path: ${rel}`);
      continue;
    }
    const stat = await fs.lstat(full);
    if (stat.isSymbolicLink()) {
      errors.push(`symlink: ${rel}`);
      continue;
    }
    if (entry.isDirectory()) await walk(full);
  }
}

for (const id of packages) {
  const dir = path.join(root, "packages", id);
  try { await fs.access(path.join(dir, "package.json")); } catch { errors.push(`missing package manifest: packages/${id}`); }
}
await walk(root);

for (const id of packages) {
  const manifestPath = path.join(root, "packages", id, "package.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const files = manifest.files ?? [];
    for (const item of files) {
      if (/provenance|verification|evidence|profiles|node_modules|test-artifacts/i.test(item)) {
        errors.push(`manifest widens private boundary: packages/${id}/package.json files=${item}`);
      }
    }
  } catch {}
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`public-tree-check: PASS; ${packages.length} package manifests, no forbidden paths or symlinks`);
}
