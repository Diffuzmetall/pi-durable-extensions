# Installing the Agent Mail identity extension

This package is an extension for **Pi Durable 1.1.0** (with pi-ai 1.1.0 and Node 24.19 or newer). It binds an existing
Agent Mail identity to one Durable conversation (AM1), watches one bound mailbox read-only and wakes an idle
conversation with one bounded batch (AM2), and ships a fail-closed Pocket adapter (AM3). Pi Pocket is **not** required:
the package has one generic entry point for a bare Durable host and one separate Pocket entry point, and the generic
entry point imports nothing from Pocket.

Install it in your own host the way you install any other extension: add the package, build the extension, install it
into the registry, and grant the identity from trusted host code. There is no installer, no daemon and no service.

## Requirements

- `@earendil-works/pi-durable` 1.1.0 and `@earendil-works/pi-ai` 1.1.0 are peer dependencies. The package imports
  nothing else in production; `@earendil-works/chord` is used by the tests only and is a development dependency.
- An existing Agent Mail identity (project plus exact agent name) and an `am` executable. The packaged CLI transport
  needs an **absolute** path to it.
- The existing MCP extension's tool definitions, passed as `mailTools`. Do not also install the original unguarded
  definitions.

## Standalone Pi Durable host (the main path)

```ts
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
	BindingAuthority,
	createAgentMailIdentity,
	createCliTransport,
	standaloneWatch,
} from "pi-durable-agent-mail-identity";

const registry = createRegistry();
const authority = new BindingAuthority();
let harness: Harness; // the harness is opened below; the watcher only needs it once it is running

const identity = createAgentMailIdentity({
	authority,
	transport: createCliTransport("/usr/local/bin/am"),
	mailTools: existingMailExtension.tools,
	// `standaloneWatch` is the wiring a standalone host would otherwise have to invent: a live presence source read
	// from the same registry reader the harness reads (`registryPresence` inside), and the harness's own abort.
	watch: standaloneWatch({
		registry,
		abort: taskId => harness.abortTask(taskId as never, ctx),
	}),
});
registry.install(identity);

harness = await Harness.open(await openNodeSqliteStorage("/var/lib/pi/session.sqlite"), { registry, models }, ctx);
const conversation = await harness.root(ctx, { agent: { model: { provider, modelId } } });

// Trusted host code grants a target only after it has checked ownership. This is not the model's decision.
await authority.grant(conversation.id, { projectKey: "/my/project", agentName: "ExactExistingName" });
```

Importing the package performs no I/O. Installing the extension binds no conversation, starts no watcher and wakes
nothing. Three separate, explicit steps follow.

1. **Bind** (once per conversation, immutable): the model calls

   ```json
   { "action": "bind", "projectKey": "/my/project", "agentName": "ExactExistingName" }
   ```

   on `agent_mail_identity`. A host without a grant for that exact target gets `binding_not_authorized`, and the
   profile lookup must confirm the name exists. Nothing is ever registered.

2. **Enable wake** (separate action, per conversation):

   ```json
   { "action": "watch_enable" }
   ```

   plus either `{"watchFrom": "now"}` to deliberately discard the existing backlog, or `{"watchFrom": "<cursor>"}` to
   read the backlog from an explicitly chosen delivery cursor. An omitted `watchFrom` keeps the stored cursor. The
   watcher is a durable background task, created in the same transaction that records the cursor and the intent.

3. **Stop it**: `{"action": "watch_pause"}`, `{"action": "watch_resume"}`, `{"action": "watch_disable"}` (stops the
   watcher and keeps identity, cursor and pending delivery), or `{"action": "disable"}` (the AM1 action, which also
   stops a configured watcher). Disabling is not uninstalling: to remove the extension from the registry, disable the
   watcher first.

`status` reports the bound identity or `unbound`, the wake state and the watcher's phase, cursor, pending digest, last
fixed error code and next poll time. It never renders a mail body or a token.

### Checks

Run from the workspace root:

```sh
npm --prefix packages/agent-mail-identity test
npm --prefix packages/agent-mail-identity run typecheck
npm --prefix packages/agent-mail-identity run lint
npm --prefix packages/agent-mail-identity run test:live:am2
npm --prefix packages/agent-mail-identity run test:live:pocket
npm --prefix packages/agent-mail-identity run bench
```

The tests need no Pocket checkout. The one test that exercises Pocket's real `codemode` extension resolves the checkout
from `AM_POCKET_CHECKOUT` (default: a `pi-pocket` checkout next to this repository) and **skips with a stated reason**
when the path does not exist, so `npm test` is green for a standalone Durable user:

```sh
AM_POCKET_CHECKOUT=/nonexistent npm --prefix packages/agent-mail-identity test
```

`test:live:am2`, `test:live:pocket` and `bench` are deliberately fail-closed: they exit 2 with the reason the lane
cannot run and never fabricate a receipt. Live Mail acceptance, cloud-worker lanes, screenshots, video, the trunk
comparison and every performance budget are unavailable.

## Optional: Pi Pocket

Pocket is an adapter, not the package's environment. The Pocket entry point is a separate export, `pi-durable-agent-mail-identity/pocket`,
and it imports nothing from Pocket: it reads only the structural host surface, so no Pocket source, no Pocket
application and no Pocket database module is involved.

```ts
// extensions/agent-mail.ts of a Pocket server — written by the host owner, not shipped by this package.
import { createCliTransport } from "pi-durable-agent-mail-identity";
import pocketEntryPoint from "pi-durable-agent-mail-identity/pocket";

export default (host: unknown) => pocketEntryPoint(host as never, {
	transport: createCliTransport("/usr/local/bin/am"),
	mailTools: [],
});
```

The current `PocketHost` publishes **no** submit-as-bound-person operation with live person, steer-role, visibility and
driver validation (A6) and **no** live `RegistryReader` (A1). A mandatory capability that is missing is never replaced
by a permissive fallback, so this entry point refuses to enable wake:

```json
{ "action": "enable" }
```

on the `agent_mail_wake` tool answers `denied` with reason `missing_host_capability` and the exact missing list
(`submit_as_bound_person`, `live_registry_reader`, and `admission_lookup` when the host composes a hindsight admission).
The refusal is total: nothing is read from the host, no watcher is created, no cursor is written, no turn starts. Do not
add methods to `PocketHost` for this, and do not import `PocketApp` or read Pocket's internal user or driver tables.
A positive wake becomes reachable only through an already-public embedding contract that the host itself proves — see
[CONTRACT.md](CONTRACT.md) for its exact shape and the admission rules.

Upgrading an existing installation is described in [MIGRATION.md](MIGRATION.md).
