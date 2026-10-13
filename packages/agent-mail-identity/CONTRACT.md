# Agent Mail identity contract (AM1 identity, AM2 watcher)

## Stored identity

`MailIdentityDoc` has kind `agent-mail-identity.binding`, version 1, conversation scope, latest history, and `fork: "initial"`. Its initial value has schema version 1, unbound identity, and wake disabled with reason `not_implemented`.

A bound identity stores `ownerConversationId`, `bindingId`, `projectKey`, and `agentName`. Owner mismatch is not a usable binding. Unknown schema version denies. No per-binding revision is stored; the package does not support rebinding, and the watcher state is a separate document (see below) rather than an identity revision.

The host grants an exact conversation, project, and actor tuple. Profile lookup confirms the exact existing name. It is not proof of human ownership: that decision belongs to the trusted host before `grant`. The package has no registration intent, registration token, named-registration retry, or automatic registration fallback.

## Admission linearization

`BindingAuthority` uses one in-memory queue per authority instance. A queued admission validates a captured target against the grant when its operation begins. It keeps the queue occupied until its commit callback settles. A subsequent revoke returns only after the admitted operation settles. Failure releases the queue without creating binding.

Cancellation is checked before admission and inside the actual binding transaction. Durable also rejects invocation writes after abort or close. A successful already-committed binding is not rolled back by later cancellation. Grant revocation does not promise revocation of established identity, replay, or external effects.

The authority object must be a concrete `BindingAuthority`, not a callback or subclass. The factory captures the prototype admission method. The obsolete `authorizeBind` callback is ignored and cannot authorize a bind.

## Execution and hooks

`mailTools` accepts existing public `ToolRegistration` definitions. The factory guards their `execute` and argument-repair methods without copying MCP schemas or changing replay policy. Registration and unknown operations remain denied by policy.

The execution guard checks selected identity extension, current binding ownership, explicit project, acting field, and prohibited credentials. It runs after final schema validation and later `beforeTool` replacements. It also runs when direct safe recovery skips `beforeTool`.

A public `wrapTool` on each enrolled name guards the resolved definition, including a same-name raw definition contributed by another selected extension. Guarding is idempotent. Arguments are copied before asynchronous reads so another hook's retained reference cannot change the checked actor.

The pre-intent hook performs an early policy check and denies unenrolled names. It is not terminal validation. `HookApi` has no public `agent` or registry method in Durable 1.1.0; the implementation does not rely on the runtime's extra private methods. The execution API does provide `agent` and document snapshots.

Guarded definitions remain guarded when `guardAgentMailExtension` is used outside the combined factory. Deselection denies with `identity_extension_not_selected`. Conversation extension selection is a phase snapshot. Removing an extension mid-invocation does not prove immediate cancellation or drain. Abrupt uninstall and live registry cancellation belong to AM2.

Trusted host code must enroll every reachable Mail definition and must not use later wrappers to remove execution guards. A separately installed unguarded extension must not remain reachable after identity deselection. Arbitrary external MCP gateways, shell commands, direct network code, malicious host hooks, and independent transports are outside this contract. The package cannot restrict tools after its extension and all its guarded definitions have been removed.

## Operation policy

`MAIL_OPERATION_POLICY` defines 17 acting operations, seven project reads, and health. The other 20 operations in the inspected 45-operation MCP catalog deny. Unknown operations deny. Each acting operation checks its exact field. Recipients and lookup names are not acting identities.

All enrolled operations, including health, require the identity extension to be selected. Health has no binding requirement. Other allowed operations require an owned binding and exact `project_key`. Model-supplied credentials deny. The explicit `project_key` determines scope; terminal bridge defaults are not consulted.

The inspected native MCP candidate `0.0.0-candidate.1` defines only health as replay-safe. Interrupted effectful Mail operations are unsafe and do not repeat. The safe fixture replay tests exercise Durable's real execute checkpoint with seeded committed intent, not an operating-system crash and not a production replay.

## Public diagnostics

Profile exceptions, including unknown `IdentityError` codes and throwing accessors, are reduced to fixed public codes. The sanitizer does not read `error.message`, stringify an error, or trust an injected `code` getter. Guarded delegate and argument-repair exceptions also use fixed diagnostics. Public CLI errors never include stderr or private subprocess bodies.

Successful tool content and explicit `api.output`, `details`, or `diagnostic` calls remain trusted tool output. The guard is not a general redactor for malicious tools, host storage reports, or errors from unrelated host hooks. No credential or error body is logged by this package.

## CLI lifecycle

The CLI transport uses an absolute executable, argv, no shell, a detached POSIX process group, at most 5000 ms runtime, and at most 256 KiB combined stdout and stderr. The child environment is an explicit allowlist (`PATH`, `HOME`, and this process's `AGENT_MAIL_*` variables) plus the caller's `options.env`; the whole `process.env` is never forwarded to a subprocess. A project key that begins with `-` is rejected before any argv is built, so it cannot be read as an option by the CLI. It sends TERM, then KILL after 100 ms. A separate 200 ms drain deadline prevents inherited pipes from hanging promise settlement.

The parent `exit` event triggers descendant or nonzero-exit cleanup even when inherited pipes delay `close`. Successful JSON parsing requires `close` and no remaining process group. Cleanup uncertainty returns `cli_cleanup_unverified`. A conservative unverified result can precede subsequent OS reaping.

Process-group containment applies to descendants that remain in that group. A hostile executable can escape with a new session or process group. This package has no kernel namespace, subreaper, cgroup, or Windows containment. Escaped descendants are not universally contained. Trusted executable selection is mandatory.

A zombie is stopped, not proven reaped. Fixtures inspect `/proc` separately and report both execution state and reaping evidence. Only absent fixture PIDs count as observed reaping. No file deletion or host process-manager mutation occurs.

## Delivery monitoring (AM2)

`MailWatchDoc` (`agent-mail-identity.watch`, version 1, conversation scope, latest history, `fork: "initial"`) holds the delivery state, separate from the immutable identity: `disabled` | `running` | `paused` with an explicit reason, the durable `cursor`, at most one `pending` delivery, the last fixed error code, and the last/next poll times. A fork starts disabled with no cursor. Identity and watch state never share a document, so disabling monitoring cannot touch the binding.

Enable, pause, resume and disable are the `watch_enable`, `watch_pause`, `watch_resume` and `watch_disable` actions; the AM1 `disable` action also stops a configured watcher. Enable and resume require the same host grant as `bind`, so a host that has not granted the target cannot start monitoring. `watchFrom: "now"` deliberately discards the existing backlog and is reported back in the result; an absent `watchFrom` resumes the stored cursor, and an absent or explicitly `now` value on a live watcher never moves it backwards. A repeat enable adopts the existing watcher: the state that names it and the task record are written in one transaction, so two concurrent enables cannot create two watchers.

One `defineTask` (`agent-mail-identity.watch`, version 1, `background: true`) polls the bound conversation. Its checkpoint moves through `poll`, `prepare`, `submit` and `settle`, and every wait goes through `runtime.sleep`; the package adds no timer, daemon, or subprocess. An empty poll sleeps the idle cadence, creates no model turn, writes no transcript entry, and issues no read-marking call.

### Read-only listing

`MailTransport.poll` is optional, and it is read-only by contract. A host that composes no listing and uses a transport without one cannot enable monitoring: the result is `watcher_unavailable`, which now means a genuinely missing capability rather than a normal transport. The packaged CLI transport supplies one over `am inbox-events`, whose contract was read from the live CLI:

```
am inbox-events --project <PROJECT> --agent <AGENT> --json [--after <CURSOR>] [--limit 1..1000]
am inbox-events --project <PROJECT> --agent <AGENT> --json --position-now
```

`--after` is a delivery cursor and not a message ID, `--position-now` returns the durable tail cursor with no events, and the response carries `events[]` (`cursor`, `message_id`, `kind`, `delivered_ts`, `subject`, `from`, `importance`, `ack_required`), `next_cursor`, `has_more`, `oldest_available_cursor` and `tail_cursor`. The transport reads only those fields. The project and agent are always passed explicitly, so the CLI's own environment or directory default is never consulted, and the page is bounded by `--limit` (default 100, maximum 1000) inside the same `runJsonCli` limits as the profile lookup: absolute executable, no shell, a detached process group, 5 s, 256 KiB, and no read-marking subcommand ever invoked.

A null cursor asks for the current position, so the first poll of a watcher enabled with `watchFrom: "now"` adopts the reported tail as its durable cursor and delivers nothing. Only that explicit position-now read may establish a position: an empty page for a request that carried a cursor must report exactly that cursor, whatever its encoding, and anything else pauses the watch with `watcher_cursor_regression` instead of moving or rewinding the cursor. Fail-closed, with no event ever skipped silently: malformed JSON (`cli_invalid_json`), an unexpected page or event shape including a cursor at or before the requested one (`invalid_delivery_page`), a nonzero exit (`cli_exit_failed`), a cursor the mailbox no longer keeps (`watch_cursor_expired`, detected when `oldest_available_cursor` is past the requested cursor — the live CLI answers such a request with events from the oldest available position and exit 0), and a cursor the listing refuses (`invalid_watch_cursor`, which also pauses the watch rather than retrying a mistyped cursor forever). All of them pause the watch. The listing contract carries no message body, so a batch carries the event identity, sender, subject and delivery time, and reading a full message stays a model-visible Mail tool call under the identity guard rather than part of monitoring.

One batch is capped at 50 events and 8 KiB of rendered payload. The byte budget counts the header, every block and the newline between them, so the rendered payload always fits; each unbounded field of an event (sender, subject, body) is clipped to its own cap and marked `[truncated]`, so one oversized letter can neither exhaust the batch nor push the payload past the budget. A page larger than the batch cap is drained from the per-event cursor — the first batch takes the prefix, the next poll continues after its last event — and `has_more` and `tail_cursor` are part of the contract but are not used for cursor movement: the per-event cursor is exact, while a page-level hint is not. `PendingDelivery` (schema version 1) carries binding, the admission key, the cursor before and after, event and message IDs, the rendered payload, its byte size, and the creation time. The key is a SHA-256 over conversation, binding, `cursorBefore` and the batch's event IDs, so a replay before the pending record exists derives the same key, and a replay after it reuses the stored key and the stored payload byte for byte.

Admission is checked through the public transaction lookup `tx.submissionByRequest` (an empty commit: a line read that writes nothing) before any external delivery, and the delivery itself uses `conversation.submit(..., requestId, whenBusy: "reject")`. A busy conversation keeps the delivery pending and is retried after the capped, jittered backoff (15, 30, 60, 120, 300 seconds by default); the watcher never steers, queues behind, or interrupts an active turn. The `settle` phase re-checks the same key inside its own transaction and only then advances `cursor` and clears `pending` in that one commit; the cursor therefore never moves past a batch whose admission is not confirmed, and a successful model answer is never required to advance it. Requests can be repeated with the same key, and the host's deduplication decides: the package does not promise exactly-once model tools.

Before every poll and every submit the phase checks the stored watch state, the owning conversation, the binding, and the injected live presence. Authentication and incompatible-schema failures move the watch to `paused` and end the task; other transport failures keep the delivery pending and retry read-only first. Losing presence pauses the watch with reason `uninstalled`. Abort is the definition's own `abort` handler: it keeps identity, cursor and `pending`, downgrades only a `running` watch, and commits a terminal outcome.

### Disable linearization and its limit

Operator commands and phases own different fields of `MailWatchState`, and each writes only its own against the document as its transaction currently sees it. `enable`, `pause`, `disable` and `resume` own `watch` (and `enable` sets `cursor` only when the operator asked for a start position); the phases own `cursor`, `pending`, `lastError`, `lastPollAt` and `nextPollAt`, and they may write `watch` only to stop a watch that is still `running`. A phase therefore cannot resurrect or downgrade a watch the operator disabled, and the operator cannot clear a pending delivery or move a cursor a phase is using. `cursor` and `pending` are written together and only by the settle commit.

The linearization point of `disable` is its committed watch state: after that commit returns, no poll and no submit may start, and the disable then aborts and verifies the watcher task. Verification re-reads the task record, because `Harness.waitForTask` was observed resolving with a non-terminal record on a live abort; a bounded recheck loop then joins the task, and when the terminal state still cannot be verified the result is `watcher_join_unverified` rather than a claim of success. Enabling a watcher adopts a live one instead of creating a second: the live statuses are each queried directly inside the transaction, so a conversation whose terminal watcher records outnumber one listing page still has exactly one live watcher. What this package cannot prove through public APIs is an admission that already passed its last pre-submit checks: the signal check immediately before the call is the final public barrier, and a disable that lands after it does not revoke that in-flight delivery. `test/delivery.test.ts` demonstrates that residual window explicitly instead of claiming the stronger guarantee. Disabling also does not erase identity, cursor or pending: a later enable continues from the stored cursor and can still settle a pending delivery admitted before the crash.

### Uninstall limit

Presence comes from an explicitly injected source, normally `registryPresence(registryReader)`. Removing the extension from the registry makes the watcher stop at its next presence check and leaves the watch `paused` with reason `uninstalled`. Removing the *definition* alone does not abort a live task: Durable keeps running it under its stored definition and reports that fact through `onReport`; the task only becomes unschedulable, not terminal. The watcher therefore never promises a cleanup phase after its definition is removed, and a host that wants an immediate stop must supply the presence source and, where it needs a join, the abort capability.

Status reports the watch state, its reason, the task ID, the current phase, the cursor, the pending digest (count, key, events, bytes), the last fixed error code and the next poll time. It never renders a mail body, a token, or an unbounded error log.

## Pocket wake admission (AM3)

A separate entry point (`pocket/index.ts`, exported as `pi-durable-agent-mail-identity/pocket`) adapts this package to a host whose surface is structural. It imports no Pocket source, no Pocket application and no Pocket database module, and it reads no Pocket user or driver table: what it knows about the host arrives through `PocketHostSurface`, a structural subset of the current `PocketHost` (`requesterOf`, `heldBack`, optional `onLimitsChanged`, optional `hindsight.admitInput`). No method is added to `PocketHost`, and no Pocket file is patched.

`HostAdmission` has exactly four outcomes: `allowed`, `busy` (retry; the delivery stays pending), `paused` (not now), and `denied`. Every refusal carries a fixed public reason from `missing_host_capability`, `held_back`, `budget_denied`, `identity_mismatch`, `registration_failed`, `extension_removed`, `schema_unsupported`, `requester_unbound`, `admission_unproven` and `host_read_failed`. `registration_failed` is part of the vocabulary but unreachable by design: this package never registers an identity.

Admission is a *revalidation*, not a permission check performed earlier. `requesterOf` alone proves nothing, so at admission time the adapter reads, through the host's own public operations, whether the person the conversation works for still exists, still steers here (not a viewer), can still see the conversation, is still the current driver, and whether work with nobody asking is held back or the spend limit is reached — plus the schema version of the stored watch state. Then it reads the host input binding for this request id: a binding recorded for a different owner denies (`identity_mismatch`), an unprovable one pauses (`admission_unproven`), and an absent one is written before the submit. The whole read set is taken again immediately before the submit, so a change of creator role, visibility, driver, `heldBack` or limit cancels the admission and leaves the delivery pending.

The domain part is pure: `revalidateWake(facts)` is a function over plain facts and knows nothing about Pocket users or spend documents; the host adapter is what reports rights and limits.

### Capabilities and the current host

The wake path needs three capabilities, and a missing one is a refusal, never a degraded mode: `submit_as_bound_person` (a public operation that submits as the bound person, with the host performing the person, role, visibility and driver validation inside its own submit path), `live_registry_reader` (a live presence source, not a phase snapshot), and — only when the host composes a hindsight input binding — `admission_lookup` (a public lookup of the binding recorded for a request id).

The current `PocketHost` provides none of the three (`hindsight.admitInput` exists, its lookup does not), so the default entry point answers `enable` with `denied`/`missing_host_capability` and the missing list, having read nothing, written nothing, created no watcher and started no turn. Two callbacks are deliberately absent rather than approximated: a submit that does not perform the live rights validation, and a presence source that is only a snapshot.

### Idempotency of the admission side effects

The input binding is its own side effect, separate from the submit. It is repeated with the same request id as the pending delivery and the conversation submit, and only when the public lookup proves it is not recorded yet, so a crash between the binding and the submit neither books the budget twice nor changes the input's owner; recovery submits under the binding that already exists. A contract that cannot prove the binding leaves the admission `paused` with `admission_unproven` instead of submitting under an unproven owner or an unproven booking. What is promised is admission deduplication, never exactly-once model tools.

The residual window is real and is demonstrated rather than promised: the re-read immediately before the submit is the last public barrier, and a rights change that lands after it happens inside the host's own submit. `test/pocket/admission.test.ts` shows both the cancellation before that barrier and the admission that survives a change behind it.

## Unavailable capabilities

There is no wake for a real Pocket turn, no registration, and no automatic installation: presence and the abort capability are injected by the host. Live Agent Mail acceptance, the ten cloud-worker lanes, screenshots, video, the trunk comparison and the performance budgets are unavailable and unverified; `test:live:am2` exits 2 with a stated reason rather than fabricating a receipt. `test:live:pocket` does the same for the Pocket lanes, whose positive form needs the A6 admission capability the current `PocketHost` does not publish and the A1 live cancellation the plan still owes: with neither, the adapter refuses `enable` with `missing_host_capability` and no turn can start. The live `am inbox-events` contract was read and exercised read-only by hand; the test suite exercises it through a fixture that reproduces that contract, which is not live acceptance. Unit fixtures do not close the plan's live, screenshot, video, or performance gates.
