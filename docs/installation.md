# Installation routes

U5 distributes exact packed artifacts. The root `catalog.json` is a checked-in baseline metadata catalog; it does **not** claim that `artifacts/` exists in this checkout. A working bundle has its own generated catalog and artifact directory.

## Build a working bundle

Choose a new caller-owned absolute path. The path must not exist, be a symlink, or contain foreign files:

```sh
BUNDLE=/absolute/new/pi-durable-bundle
node scripts/pack-all.mjs --output "$BUNDLE"
```

The command creates `$BUNDLE` and `$BUNDLE/artifacts` with mode `0700`, packs all nine packages using `npm pack --ignore-scripts`, makes generated files mode `0600`, computes SHA-256 from those exact tarballs, and writes `$BUNDLE/catalog.json`. It refuses an existing output root and never removes or overwrites a previous bundle.

Use the generated catalog with the standalone CLI:

```sh
node packages/cli/src/index.mjs list \
  --catalog "$BUNDLE/catalog.json" --allow-experimental
node packages/cli/src/index.mjs doctor \
  --catalog "$BUNDLE/catalog.json" --json
```

The catalog paths are relative to the bundle (`artifacts/<filename>`). No registry publication, URL, private sandbox path, or artifact-copy assumption is involved. Rebuild into another new output path when source or package metadata changes.

## Supported manual route

The package candidates preserve TypeScript source exports. Node 24 intentionally refuses type stripping for files inside `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Therefore this is **not** a supported route for these candidates:

```sh
npm install ./some-package.tgz
node -e "import('some-package')"
```

That failure is a Node/package-format limitation, not a reason to change candidate source semantics or add a compiler framework.

For the supported U5 route, unpack the exact hash-verified tarball into a new standalone target root **outside `node_modules`**, audit the gzip tar as regular-files/directories only, then install only runtime dependencies into that target:

```sh
TARGET=/absolute/new/manual-target
CACHE=/absolute/new/private-npm-cache
# TARGET and CACHE must not exist; use an exclusive private setup.
node scripts/manual-route-proof.mjs \
  --bundle "$BUNDLE" --output /absolute/new/manual-proof
```

The proof command performs the complete route for each catalog entry:

1. Reads the bundle catalog and verifies each tarball SHA-256.
2. Creates a fresh private target and cache with exclusive paths.
3. Audits archive members, rejects symlinks/hardlinks/traversal/non-regular entries, and extracts package files directly into the target root.
4. Runs the following runtime-only install from that target, using the same verified tarball as the local package input so declared runtime and peer dependencies are materialized, with isolated config and cache:

   ```sh
   npm install --prefix "$TARGET" --ignore-scripts --bin-links=false \
     --omit=dev --workspaces=false --no-audit --no-fund \
     --cache "$CACHE" --userconfig /dev/null \
     --globalconfig /nonexistent/pi-durable-extensions-global.npmrc \
     "$ARTIFACT"
   ```

   Fresh consumers may download anonymous public dependencies from the npm registry during this step. The route is not claimed to be network-free and does not force `--offline` on an empty cache.
5. Imports the packed entry from the target root. TypeScript entries use Node's `--experimental-strip-types` against the unpacked target path; existing JavaScript entries use normal Node imports.
6. Runs the package's faux/local example where one exists. These examples make no live provider, backend, account, quota, external Hindsight service, microphone, or detached-service calls. The Antigravity live-only example is not run.
7. Runs the standalone CLI from the unpacked target with `--catalog "$BUNDLE/catalog.json"`.

`manual-route-proof.mjs` records commands, exits, archive counts, target-file counts, and logs in its new private proof directory. A target-root import demonstrates the supported unpacked-source route; it must not be reported as proof that a TypeScript package imports normally from `node_modules`. The installed copy under `node_modules` exists only to supply runtime dependencies and is not the import target.

## CLI installation route

For a selected artifact, use the generated bundle catalog and a new non-root target:

```sh
node packages/cli/src/index.mjs install codemode \
  --catalog "$BUNDLE/catalog.json" \
  --target /absolute/new/install-target \
  --version 0.1.0-candidate.0 \
  --allow-experimental
```

The CLI verifies the exact artifact hash, uses `--ignore-scripts`, `--bin-links=false`, `--omit=dev`, isolated npm configuration, retained staging, Linux directory-fd anchoring, and no-clobber publication. Installation does not activate components or start services.

U6 clean-target distribution acceptance remains separate and is not claimed by this document.
