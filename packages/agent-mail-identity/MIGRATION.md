# Migrating from the old bridge

This package replaces the earlier terminal bridge for the same mailbox. A mailbox has exactly one owner, so the two must
never poll it at the same time. The migration is procedural: this package installs nothing and starts nothing on its own.

## Before you switch

1. **Stop the old bridge.** Stop the process or session that polls the mailbox today (the terminal bridge, a shell
   loop, or a task another host started). Do not start the new watcher while the old one is still polling: two readers
   would deliver the same letters twice.
2. **Keep the identity.** Migration does not touch the Agent Mail identity: the same `projectKey` and `agentName` are
   reused, and a conversation that was already bound keeps its `bindingId`. Do not register a name again. Identity and
   watch state live in different documents, so disabling monitoring never removes the binding.
3. **Never import the old in-memory position.** A cursor that only lived in the old bridge's memory is not durable and
   is not adopted. The default is the mailbox's current position (`watchFrom: "now"`): the backlog is deliberately
   discarded. To read past events on purpose, supply an explicitly chosen, valid `cursor` and accept that the events
   before it are lost — a cursor the mailbox can no longer serve pauses the watcher (`watch_cursor_expired`) instead of
   skipping letters silently.

## Switching

```json
{ "action": "bind", "projectKey": "/my/project", "agentName": "ExactExistingName" }
{ "action": "watch_enable", "watchFrom": "now" }
```

The enable writes the cursor and the intent and creates the watcher task in one transaction, so a restart resumes the
stored cursor rather than a fresh position. A repeated enable adopts the existing live watcher instead of creating a
second one: after any number of restarts there is at most one watcher per binding, and it is the durable state that
names it. `status` shows which task currently owns the mailbox.

## Rolling back / disabling

1. `{"action": "watch_disable"}` stops the watcher and proves it is terminal (a join that cannot be verified is
   reported as `watcher_join_unverified`, never as success). It keeps the identity, the `cursor` and any pending
   delivery, so a later `{"action": "watch_enable"}` continues from where the watcher stopped.
2. Remove the extension from the registry, or stop the host. Removing the extension makes the watcher stop at its next
   live-presence check and leaves the watch `paused` with reason `uninstalled`. Removing only the task *definition*
   does not abort a running task: Durable keeps running it under its stored definition until the presence check stops
   it, which is why the host must supply the presence source (`standaloneWatch` does).
3. Restart the old bridge only after the watcher is disabled and its task is terminal.

## Schema and downgrade

The watch document carries `schemaVersion: 1`. A document written by another schema version is not guessed at: the
watcher pauses with `watch_schema_incompatible` (rewriting only its own fields, so the document becomes decodable
again), and an admission refuses with `schema_unsupported`. On a downgrade to a build that does not know a stored
schema, poll and submit stay forbidden until the document is understood again. Do not hand-edit the stored documents.

## What is preserved and what is not

- Preserved: the identity binding, the durable `cursor`, at most one `pending` delivery, the last fixed error code and
  the poll schedule.
- Not preserved: the old bridge's in-memory position, its own retry counters, and any open terminal session. Nothing
  from the old bridge is imported — not even as a starting hint.
- Never claimed: exactly-once model tools. Admission of one batch is deduplicated; a repeated model turn is not.
