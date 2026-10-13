# Compatibility and activation boundaries

Observed integration runtime: Linux x64, Node `24.19.0`, npm `11.17.0`. This is not a universal compatibility claim. Each package README and catalog entry retains its own tested tuple and peer requirements.

| Package | Tested tuple / requirements | Activation boundary |
|---|---|---|
| codemode | Pi Durable/Pi AI/Chord/Pi Codemode `1.1.0`; Node `>=22.19` | Register explicitly; Pocket name adapter remains separate |
| agent-mail | Pi Durable/Pi AI/Chord/Pi MCP `1.1.0`; Node `>=22.19` | Configure loopback MCP endpoint and host write policy |
| codex-api | Pi Durable/Pi AI/Chord `1.1.0`, TypeBox `1.3.27`; Node `24.19` observed | Host supplies OAuth authorization and optional upload root |
| agent-profiles | `yaml 2.9.0`; Agent Profiles author dev compiler TypeScript `6.0.3`; Node `24.19` observed | Parser/catalog only; launcher adapter is separate |
| web-tools | Pi Durable/Pi AI/Chord `1.1.0`; optional fetch peers remain explicit | Review network policy and register manually |
| antigravity-shim | Node `>=22.15`; `pi-antigravity >=0.10`; local service | Provision/start service separately; installer never starts it |
| codex-voice | Pi Durable/Pi AI `1.1.0`; Node `24.19` observed | Host supplies Models, auth, lifecycle and microphone adapter |
| hindsight | Pi Durable/Chord/Pi AI `1.0.2`; Node `>=24` | Bind lifecycle controller explicitly; external memory setup is separate |
| agent-mail-identity | Pi Durable/Pi AI `1.1.0` (`chord 1.1.0` is test-only); Node `>=24.19.0` | Register the extension and grant a binding per conversation; the host supplies the Mail transport and the Pocket entry point refuses without host capability |

Hindsight's version tuple is intentionally distinct from the `1.1.0` component tuple. Profile compiler details are package-local evidence only. No Pocket adapter, live provider, account, quota, microphone, detached service, or restart claim is implied by this table.
