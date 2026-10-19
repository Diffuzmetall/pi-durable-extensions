# Durable Subagents: host and parent guide

[Package, installation and exports](../packages/durable-subagents/README.md).
This guide describes the candidate SDK extension, not an installed application.

## Assign work, not personas

Every child receives one common guide: answer the parent in ordinary text, keep
routine progress quiet, send important findings without waiting, and ask the
actual parent only when a decision blocks work. `worker` and `reviewer` are tool
permission roles, not specialist system prompts. Put the required specialty,
files, constraints and deliverable into `task` (or its alias `message`). No JSON
report contract is required.

Parent tool calls below are illustrative arguments to the registered tools, not
shell commands or a new configuration format:

```js
// Start A and B independently; stable request IDs deduplicate repeated admission.
subagent({ name: 'a', task: 'Inspect the parser boundary and report findings.',
  requestId: 'parser-a', role: 'reviewer' });
subagent({ name: 'b', task: 'Inspect the serialization boundary and report findings.',
  requestId: 'parser-b', role: 'reviewer' });
// Save each spawn receipt's executionId, conversationId and native requestId.
```

Both run in native child conversations. When A and B have returned results, the
**parent** evaluates them and starts C with the relevant context:

```js
subagent({ name: 'c', task: 'Reconcile the supplied A and B findings: ...',
  requestId: 'parser-c' });
```

There is no `dependsOn` field, global queue, DAG scheduler or automatic A+B→C
mechanism. The parent owns that orchestration and any product acceptance decision.
The default active-child limit is 20; admission refusal does not authorize bypass.

`subagent({action:'send',name:'a',message:'Check this additional case.',
requestId:'parser-a-followup',followUp:true})` queues a **per-child** follow-up.
Without `followUp:true`, send steers that child through the SDK's native processing
boundary. It does not interrupt an arbitrary running external command. Reuse
`send` for the existing child; duplicate names on new spawns are rejected.
A stable request ID reused with different content/options is a conflict.

`subagent_send_many({names:['a','b'],message:'Check the same additional case.',
requestId:'shared-check',mode:'followUp'})` persists its recipient snapshot and
per-recipient outcome. A retry does not readmit recipients already accepted.
`all:true` targets the current team, not historical or subsequently created members.
It still does not create a global scheduler.

## Models and reasoning

Call `subagent_models({})`, or filter with `{provider:'your-provider'}`, to inspect
the host's **authenticated available** inventory. Use the exact returned
`provider/modelId` string at spawn time:

```js
subagent({ name: 'chosen', task: 'Inspect the supplied design.',
  requestId: 'chosen-1', model: 'provider/exact-model-id', thinking: 'high' });
```

Replace the placeholder with an actual inventory item. A cross-provider model,
including Gemini, can be selected only when that provider is already authenticated,
available and authorized by the host. No fallback, credentials, provider shim or
login is supplied by this package. Omitting `model` inherits the parent model;
omitting `thinking` inherits its level, with the SDK clamping explicit selections
to supported levels. Supported request values: `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`. Receipts/details and human status disclose the effective model
and thinking, not merely the requested values.

**Explicit selection requires a host-owned `resolveModel(selection, api, context)`
callback** returning a `ModelRef` (`{provider,modelId}`). It must authorize the exact
selection, not merely parse the string or trust inventory membership. The extension
then verifies that the selected model exists. The default registry adapter accepts
this callback as an option, but a loader invoking it with only `base` supplies none:
in that composition explicit `model` is rejected rather than silently ignored.

A single-user host may explicitly opt in to the package's `resolveAvailableModel`
export when its policy is to allow every model from its authenticated picker:
`installSubagents(base, {resolveModel: resolveAvailableModel})`. The resolver
requires the exact `provider/modelId`, checks `api.models.getAvailable(provider)`,
and refuses aliases, unavailable/unconfigured providers or models and auth errors
without a fallback. It does not change the parent or global model. For tenant,
provider, spending or other restrictions, use a narrower host-owned callback;
this helper is not a multi-user authorization service. Existing admission and
tool-role guards remain in force.

`send` intentionally rejects `model`, `thinking`, `role` and `tools`. Existing
children keep their spawn configuration. For a new authorized configuration,
spawn a new named child; do not claim that send changed an existing child's model.
Package tests do not prove any consumer's resolver or provider credentials work.

## Results: one canonical SDK answer

The answer remains in the child's canonical SDK assistant entry. An execution
stores its `durable:<conversationId>:<entryId>` reference, not a second report body
or synthesized summary. Ordinary text, optional JSON, malformed JSON and Unicode
are not parsed into a report schema.

Retrieve an exact result without rerunning the child:

```js
subagent({ action: 'status', name: 'a', requestId: '<native-requestId-from-receipt>' });
```

Use the **native requestId from the spawn/send receipt**, not the caller's original
idempotency key or an execution belonging to another child. Named status returns
the text, `answerRef` and exact correlation in canonical `output` / `structuredOutput`.
The structured row also distinguishes execution workState, pending reply IDs and
progress from another (stale) execution. Unnamed inventory is bounded to 50 agents
and omits full result bodies; `truncated` describes that inventory bound.

The SDK's model-facing tool output has a **50 KiB / 2,000-line** bound. A long result
may be clipped with an explicit native warning while a diagnostic retains its
canonical reference. Full named-status `structuredOutput.agents[0].result.text`
remains available to host code and nested/CodeMode calls. Do not confuse clipped
model text with truncated canonical data or silently call the child again.
CodeMode is an optional separately composed SDK extension, not a package dependency
at runtime. A CodeMode consumer can read:

```js
const r = await tools.subagent({action:'status',name:'a',requestId:'<native-requestId>'});
const result = r.agents[0].result; // text + answerRef; no mandatory report JSON
```

Missing or foreign references fail closed; an old formatted summary is never
pretended to be the canonical answer. Historical records without a reference are
explicitly marked as saved, noncanonical text.

## Delivery, decisions and recovery

An SDK-owned **Anchor** holds each child conversation. A native **Reporter** submits
its input, waits for its answer, saves the reference and directly submits a parent
notification with `whenBusy:'steer'` and a stable native request ID. It ends after
native admission, without waiting for the parent's model answer. Busy placement
occurs at the next SDK boundary; admission is not proof that the parent has read,
accepted or acted on the result, nor a promise to preempt a running tool.

Coalesced child inputs can resolve to the same canonical assistant entry. The
persisted answer claim and recoverable report checkpoint select one notification
owner, so exact per-execution status remains available without notifying twice.
Reopen reuses the native request receipt; it does not resubmit child work by guess.
Foreground waits return the canonical result directly; abandoned foreground guards
have a native recovery handback rather than leaving completed work stranded.

New completions have no Courier/outbox/batch/budget-hold path. Legacy Courier
schema/tasks remain for already-persisted work only. Existing uncertain holds and
unsafe external side effects are not automatically replayed. An old admission
hold can be explicitly released by its actual parent; unknown delivery outcomes
require inspection, not a force-deliver or automatic retry. Exactly-once native
admission does not guarantee exactly-once external effects.

`contact_supervisor({reason:'progress_update',message:'...'})` records quiet progress.
`important_update` persists a nonblocking steer and the child continues.
`need_decision` and `interview_request` wait without a timeout for the actual parent;
the parent uses `subagent_supervisor` pending/reply with the exact replyTo. Interview
answers must match question IDs/options. Identical replies are idempotent;
conflicting, stale, cancelled or foreign replies are refused. Only interview
answers have a JSON-object requirement; child final reports do not.

Cancellation targets one bound child and its pending requests; sibling work is
isolated. Parent-only controls remain guarded even if a host accidentally exposes
them to a child. A reply never expands the child's permissions.

## Admission and Mail are separate boundaries

The default registry adapter requires the existing Hindsight admission controller.
A direct factory consumer must wire the equivalent admitted host policy. Preserve
other guards and one physical SDK execution owner; do not omit admission to make a
refusal disappear.

This package does **not** provide MCP transport, per-child Mail identities, project
grants, credentials, a registry loader, TUI or host installation. Compose an admitted
conversation-bound MCP/Agent Mail adapter separately. Each child must self-register
through that adapter in its own genuine context. Parent identity, a display label,
a client tuple or this package's successful spawn does not prove a child Mail binding.
