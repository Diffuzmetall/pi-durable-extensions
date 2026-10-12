# Codex Voice candidate

Candidate package for a bounded Codex subscription transcription transport and an explicit native Models voice adapter.

This is an **experimental candidate**, not an accepted Pocket microphone integration. It does not add a microphone button,
recording UI, autosend, browser fallback, retry/download surface, audio persistence, user-data reads, or credential-file
discovery. A host must pass its native `Models` capability and its existing microphone lifecycle explicitly.

## Scope

- `createCodexVoice({ models })` validates the host seam without reading auth or making a request.
- `transcribe(models, audio, signal, fetcher?)` validates supported in-memory audio, requires `openai-codex` OAuth,
  sends one fixed multipart request to `https://chatgpt.com/backend-api/transcribe`, and returns a bounded transcript.
- Cancellation stops voice admission and output insertion while an already-started native auth refresh may finish safely.
- Response bodies, errors, account claims, tokens, audio and transcript payloads are not logged or returned in diagnostics.
- The optional `fetcher` exists only for deterministic tests. Production callers use the global fetch and cannot change the
  fixed endpoint.

The adapter is host-neutral and contains no Pocket import. Pocket UI, session/owner authorization, generation invalidation,
provider enablement and installation are separate adapter/host gates. Fixture transcription proves neither a real account,
real subscription, device microphone, browser UI, nor live service availability.

## Requirements and setup

Observed baseline for this candidate: Node `v24.19.0`, `@earendil-works/pi-durable` `1.1.0`, and
`@earendil-works/pi-ai` `1.1.0` on Linux x64. The package declares Node `>=22.19.0` and peers `>=1.1.0 <1.2.0`,
but those ranges are requirements, not a compatibility proof; only the observed tuple is locally verified.

For retained local verification, from this directory:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
node examples/harness.mjs
```

The install is local and does not enable an extension, start a service, access credentials, or contact the transcription
endpoint. `node examples/harness.mjs` uses an in-memory real Pi Durable Harness, a faux model, explicit fixture Models,
and a fixture fetcher on no network path.

## Host use

```ts
import createCodexVoice from "@pi-durable-extensions/codex-voice";

const voice = createCodexVoice({ models: nativeModels });
const text = await voice.voice.transcribe(audioBlob, abortSignal);
```

The host remains responsible for sign-in, owner/session authorization, enabled-provider semantics, stale-result
invalidation, draft insertion, microphone permission and any production restart/enablement. Do not pass a browser or
user-data capability to this package. Do not replace a failed enabled provider with browser recognition.

## Verification boundary

The candidate tests cover import isolation, adapter construction, OAuth/API-key negative cases, audio and response bounds,
stream cancellation, error sanitization, no retry, and a real in-memory Harness invocation. They are deterministic fixture
checks only. Live subscription transcription, Pocket adapter compatibility, existing microphone/device behavior, package
installation from a packed collection, and production enablement remain unverified.

## Attribution and license

The bounded transport is substantially derived from get-bb/bb `desktop-v0.46.0` commit
`4c87fdec7b7effc022ff2ee31ec95c0a09c9ee62`, `plugins/provider-codex/src/ai/chatgpt-client.ts`, under the inherited MIT
notice in [`NOTICE.md`](./NOTICE.md). The new native Models adapter and package wiring have no separate license grant in this
candidate artifact. Candidate-only provenance and exact source hashes are retained in `provenance.json` in the leased source
tree and are deliberately excluded from the public package file allowlist. This candidate is not a publication or
redistribution authorization.
