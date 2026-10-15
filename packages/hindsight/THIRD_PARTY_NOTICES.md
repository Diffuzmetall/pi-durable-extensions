# Third-party notices for the extraction whitelist

These notices supplement, and do not replace, the original [Pi MIT license](LICENSE) (Copyright (c) 2025 Mario Zechner) and [Hindsight MIT license](src/vendor/LICENSE) (Copyright (c) 2025 Vectorize AI, Inc.). Preserve both original files when distributing this source. New project files are MIT, Copyright (c) 2026 pi-durable-hindsight contributors.

## Scope and evidence

The complete executable vendor whitelist is **five** files, not six: `src/vendor/{pi.mjs,daemon-start.js,deepen.js,mcp-server.js,survey-supervisor.js}`. The remaining upstream package JSON is metadata, not a sixth executable bundle. All bytes of these five files were scanned for source headers, including every `node_modules/` occurrence, not just selected dependencies. The complete ordered header inventory, bundle hashes, license-source versions and copied-text hashes are in [licenses/EVIDENCE.json](licenses/EVIDENCE.json). Node built-ins are not separately redistributed here. Upstream `src/` headers belong to the retained Hindsight source. The Pi 1.2 compatibility migration adds one local cache-permission patch to `pi.mjs`; see [local patch](licenses/PI12_PATCH.md). The hashes in EVIDENCE.json describe the original extracts, not this locally patched bundle.

There are 80 dependency source headers in `pi.mjs` (Zod), 212 in `mcp-server.js` (the eight packages below), one in `daemon-start.js` (hindsight-all), and none in `deepen.js` or `survey-supervisor.js`. There are no other dependency names in the complete header inventory. The fast-uri license additionally retains the original uri-js/Gary Court attribution; do not discard it.

Exact bundle releases are **unknown**, except Zod's embedded v4 version object explicitly reports **4.4.3** in both `pi.mjs` and `mcp-server.js`. Its bundled v3 compatibility implementation is part of that Zod package, not evidence of a separately resolved v3 package. License-source versions below identify the artifacts from which notice text was obtained, **not** invented bundled version attestations. The root clean-install lockfile describes runtime peers, not the dependency tree used to build Hindsight 0.8.0.

## Collected license texts

| Embedded package | Evidence in bundle | License / attribution | Text source (not bundled-version claim) |
| --- | --- | --- | --- |
| `zod` | `pi.mjs`, `mcp-server.js`: `node_modules/zod/{v3,v4}/...` | [MIT](licenses/zod.txt), Copyright (c) 2025 Colin McDonnell | Official npm `zod@4.4.3` tarball `package/LICENSE`; embedded v4 version verified |
| `@modelcontextprotocol/sdk` | `mcp-server.js`: `node_modules/@modelcontextprotocol/sdk/dist/esm/...` | [MIT](licenses/mcp-sdk.txt), Copyright (c) 2024 Anthropic, PBC | Trusted installed package `@modelcontextprotocol/sdk@1.32.1`, `LICENSE` |
| `ajv` | `mcp-server.js`: `node_modules/ajv/dist/...` (including schema JSON artifacts) | [MIT](licenses/ajv.txt), Copyright (c) 2015-2021 Evgeny Poberezkin | Trusted installed `ajv@8.20.0`, `LICENSE` |
| `ajv-formats` | `mcp-server.js`: `node_modules/ajv-formats/dist/...` | [MIT](licenses/ajv-formats.txt), Copyright (c) 2020 Evgeny Poberezkin | Trusted installed `ajv-formats@3.0.1`, `LICENSE` |
| `fast-deep-equal` | `mcp-server.js`: `node_modules/fast-deep-equal/index.js` | [MIT](licenses/fast-deep-equal.txt), Copyright (c) 2017 Evgeny Poberezkin | Trusted installed `fast-deep-equal@3.1.3`, `LICENSE` |
| `fast-uri` | `mcp-server.js`: `node_modules/fast-uri/{index.js,lib/...}` | [BSD-3-Clause](licenses/fast-uri.txt), Copyright (c) 2011-2021 Gary Court and 2021-present The Fastify team; original notices and contributor link retained | Trusted installed `fast-uri@3.1.8`, `LICENSE` |
| `json-schema-traverse` | `mcp-server.js`: `node_modules/json-schema-traverse/index.js` | [MIT](licenses/json-schema-traverse.txt), Copyright (c) 2017 Evgeny Poberezkin | Trusted installed `json-schema-traverse@1.0.0`, `LICENSE` |
| `zod-to-json-schema` | `mcp-server.js`: `node_modules/zod-to-json-schema/dist/esm/...` | [ISC](licenses/zod-to-json-schema.txt), Copyright (c) 2020 Stefan Terdell | Trusted installed `zod-to-json-schema@3.25.0`, `LICENSE` |

All eight texts are byte-for-byte filesystem copies or bytes extracted from the official registry tarball; no copyright lines or disclaimers were synthesized. Hashes and portable source descriptions are in `licenses/EVIDENCE.json`. Downloaded source artifacts remain in ignored `.verification/license-artifacts/`; no package scripts were run for notice collection.

## Verified repository license coverage: hindsight-all

`daemon-start.js` contains the exact header `// node_modules/@vectorize-io/hindsight-all/dist/index.js`. The bundled version is unknown; the retained Hindsight metadata declares `^0.8.6`, which is a range, not a resolved version. Official registry `@vectorize-io/hindsight-all@0.8.6` declares `license: "MIT"`, author Vectorize, repository `https://github.com/vectorize-io/hindsight.git`, directory `hindsight-all-npm`. Its tarball contains **no LICENSE, COPYING or NOTICE file**. Tarball SHA-256: `003e0ec59b237943a0115e38ad047f19a256a516a457006485b3b21db5039397`; `package/package.json` SHA-256: `37f954a4c6e0db1c3c1ed6099f047eae66c04035d917f49081ed9b220f4d2ccf`.

Verified on 2026-10-11 through the official npm registry and read-only GitHub API: npm metadata supplies `gitHead` **08995e3013858e705fb4ca27c0ade3a286ef4750**. At that immutable commit, `hindsight-all-npm/package.json` identifies this package/version/repository directory and declares MIT; its SHA-256 equals the tarball package manifest hash above. `hindsight-all-npm/src/index.ts` identifies the lifecycle module exports, and the package README also states MIT. The complete, non-truncated repository tree has no LICENSE, COPYING or NOTICE override anywhere under `hindsight-all-npm/`; the inspected package manifest and README state no different license or exception.

The original repository-root [LICENSE](https://github.com/vectorize-io/hindsight/blob/08995e3013858e705fb4ca27c0ade3a286ef4750/LICENSE), Git blob **8dce7b4d4c2632990bdf8b4101694ea19ba6ad46**, is MIT, Copyright (c) 2025 Vectorize AI, Inc. It covers the package directory without an explicit exception and is **byte-identical** to the already-retained [src/vendor/LICENSE](src/vendor/LICENSE), SHA-256 `01fde0bedf83bdc185065d7af524a61690efe576a67f922eaff3a1280c17b63a`; no duplicate or synthesized notice is needed. Preserve that full original permission, copyright and disclaimer text for the bundled module. Immutable source/blob and coverage evidence are recorded in `licenses/EVIDENCE.json`.

This resolves the header-identified notice-applicability case. The bundled hindsight-all version remains **unknown**: 0.8.6 is the inspected license-source snapshot, not a resolved bundle-version claim. Original repository MIT coverage is attribution evidence, not blanket clearance for unexamined artifacts, future dependency changes or runtime privacy; the parent owns the final publication candidate scan.
