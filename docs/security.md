# Security and side-effect boundaries

The collection keeps trust-boundary behavior in package cores and explicit host capabilities. It does not add a universal authorization framework.

- Codemode keeps sandbox, hooks, cancellation, output/file bounds, unsafe replay and conversation-scoped durable storage semantics.
- Agent Mail requires the exact loopback MCP endpoint, rejects custom headers/redirects, and marks only health operations replay-safe.
- Codex API requires explicit authorization, native OAuth, bounded inputs/outputs, contained images and no paid fallback.
- Profiles rejects traversal, escaped symlinks, malformed/duplicate YAML, non-regular files and oversized files. Owner/private profiles are not distributed.
- Web tools retain their existing network/extraction limitations; this collection does not claim new SSRF hardening.
- Antigravity is a separately provisioned loopback service; package installation does not start it or modify provider configuration.
- Voice uses bounded in-memory audio and an explicit test fetcher only in fixtures; it does not persist recordings or add microphone UI.
- Hindsight creates private paths with mode/owner checks, bounded no-follow cache reads, explicit bind/admission/shutdown ordering and retained outbox semantics. Same-UID ancestor attacks outside the trusted host scope are a documented non-goal.
- CLI verifies catalog SHA-256, rejects unsafe archive entries, uses `--ignore-scripts`, isolated config/cache, fresh retained staging, Linux directory-fd anchoring and no-clobber publication. It fails closed on unsupported platform semantics.
- Agent Mail identity binds one existing Mail identity to one conversation under a host-owned in-memory grant, never reads a mail body into a wake batch, never marks mail read or acknowledged, carries no credentials in arguments or state, and its Pocket entry point refuses (`missing_host_capability`) rather than degrading when the host lacks a live capability. Its listing calls `am` with explicit `--project` and `--agent` and fails closed on an unservable cursor or an unexpected page.

No credentials, private profiles, audio, uploads, databases, runtime logs, Pocket settings, production Agent Mail state, or live service quota belong in this public tree. Failure staging is retained rather than deleted.
