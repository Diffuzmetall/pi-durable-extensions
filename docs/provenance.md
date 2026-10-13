# Sanitized provenance

This U5 tree was assembled from the accepted local candidate trees after the final-three-gates receipt. Candidate source and behavior receipts remain in the private sandbox prep area and are not copied into this public tree.

## Frozen inputs

- Inventory baseline: `inventory-v3.json` (the original eight active components plus deferred Context7); the current public tree promotes the accepted Context7 candidate as the ninth active component and the accepted `agent-mail-identity` candidate as the tenth.
- Baseline: `baseline-v3.json` and its current hash register.
- Runtime observed for integration: Linux x64, Node `24.19.0`, npm `11.17.0`.
- Component package hashes are recomputed before copy and compared against the retained post-copy manifest. Drift stops U5 rather than being normalized.

## Public boundary

The public tree contains package source, examples, tests, notices and applicable licenses only where the source receipt supports that scope. It excludes `node_modules`, private profiles, root provenance and verification receipts, journals, evidence, generated fixture output, audio, uploads, databases, runtime configuration, credentials, and source checkouts. Hindsight vendor attribution files are retained only where they are part of the public vendor/license boundary; private evidence is retained outside this repository.

## Status

Context7 promotion adds fixture and real bare-Durable Harness verification, including a bounded two-call live-service proof. Its licence is MIT, granted by the copyright holder for this collection's own first-party code, so no upstream grant was needed; the repository still makes no stable or registry-distribution claim for it.

The `agent-mail-identity` promotion adds the accepted identity, watcher and fail-closed Pocket entry point as the tenth component, with its package tests (110 tests on Node `24.19.0`), typecheck and static boundary lint as the local evidence, and its `test:live:*` and `bench` lanes left deliberately unavailable (exit 2 with a stated reason). Its first-party MIT grant comes from the copyright holder like the rest of this collection's own code. The candidate's 336 MiB of retained fixture runtime scratch and its run logs and delivery reports stay outside this public tree; only the three frozen SHA-256 candidate manifests and the single bounded CLI fixture script are carried so that the package's own checks remain runnable here. No live Agent Mail call, Pocket wake, benchmark measurement, or Mail-project effect is claimed.

The broader tree still does not certify U7 Pocket adapter compatibility, other live providers, accounts, devices, service deployment, legal redistribution, or publication.
