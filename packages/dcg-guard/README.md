# `@pi-pocket/dcg-guard`

A Durable extension that checks the actual prepared shell command with an owner-selected DCG 0.15.3 binary before forwarding it to the selected Durable `bash` operation. It is an additional protection layer, not a sandbox.

**Delivery status:** First-party source and PR review are independent of the external DCG license-applicability question. Collection publication, installation, and enablement require independent QA of the exact selected archive and coordinator GO. The archive contains no DCG binary or upstream source. Whether a consumer may provision or invoke an externally operated DCG executable under the pinned rider is **unverified**; obtain operator/legal review before that use. This is not a claim of unrestricted use.

## Bare Pi Durable

Requirements: Node.js `>=24.19.0`, Pi Durable `1.2.0`, and an owner-provisioned executable DCG `0.15.3` binary. For this install candidate, give DCG a dedicated evaluator state root; do not reuse or copy the owner's existing DCG configuration, allowlists, or data. Create the root and its `home/`, `config/`, and `data/` directories, plus comment-only `policy.toml` and `system-allowlist.toml` files. Their contents can be:

```toml
# Dedicated DCG policy for this guard. No allow rules are admitted.
```

Keep `<root>/config/dcg/allowlist.toml` absent; the separate policy contains no `[[allow]]` entries and no directory-scoped allowlists are admitted. These are separate evaluator paths, not edits to owner settings.

Pass only absolute, owner-selected paths as trusted configuration (never derive them from model-controlled shell arguments or environment values):

```ts
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createDcgGuard } from "@pi-pocket/dcg-guard";

const policyRoot = "/absolute/path/to/dcg-guard-state";
registry.install(CodingTools);
registry.install(createDcgGuard({
  binaryPath: "/absolute/path/to/dcg",
  evaluatorEnv: {
    HOME: `${policyRoot}/home`,
    XDG_CONFIG_HOME: `${policyRoot}/config`,
    XDG_DATA_HOME: `${policyRoot}/data`,
    DCG_CONFIG: `${policyRoot}/policy.toml`,
    DCG_ALLOWLIST_SYSTEM_PATH: `${policyRoot}/system-allowlist.toml`,
    DCG_ALLOW_ONCE_PATH: `${policyRoot}/data/allow-once.jsonl`,
    DCG_PENDING_EXCEPTIONS_PATH: `${policyRoot}/data/pending-exceptions.jsonl`,
  },
}));
```

The two TOML files are intentionally empty/comment-only. The dedicated allow-once and pending-exception paths preserve DCG's exact-command single-use grant flow without sharing or changing existing owner grant/config state. Do not disable one-use grants or add directory-scoped allowlists to this policy.

The factory accepts only `binaryPath` and `evaluatorEnv`. It returns a selectable Durable extension; it does not install itself, locate or download DCG, change host configuration, or enable itself in Pocket.

## Pi Pocket drop-in

The separate default-export example is [`pocket/dcg-guard.ts`](pocket/dcg-guard.ts). It contains placeholders for the trusted binary and a separate evaluator-state root; replace them with absolute owner-selected paths before use. Provision comment-only policy files and fresh isolated `home/`, `config/`, and `data/` directories at that root. Do not point this drop-in at or copy existing owner settings. `config/dcg/allowlist.toml` must remain absent; exact-command one-use grants use the dedicated `data/allow-once.jsonl` store. The example deliberately contains no path from the development machine.

For the no-core-write Pocket layout, unpack the exact accepted package archive so its package root is at `<dataDir>/extensions/_dcg-guard/`, retaining `package.json` and `dist/`. Copy `pocket/dcg-guard.ts` to `<dataDir>/extensions/dcg-guard.ts`. Its relative import resolves the unpacked package at `./_dcg-guard/dist/index.js`; the Durable peer resolves through Pocket's existing extensions dependency link. Do not install into or replace that link. Review the complete configured drop-in and enable the extension only through the owner's approved Pocket workflow. Changing the helper package requires a fresh helper location or owner restart; reloading only the drop-in does not invalidate imported modules.

## Admission and limits

The guard supports only an admitted local POSIX Node environment using the public Durable `1.2.0` APIs and the pinned DCG `0.15.3` robot-test protocol. Host admission must confirm the selected bash implementation, stable trusted shell setup and extension/wrapper composition. The guard rejects unsupported environments and evaluator/protocol failures; it never treats an unavailable result as allow.

Only a complete, consistent protocol allow permits the original shell operation. Refusals use fixed errors: `DCG_DENIED` or `DCG_UNAVAILABLE:<GuardFailure>`; invalid factory options throw `DCG_INVALID_OPTIONS`. Raw command text, evaluator output, rule IDs and configuration are not included in guard errors.

This is not an OS sandbox. It does not cover arbitrary extensions that bypass the supplied execution environment, opaque script contents, direct process launches outside Durable's `exec`, arbitrary MCP/file mutations, remote or container environments, Windows, PowerShell, Bun, or untested Durable versions. DCG policy files and the admitted host environment remain trusted. This install candidate uses isolated policy/config paths with no directory-scoped allowlists; exact-command one-use grants remain enabled in a separate grant store. The guard does not create, refund or cache grants. Evaluation can consume a one-use grant before cancellation or a crash prevents shell forwarding; grants are not refunded or replayed. The scoped-policy `cd` counterexample remains recorded as excluded evidence, not a passing supported-policy claim; full hook parity for `cd`-scoped rules is not claimed.

Abort before evaluation, during evaluation, or after an allow verdict but before the immediate call to the original shell operation prevents that operation and terminates the owned evaluator. After shell-operation admission, cancellation follows the original Durable environment behavior; this wrapper does not claim an OS-level no-spawn guarantee for an abort during downstream shell startup.

## Package checks

The scripts are `typecheck`, `build`, `test`, `test:dcg`, `test:dcg:excluded`, `test:pocket`, and `test:consumer`. `test:dcg` runs only the admitted no-directory-scoped-policy cases. `test:dcg:excluded` runs the unchanged strict scoped-policy counterexample as an explicitly excluded diagnostic; it is expected to fail under the unsupported scoped policy and must never be described as passing or included in release acceptance. Build emits ESM and declarations under `dist/`; package scripts do not clean or install dependencies. Package generation does not run package scripts; the exact archive, catalog digest, and CLI peer-trust digest must agree before installation. Source checks do not substitute for archive verification, and installation does not activate the extension or prove Pocket live behavior.

**Historical frozen-source evidence** (`src/index.ts` `b424d7ca1e88079187167b6ca5e0a33b4028a12e8a42c016ed8d8a5de238ae37`; `dist/index.js` `1ce69dc577f777383b1369ead281f46e03ec5c49a19dfa7c18c76b0bdaa72ff4`; declaration `97c350b1af28fc427dac33f70263279e365851c3e47de9b19a058ff3f722d7dc`):** the recorded frozen-source typecheck/build passed; corrected boundary+Harness tests passed 33/33; supported real-DCG tests passed 5/5. The separate strict scoped-policy counterexample remains an expected-fail excluded diagnostic, not a passing supported-policy claim. The governing ISA's 30/30 acceptance, including clean-consumer, isolated Pocket and owner-enabled live evidence, applies to the earlier exact archive `pi-pocket-dcg-guard-0.1.0.tgz` (`49ac78458c6ebf7b7d4b22d7944f763e145289ec4bcd72858bb68c249e330d0c`) only. That historical archive predates this collection copy's package `LICENSE` and `NOTICE`; its results do not establish acceptance of the license/notice-bearing archive.

## Collection archive and installation conditions

The selected collection archive must be independently verified as the exact seven-member package, and its digest must match both the selected catalog and the CLI peer-trust pin before installation. Coordinator GO is also required. The historical `49ac78458c6ebf7b7d4b22d7944f763e145289ec4bcd72858bb68c249e330d0c` archive predates this collection copy's package `LICENSE` and `NOTICE`; it is historical, not the license/notice-bearing collection archive. Installation does not activate the extension, provision DCG, or authorize external DCG use.

## Provenance and licensing

The adapter and collection-specific integration are first-party source authored for this project. The package `LICENSE` names Diffuzmetall and covers only those first-party files; it does not cover DCG upstream software. The adapter uses public Pi Durable APIs and Node built-ins. It does not include DCG's Rust implementation, parser, rules, binary, or other upstream source.

The pinned upstream source commit `3eec165ae64a56bfbb2cecaa2510d82076010851` has a `LICENSE` titled “MIT License (with OpenAI/Anthropic Rider)” and an “ADDITIONAL RIDER / RESTRICTION (OpenAI / Anthropic)” section. That rider defines restricted parties and states that “use” includes execution, testing, and analysis. See the exact pinned file: [upstream LICENSE](https://github.com/Dicklesworthstone/destructive_command_guard/blob/3eec165ae64a56bfbb2cecaa2510d82076010851/LICENSE). This package does not characterize the upstream terms as an unmodified MIT grant, relicense DCG, or conclude whether this independently authored adapter is a derivative work or whether a particular consumer may obtain or invoke the executable. An operator/legal reviewer must assess the pinned terms and their applicability before provisioning or running DCG. No unrestricted-consumer claim is made.
