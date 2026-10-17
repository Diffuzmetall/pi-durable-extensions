# Origin and license notice

Copyright (c) 2026 Tanner Middleton — Pocket-derived patterns and code, MIT;
complete notice in LICENSE.pocket.
Copyright (c) 2026 Diffuzmetall — integration adaptations, MIT;
complete notice in LICENSE.

Source lineage:

- Pocket `src/server/extensions/subagents.ts`: named persistent messaging,
  background ownership and reporter queue-withdrawal behavior. PocketHost backend,
  account model, budgets, application documents and legacy result contract are not
  imported. Pocket's MIT notice is retained in full.
- The pi-durable-bb-adapter BB2 SDK 1.2 subagent owner and its documents/tasks/delivery
  modules: foreground execution, stable ownership, roles/admission and scoped controls.
  `documents.ts` preserves the existing `bb.subagents` v1 schema.
- The adapter's subsequent standalone-team integration: parent/supervisor correlation,
  direct native reports, single canonical answer references, coalescence/recovery,
  native text results and registry composition with the existing Hindsight controller.
- Supervisor reasons/correlation use patterns from `pi-subagents` 0.78.0
  `native-supervisor-channel.js` (MIT), as noted in `src/supervisor.ts`.

The nine runtime source modules preserve the accepted standalone native-text
implementation without packaging-specific behavior changes. Package tests are
adapted from the same source's regression suites; only relative imports,
standalone subprocess bootstrap and retained OS-temp fixture locations differ.
No private acceptance files, runtime state, host implementation or SDK code is
included in the archive. The public Durable, Pi AI and Chord 1.2.0 SDKs are peers;
CodeMode and MCP are used only by repository tests.
