# Portable Pi Durable Extensions

This repository is a local GitHub-ready candidate collection. It is not a Pocket replacement and does not activate extensions or services.

## Boundaries

- Keep the eight catalog components independently selectable; the CLI is a separate installer/doctor package.
- Do not add Context7, Pi Durable Beads, Lancet policy, goals, schedules, triggers, or other Pocket built-ins to the active catalog.
- Preserve package-local exports, dependencies, notices, and semantics. Pocket host behavior belongs in explicit adapters.
- Never commit `node_modules/`, private profiles, provenance/verification/evidence receipts, journals, audio, uploads, databases, runtime configuration, credentials, or retained fixtures.
- Installation must use exact packed artifacts, `--ignore-scripts`, isolated targets/caches, and no-clobber publication. Activation, service startup, provider authorization, live quota, Pocket checks, and publication are separate operator actions.
- Keep candidate, experimental, and unresolved-license status truthful. Do not invent a namespace, license grant, or universal compatibility claim.

## Verification

Record exact package/version, artifact path and SHA-256, Node/npm tuple, command, result, and limitations. A local fixture is not proof of a live provider, subscription, microphone, Pocket adapter, or service deployment.
