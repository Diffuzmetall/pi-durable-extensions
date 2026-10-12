import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
for (const dir of ['src/', 'src/vendor/', 'test/', 'scripts/']) {
  for (const name of await readdir(new URL(dir, root))) {
    if (!/\.(mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(dir + name, root))], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
for (const path of ['package.json', 'provenance.json', 'src/vendor/package.json', 'src/vendor/provenance.json']) JSON.parse(await readFile(new URL(path, root), 'utf8'));
console.log('Syntax and JSON OK');
