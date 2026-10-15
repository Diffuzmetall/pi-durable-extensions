# Compatibility and activation boundaries

Verified tuple for this checkout: Linux x64, Node `24.19.0`, npm `11.17.0`, Pi Durable `1.2.0`. The npm registry reported `1.2.0` as the latest published version when this migration started. Version ranges for other releases are not inferred from this proof.

| Component | Runtime dependencies checked | Activation boundary |
|---|---|---|
| codemode | Durable / Pi AI / Chord / Pi CodeMode `1.2.0` | Explicit registry install; native invocation-bound nested execution |
| agent-mail | Durable / Pi AI / Chord / Pi MCP `1.2.0` | Explicit loopback endpoint and host write policy |
| codex-api | Durable / Pi AI / Chord `1.2.0`, TypeBox `1.3.27` | Host OAuth authorization and optional upload root |
| agent-profiles | No Pi runtime dependency; YAML `2.9.0` | Parser/catalog only, not a launcher |
| web-tools | Durable / Pi AI / Chord `1.2.0` | Explicit registry install and network policy |
| context7 | Durable / Pi AI / Pi MCP `1.2.0` | Explicit credential capability and host invocation policy |
| antigravity-shim | Installed `pi-antigravity 0.10.0` peer with Pi AI / coding-agent `1.2.0` | Separately started service; fixture tests do not access real OAuth accounts |
| codex-voice | Durable / Pi AI / Chord `1.2.0` | Host Models/auth and a separate microphone adapter |
| hindsight | Durable / Pi AI / Chord `1.2.0` | Explicit lifecycle controller; external memory service remains separate |
| dcg-guard | Durable `1.2.0` | Owner-provisioned DCG; fail-closed guard and native runtime identity checks retained |
| search-history | Durable / Pi AI / Chord `1.2.0` | Explicit extension registration; no service, configuration read or background task |
| CLI | Node `24.19.0`, npm `11.17.0`, Linux directory-fd semantics | Exact artifact verification/installation only; never activation |

## What changed in Pi 1.2

Tool execution results carry model-visible `output`, program-visible `structuredOutput`, UI `details` and `diagnostics`. MCP wire results and model-message content continue to use `content`; those are different contracts and must not be renamed blindly. CodeMode calls `api.executeTool` instead of constructing a partial tool API, so native validation, hooks, caller policy, replay and cancellation remain authoritative.

## Source packages and host integration

TypeScript-source packages are usable from extracted installation targets outside `node_modules` with Node's native stripping. Node refuses direct TypeScript loading inside `node_modules`; these packages are not claimed to be ordinary compiled npm drop-ins. Use the selective installer's extracted target, or a compatible TypeScript runtime. Compiled Agent Profiles and DCG entries use their generated `dist` modules.

Use one admitted host runtime when integrating components. In particular DCG deliberately rejects an environment created by another physical copy of the Durable class, even at the same version. Do not bypass that check to combine separately resolved copies; arrange a single host dependency tree and verify admission instead.

Package fixtures, real Harness tests and packed-artifact verification do not prove Pocket/BB loader activation, live provider credentials, paid quotas, microphone access, or external Hindsight/Agent Mail services. No host configuration or live service activation is part of this migration.
