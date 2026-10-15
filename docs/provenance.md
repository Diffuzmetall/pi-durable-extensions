# Sanitized provenance

This U5 tree was assembled from the accepted local candidate trees after the final-three-gates receipt. Candidate source and behavior receipts remain in the private sandbox prep area and are not copied into this public tree.

## Frozen inputs

- Inventory baseline: `inventory-v3.json` (the original eight active components plus deferred Context7); the current public tree promotes the accepted Context7 candidate as the ninth active component.
- Baseline: `baseline-v3.json` and its current hash register.
- Runtime observed for integration: Linux x64, Node `24.19.0`, npm `11.17.0`.
- Component package hashes are recomputed before copy and compared against the retained post-copy manifest. Drift stops U5 rather than being normalized.

## Public boundary

The public tree contains package source, examples, tests, notices and applicable licenses only where the source receipt supports that scope, plus one checked-in DCG canonical archive containing exactly seven first-party package files. It excludes `node_modules`, private profiles, root provenance and verification receipts, journals, evidence, generated fixture output, audio, uploads, databases, runtime configuration, credentials, and source checkouts. Hindsight vendor attribution files are retained only where they are part of the public vendor/license boundary; private evidence is retained outside this repository.

## Status

Context7 promotion adds fixture and real bare-Durable Harness verification, including a bounded two-call live-service proof. Its licence is MIT, granted by the copyright holder for this collection's own first-party code, so no upstream grant was needed; the repository still makes no stable or registry-distribution claim for it. The broader tree still does not certify U7 Pocket adapter compatibility, other live providers, accounts, devices, service deployment, legal redistribution, or publication.

## DCG guard source and license

The collection adds first-party `dcg-guard` source from the frozen local package. The accepted source hash is `b424d7ca1e88079187167b6ca5e0a33b4028a12e8a42c016ed8d8a5de238ae37`; its compiled `dist/index.js` and declaration remain byte-for-byte unchanged at `1ce69dc577f777383b1369ead281f46e03ec5c49a19dfa7c18c76b0bdaa72ff4` and `97c350b1af28fc427dac33f70263279e365851c3e47de9b19a058ff3f722d7dc`. Source imports public Pi Durable APIs and Node built-ins and invokes an external DCG executable; no DCG binary, Rust implementation, parser, rules, or upstream source is included. Per owner authorization, the collection root MIT license covers this first-party package code; the identical `LICENSE` and a package `NOTICE` are included. The external pinned DCG 0.15.3 executable is not redistributed. Its qualified MIT license includes an OpenAI/Anthropic Rider; applicability remains unresolved and requires operator/legal review before executable provisioning or use. No unrestricted-use or legal-clearance claim is made.

The earlier exact package archive (`49ac78458c6ebf7b7d4b22d7944f763e145289ec4bcd72858bb68c249e330d0c`) and its acceptance receipts remain historical, unchanged. The distinct collection archive at `artifacts/pi-pocket-dcg-guard-0.1.0.tgz` is 9532 bytes, SHA-256 `e8f98754876383f425e42e95cb6bc9fc889f78e57d77544eeb1eeeba6a7bfe5b`. It contains seven regular first-party files, including final README/NOTICE and unchanged compiled code/Pocket adapter, produced with GNU ustar/gzip (owner/group zero, epoch mtime) rather than npm. The public asset is an absent-first `COPYFILE_EXCL` copy of the independently verified private candidate, mode `0644`, with source and destination digests checked.

Independent archive/API QA verified all seven member bytes, frozen source/compiled pins, canonical package import, public factory and registry selection using reused physical public npm SDK peers (Durable/AI/Chord 1.1.0; SDK nested TypeBox 1.3.27). Separate source-only seven-test acceptance remains unchanged. This repository delivery does not claim a fresh outside installation, full 33-test run, packed Harness acceptance, DCG evaluation, database/lifecycle run or activation. Standalone ISA 30/30 and older behavior receipts describe their separately accepted scope, not new collection-archive behavior tests.

Both catalogs and CLI DCG trust metadata pin this new digest and seven entries. `scripts/pack-all.mjs` copies this catalog-pinned canonical DCG archive; its nine-other-component and CLI npm routes remain unchanged. The full eleven-package bundle command was not run for this delivery. Feature-branch publication and main integration remain separate gates; no main merge is implied.

## Search History source and migration

The eleventh component is promoted from the reviewed standalone candidate kept in the private sandbox (`packages/search-history`, MIT, adapted from `disler/durable-pi` @ `37165c619573dbaf425463038bbffecfe576beec`). Its parsing/filtering source, fixture suite, `LICENSE`, `NOTICE.md` and `VERIFICATION.md` are carried over unchanged; the package manifest gained the collection's pinned `1.2.0` peer and dev family and the two standard check/test scripts. The candidate's local Pocket drop-in and its own sandbox package remain untouched outside this repository.

The migration is one line in `src/index.ts`: a successful tool result returns `output` instead of `content`, matching `ToolExecutionResult` in Pi Durable `1.2.0`. Evidence for the change is recorded in `packages/search-history/VERIFICATION.md`: the unmodified candidate passes 9/9 on the `1.1.0` stack and 4/9 on `1.2.0`, with the recorded tool result carrying empty content, and the field rename confirmed in both installed distributions.

Both catalogs and the CLI trust metadata pin the archive `artifacts/diffuzmetall-pi-durable-search-history-0.1.0-candidate.0.tgz`, SHA-256 `deb3adc75ce312de8024a2af66bb3c15684174574cfc53378cf4dc6418e96906`, six entries, produced with `npm pack --ignore-scripts`. The full twelve-package bundle command was not rerun for this promotion; the compatibility sweep, the installer dry run and the package's own fixture checks are the fresh evidence.
