# Pi Durable Extensions

Ten independently selectable components for Pi Durable, plus a small selective
installer/doctor CLI. Each component is packaged and installed on its own; nothing
here is a Pi Pocket built-in, and nothing activates providers, services, or
Pocket modules by itself.

- **Not** a Pi Pocket distribution and not a replacement for Pocket built-ins.
- No component starts a service, opens a microphone, calls a provider, or reads
  a host data directory unless the host explicitly grants that capability.
- Every component ships its own README with host capabilities, authorization,
  external services and limitations.

## Contents

| ID | Kind | Version | What it does |
|---|---|---:|---|
| `codemode` | extension | `0.1.0-candidate.0` | Portable QuickJS sandbox extension; the Pocket adapter stays separate |
| `agent-mail` | adapter | `0.0.0-candidate.1` | Fixed-loopback Agent Mail MCP bridge; write authority stays host-controlled |
| `codex-api` | adapter | `0.1.0-candidate` | Codex Ask/Search/Image/Usage with explicit authorization and upload capability |
| `agent-profiles` | adapter | `0.1.0-candidate.0` | Markdown profile parser/catalog; no launcher, no bundled profiles |
| `web-tools` | extension | `0.1.0` | Search/fetch extension with its documented network limits |
| `context7` | extension | `0.1.0-candidate.1` | Context7 documentation MCP bridge with explicit credential-file capability |
| `antigravity-shim` | service | `0.1.0-candidate.20261012` | Local OpenAI-compatible service, provisioned and started separately |
| `codex-voice` | adapter | `0.1.0-candidate` | Bounded transcription transport; no microphone UI |
| `hindsight` | adapter | `0.1.0` | Trusted lifecycle/registry adapter; external memory setup stays separate |
| `agent-mail-identity` | extension | `0.1.0-candidate.0` | Durable identity binding plus a read-only mailbox watcher; the Pocket entry point refuses without host capability |

`packages/cli` holds `portable-pi`, a separate selective installer/doctor with
`list`, `info`, `install` and `doctor`. It is not one of the ten components.

## Requirements

- Linux x64 (observed runtime: Node `24.19.0`, npm `11.17.0`)
- Node `>=22.19.0` for components that declare it (`codemode`); Node `>=24.19.0`
  for `agent-mail-identity`
- No global install, no workspace symlinks: install one package from its packed
  artifact into its own target.

Per-package runtime tuples are authoritative. Most components use Pi
Durable / Pi AI / Chord `1.1.0`; Hindsight uses `1.0.2`. These are measured
tuples, not a universal compatibility claim.

## Quick start

```sh
git clone https://github.com/Diffuzmetall/pi-durable-extensions
cd pi-durable-extensions

# What is in the collection
node packages/cli/src/index.mjs list --allow-experimental
node packages/cli/src/index.mjs info codemode

# Check a catalog artifact without installing anything
node packages/cli/src/index.mjs install codemode \
  --target "$PWD/.scratch/target" --version 0.1.0-candidate.0 --dry-run

# Install into a private target with a private npm cache
node packages/cli/src/index.mjs install codemode \
  --target "$PWD/.scratch/target" --version 0.1.0-candidate.0

# Integrity / inventory report
node packages/cli/src/index.mjs doctor --json
```

`--dry-run` creates no staging, runs no npm and starts nothing. Experimental and
candidate packages require explicit opt-in (`--allow-experimental`).

The CLI installs a component into the target you name, resolves that component's
declared peer dependencies into a private prefix, and copies them into the
target. It never installs the root workspace, never uses a workspace symlink and
never assumes a neighbouring package is present.

## Using a component in a host

1. Install the exact packed artifact (or the package directory) into your host.
2. Import the package's documented entry point from the installed path — not
   from a source checkout.
3. Provide the host capabilities the component declares (data directory,
   requester lookup, authorization policy, upload root).
4. Wire auth, providers, Pocket modules, or service startup yourself, explicitly.

Each package README lists its entries, host capabilities, examples and hard
boundaries. `packages/*/examples/` contains runnable local examples that use
fixtures instead of live services.

## Verification

What was verified locally for this tree:

- Package tests and packed-artifact installation for the original eight components.
- Context7 fixture tests, a real bare-Durable Harness example, two live Context7 tool calls through that Harness, and a packed artifact with a pinned digest.
- `agent-mail-identity` package tests (110 tests on Node `24.19.0`), its TypeScript typecheck, its static boundary lint, and its three fail-closed gates (`test:live:am1`, `test:live:am2`, `test:live:pocket`, `bench`), each exiting 2 with a stated reason. No live Mail call, Pocket wake, or benchmark number was produced.
- Independent source review and an independent behavioral QA pass over the
  distribution manifest, component digests, and CLI routes.
- `portable-pi list / info / doctor / install --dry-run` against the catalog in a
  private environment.

What is **not** verified and should not be assumed:

- Live Pocket loader/startup, SQLite, drop-in activation, or restarts.
- `agent-mail-identity`'s live lanes: no live Agent Mail project, no live Pocket wake, no performance budget. Its mailbox effect comes only from its own bounded CLI fixture, and one of its tests reads the recorded Agent Mail MCP catalog from a sibling `pi-durable-agent-mail` checkout.
- Live providers, accounts, quotas, microphones, or third-party services beyond the bounded two-call Context7 proof documented above.
- Importing the `codex-api` package with Node from `node_modules` fails with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` because the package ships
  TypeScript sources; run it from an extracted package directory or a Bun
  runtime, as its README describes.
- `codex-api`'s `uploadRoot(conversationId)` returns
  `<dataDir>/uploads/<conversationId>` verbatim. It does not sanitise the id: an
  id containing `..` resolves outside the uploads root. Hosts must validate
  conversation IDs and enforce resolved-path containment before any file
  operation.
- General compatibility beyond the measured runtime tuple.

See `docs/installation.md`, `docs/compatibility.md`, `docs/security.md` and
`docs/provenance.md`.

## Licensing

MIT for this collection's own code and documentation — see [LICENSE](LICENSE).
Third-party components, vendored files and bundled dependencies keep their own
licenses; see [NOTICE.md](NOTICE.md) and the package-local LICENSE / NOTICE /
THIRD_PARTY_NOTICES files. Context7 is MIT like the rest of this collection's own first-party
code; no stable or registry-distribution claim is made for it either. No rights are granted to Pi Pocket, Pi Durable, Pi AI,
Chord, the Codex/OpenAI service, the Agent Mail service, Antigravity, or any
other external product.
