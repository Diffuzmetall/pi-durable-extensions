# Antigravity shim candidate

This is a **service candidate**, not a Pi Durable extension. It exposes the installed `pi-antigravity` provider through a loopback-only OpenAI Chat Completions endpoint. It preserves the upstream provider's request builder, model routing, thinking mapping, OAuth/account failover, SSE parsing, and catalog by loading its sources through `hooks.mjs`.

## Status

`candidate` / `needs_checks`. This retained staging package has not been published, committed, installed into Pocket, enabled as a service, or tested against a live account. Stable redistribution remains blocked by licensing and independent verification gaps retained privately outside the distributed package. The common repository root catalog and generated bundle catalog record package versions and exact packed-artifact SHA-256 metadata only; they are not raw-evidence manifests.

## Requirements

- Node `>=22.15.0`; measured locally with Node `v24.19.0`.
- The upstream `pi-antigravity` package and its source tree, currently observed at version `0.10.0`.
- A Pi auth/account setup created by the upstream provider when making real requests. The shim reads `antigravity-accounts.json` read-only and never accepts or logs a client credential.
- A host that supports Node's loader hooks and `stripTypeScriptTypes`.

The package is intentionally private and has no runtime dependency copy. `pi-antigravity` is a required peer/source dependency and must be installed separately by the host's normal Pi package flow. No Pi Pocket import or Pocket host API is used.

## Setup and manual run

From this candidate directory:

```sh
node run.mjs
```

Optional configuration:

```sh
PI_CODING_AGENT_DIR="$HOME/.pi/agent" \
PI_ANTIGRAVITY_DIR="$HOME/.pi/agent/npm/node_modules/pi-antigravity" \
ANTIGRAVITY_SHIM_HOST=127.0.0.1 \
ANTIGRAVITY_SHIM_PORT=18790 \
node run.mjs
```

The service binds to `127.0.0.1` by default. It serves `/healthz`, `/v1/models`, `/v1/chat/completions`, and `/chat/completions`. It does not start from installation, modify `models.json`, enable a systemd unit, or install a background service.

To print the provider catalog for an explicit host action:

```sh
node scripts/emit-models.mjs
```

`--write` mutates the host's `models.json` and is deliberately not part of candidate verification. The supplied systemd unit is reference-only; no enable/start action is authorized here.

## OpenAI-compatible example

With the service already started by an explicit operator action:

```sh
node examples/openai-client.mjs
```

The example only calls the local endpoint. It does not start the service or contact a live provider.

## Testing

```sh
npm test
```

The translation tests are deterministic and do not use credentials or network. The fixture-service test starts two retained local child processes: a fake upstream event server and the shim on isolated loopback ports. It exercises `/healthz`, `/v1/models`, streaming text, tool-call deltas, non-streaming output, unknown-model rejection, and malformed JSON rejection. `ANTIGRAVITY_SHIM_FIXTURE_URL` is accepted only when `NODE_ENV=test` and the URL is loopback; it is a test seam and never replaces the real upstream path in normal service mode.

A bare OpenAI-compatible `fetch` client is included in the example/test. A bare `@earendil-works/pi-ai` client was not run because the installed SDK is outside this candidate's dependency resolution; this is recorded as an unavailable check, not a PASS.

## Security and limits

- Loopback binding is the default and the service is not an access-control boundary for other local users.
- The request `Authorization` header is ignored; the shim owns upstream auth.
- OAuth tokens, account email, project id, request bodies, and model responses are not written to evidence or logs.
- The catalog is a snapshot of the installed extension; live discovery is not exposed by this service.
- Upstream tools such as search, image generation, and usage commands are not bridged.
- Live upstream/auth/model behavior, account failover, quota handling, and real Pi Durable provider registration remain unverified in this candidate.
- The service does not provide a Pocket adapter, UI, launcher, or service supervisor.

Private source hashes, compatibility observations, and verification receipts remain outside the distributed package. Use the common repository root catalog and generated bundle catalog for package/version/artifact SHA-256 metadata; those catalogs do not carry raw source evidence.
