# Local verification — 2026-10-13

Status: locally verified candidate, locally installed and live-dispatch checked in the current conversation; not published.

## Final checks

- `node --test --test-reporter=spec packages/search-history/test/search-history.test.mjs`: PASS 9/9, zero failures/skips, final rerun duration 1323.770683 ms.
- `node /home/ubuntu/Projects/pi-pocket/node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --module NodeNext --moduleResolution NodeNext --target ES2023 --allowImportingTsExtensions packages/search-history/src/index.ts packages/search-history/src/history.ts`: PASS, no diagnostics. External existing TypeScript 6.0.3 used without installing dependencies.
- No workspace-wide test/typecheck/lint configuration found: sandbox is not a Git checkout and has no root package.json. Package has scoped node:test only; no configured lint. `git status` / `git diff --check` unavailable (exit 128), not a passing check. No shipping/commit/PR acceptance claimed.

## Review and simplification

Read-only independent reviewer `search-history-review` identified a P2 wrong active label for a superseded compaction marker. Fixed by retaining marker status and the latest marker ID; added a real Harness repeated-compaction regression, now passing. Reviewer did not execute tests.

Three read-only supporting ce-simplify-code passes used the full skill prompt assets: reuse — no worthwhile findings; quality — no worthwhile findings; efficiency — filter raw entry IDs before text extraction/argument serialization for lookup/range. Efficiency finding applied without changing the native scan/completeness metadata. Entry lookup ignoring conflicting filters additionally asserted. Final test/typecheck commands above ran after these changes. Applied: reuse 0, quality 0, efficiency 1; no unresolved worthwhile simplification findings.

## Evidence limits

Integration invokes the public tool through real Harness and MemoryStorage with deterministic Faux model responses. It verifies stored reset/compaction boundaries and fork scope; not model summarization, SQLite recovery, process restart, live model-provider evaluation or packed-consumer installation. Subsequent native live dispatch evidence is recorded below. A dedicated CE shipping review receipt was not generated; publication was not authorized.

The assistant did not edit production databases, owner settings, core Pocket code or the portable collection catalog. Only the authorized search drop-in was installed; normal live tool invocations persist their calls/results through Harness. Tests close only in-memory Harness instances. No file cleanup/deletion, dependency installation, release packaging, commit, push or deploy performed in the search implementation.

## Final optional rerun limitation

After documentation updates, one additional test rerun was requested but the bash protection service returned `DCG_UNAVAILABLE:timeout`; it did not produce a test result. The following chained typecheck did not run. No protection bypass or alternate execution path was attempted. The source/test/wrapper candidate is unchanged since the earlier successful 9/9 and strict TypeScript checks. Two subsequent native live tool calls succeeded as recorded below.

## Installation and live evidence

Authorized local drop-in: `/home/ubuntu/.local/share/pi-pocket-eval/extensions/search-history.ts`, default re-export of the sandbox package factory, no PocketHost/raw DB. Native import reported extension `search-history`, tool `search_history`. After installation, test rerun passed 9/9 (1246.983903 ms). Owner controls activation in Menu → Extensions; the assistant did not enable settings.

The native tool subsequently appeared in this conversation. Live `{query:"план",kind:"user",limit:3}` returned two historical user messages with `total_is_complete:true`; `{entry:90197}` recovered the original user instruction. This confirms live tool dispatch and historical lookup in the current conversation. It does not establish new-conversation/global defaults or process-restart/SQLite recovery.

## Jobs plan

The user authorized plan authoring and expanded it to sequential/parallel/dynamic/event examples. `docs/plans/2026-10-13-durable-jobs.md` and the version-pinned comparison in `docs/research/2026-10-13-dynamic-workflows.md` are written. Jobs remains planning-only; no model runs, additional scheduler, raw shell or publish/deploy capability implemented.

---

# Collection promotion verification — 2026-10-15

Status: promoted into `pi-durable-extensions` as the eleventh component on operator request
(Variant A: migrate to the 1.2.0 `output` result field; the local 1.1.0 Pocket sandbox and its drop-in
stay untouched). Candidate status; no stability claim.

## Version-matching check

The candidate pinned peers to Pi Durable / Pi AI 1.1.0 while the collection is on the 1.2.0 family.
Both stacks were measured on Node 24.19.0:

- 1.1.0 (as installed in the live Pocket sandbox): `node --test` PASS 9/9.
- 1.2.0 (from the admitted Durable host checkout), unmodified source: **4/9 pass, 5 fail** — every
  real-Harness integration test failed inside the test's own `ask()` helper.

Root cause, proven from the installed distributions rather than inferred:

- `@earendil-works/pi-durable` 1.1.0 `dist/harness/tool.js` `finalResult()` reads `result.content`.
- 1.2.0 `finalResult()` reads `result.output`; the public type is
  `ToolExecutionResult = { output?: ToolResultMessage["content"], structuredOutput?, isError?, … }`.
- A diagnostic Harness run on 1.2.0 recorded the tool call as successful
  (`pi.assistant` entry with `stopReason: "toolUse"`) while the `pi.tool-result` entry carried
  `content: []` and `isError: false`: the tool ran, and its text was dropped.

All other APIs the package uses are unchanged between the two versions: `scanEntries(query, limit,
cursor)`, `latestHeadMarker(conversationId)`, `api.commit`, `api.conversationId`, `defineTool`,
`defineExtension` (confirmed in both `dist/harness/types.d.ts` and `dist/session/transaction.d.ts`).

## Migration

One line in `src/index.ts`: the tool's successful result returns `{ output: [{ type: "text", … }] }`
instead of `{ content: … }`. No behavioural or schema change; `src/history.ts` and the fixture suite
are byte-identical to the sandbox candidate.

## Post-migration checks (in this tree)

- `npm run check:compat search-history` — private temp copy, real `npm install --ignore-scripts` of the
  pinned 1.2.0 dev family, `npm run check` (tsc) and `npm test`: recorded in the run report below.
- `node packages/cli/src/index.mjs list/info/doctor search-history` and a dry-run install against the
  root catalog: artifact digest, canonical peer declarations and pins verified by the installer.

Not verified here: live provider credential lanes, SQLite restart recovery, and BB/Pocket activation;
those remain separate acceptance gates.
