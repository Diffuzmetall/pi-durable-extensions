# Durable Subagents

An independently packable **Pi Durable SDK 1.2.0 extension/library** for persistent,
isolated child conversations. No Pocket application, BB provider, host patch,
second runtime, scheduler, credentials or external service is included.

Candidate version `0.1.0-candidate.1`; Node.js **>=24.19.0**. The checked compatibility
tuple is Linux x64, Node 24.19.0 and the public Durable / Pi AI / Chord 1.2.0 family.
The three SDK packages are peers: resolve them to the host's admitted physical
runtime, not a second copy. This is a GitHub package, **not an npm release**.

## Get the package

```sh
git clone https://github.com/Diffuzmetall/pi-durable-extensions.git
cd pi-durable-extensions
node packages/cli/src/index.mjs info durable-subagents --catalog "$PWD/catalog.json"
node packages/cli/src/index.mjs doctor durable-subagents --catalog "$PWD/catalog.json" --json
```

The root catalog pins the checked-in archive. To install only this package, choose
a new absolute target outside the checkout and outside `node_modules`, with an
existing parent directory:

```sh
TARGET="$HOME/pi-durable-subagents-target-01"
node packages/cli/src/index.mjs install durable-subagents \
  --catalog "$PWD/catalog.json" --target "$TARGET" \
  --version 0.1.0-candidate.1 --allow-experimental --dry-run
# After inspecting the dry run, repeat without --dry-run to materialize the package.
```

Installation does not activate anything. The installer can download public
peer dependencies with lifecycle scripts disabled; it does not configure models,
start a host or register tools. See [manual extraction](https://github.com/Diffuzmetall/pi-durable-extensions/blob/main/docs/installation.md).

Exports are TypeScript source. Native Node type stripping cannot load `.ts` inside
`node_modules`; use an extracted target **outside** it (as above), or a compatible
TypeScript loader. Do not present ordinary npm installation as a universal loader.

## Register with your host

The package root exports `createSubagent`, `Subagent` and a **default registry
adapter**. The `./registry` subpath exports the same default adapter. They are not
classic Pi `ExtensionAPI` initializer functions and are not interchangeable:

```js
// Paths refer to your extracted target; import these in your host composition.
import installSubagents from './subagents-target/src/registry.ts';
import { createSubagent } from './subagents-target/src/index.ts';

// existingRegistry is your host's RegistryReader, already composed with Hindsight.
// hostResolveModel is your host-owned authorization/resolution callback.
const registry = installSubagents(existingRegistry, { resolveModel: hostResolveModel });
// Give registry to the host's existing Harness startup path. Do not open a second one.
```

The adapter preserves all installed extension objects except the existing
`subagent` owner, then installs this owner. **It requires the existing Hindsight
admission controller** and fails if it is absent. It uses that controller for child,
parent report and supervision admissions; replacing the owner does not remove
other guards. Without `resolveModel`, inheritance works but explicit model
selection is rejected. A host registry-loader that only passes `base` does not
supply this callback automatically.

For a single-user host whose policy permits every model in its authenticated
picker, opt in to the included resolver instead of writing the callback:

```js
import installSubagents, { resolveAvailableModel } from './subagents-target/src/index.ts';
const registry = installSubagents(existingRegistry, { resolveModel: resolveAvailableModel });
```

`resolveAvailableModel` accepts an exact `provider/modelId`, checks
`api.models.getAvailable(provider)`, and rejects bare aliases, unknown models,
unconfigured providers and auth lookup failures without fallback. It preserves
slashes inside model IDs and does not log in, enable providers or change parent
or global defaults. This **is an explicit authorization choice**, not automatic
permission from catalog membership. Multi-user, provider-restricted or
budget-restricted hosts must supply their own narrower policy instead. The
unconfigured adapter still rejects explicit model selection.

For a host that directly composes SDK extensions, `registry.install(createSubagent(
  hostAdmission, { resolveModel: hostResolveModel }))` is the factory route.
`hostAdmission(child, requestId, context)` must enforce the host's admitted memory
and execution policy. The factory's optional argument is an integration hook,
**not advice to omit admission or bypass Hindsight/other guards**. The exported
`Subagent` constant is the unconfigured SDK extension, not an automatically
policy-wired production installation. Admission failure must remain a refusal.

No loader or host is bundled. Wire the documented export into your host's supported
registry composition boundary; do not pass it to a classic extension loader or
patch SDK/core to make it fit. Only one subagent owner may be installed.

## Tools and behavior

- `subagent`: `spawn` (default), `send`, `status`, `stop`. Background by default;
  `background:false` waits, yielding `needs_attention` when the child needs a decision.
- `subagent_models`: authenticated available model inventory, optionally one provider.
  It does not log in, refresh credentials, execute a model or authorize a choice.
- `subagent_send_many`: explicit names or a current-team snapshot; persisted recipient
  IDs and partial-admission results. This is multicast, not a global task queue.
- `subagent_supervisor`: the real parent lists pending questions / quiet progress /
  important updates and replies to an exact `replyTo`.
- `subagent_stop`: aborts only the named owned child; siblings keep running.
- `subagent_release_hold`: explicit release of a **legacy admission** hold only;
  uncertain delivery cannot be guessed or silently replayed.

Workers inherit the parent's allowed tools, including callable nested tools,
minus delegation/sibling controls. Reviewers get only the available `read` tool
plus `contact_supervisor`. A host can narrow the role allowlists; an explicit
`tools` list cannot widen them. **These are permission roles, not dedicated role
personas.** Specialization belongs in the assigned task. All children share the
same supervision guide and answer in ordinary text: there is no mandatory JSON
report schema. Optional JSON and even malformed JSON are treated as literal text.

Children cannot delegate or control siblings. `contact_supervisor` derives the
actual parent from the native ownership binding; client-supplied identity is not
permission. A reply is data, not a grant of additional authority.

See [workflow, model selection, delivery and recovery](https://github.com/Diffuzmetall/pi-durable-extensions/blob/main/docs/durable-subagents.md)
for tool examples and limits.

## Develop and verify without a real model

From this package directory in the cloned repository:

```sh
npm ci --ignore-scripts --workspaces=false --no-audit --no-fund
npm run check
npm test
npm pack --ignore-scripts --pack-destination /absolute/existing/private-output
```

Tests use the public SDK with faux providers, private retained SQLite files and
bounded local gates. The CodeMode/MCP checks use an in-memory transport, never real
Mail or provider accounts. A few recovery tests kill **their own fixture subprocess**;
no user host is touched. Temporary databases are retained under the OS temp root,
not in the package or archive. Tests and dev dependencies are repository-only;
the archive allowlist contains just `src/`, this README, NOTICE and licenses.

Typechecking and package tests do not certify your host's authorization callback,
real provider credentials, Mail identity, loaded TUI or deployment. The core source
was accepted separately; packaging checks exercise the same bytes through public
SDK imports rather than claiming that historical acceptance is a new live run.

## License

MIT integration code; Pocket-derived code retains its MIT license in
[LICENSE.pocket](LICENSE.pocket). See [NOTICE.md](NOTICE.md) for attribution and
provenance. No SDK implementation is vendored.
