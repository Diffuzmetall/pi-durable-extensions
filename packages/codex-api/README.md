# Codex API candidate for Pi Durable

**Status: experimental candidate; not a stable or published distribution.**

This package extracts the Codex Ask, Search, Image, and manual Usage tools from
Pi Pocket into a host-independent Pi Durable extension. The core receives two
explicit capabilities:

- `authorize(request)`: fail-closed trust-boundary authorization for the current conversation.
- `uploadRoot(conversationId)`: optional root for current-conversation uploads. Omit it to disable upload-path inputs.

The core does not import Pi Pocket, read `dataDir`, inspect requesters, read
configuration, use a terminal initializer, or provide a paid/API-key fallback.
A structural `createPocketAdapter({ dataDir, requesterOf })` is available as an
optional adapter; it preserves the owner-role and per-conversation upload
semantics without importing Pocket modules.

## Requirements and setup

Observed and locally checked only:

- Node `v24.19.0` (candidate engine range: `>=24.19.0 <25`)
- `@earendil-works/pi-durable` `1.1.0`
- `@earendil-works/pi-ai` `1.1.0`
- `@earendil-works/chord` `1.1.0`
- `typebox` `1.3.27`
- `@types/node` `26.6.5` for the local check

The host must provide native Models OAuth for provider `openai-codex`. This
candidate never reads token files and never falls back to a paid API route.
There are no startup requests, polling loops, subscription calls, credit
inventory, redemption, or service startup.

For a retained local checkout:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

`npm test` includes a real `@earendil-works/pi-durable` Harness run with a
scripted native Models transport and isolated loopback fixture responses. It is
not evidence of access to a real subscription or backend. The test intentionally
retains generated fixture artifacts; it does not run cleanup or deletion.

## Embedding

```ts
import createCodexApi, { createPocketAdapter } from "@pi-durable/codex-api-candidate";

const host = {
  authorize: async ({ conversationId, api }) => {
    // Enforce the embedding application's owner/requester policy.
    return await policy.allows(conversationId, api);
  },
  uploadRoot: (conversationId) => uploads.rootFor(conversationId),
};

registry.install(createCodexApi(host));
```

Pocket owners may use the optional structural adapter instead:

```ts
registry.install(createCodexApi(createPocketAdapter({
  dataDir,
  requesterOf: (conversationId) => pocketRequesterOf(conversationId),
})));
```

The adapter is deliberately opt-in. It is not required by the core and does
not enable an extension or alter host settings.

## Safety and limits

- Ask, Search, Image, and Usage are `replay: "unsafe"`; interrupted calls must
  not be automatically retried or regenerated.
- Native Codex OAuth is checked before model/auth/workspace access. Missing or
  non-OAuth authorization fails closed.
- Ask forwards only its explicit prompt and selected images. `max_output_tokens`
  is rejected because the installed native provider cannot enforce it; visible
  answer text is bounded to 60,000 characters.
- Remote requests have exact endpoint/method allowlists, no redirects,
  no automatic retries, 180-second deadline, and 160 MiB JSON bounds.
- Image paths are regular files under the real cwd or the explicit current
  upload root, with `/proc/self/fd` containment checks and a 20 MiB per-image,
  five-image limit. URLs are never downloaded as image inputs.
- Image output is bounded, canonical PNG only, rejects indexed PNG, and refuses
  existing output paths. Pending artifacts are retained; automated cleanup is
  not performed.
- Search output, citations, inline-image hints, and conversation-scoped
  browsing IDs retain the source semantics. Inline search images are omitted.
- Usage returns only quota windows, never account IDs, credentials, credits, or
  raw backend bodies.

No live auth, real subscription, production Pocket process, Pocket data, or
external quota was used for this candidate. Disk/process restart persistence
and live-provider acceptance remain outside this candidate's local evidence.
Private source/provenance/verification receipts are retained outside the distributed package. The common repository root catalog and generated bundle catalog record package versions and exact packed-artifact SHA-256 metadata only; they are not raw-evidence manifests.
