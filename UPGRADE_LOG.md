# Pi Durable 1.2 compatibility migration

## Result and scope

All ten catalog components and the selective installer are adapted and locally verified against the published Pi `1.2.0` family. Registry version was checked at the start and again after verification. Observed environment: Linux x64, Node `24.19.0`, npm `11.17.0`.

The initial migration was prepared on branch `fix/pi-durable-1.2-compat`, based on upstream `4a6fafb4cadc355c9270a7ec87206dedd93d13ac`. The original checkout and live host settings were not edited. GitHub delivery was subsequently authorized separately; npm publication, real account access and host/service activation remain excluded.

## Changes

- Pin Pi-dependent packages and their runtime peers to the verified `1.2.0` tuple. Pi-independent Agent Profiles retains its own runtime requirements.
- Return Durable model-visible tool `output`, not legacy `content`. MCP wire and model-message `content` remain unchanged.
- CodeMode uses invocation-bound `api.executeTool`, preserving native validation, hooks, caller restrictions, replay, cancellation and structured values. Its sandbox, output/image bounds, private spill and successful-only durable store remain intact.
- Hindsight's vendored atomic cache temporary file is created with `0600`; strict private-file checks are not relaxed. The single vendored delta is documented in `packages/hindsight/licenses/PI12_PATCH.md`; original license/provenance records remain intact.
- Antigravity resolves its installed peer before the legacy global fallback, preserving the explicit directory override. Only fixture service startup is tested; the readiness budget accommodates SDK 1.2 startup.
- Update the installer's hard-coded canonical artifact hashes, exact peer manifests and pins. Oversize Hindsight admission remains conjunctively bound to the exact archive/member; unrelated oversize and untrusted peers are still refused.
- Modernize fixture APIs/examples and remove machine-specific QA-file/module assumptions. Add declared check/test/compiler dependencies where missing.
- `npm run check:compat` uses independent copied package installs, ignores lifecycle scripts, sanitizes inherited npm lifecycle configuration, retains private streamed logs and refuses a zero-test success. Fixtures do not call optional live provider/DCG/Pocket test lanes.
- Refresh lockfiles, compiled package entries, all eleven archives, root/embedded catalogs and compatibility documentation.

## Verification

| Component | Node test cases passed | Additional evidence |
|---|---:|---|
| codemode | 7 | Typecheck; real native nested bash/structured result/caller policy/hooks; SQLite store reopen; image/spill bounds |
| agent-mail | 4 | Typecheck; real Harness/MCP loopback; model-visible result; cancellation and endpoint/header refusal |
| codex-api | 6 | Typecheck; controlled provider/transport fixtures, no paid call |
| agent-profiles | 6 | Typecheck and compiled build |
| web-tools | 3 test files | Typecheck; Harness, parser/transport/output-bound fixture assertions |
| context7 | 11 | Typecheck; MCP JSON/SSE, credential/error/cancellation/bounds fixtures |
| antigravity-shim | 5 | OpenAI translation and independently started/stopped loopback fixture service |
| codex-voice | 10 | Typecheck; fixture transcription reaches the Harness model; global fetch forbidden |
| hindsight | 13 | Syntax checks; real Harness admission/reload/memory; private cache and lifecycle fixtures |
| dcg-guard | 33 | Typecheck/build; inert evaluator/recorder, deny/refusal/cancellation/TOCTOU/class-identity checks |
| CLI | 25 | Expanded canonical Codex/Hindsight tests enabled; zero skips; exact pins, public-npm materialization, fd/symlink/oversize/no-clobber guards |

Total: 123 Node test cases/file entries passed across the packages and expanded CLI suite; no failed or skipped cases in the combined accepted evidence. Web-tools also runs assertions inside its three test-file entries.

All ten fresh component archives were installed through the updated selective installer into independent extracted targets. Their documented entries import with Node, and installed Pi dependencies are `1.2.0`. No component was registered into the active BB host. Root/embedded component metadata and final artifact digests are checked for agreement. The final CLI archive is checked against its reviewed source.

`npm audit --omit=dev` reported zero advisories for the eleven isolated dependency trees. This is dependency-database evidence only, not an audit of bundled vendor code or authorization of external providers. Public-tree and owned-diff whitespace checks pass. No dedicated repository-wide lint command exists.

## Review

Three independent read-only BB reviews covered reuse, quality and efficiency. Four justified cleanups were applied: shared caller predicate, obsolete mock memo/import removal, and bounded streamed verification logs. No guard was weakened.

The actual `ce-code-review` attempt terminated before review: its in-turn collection requirement conflicts with the mandatory asynchronous delegation protocol. It is **not** a passed full CE review. `Code review: harness-native fallback` — OCR delegate preview/rules plus host diff/body/caller review; 34 eligible source/manifest/test files accounted for, no remaining actionable blockers. Receipt: `docs/reviews/pi12-native-review.json`. Generated archives/locks are assessed through deterministic integrity/runtime checks rather than raw line review.

## Retained local evidence

A fresh pre-publication sweep again passed all 123 cases/file entries with zero
failures and skips. Its report is `/tmp/pi12-compat-11WSVk/report.json`; the launcher
log is `/tmp/pi12-prepublish-complete.log`. To include the optional canonical
installer fixtures without activating services:

```sh
TMPDIR=/tmp \
PPC_U6_BUNDLE="$PWD" \
PPC_RUN_PUBLIC_NPM_PEER=1 \
PORTABLE_HINDSIGHT_ARTIFACT="$PWD/artifacts/pi-durable-hindsight-0.1.0.tgz" \
npm run check:compat
```

Local `/tmp` receipts are not distributed artifacts; use this command to reproduce
the checks in a fresh checkout. It downloads public npm dependencies.

- Full package sweep: `/tmp/pi12-compat-CUjoHA/report.json`; final CodeMode/Agent Mail checks: `/tmp/pi12-compat-tX6MWE/report.json`.
- Final shim check: `/tmp/pi12-compat-SqDxTO/report.json`.
- Expanded CLI check (all 25 cases): `/tmp/pi12-compat-PhvXAA/report.json`.
- Packed installation/import proof: `/tmp/pi12-installed-targets-v12/report.json`, `/tmp/pi12-installed-imports.log`.
- Fresh archive/catalog bundle: repository `artifacts/` and `catalog.json`; intermediate generation receipts are retained under `/tmp/pi12-extensions-bundle-*`.
- Failed CE review receipt is retained separately; the native fallback report records its limitation.

The initial safety stop after 26 failing legacy fixtures was explicitly cleared by the operator. Fixture contracts, permissions, startup readiness, installer pins and packaging were corrected; the failures were not suppressed.

## Host integration boundaries

TypeScript-source packages require an extracted target outside `node_modules` or a compatible TypeScript runtime; ordinary Node npm drop-in activation is not claimed. DCG deliberately requires the same physical admitted Durable runtime class; do not bypass it when combining separately resolved installations. See `docs/compatibility.md`.

Live provider credentials/quotas, microphone capture, Agent Mail/Hindsight services, real DCG/legal admission and Pocket/BB loader/restart activation remain separate host integration work, not silently accepted by these fixture/import checks.
