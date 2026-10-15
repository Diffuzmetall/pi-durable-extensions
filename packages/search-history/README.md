# Pi Durable search_history

Candidate `0.1.0-candidate.0`. One read-only tool, `search_history`, that searches the **calling**
conversation's stored history: entries before reset and compaction, inherited fork history up to the
fork point, and records superseded by newer context heads. Not a session search engine: it cannot
select another conversation, and it needs no index, SQLite path, network access, credentials or added
runtime dependency.

## Runtime

Recorded compatibility environment: Linux x64, Node 24.19.0, npm 11.17.0, Pi Durable / Pi AI /
Chord **1.2.0**. The TypeScript entry uses native Node type stripping. Peer versions are pinned to the
verified 1.2.0 family; other tuples are unverified.

### 1.2.0 migration

Pi Durable 1.2.0 renamed the tool execution result field the model reads: `content` became `output`
(`ToolExecutionResult` in `@earendil-works/pi-durable`). The 1.1.0 form is silently ignored on 1.2.0 —
the tool succeeds and returns an empty result. This package returns `output` and therefore targets
1.2.0 only. Every other API it uses (`defineTool`, `defineExtension`, `api.commit`, `tx.scanEntries`,
`tx.latestHeadMarker`, `api.conversationId`) is unchanged between 1.1.0 and 1.2.0.

## Bare Harness

```ts
import createSearchHistory from "@diffuzmetall/pi-durable-search-history";
const extension = createSearchHistory();
registry.install(extension);
// Select Extension objects when configuring, not stored name strings:
await root.configure({ extensions: { add: [extension] } }, context);
```

Import and configure in your existing host; do not open another Harness on the same storage. No
service, background task or configuration file is started or read by this package. Host session
permissions remain the authorization boundary; the tool cannot select a different conversation ID.

## Arguments

All optional: `query`, `tool`, `entry`, `kind`, `from_entry`, `to_entry`, `order`, `limit`, `offset`.

- `query`: case-insensitive literal words combined with AND; no SQL/regex/semantic search.
- `tool`: case-insensitive exact tool name.
- `kind`: `user`, `assistant`, `tool_call`, `tool_result`, `event`. Calls remain assistant-entry hits.
- Entry bounds are inclusive. `entry` ignores other filters, but still obeys the scan window and pagination.
- `order`: newest (default) or oldest within the scanned window. `limit`: 1–50, default 10; `offset`: 0–10000.

Examples:

```json
{"query":"checkout regression","kind":"user","limit":10}
{"tool":"bash","kind":"tool_result","from_entry":10,"to_entry":100}
{"entry":42}
```

## Output and limits

The tool scans at most the newest 10000 visible entries in one consistent Harness transaction, then
searches that window. `total` counts matches in the window. `truncated: true` / `total_is_complete:
false` warns that older entries were not scanned. `oldest_scanned_entry` gives the oldest inspected
ID. Changing `order`/`offset`/bounds does not expand the scan window. No match with truncation is not
proof of absence.

Results include entry ID, kind, context, tool names and text. Text is capped at 360 characters (4000
for entry lookup); tool names are capped at 20 × 80 characters, with `tools_truncated` when the list
is shortened. "Read entry" is a bounded text preview, not the entire record.

Context labels: `active`, `before reset` when a reset in the window establishes that, otherwise
`historical` for records older than the latest context head and superseded head markers. The tool
does not guess whether an unseen old reset or compaction caused the boundary.

Returns text blocks and tool arguments/results, not thinking, images, system prompts or arbitrary
event data. Search calls/results are excluded unless explicitly requested by tool name or entry ID; a
mixed assistant entry with other calls remains searchable. Historical text is untrusted data. No
secret-redaction guarantee: visible transcript content may contain sensitive text and returned
excerpts go to the model.

Read-only means no history/document mutation, shell or external effect. The Harness still normally
persists the invocation and its result. `replay: safe` makes rereading harmless, not identical if
later history has changed.

## Verify

```sh
npm install --ignore-scripts   # dev dependencies: the pinned 1.2.0 runtime family
npm run check                  # tsc --noEmit over both source files
npm test                       # node --test, nine fixture checks
```

Nine checks cover words, filters, pagination, entry previews, non-text exclusion, real Harness tool
dispatch, reset, a committed compaction boundary, repeated-compaction summary labels, fork
visibility, independent conversation isolation, schema errors and the 10000-entry cutoff. Integration
uses real Harness/MemoryStorage and a deterministic Faux model; it does not call a live provider. The
compaction test writes the boundary through the public transaction rather than testing model
summarization.

Not verified: global/new-conversation activation, SQLite process-restart recovery, packed-consumer
installation and live model-provider evaluation. Those are separate acceptance stages, not implied by
these local checks.

## Provenance

Adapted from `disler/durable-pi` @ `37165c619573dbaf425463038bbffecfe576beec`, MIT; see `LICENSE`
and `NOTICE.md`. Promoted into this collection from the reviewed standalone candidate; the original
sandbox package and its local Pocket drop-in are unchanged.
