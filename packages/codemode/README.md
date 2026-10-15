# Portable codemode candidate

This candidate packages Pi Pocket's codemode behavior for a bare Pi Durable Harness. It is **experimental** and is not a stable or published distribution.

## Requirements

- Node.js `>=22.19.0`; this candidate was measured on Node `v24.19.0`.
- Pi Durable `1.2.0` and its peer runtime packages, installed by this package's manifest.
- A Pi Durable `Harness` and registry supplied by the embedding application.

## Setup

```sh
npm install --ignore-scripts
npm test
npm run check
```

Use the package in a Harness without Pocket imports:

```ts
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import createCodemode, { installCodemode } from "@pi-durable-extensions/codemode";

const registry = createRegistry();
installCodemode(registry); // rejects occupied extension/tool names
const harness = await Harness.open(new MemoryStorage(), { registry, models }, BACKGROUND_CONTEXT);
```

`createCodemode()` returns the extension for hosts that manage installation themselves. Bare Durable keeps the tool name `codemode`; an adapter can pass a different name. `installCodemode()` checks the registry immediately before installation and rejects any occupied extension or tool name rather than replacing it.

## Preserved behavior and limits

- Scripts execute in the `@earendil-works/pi-codemode` QuickJS sandbox: no Node, filesystem, network, or timers.
- Nested calls use the selected tools' argument validation, before/after hooks, per-call memo scope, output limits, and cancellation signal.
- The tool is `replay: "unsafe"`; interrupted calls are not replayed by Durable.
- `store()`/`load()` use the package-owned `CodemodeStoreDoc` (`kind: codemode.store`), scoped to the conversation. Writes commit only after a successful script; failed scripts do not commit store changes.
- Output is bounded. The configured `max_output_tokens * 4` budget covers the bounded captured payload text (including the rejection warning) and decoded image bytes; at most 100 images are retained, and malformed or over-budget images are rejected with a bounded warning. The independently host-generated header and full-output spill pointer remain visible in `ToolExecutionResult.content` but are excluded from that captured-payload budget. Full overflow text is retained in a private `0700` temporary directory with a new `0600` file; `details.fullOutputPath` remains available. Cleanup is intentionally not automated by this candidate.
- The configured codemode tool is excluded from the callable tool list, preventing recursion.
- Harness tests use deterministic faux models and local tools/fixtures only. `MemoryStorage` proves behavior but not restart durability. The retained SQLite restart gate is requested separately and is not implied by the author test run.
- This package does not provide Pocket host authorization, UI, built-in name reservations, live services, model credentials, or service startup. Embeddings must supply their own authorization and registry policy.

## Status

Candidate only. No publication, production activation, Pocket restart, live provider, credential, upload, or external quota is part of this package. Private source/provenance/verification receipts are retained outside the distributed package. The common repository root catalog and generated bundle catalog record package versions and exact packed-artifact SHA-256 metadata only; they are not raw-evidence manifests.
