# Local packaging and privacy checks

## Scope

A source scan can support a bounded statement about the exact candidate; it cannot guarantee that the runtime never reads, stores, logs or sends private data. Hindsight defaults may start processes, seed history/source, retain conversations and call billable services. Review config before binding; see the README's explicit disabled/automatic-action settings. Session SQLite, cache, logs and diagnostics can contain plaintext prompts and memory. Environment path overrides are process-wide and take priority. Do not publish runtime data or secret files; `.gitignore` is not a content sanitizer.

GitHub private visibility controls GitHub access. npm `private:true` only blocks npm publication. Neither setting encrypts local files nor prevents configured network calls.

## Reproduce isolated installation

Use Node 24 or later (this pass: Node 24.19.0, npm 11.17.0). **Never run npm install/ci in an extraction root with a node_modules symlink.** The symlink must not be deleted or replaced. Start in the repository root and make a fresh directory; these commands copy only the installation/verification allowlist, not runtime state, environment, credentials or upstream dependencies:

```sh
verification=".verification/clean-install-$(node -e 'console.log(crypto.randomUUID())')"
mkdir -p "$verification"
cp package.json provenance.json LICENSE "$verification/"
cp -R src test scripts "$verification/"
cd "$verification"
# Repo-local cache/log paths; official registry; scripts disabled during install.
export npm_config_registry=https://registry.npmjs.org
export npm_config_user_agent='OpenAI File Downloader, XaiImageApiFetch/1.0'
export npm_config_cache="$PWD/.npm-cache"
export npm_config_logs_dir="$PWD/.npm-logs"
npm install --ignore-scripts --no-audit --no-fund
npm test
npm run check
npm run check:provenance
```

Do not copy `node_modules`, `.env`, caches, host settings or existing session files. Do not use `--conditions=source` or transpilation hooks. Tests use native installed exports and SQLite with deterministic offline clients/faux model requests, not live memory providers. Fixtures are retained; no cleanup or deletion commands are part of verification. `package-lock.json` in the root is the exact fresh npm-generated lockfile, not a hand-built substitute. For a **new clone without a dependency symlink**, installation from that lockfile is `npm ci --ignore-scripts`; this pass ran `npm install` in the fresh verification tree, not root npm ci.

## Bounded, non-disclosing source scan

Before publication, define the intended file set, inspect all files in it, and exclude `.verification/`, `node_modules/`, runtime directories and credentials. The following read-only example scans the source/documentation allowlist without following dependency symlinks. It reports only relative file names, line numbers and filter categories, **never matching text or secret material**. Zero hits only means these filters found no matches in these files; review the actual content locally and use authorized additional checks if needed.

```sh
python3 - <<'PY'
from pathlib import Path
import re
roots = ['src', 'scripts', 'test', 'licenses']
paths = [Path(n) for n in ['README.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
                          'LICENSE', '.gitignore', 'package.json', 'package-lock.json',
                          'provenance.json']]
paths += [p for root in roots for p in Path(root).rglob('*')
          if p.is_file() and not p.is_symlink()]
filters = {
  'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
  'credential-token': r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b',
  'absolute-home-path': r'/(?:home|Users)/[^/\s]+/',
  'credential-assignment': r'(?i)(?:api[_-]?key|api[_-]?token|password)\s*[:=]\s*[\"\'][^\"\'\s]{16,}[\"\']',
}
hits = 0
for p in sorted(set(paths)):
    if p.is_symlink():
        raise SystemExit('Unexpected allowlist symlink')
    for line, value in enumerate(p.read_text(errors='replace').splitlines(), 1):
        for category, pattern in filters.items():
            if re.search(pattern, value):
                print(f'{p}:{line}: {category}')
                hits += 1
print(f'files={len(set(paths))} filter_hits={hits}')
PY
```

Do not dump environment, auth failures, matching lines, credentials or full runtime logs to a public terminal transcript. Variable names and placeholders are not necessarily secrets; a flagged item requires local review rather than blind removal. Track any necessary source sanitization in provenance with original and extracted hashes; do not silently alter a vendored artifact. `npm run check:provenance` verifies the preserved source hashes and reversible vendor patches, not license clearance or secret absence.

## License review and verification record

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `licenses/EVIDENCE.json` enumerate every dependency source header plus the wrapper-path occurrences in the executable vendor whitelist. Preserve MIT, BSD-3-Clause and ISC texts and their original copyright notices. The `hindsight-all` notice-applicability case is resolved by its own official repository package-path MIT declaration and root LICENSE at npm gitHead, with no subdirectory notice/license override. The authoritative raw text is byte-identical to retained `src/vendor/LICENSE`; bundled version remains unknown. This is bounded attribution evidence, not blanket legal/privacy clearance; final candidate scanning remains the parent's responsibility.

The actual second-pass verification directory is `.verification/clean-install-3fd284cd-3de2-48b7-b4bc-beb01346d443`. Its `install.log`, `test.log`, `check.log` and `provenance.log` are retained locally and ignored. `npm install --ignore-scripts --no-audit --no-fund`, `npm test`, `npm run check`, `npm run check:provenance` each exited 0; tests: 8 passed, 0 failed/skipped. Installed `@earendil-works/{pi-durable,chord,pi-ai}` are each 1.0.2. All six public package exports also imported successfully via ordinary `import()` in that isolated tree (exit 0); `NODE_OPTIONS` was unset. The documented allowlist scan examined 36 files and reported four credential-assignment filter hits, all locally classified as `HINDSIGHT_API_TOKEN` environment-variable-name mappings, not credential values. No raw matching material was output. Offline checks do not attest real backend extraction, detached startup or host lifecycle correctness beyond the exercised fixtures.
