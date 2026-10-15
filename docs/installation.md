# Installation routes

U5 distributes exact packed artifacts. The root `catalog.json` pins one checked-in canonical artifact, `artifacts/pi-pocket-dcg-guard-0.1.0.tgz`; the other ten component and CLI entries remain baseline metadata for a generated bundle. The checkout is not a complete twelve-package bundle.

## Build a working bundle

Choose a new caller-owned absolute path. The path must not exist, be a symlink, or contain foreign files:

```sh
BUNDLE=/absolute/new/pi-durable-bundle
node scripts/pack-all.mjs --output "$BUNDLE"
```

The command creates `$BUNDLE` and `$BUNDLE/artifacts` with mode `0700`. It packs the ten non-DCG components and CLI using `npm pack --ignore-scripts`; for DCG it copies the checked-in canonical archive byte-for-byte after checking the root catalog digest, refusing an existing destination. Generated files have mode `0600`, their exact SHA-256 values populate `$BUNDLE/catalog.json`, and the bundle contains twelve packages. It refuses an existing output root and never removes or overwrites a previous bundle. This full bundle command was not rerun for the DCG repository delivery; the DCG copy route is verified separately.

Use the generated catalog with the standalone CLI:

```sh
node packages/cli/src/index.mjs list \
  --catalog "$BUNDLE/catalog.json" --allow-experimental
node packages/cli/src/index.mjs doctor \
  --catalog "$BUNDLE/catalog.json" --json
```

The catalog paths are relative to the bundle (`artifacts/<filename>`). No registry publication, URL, private sandbox path, or artifact-copy assumption is involved. Rebuild into another new output path when source or package metadata changes.

## Supported manual route

Some package candidates preserve TypeScript source exports; `dcg-guard` is compiled ESM with declarations. Node 24 intentionally refuses type stripping for TypeScript files inside `node_modules` with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Therefore this is **not** a supported route for the source-export candidates:

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
6. Runs the package's faux/local example where one exists. Context7 and DCG have import mappings only; no example, factory, evaluator or live-service call is selected for them. The eight older import mappings and existing example selections are unchanged. These examples make no live provider, backend, account, quota, external Hindsight service, microphone, or detached-service calls. The Antigravity live-only example is not run.
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

### DCG guard candidate

The `dcg-guard` candidate targets Node.js `>=24.19.0` and Pi Durable `1.1.0`. Its canonical archive SHA-256 is `e8f98754876383f425e42e95cb6bc9fc889f78e57d77544eeb1eeeba6a7bfe5b`, with seven first-party files (9532 bytes), pinned identically in both catalogs and CLI trust metadata. It was produced by manual GNU tar, not npm. Independent QA verified exact archive members against the frozen source and public factory/registry imports using reused physical public npm SDK peers; this is not a fresh outside install, full 33-test rerun, or packed Harness proof.

For this single checked-in artifact, use the root catalog explicitly and opt into candidate installation:

```sh
node packages/cli/src/index.mjs install dcg-guard \
  --catalog "$PWD/catalog.json" \
  --target /absolute/new/dcg-target \
  --version 0.1.0 --allow-experimental
```

This documents the guarded installer route; no fresh npm installation run is claimed here. An owner must separately provision DCG `0.15.3` and dedicated evaluator paths. Installation does not install the binary, configure policy, register or enable the extension. External DCG's qualified MIT license includes an OpenAI/Anthropic Rider whose applicability requires operator/legal review before executable provisioning or use; the first-party adapter's MIT grant is not legal clearance for that separate executable. The package README documents the public setup, separate Pocket drop-in and compatibility limits. Pocket enablement remains an explicit owner action.

The current ten-component plus CLI full bundle and manual-proof route were not executed for this delivery. U6 clean-target distribution acceptance remains separate and unpassed here; syntax checks and import mappings do not establish it.
