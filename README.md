# Pi Durable Extensions

**Add the tools you need to Pi Durable—without a Pi Pocket installation.**

Select one component. Install its exact packed artifact. Connect it to your
host. The collection includes code execution, web and documentation tools,
service adapters, and a selective installer. Pocket-specific integration stays
separate from portable packages.

- **Selective:** each component has its own package, entry point, and requirements.
- **Explicit:** your host controls authorization, credentials, and activation.
- **Inspect before install:** the CLI lists components, reports requirements,
  and validates artifacts with `--dry-run`.

This is a **candidate collection**, not a stable npm release or a Pocket
distribution. Package versions alone do not indicate stable status.

[Components](#choose-a-component) · [Quick start](#quick-start) ·
[DCG guard](#dcg-guard-integration-candidate) · [Limits](#limits-and-verification) ·
[Development](#development) · [Contributions](#contributions)

## Choose a component

The [catalog](catalog.json) in this checkout contains ten components.
Open a component's README for its API, host capabilities, and activation steps.
DCG is a `candidate` with one checked-in canonical archive and scoped archive/API verification.

| Component | Kind | Version | Use it for |
|---|---|---|---|
| [codemode](packages/codemode/README.md) | extension | `0.1.0-candidate.0` | QuickJS scripts with nested tool calls and conversation-scoped storage |
| [agent-mail](packages/agent-mail/README.md) | adapter | `0.0.0-candidate.1` | A fixed-loopback Agent Mail MCP connection with host-controlled write authority |
| [codex-api](packages/codex-api/README.md) | adapter | `0.1.0-candidate` | Codex Ask, Search, Image, and Usage through explicit host authorization |
| [agent-profiles](packages/agent-profiles/README.md) | adapter | `0.1.0-candidate.0` | A Markdown profile parser and catalog, without a launcher or private profiles |
| [web-tools](packages/web-tools/README.md) | extension | `0.1.0` | Web search and page fetch tools |
| [context7](packages/context7/README.md) | extension | `0.1.0-candidate.1` | Library documentation through the Context7 MCP service |
| [antigravity-shim](packages/antigravity-shim/README.md) | service | `0.1.0-candidate.20261012` | A separately provisioned local OpenAI-compatible service |
| [codex-voice](packages/codex-voice/README.md) | adapter | `0.1.0-candidate` | A bounded transcription transport, without microphone UI |
| [hindsight](packages/hindsight/README.md) | adapter | `0.1.0` | Memory integration through explicit registry and lifecycle capabilities |
| [dcg-guard](packages/dcg-guard/README.md) | extension | `0.1.0` | Fail-closed shell protection with an owner-provisioned DCG binary |

The separate [CLI](packages/cli/README.md), `portable-pi-cli`
`0.1.0-candidate.2`, provides `list`, `info`, `install`, and `doctor`.
It does not count as a component. The Agent Mail entry is an MCP adapter,
not an Agent Mail identity bridge.

Extensions need explicit registry installation. Adapters also need their
documented host capabilities. The service needs separate provision and startup.
Installation does not enable Pocket modules, create credentials, or start services.

## Requirements

- Repository and CLI baseline: **Node.js `>=24.19.0`**.
- Recorded integration environment: **Linux x64, Node `24.19.0`, npm `11.17.0`**.
- CLI installation uses Linux directory-fd semantics, `/proc/self/fd`, and GNU
  coreutils `/usr/bin/mv`. The recorded `mv` version is `9.5`.
- Each package retains its own runtime requirements. Most Durable integrations
  use `1.1.0`. Hindsight uses the distinct Durable/Chord/Pi AI `1.0.2` tuple.

These versions describe recorded environments, not compatibility with every
Node, Durable, or operating-system version. Refer to the package README and
[compatibility notes](docs/compatibility.md).

## Quick start

### 1. Inspect the source catalog

This general quickstart also applies to the original nine-component baseline.
DCG instructions need a checkout that contains `packages/dcg-guard`.
Do not assume that a default-branch clone includes DCG before its feature PR merges.

```sh
git clone https://github.com/Diffuzmetall/pi-durable-extensions.git
cd pi-durable-extensions

node packages/cli/src/index.mjs list \
  --catalog "$PWD/catalog.json" --allow-experimental
node packages/cli/src/index.mjs info codemode \
  --catalog "$PWD/catalog.json"
```

`list` shows only stable entries by default. The baseline has no stable entries,
so use `--allow-experimental` to display its candidate and experimental components.

This feature checkout includes **one canonical DCG tarball** under `artifacts/`.
The other nine component entries and the CLI retain historical artifact metadata,
not a complete checked-in bundle. Their tarballs need a generated bundle.
A full-catalog doctor report against the checkout can report those missing artifacts.
Use the [canonical DCG route](#install-the-canonical-dcg-candidate) for the included asset.

### 2. Create a local artifact bundle

Select new absolute paths outside the checkout. Their parents must already
exist. Do not reuse an output directory or an installation target.

```sh
BUNDLE="$HOME/pi-durable-bundle-01"
TARGET="$HOME/pi-codemode-target-01"

node scripts/pack-all.mjs --output "$BUNDLE"
node packages/cli/src/index.mjs doctor codemode \
  --catalog "$BUNDLE/catalog.json" --json
```

The pack script uses `npm pack --ignore-scripts` for the other nine components
and the CLI. For DCG, it verifies the root catalog pin and copies the checked-in
canonical archive byte-for-byte. It refuses an existing output root and writes
a generated catalog with SHA-256 digests of the exact tarballs.
It does not publish packages or install the root workspace.
This DCG delivery did not include a full eleven-package bundle run.

### 3. Validate, then install one component

```sh
node packages/cli/src/index.mjs install codemode \
  --catalog "$BUNDLE/catalog.json" \
  --target "$TARGET" --version 0.1.0-candidate.0 \
  --allow-experimental --dry-run

node packages/cli/src/index.mjs install codemode \
  --catalog "$BUNDLE/catalog.json" \
  --target "$TARGET" --version 0.1.0-candidate.0 \
  --allow-experimental
```

A dry run validates prerequisites and the artifact digest. It creates no staging
directory, runs no npm install, and starts no service.

The actual install uses a private dependency prefix and cache. It disables
lifecycle scripts and bin links. Public dependency downloads can occur.
The installer refuses foreign files, unsafe archives, and target conflicts.
Failure staging remains available for inspection. An intact, identical prior
installation is a no-op.

For another component, select its exact ID and version from the generated
catalog. Supply `--allow-experimental` for candidate or experimental entries.

### CLI reference

Use `node packages/cli/src/index.mjs` as the command prefix from this checkout.
Use the same explicit catalog throughout an installation: the root catalog for
the checked-in DCG asset, or the generated bundle catalog for bundled artifacts.

| Command | Example arguments | Purpose |
|---|---|---|
| `list` | `--catalog "$BUNDLE/catalog.json" --allow-experimental` | Display selectable components |
| `info` | `codemode --catalog "$BUNDLE/catalog.json"` | Display one component's requirements and activation boundary |
| `install` | `codemode --catalog "$BUNDLE/catalog.json" --target "$TARGET" --version 0.1.0-candidate.0 --allow-experimental --dry-run` | Validate an exact installation without materialization |
| `doctor` | `codemode --catalog "$BUNDLE/catalog.json" --target "$TARGET" --json` | Report runtime, artifact integrity, and target state |

`doctor` does not probe external services or certify host activation.
Without a component ID, `doctor` examines the full catalog, including blocked entries.
`--allow-experimental` does not override a `blocked` installation status.
Refer to [CLI safety and resource limits](packages/cli/README.md).
The archive limits do not impose quotas on npm dependency materialization.

### Manual route and host activation

The [manual installation procedure](docs/installation.md) describes archive
inspection, digest verification, extraction, and runtime dependency installation.
It also provides `scripts/manual-route-proof.mjs` for local fixture checks.

Several packages export TypeScript source. Node refuses type stripping inside
`node_modules`. Import those entries from an extracted target outside
`node_modules`, with the documented Node flags. Do not assume that a normal
`npm install` makes every candidate importable by package name.

1. Read the selected package's README.
2. Import its documented entry from the installed target.
3. Supply the required host capabilities and authorization policy.
4. Register the component explicitly in your Durable host.

Your host supplies models, storage, and the execution environment. Package
installation does not supply those capabilities. No Pocket core change is necessary
for a bare-Durable integration.

## DCG guard: integration candidate

The [dcg-guard package](packages/dcg-guard/README.md) adds destructive-command
protection to the selected Durable `bash` operation. Its catalog status is
`candidate`. The package is private, not a published npm release.

**Canonical archive:** [pi-pocket-dcg-guard-0.1.0.tgz](artifacts/pi-pocket-dcg-guard-0.1.0.tgz),
**9,532 bytes**, **seven first-party files**. Both catalogs and CLI trust metadata
pin this SHA-256:

```text
e8f98754876383f425e42e95cb6bc9fc889f78e57d77544eeb1eeeba6a7bfe5b
```

The publisher produced the archive with GNU tar/gzip, not npm.
`npm pack` creates a different DCG artifact, not this verified candidate.
The bundle script copies the canonical asset instead of a new npm archive.

### Install the canonical DCG candidate

Use a feature checkout that contains `packages/dcg-guard` and the canonical asset.
A default-branch clone does not establish DCG availability before the feature PR merges.
Choose a fresh absolute target with an existing parent.

**Pass the root catalog explicitly.** The CLI default is
`packages/cli/catalog.json`. Its relative artifact paths do not locate the
checked-in archive at the repository root.

```sh
DCG_TARGET="$HOME/pi-dcg-guard-target-01"

node packages/cli/src/index.mjs info dcg-guard \
  --catalog "$PWD/catalog.json"

node packages/cli/src/index.mjs install dcg-guard \
  --catalog "$PWD/catalog.json" \
  --target "$DCG_TARGET" --version 0.1.0 \
  --allow-experimental --dry-run

node packages/cli/src/index.mjs install dcg-guard \
  --catalog "$PWD/catalog.json" \
  --target "$DCG_TARGET" --version 0.1.0 \
  --allow-experimental
```

These commands document the guarded installer route, not a fresh npm installation
result. Installation does not provision DCG, configure policy, register the guard,
or enable Pocket. For a generated bundle, consistently use `$BUNDLE/catalog.json`
instead. Its DCG asset must retain the canonical digest.

The standalone guard uses the public DCG robot CLI protocol. It examines the actual
prepared shell command and cwd before it forwards the operation. Only a consistent
allow verdict permits execution. Denial, evaluator failure, and unsupported
protocol results stop the operation.

**Admitted tuple:** local POSIX Node environment, Node `>=24.19.0`,
`@earendil-works/pi-durable` `1.1.0`, and **DCG `0.15.3`**.
The package exports compiled ESM from `dist/`. It does not download DCG,
install itself, or change Durable/Pocket core.

### Bare Durable registry example

Before you provision or invoke DCG, obtain operator/legal review of its pinned
**MIT License (with OpenAI/Anthropic Rider)**. Applicability remains unverified.
The first-party adapter's MIT grant does not establish legal clearance for the
external executable. Refer to the package [NOTICE](packages/dcg-guard/NOTICE).

Provision an executable DCG `0.15.3` binary separately only after that review.
Select absolute paths as trusted owner configuration, not from model-controlled arguments.

Create a dedicated evaluator root with `home/`, `config/`, and `data/`
directories. Give `policy.toml` and `system-allowlist.toml` comment-only contents:

```toml
# Dedicated guard policy. No allow rules.
```

### Policy pack coverage

The comment-only policy uses DCG's default core packs: `core.git` and
`core.filesystem`. It **does not enable GitHub deletion protection**.
Selecting the guard alone does not extend the classifier's pack coverage.

For protection against `gh repo delete`, the owner must explicitly select
`platform.github` in the dedicated `policy.toml`. This documentation example
retains the core packs and adds no allow rules:

```toml
[packs]
enabled = ["core.git", "core.filesystem", "platform.github"]
```

Use this selection only after owner approval and host admission for the pinned
binary and policy. Keep `system-allowlist.toml` comment-only. Do not change
production settings through this example. The current comment-only Pocket policy
alone does not establish GitHub deletion protection.

Disk and database coverage need their corresponding packs. Select those packs
only when necessary, with explicit owner policy and admission. Pack selection
does not create grants or directory-scoped allowlists.

Keep `config/dcg/allowlist.toml` absent. Do not copy existing owner DCG settings
or grant data. Do not add directory-scoped allowlists.

### Registry setup

After owner admission of the binary, policy, and host composition, use this
registry setup in your bare-Durable host. Replace the absolute paths before use.

```js
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createDcgGuard } from "/absolute/path/to/installed-dcg-guard/dist/index.js";

const registry = createRegistry();
const root = "/absolute/path/to/dcg-guard-state";
registry.install(CodingTools);
registry.install(createDcgGuard({
  binaryPath: "/absolute/path/to/dcg",
  evaluatorEnv: {
    HOME: `${root}/home`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    DCG_CONFIG: `${root}/policy.toml`,
    DCG_ALLOWLIST_SYSTEM_PATH: `${root}/system-allowlist.toml`,
    DCG_ALLOW_ONCE_PATH: `${root}/data/allow-once.jsonl`,
    DCG_PENDING_EXCEPTIONS_PATH: `${root}/data/pending-exceptions.jsonl`,
  },
}));
```

Pass this registry to your host's Harness setup. The factory accepts exactly two
options: `binaryPath` and `evaluatorEnv`. There is no default binary lookup or
public timeout option. Host admission must confirm the selected bash implementation,
trusted shell setup, and extension composition.

### Guard limits and grants

| Boundary | Fixed limit |
|---|---|
| Evaluator deadline | `2,000 ms`, separate from the bash tool timeout |
| Framed command input | `65,536 bytes`, including the two-byte terminator |
| Evaluator stdout | `1,048,576 bytes` |
| Evaluator stderr | `65,536 bytes` |

Exact-command, single-use owner grants use the dedicated grant store. The guard
does not create, cache, replay, or refund grants. Evaluation can consume a grant
before cancellation or a crash prevents shell execution.

This is **not a sandbox**. It does not protect arbitrary MCP/file mutations,
opaque script contents, or process launches outside the admitted Durable execution
path. It does not support remote/container environments, Windows, PowerShell,
Bun, or untested Durable versions. Directory-scoped policy parity is excluded.
It does not guarantee zero OS-level process spawns during downstream cancellation.

### Optional Pocket drop-in

The separate package example is [pocket/dcg-guard.ts](packages/dcg-guard/pocket/dcg-guard.ts).
The intended no-core-write
layout places the unpacked helper at `<dataDir>/extensions/_dcg-guard/` and the
configured drop-in at `<dataDir>/extensions/dcg-guard.ts`. Its relative import
uses `./_dcg-guard/dist/index.js`.

Select a dedicated evaluator root and binary path before activation. Do not replace
Pocket's existing dependency link. Enable the drop-in only through the owner's
approved Pocket workflow. A helper-package change needs a fresh helper location
or an owner restart. A drop-in reload alone does not invalidate imported modules.

Historical standalone acceptance does not certify this archive's Pocket activation
or every loader/restart scenario. Historical evaluator timeouts remain unresolved
availability evidence, not successful checks.

## Limits and verification

Earlier collection checks covered local package tests, packed artifacts,
source review, and bounded CLI routes. Context7 also has a recorded bare-Durable
Harness proof and two live service calls. Refer to [provenance](docs/provenance.md)
for the baseline scope.

For the current DCG archive, independent checks verified all seven member bytes
and public factory/registry API imports. They reused physical public SDK peers:
Durable/AI/Chord `1.1.0` and SDK-scoped TypeBox `1.3.27`. This was not a fresh
outside dependency installation. Separate current-source tests covered seven cases,
and the canonical COPY function had three focused checks.

The historical standalone ISA `30/30` and full `33/33` test results retain their
earlier scope. They are not new collection-archive Harness or lifecycle checks.
Context7 and DCG manual-proof import mappings are source metadata, not runtime proof.
This delivery did not include a full eleven-package bundle, fresh npm-installer,
packed Harness, DCG evaluation, or Pocket database/lifecycle run.

These results apply only to their identified candidates and environments. They do
not certify all live services, Pocket startup/SQLite/restarts, or general compatibility.
Local fixtures and `MemoryStorage` do not prove restart persistence.
No stable npm publication or main merge is implied.

Important host boundaries:

- Context7 sends documentation queries to an external service. Its shared quota
  capacity and reset policy are unknown. Do not send secrets or private text.
- Codex tools need explicit host authorization and provider credentials.
- `codex-api` returns `<dataDir>/uploads/<conversationId>` without ID sanitization.
  Validate conversation IDs and resolved-path containment before file operations.
- Web tools retain their documented network limits. This collection does not
  claim new SSRF protection.
- Hindsight needs explicit lifecycle integration and separately configured memory services.
- The collection does not install Beads, Lancet, goals, schedules, triggers,
  or other Pocket built-ins.

Refer to [security boundaries](docs/security.md) and each component's README.

## Troubleshooting

| Symptom | Action |
|---|---|
| `list` shows no components | Add `--allow-experimental` for the baseline catalog |
| `doctor` reports missing artifacts | Create a fresh bundle and pass its generated catalog with `--catalog` |
| Install refuses a version or target | Use the exact catalog version and a new absolute target with an existing parent |
| `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | Use the documented extracted-source route outside `node_modules` |
| DCG returns `DCG_UNAVAILABLE:timeout` | Stop. Examine the binary, dedicated evaluator state, and fixed deadline. Do not bypass the guard |
| DCG returns `DCG_DENIED` | Respect the refusal. Use only the owner's exact-command grant procedure if authorized |

## Development

The root scripts do not install dependencies or run every package's test suite.
Use an isolated development copy for package dependencies and runtime checks.

```sh
# Read-only public-tree boundary check
npm run check

# Local fixtures, after package-local dependency setup
npm --prefix packages/cli test
npm --prefix packages/codemode run check
npm --prefix packages/codemode test

# Artifact and manual-consumer checks: each output path must be new
npm run pack -- --output /absolute/new/pi-durable-bundle
npm run manual-proof -- \
  --bundle /absolute/new/pi-durable-bundle \
  --output /absolute/new/pi-durable-manual-proof
```

The standalone DCG package defines `typecheck`, `build`, `test`, `test:dcg`,
`test:consumer`, and `test:pocket`. Real-DCG, consumer, and Pocket checks need
explicit prerequisites. `test:dcg:excluded` is the unsupported scoped-policy
counterexample, not a release acceptance check. Do not report it as a passing
supported-policy case. Build emits ESM and declarations under `dist/`.

## Contributions

Issues and pull requests are welcome as proposals. Include reproduction steps,
the component version, the runtime tuple, and the expected behavior for bug reports.
Do not include credentials or private data.

The repository owner and authorized agents control repository writes and
publication. A submitted proposal does not grant direct write access.

## License

[MIT](LICENSE), copyright © 2026 Diffuzmetall, for this collection's own code
and documentation. Third-party and vendored files retain their own licenses.
Refer to [NOTICE.md](NOTICE.md) and package-local license and attribution files.
Some candidate packages retain unresolved or `UNLICENSED` metadata. The root
license does not override those boundaries or grant rights to external products.
