# Agent Mail identity and watcher (AM1 + AM2 + AM3 candidate)

This package is an extension for **Pi Durable**: it binds an existing Agent Mail identity to one Durable conversation
(AM1), adds a durable, crash-safe watcher that reads one bound mailbox read-only and wakes an idle conversation with one
bounded batch (AM2), and ships a fail-closed Pocket adapter with its own entry point (AM3). Pi Pocket is an optional
adapter, not the environment the package lives in: the generic entry point imports nothing from Pocket and works on a
bare Durable host. The candidate requires independent parent acceptance.

- Installation, including the standalone host example: [INSTALLATION.md](INSTALLATION.md)
- Migration from the old bridge: [MIGRATION.md](MIGRATION.md)
- Exact contracts and their limits: [CONTRACT.md](CONTRACT.md)

## Host composition (standalone Pi Durable)

Use Durable and pi-ai 1.1.0 with Node 24.19 or newer. Supply the existing MCP extension's tool definitions through
`mailTools`. Do not also install the original unguarded definitions.

```ts
import {
	BindingAuthority, createAgentMailIdentity, createCliTransport, standaloneWatch,
} from "pi-durable-agent-mail-identity";

let harness: Harness;
const authority = new BindingAuthority();
const identity = createAgentMailIdentity({
	authority,
	transport: createCliTransport(trustedAbsoluteAmExecutable),
	mailTools: existingMailExtension.tools,
	// The wiring a standalone host would otherwise invent: live presence from the registry reader, and the abort
	// capability of its own harness.
	watch: standaloneWatch({ registry, abort: taskId => harness.abortTask(taskId as never, ctx) }),
});
registry.install(identity);

// The trusted host grants a target only after checking ownership.
await authority.grant(conversation.id, { projectKey: explicitProjectKey, agentName: exactExistingAgentName });
```

The identifiers supplied by the host in this example are not configuration defaults. Importing the package performs no
I/O, and installing the extension binds nothing, enables nothing and wakes nothing. See
[INSTALLATION.md](INSTALLATION.md) for the full host example and the three separate steps (bind, `watch_enable`,
disable).

The model calls `agent_mail_identity` with `action: "bind"`, `projectKey`, and `agentName`. `status` returns bound
identity or unbound, plus the wake state. `disable` returns the same disabled state and, when a watcher is composed,
stops it without erasing identity, cursor or pending delivery. Without a composed watcher there is no watcher to stop,
exactly as in AM1.

The factory enrolls and guards supplied tools at execution time. With no `mailTools`, its hook denies all external
Agent Mail tools with `mail_execution_guard_required`. The hook alone is not an identity security boundary. The
intrinsic execution guard checks final arguments after other hooks, including nested Pocket codemode calls and direct
replay-safe recovery.

`guardAgentMailExtension(extension)` guards existing tool definitions without changing their schemas or replay
policies. It is available for trusted host composition. Its guarded tools deny execution when the conversation does not
select `agent-mail-identity`. Host code and extensions are trusted: they must not install same-name unguarded
replacements, remove guards, or expose another Mail transport to the model.

## Binding and grants

`BindingAuthority` serializes grants, revocations, and admitted binding operations. An admitted operation holds its
grant through profile lookup and the Durable binding commit. A revocation queued behind it cannot return before that
operation finishes. A revocation that runs first denies later admission.

Grants are in-memory host authority, not persisted conversation state. After host restart, grant again before a bind
invocation, including an idempotent bind. Existing immutable identity remains available to status and guarded Mail
tools. Revoking a bind grant does not revoke an established identity's Mail access. Live access revocation is not
implemented.

Binding is immutable. A repeated bind to the same target keeps the same binding ID. A different target denies. Forks
start unbound. No identity comes from titles or `process.env`.

## Delivery monitoring (AM2)

AM1 binds an identity. AM2 adds a durable watcher that reads one bound mailbox read-only and admits one bounded batch
into an idle conversation. It never registers a name, never marks a message read or acknowledged, and never steers an
active turn.

The model calls `agent_mail_identity` with `action: "watch_enable"` (optional `watchFrom: "now"` or an explicit
cursor), `watch_pause`, `watch_resume`, `watch_disable`, or `disable`. Without a composed watcher every `watch_*` action
denies with `watcher_unavailable`, and `status` keeps its AM1 shape. With one, `status` also reports the watch state,
reason, phase, cursor, pending digest, last error code, and next poll time — never a mail body or a token.

Enable writes the cursor and the intent and creates the watcher task in one transaction, so a restart resumes the stored
cursor and a repeat enable cannot create a second watcher, however many finished watcher records the conversation has.
Operator commands and phases write different fields of the watch state, so a disable during an active phase cannot be
undone by that phase. An empty poll sleeps the idle cadence and writes nothing. One batch carries at most 50 events and
8 KiB; a repeat delivery uses the same admission key and the same payload, and the cursor advances only in the
transaction that confirms the admission.

Monitoring is read-only end to end. The packaged transport lists delivery events with `am inbox-events`, always passing
an explicit `--project` and `--agent`, and never invokes a read-marking subcommand; a page the mailbox can no longer
serve, a malformed page, a page that carries events without a usable oldest position, or a nonzero exit pauses the
watcher instead of silently skipping letters. Because the listing carries no message body, a wake batch contains the
event identity, sender, subject and delivery time.

Delivery cursors are global across recipients, so valid continuations can be sparse: an empty mailbox positioned at
`0` can receive its first event at any later sequence. `oldest_available_cursor` is the recipient's minimum event,
not a retention floor. The daemon checks actual global retention; its nonzero CLI errors still pause the watcher
with the bounded `cli_exit_failed` diagnostic. Successful pages are not rejected merely because that minimum exceeds
`after`.

## Pocket adapter (AM3)

The Pocket entry point is a separate export, `pi-durable-agent-mail-identity/pocket`. It imports no Pocket source, no
Pocket application and no Pocket database module, and it reads no Pocket user or driver table: the host arrives as a
structural surface, and a host that lacks a mandatory capability is refused, never degraded.

```ts
import { createCliTransport } from "pi-durable-agent-mail-identity";
import pocketEntryPoint from "pi-durable-agent-mail-identity/pocket";

export default (host: unknown) => pocketEntryPoint(host as never, { transport: createCliTransport("/usr/local/bin/am"), mailTools: [] });
```

`agent_mail_wake` reports the capability picture and asks for an admission. The current `PocketHost` publishes no
submit-as-bound-person operation with live person, steer-role, visibility and driver validation (A6) and no live
`RegistryReader` (A1), so `enable` answers `denied` with reason `missing_host_capability` and the exact missing list —
and reads nothing, writes nothing, creates no watcher and starts no turn. A positive wake becomes reachable only through
an already-public embedding contract the host itself proves; see [CONTRACT.md](CONTRACT.md). No method is added to
`PocketHost`, no permissive fallback exists, and no host patch is applied.

## Checks

Run from the workspace root:

```sh
npm --prefix packages/agent-mail-identity test
npm --prefix packages/agent-mail-identity run typecheck
npm --prefix packages/agent-mail-identity run lint
npm --prefix packages/agent-mail-identity run test:live:am2
npm --prefix packages/agent-mail-identity run test:live:pocket
npm --prefix packages/agent-mail-identity run bench
```

Tests use real SQLite, the faux model provider, and bounded local subprocess fixtures. No paid model or production Mail
API is called, and no production mailbox effect is produced. The delivery unit suite drives the real phase functions
over an in-test durable model to interrupt the process before pending, after pending, after admission and after settle;
the watcher suite runs the real Durable task over SQLite and covers duplicate pages, paged reads, empty polls, a busy
race, disable, pause, resume, abort, presence loss, uninstall, a stale binding, a foreign watch document and pending
recovery; the Pocket suites cover the admission cases, installation, the refusal, and the migration from the old
bridge. Fixtures and evidence are retained; the tests do not delete files.

The tests need no Pocket checkout. The single test that drives Pocket's real codemode extension resolves its path from
`AM_POCKET_CHECKOUT` (default: a `pi-pocket` checkout next to this repository) and skips with a stated reason when the
path does not exist:

```sh
AM_POCKET_CHECKOUT=/nonexistent npm --prefix packages/agent-mail-identity test
```

`test:live:am2`, `test:live:pocket` and `bench` are deliberately fail-closed: each exits 2 with the reason its lane
cannot run, and never fabricates a live watcher run, benchmark, screenshot, or delivery receipt. Live Agent Mail
acceptance, a real Pocket wake, the cloud-worker lanes, screenshots, video, the trunk comparison and the performance
budgets remain blocked. Tests and static checks are not live acceptance.

A separate retained isolated-service check on 2026-10-15 exercised Agent Mail 0.3.39 / FrankenSQLite 0.4.12 with a
standalone Durable 1.1.0 host and real packaged CLI transport: sparse first delivery, guarded outbound reply,
pause/resume/disable, unread preservation, deduplication across a clean process reopen, and retained identity/cursor
state passed. Only the model provider was deterministic faux. This is not a production installation, a real Pocket
wake, a paid/cloud-model test, or crash/power-loss acceptance; the packaged live/performance gates above remain
unavailable.

Evidence: [REPAIR-REPORT.md](REPAIR-REPORT.md) (AM1 repair), [AM2-REPORT.md](AM2-REPORT.md) (AM2 unit report and crash
matrix), [AM3-REPORT.md](AM3-REPORT.md) (AM3 admission, installation and migration), manifests
`test/evidence/candidate.sha256` (AM1, retained unchanged), `test/evidence/am2-candidate.sha256` (AM2, retained) and
`test/evidence/am3-candidate.sha256` (AM3).
