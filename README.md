# Pi Durable Extensions

Tools and adapters for **Pi Durable 1.2.0**, packaged so you can install one component without installing Pi Pocket.

Run sandboxed tool scripts, fetch web pages, look up library docs, connect memory services, or add a shell guard. Each component has its own archive and API. Your host decides what to load and which capabilities to grant.

**Status: candidate collection.** The current catalog contains ten components and a separate installer CLI. None is marked stable; a package version such as `0.1.0` is not a stability guarantee.

[Components](#components) · [Quick start](#quick-start) · [Host integration](#host-integration) · [Verification](#verification) · [Documentation](#documentation)

## Components

| Component | Kind | What it provides |
|---|---|---|
| [CodeMode](packages/codemode/README.md) | Extension | QuickJS scripts with nested tool calls and conversation-scoped storage |
| [Agent Mail](packages/agent-mail/README.md) | Adapter | A fixed-loopback MCP connection with host-controlled write authority |
| [Codex API](packages/codex-api/README.md) | Adapter | Ask, Search, Image, and Usage tools through explicit host authorization |
| [Agent Profiles](packages/agent-profiles/README.md) | Adapter | A Markdown profile parser and catalog—not an agent launcher |
| [Web Tools](packages/web-tools/README.md) | Extension | Web search and page fetching |
| [Context7](packages/context7/README.md) | Extension | Library documentation through the Context7 MCP service |
| [Antigravity Shim](packages/antigravity-shim/README.md) | Service | A separately started, local OpenAI-compatible service |
| [Codex Voice](packages/codex-voice/README.md) | Adapter | A bounded transcription transport, without microphone UI |
| [Hindsight](packages/hindsight/README.md) | Adapter | Memory integration with explicit registry and lifecycle capabilities |
| [DCG Guard](packages/dcg-guard/README.md) | Extension | Fail-closed checks for an admitted Durable shell execution path |

Exact IDs, versions, artifact paths, and SHA-256 digests live in [`catalog.json`](catalog.json). The separate [`portable-pi-cli`](packages/cli/README.md) supplies `list`, `info`, `install`, and `doctor`.

The Agent Mail component is an MCP adapter, **not an identity bridge**. The collection does not include private agent profiles or install Pocket's Beads, goals, schedules, or other built-ins.

## Why use this collection?

- **Select only what you need.** Install a component rather than a complete application.
- **Inspect before installing.** Read its requirements, check the artifact, and run a dry run.
- **Keep the host in control.** Installation does not register tools, create credentials, enable extensions, or start services.

| Approach | Choose it when… |
|---|---|
| This collection | You have a Durable host and want selected packages with explicit integration boundaries. |
| Direct component integration | You want to manage source, dependencies, packaging, and admission yourself. |
| A Pi Pocket installation | You want the application and its built-in workflows, rather than a portable package collection. |

## Requirements

The recorded compatibility environment is **Linux x64, Node.js 24.19.0, npm 11.17.0, and Pi Durable 1.2.0**.

- The repository and CLI require **Node.js `>=24.19.0`**.
- The installer uses Linux directory-fd semantics, `/proc/self/fd`, and GNU `/usr/bin/mv`; the recorded coreutils version is `9.5`.
- Pi-dependent packages are pinned to the verified `1.2.0` family. Pi-independent packages have their own requirements.
- Several packages export TypeScript source. With native Node loading, use an extracted target **outside `node_modules`**, or a compatible TypeScript runtime. Ordinary npm drop-in loading is not supported for every package.

Other operating systems, runtime versions, and host compositions are not covered by this compatibility evidence. See [compatibility notes](docs/compatibility.md).

## Quick start

The repository includes the ten component archives and the CLI archive in [`artifacts/`](artifacts/). You do not need to rebuild a bundle to inspect or install them.

### 1. Inspect a component

```sh
git clone https://github.com/Diffuzmetall/pi-durable-extensions.git
cd pi-durable-extensions

node packages/cli/src/index.mjs list \
  --catalog "$PWD/catalog.json" --allow-experimental

node packages/cli/src/index.mjs info codemode \
  --catalog "$PWD/catalog.json"

node packages/cli/src/index.mjs doctor codemode \
  --catalog "$PWD/catalog.json" --json
```

`list` shows stable entries by default. Since this catalog has none, use `--allow-experimental` to see the candidate and experimental components.

### 2. Validate an installation

Choose a new absolute target outside the checkout, with an existing parent directory. Change this example path if it is already in use.

```sh
TARGET="$HOME/pi-codemode-target-01"

node packages/cli/src/index.mjs install codemode \
  --catalog "$PWD/catalog.json" \
  --target "$TARGET" --version 0.1.0-candidate.0 \
  --allow-experimental --dry-run
```

A dry run checks prerequisites and the artifact digest. It creates no staging directory, installs no dependencies, and starts no service.

### 3. Install the package when ready

```sh
node packages/cli/src/index.mjs install codemode \
  --catalog "$PWD/catalog.json" \
  --target "$TARGET" --version 0.1.0-candidate.0 \
  --allow-experimental
```

The installer uses a private dependency prefix and cache, with lifecycle scripts and bin links disabled. It may download public npm dependencies. It refuses unsafe archives, foreign files, and conflicting targets; an intact identical installation is a no-op.

**Always pass the catalog explicitly.** The CLI's embedded catalog has relative paths that do not locate the root checkout's artifacts. Use the same selected catalog throughout inspection and installation. `--allow-experimental` does not override a blocked entry.

For another component, take its exact ID and version from the catalog. For manual extraction, see [installation](docs/installation.md).

## CLI reference

Run these commands from the repository root. Examples use CodeMode; substitute another catalog ID as needed.

| Command | Example | Purpose |
|---|---|---|
| `list` | `node packages/cli/src/index.mjs list --catalog "$PWD/catalog.json" --allow-experimental` | List selectable components |
| `info` | `node packages/cli/src/index.mjs info codemode --catalog "$PWD/catalog.json"` | Show requirements and activation boundaries |
| `install` | See the dry-run and installation commands above | Validate or materialize an exact component |
| `doctor` | `node packages/cli/src/index.mjs doctor codemode --catalog "$PWD/catalog.json" --target "$TARGET" --json` | Report artifact integrity and target state |

`doctor` does not probe external services or certify activation. Without an ID, it examines the full catalog, including blocked entries. Archive limits are not quotas on npm dependency materialization. See the [CLI reference and safety limits](packages/cli/README.md).

## Host integration

**Installing a package is not connecting it to Durable.** Your application must import its entry point, supply the documented capabilities, and register it explicitly.

```text
catalog + archive → verified installation target
                                ↓
               host capabilities + explicit registration
                                ↓
                         Durable Harness
```

1. Read the component's README for its entry point and factory API.
2. Import it from the installed target using a supported loading method.
3. Supply the required models, authorization, storage, execution environment, or lifecycle hooks.
4. Register it in your host. Provision and start any external service separately.

There is no universal configuration file that activates all ten components. A bare-Durable integration does not require Pocket core changes, but this collection does not provide automatic BB/Pocket loader integration.

Use **one admitted physical Durable runtime** for the host composition. In particular, DCG checks runtime-class identity; a second copy at the same version is not interchangeable. Do not bypass that check.

### DCG Guard

DCG Guard is an additional protection layer, **not a sandbox**. It checks the prepared command and cwd before forwarding the selected Durable shell operation. Denial, evaluator failure, or an unsupported protocol stops that operation.

- The external DCG `0.15.3` executable is **not included or downloaded**. Before provisioning or invoking it, obtain operator/legal review of the pinned **MIT License (with OpenAI/Anthropic Rider)**; applicability remains unverified. See the [NOTICE](packages/dcg-guard/NOTICE).
- Use the exact catalog-pinned archive. The bundle script copies it byte-for-byte; `npm pack` produces a different artifact.
- Admission requires a trusted local POSIX Node host, the selected bash implementation, and a separate evaluator state root. Do not reuse owner configuration, allowlists, or grants. Do not add directory-scoped allowlists.
- The comment-only policy enables the default core Git/filesystem packs. It does **not** establish GitHub deletion protection; additional packs require explicit owner selection and admission.
- The evaluator deadline is `2,000 ms`; framed command input is capped at `65,536` bytes, stdout at `1,048,576` bytes, and stderr at `65,536` bytes. These are fixed guard limits, separate from the bash timeout.
- Exact-command, single-use grants remain in a dedicated store. Evaluation can consume a grant before cancellation prevents execution; the guard does not create, cache, replay, or refund grants.
- Coverage excludes arbitrary MCP/file mutations, opaque script contents, and direct process launches outside the admitted path. Remote/container environments, Windows, PowerShell, Bun, and untested Durable versions are not supported. Downstream cancellation is not an OS-level no-spawn guarantee.

Factory options, isolated policy setup, Pocket drop-in layout, reload constraints, and the full admission conditions are in the [DCG package guide](packages/dcg-guard/README.md). Historical real-DCG and Pocket results are not fresh acceptance of this collection's current archive.

## Verification

The Pi `1.2.0` migration passed **123 Node test cases/file entries** across ten components and the expanded CLI suite, with no failures or skips in the accepted evidence. All ten component archives were installed into independent extracted targets and their documented entries imported; all eleven archive digests were checked.

These are package, fixture, and installation results—not proof of live credentials, paid quotas, microphone access, external services, real DCG admission, or BB/Pocket activation. Local fixtures and `MemoryStorage` do not prove restart persistence. The full CE review did not complete; the documented native review fallback is not a passed CE review.

See the [upgrade log](UPGRADE_LOG.md) for per-package evidence, reproduction commands, and review limitations. Earlier checks retain their historical scope in [provenance](docs/provenance.md). This is not a stable npm release.

## Security and service boundaries

- The host owns credentials and authorization. Installation grants neither.
- Context7 sends documentation queries to an external service; do not send secrets or private text. Shared quota capacity and reset policy are unknown.
- Codex upload paths require host-side conversation-ID validation and resolved-path containment checks.
- Web Tools do not claim new SSRF protection.
- Hindsight requires lifecycle integration and a separately configured memory service.

Read [security boundaries](docs/security.md) before enabling a component.

## Development

```sh
# Check the public repository boundary; no dependency installation.
npm run check

# Install dependencies in private temporary copies and run local fixture suites.
npm run check:compat

# Build a separate artifact bundle. The output must not exist; its parent must.
npm run pack -- --output /absolute/new/pi-durable-bundle

# Run the manual-consumer proof against that bundle, with a fresh output path.
npm run manual-proof -- \
  --bundle /absolute/new/pi-durable-bundle \
  --output /absolute/new/pi-durable-manual-proof
```

The compatibility sweep disables dependency lifecycle scripts and does not run optional live provider/DCG/Pocket lanes. It retains private logs and a report in its temporary directory. The 123-case result includes optional canonical installer fixtures; use the environment settings in [UPGRADE_LOG.md](UPGRADE_LOG.md) to reproduce that expanded run.

The bundle script packs the other nine components and the CLI with `npm pack --ignore-scripts`, verifies the DCG pin, and copies its canonical archive. It writes matching digests without publishing packages or activating a host.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `list` is empty | Add `--allow-experimental`; the current catalog has no stable entries. |
| `doctor` cannot find an archive | Pass the root catalog explicitly, or the catalog from your generated bundle. |
| Installation refuses a target or version | Use the exact catalog version and a new absolute target with an existing parent. |
| Node reports `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | Load TypeScript from an extracted target outside `node_modules`, or use a compatible TypeScript runtime. |
| Installed tools do not appear | The package still needs explicit host registration and its required capabilities. |
| DCG returns `DCG_UNAVAILABLE:timeout` | Stop and inspect the binary, isolated evaluator state, and fixed deadline. Do not bypass the guard. |
| DCG returns `DCG_DENIED` | Respect the refusal; use only the owner's authorized exact-command grant procedure. |

## FAQ

**Do I need Pi Pocket?** No. These packages target a Durable host; Pocket-specific examples are separate.

**Does installation enable an extension?** No. Registration, authorization, lifecycle wiring, and service startup are host responsibilities.

**Can I use ordinary npm installation for every package?** No. Several entries export TypeScript source and need the extracted-target route or a compatible TypeScript runtime.

**Are these stable packages?** No. Consult the catalog status, not just the package's version string.

**Does `doctor` verify my running host?** No. It checks the declared package and installation boundaries, not live service or loader behavior.

## Documentation

- [Installation and manual extraction](docs/installation.md)
- [Runtime compatibility](docs/compatibility.md)
- [Security boundaries](docs/security.md)
- [Pi 1.2 migration evidence](UPGRADE_LOG.md)
- [Source provenance](docs/provenance.md)
- [Catalog](catalog.json) and [packed artifacts](artifacts/)

## Contributions

Issues and pull requests are welcome as proposals. For bug reports, include reproduction steps, the component version, runtime tuple, and expected behavior. Do not include credentials or private data.

The repository owner and authorized agents control writes and publication. A proposal does not grant direct write access.

## License

[MIT](LICENSE), copyright © 2026 Diffuzmetall, for this collection's own code and documentation. Third-party and vendored files retain their own licenses; see [NOTICE.md](NOTICE.md) and package-local notices.

Some candidate packages retain unresolved or `UNLICENSED` metadata. The root license does not override those boundaries or grant rights to external products.
