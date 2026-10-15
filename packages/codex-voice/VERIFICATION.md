# Re-verification against Pi Durable / Pi AI 1.2.0 — 2026-10-15

Status: re-audited on operator request ("make Codex Voice and Search History stack with the new
version"). No source change was required: the package already targets the 1.2.0 family and its seams
are version-stable. Candidate status unchanged.

## What was checked

- `npm run check:compat -- codex-voice` (private temporary copy): real `npm install --ignore-scripts`
  of the pinned 1.2.0 dev family, then `npm run check` (`tsc --noEmit -p tsconfig.json`, plus
  `node --check` on the example and every test file) and `npm test` — all exit 0.
- `node examples/harness.mjs` in the same 1.2.0 copy: real in-memory Pi Durable Harness with a faux
  model, explicit fixture Models and a fixture fetcher. Reported
  `{"settled":"done","invocations":1,"fixtureCalls":1,"globalFetchCalls":0,"response":"fixture harness complete","kinds":["pi.user","pi.system","pi.assistant","pi.tool-result","pi.assistant"]}`.

## Why the transport is 1.2.0-safe

The package never registers a Durable tool and never returns a tool execution result, so the 1.2.0
rename of the model-visible field (`content` to `output`) does not apply to it. It only consumes the
native Models seam, and that seam is unchanged between 1.1.0 and 1.2.0:

- `Models.checkAuth(providerId, options?)` and `Models.getAuth(providerId|model, overrides?)` have
  identical signatures in both installed distributions.
- `AuthCheck { source?: string; type: "api_key" | "oauth" }` and
  `AuthResult { auth: ModelAuth; env?; source? }` are byte-equivalent contracts, so the transport's
  `type !== "oauth"`, `source !== "OAuth"` and `auth.apiKey` checks behave the same on both.
- Peer declarations already pin `@earendil-works/pi-ai` and `@earendil-works/pi-durable` to `1.2.0`,
  and the installed collection artifact carries those pins (the selective installer validated the
  canonical peer declarations during install).

## Companion change in the same pass

`packages/cli/test/install.test.mjs` asserted an "active catalog has ten entries" state and failed
after the search-history promotion made the catalog eleven entries (11 !== 10). The assertion is now
eleven entries, keeps the Context7/DCG checks, and additionally pins search-history's package name,
version, digest, entry count and tested runtime tuple. The CLI suite then reported 22 passed, 3
pre-existing conditional skips, 0 failed.

## Limits

Not exercised: live Codex subscription transcription, a real account's OAuth refresh, a real
microphone/device path, Pocket adapter compatibility, and production enablement. Fixture results do
not imply those gates.
