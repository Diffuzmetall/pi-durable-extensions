# Notices and third-party licensing

The root license of this repository is **MIT** (see [LICENSE](LICENSE)). It
covers the code and documentation authored for this collection.

Third-party components, vendored files, and bundled dependencies keep their own
licenses and notices. Those notices are preserved package-locally and are **not**
relicensed by the root MIT grant.

## Per-package boundaries

| Package | Licensing scope |
|---|---|
| `codemode` | MIT — see `packages/codemode/LICENSE` and `packages/codemode/NOTICE.md` |
| `web-tools` | MIT — see `packages/web-tools/LICENSE` |
| `hindsight` | MIT package license (`packages/hindsight/LICENSE`) plus third-party notices in `packages/hindsight/THIRD_PARTY_NOTICES.md` and `packages/hindsight/licenses/*.txt`; vendored files under `packages/hindsight/src/vendor/` retain their own provenance (`PROVENANCE.md`, `LICENSE`) |
| `antigravity-shim` | MIT — the retained upstream notice `packages/antigravity-shim/notices/pi-antigravity-LICENSE.txt` is MIT, Copyright (c) 2026 Rahul Arya |
| `agent-mail` | `packages/agent-mail/LICENSE` retains the upstream source's apparent MIT text as attribution evidence; it does not relicense third-party code |
| `agent-profiles` | see `packages/agent-profiles/NOTICE.md` |
| `codex-api` | see `packages/codex-api/NOTICE.md` — attribution is limited to the scope stated there and is not extended to host wiring |
| `codex-voice` | see `packages/codex-voice/NOTICE.md` |
| `cli` (`portable-pi`) | MIT, part of this collection |

## Bundled dependency licenses

`packages/hindsight/licenses/*.txt` carries the license texts for the
dependencies bundled into the packed Hindsight artifact (ajv, ajv-formats,
fast-deep-equal, fast-uri, json-schema-traverse, zod, zod-to-json-schema,
mcp-sdk). Those texts govern those files only.

## No broader grant

Nothing in this repository grants rights to Pi Pocket, Pi Durable, Pi AI, Chord,
the Codex/OpenAI service, the Agent Mail service, Antigravity, or any other
external product or service. Referencing those names describes interoperability
only.
