# Portable collection CLI candidate

This is the U6 candidate for selective local installation. A fresh private artifact may use package version `0.1.0-candidate.2`; the frozen canonical candidate remains unchanged. It has no Pocket or
collection-workspace imports and uses only Node built-ins plus the host `npm`
command. It does not publish packages, claim a public package namespace,
assert license approval, read credentials, enable extensions, start services,
alter global configuration, or remove files.

## Bootstrap

From this candidate directory, or from a future collection checkout:

```sh
node packages/cli/src/index.mjs list
node packages/cli/src/index.mjs info codemode
node packages/cli/src/index.mjs doctor --json
node packages/cli/src/index.mjs install codemode --target /absolute/new/target --version 0.1.0 --dry-run
```

The candidate-local bootstrap is:

```sh
node src/index.mjs list --allow-experimental
```

Archive caps and operational dependency output are separate boundaries. The
catalog SHA-256 pins the selected top-level artifact; npm runs with lifecycle
scripts disabled and package-manager failures retain staging. npm dependency
materialization is not given a new quota, cgroup, or global runtime limit, and
post-install hashing streams legitimate SDK/native files rather than rejecting
files over the archive caps. This limitation is explicit; the installer does
not claim pre-materialization quotas for npm.

`list` shows only `stable` entries by default. `experimental` and `candidate`
entries require `--allow-experimental` on `list` and `install`; `blocked` is
never installable. The checked-in catalog deliberately contains no distributable
artifacts yet, so its doctor report is expected to show unavailable artifacts.

## Install safety

- `install` requires an exact package ID, exact catalog-pinned version, and an
  absolute target whose parent already exists. Absolute target paths may not
  contain traversal segments.
- The artifact path and SHA-256 digest come from the catalog. The archive is
  parsed locally; absolute paths, traversal segments, duplicate entries,
  symlinks, hardlinks, devices, and unsupported tar types are refused. Resource
  caps bound the untrusted catalog artifact before materialization: compressed
  input (4 MiB), decompressed tar (16 MiB), members (1024), each archive member
  (1 MiB by default), and aggregate archive file bytes (8 MiB). The only
  oversized-member allowance is the exact conjunctive canonical Hindsight case:
  component `hindsight`, verified artifact SHA-256
  `4ce1fc0d192530ccbaa42ffd05c3bac21d4f9b8d81179960b6fb05f121043443`, raw
  member `package/src/vendor/mcp-server.js`, regular tar type `0`, size
  `1242386`, and member SHA-256
  `c1adb47de2972bbb4a708fc209dc4e1dbfc7fa53afc6666b133865f24ac9f03d`, with
  no PAX path context. All other members remain subject to the generic 1 MiB
  limit and all other caps remain unchanged. This implementation note grants
  no publication or redistribution rights and does not change any licensing
  status.
- Installation happens in a fresh retained sibling staging directory. The
  selected package manager runs with `--ignore-scripts`, `--workspaces=false`,
  `--bin-links=false`, and `--omit=dev`, plus no audit/fund, scrubbed npm
  config, isolated user/global config, and no package-manager shell. Dependency
  tool bins are not linked or executed; activation remains a manual source,
  entrypoint, or service command. A package with `workspaces` is rejected. The
  staging directory and isolated npm cache are never deleted on failure.
- On the tested Linux baseline, installation opens every target-parent component
  through directory file descriptors (`O_DIRECTORY|O_NOFOLLOW`) and keeps the
  validated parent descriptor through staging, package-manager execution, and
  publication. Child processes receive that descriptor as fd 3; unsupported
  platforms refuse installation rather than falling back to path check-then-use.
  Publication validates and uses pinned `/usr/bin/mv` (`GNU coreutils`, `-nT`)
  rather than caller `PATH`. It is a no-clobber move: a target race, symlink,
  foreign directory, or foreign file fails without replacing it. An exact prior
  install is a no-op only when its marker and all recorded file hashes still match.
- `--dry-run` validates catalog, target parent, artifact type, and digest but
  does not create a staging directory, run npm, or start anything.

For deterministic synthetic tests, `--catalog` points to a fixture catalog and
`--package-manager` points to a fixture executable. The default package manager
is `npm`; no `npm ci` is used. The offline npm fixture proves that default bin
links create a `.bin` symlink, while the installer’s explicit flags avoid it and
omit dev-only packages. The tested anchoring baseline is Linux with
`/proc/self/fd`, Node 24.19.0, and GNU coreutils `mv` 9.5.

## Peer materialization boundary

For the nine canonical component artifacts, the installer reads the extracted
`package.json` before invoking npm and only accepts a package identity, version,
peer declaration set, and optional-peer metadata that match the artifact SHA-256
and the checked-in trusted peer manifest. It matches the complete normalized
`peerDependenciesMeta` object, including explicit `optional: false` entries, and
passes only the validated non-optional peer specs as argument-array values. It
does not construct a shell command, accept package URLs, Git/file/workspace/npm
aliases, unknown package names, malformed ranges, control characters, or shell
metacharacters. Optional peers remain omitted.

The package manager runs with `--no-save`, `--package-lock=false`,
`--ignore-scripts`, `--no-audit`, `--no-fund`, `--workspaces=false`,
`--bin-links=false`, and `--omit=dev`, using a fresh retained private cache.
The npm child receives descriptor-bound `/proc/self/fd` paths for its private
cache, peer prefix, and staging cwd; ordinary `realpath` strings are not used as
security evidence. Peer copying reopens source entries with `O_NOFOLLOW`,
fstats opened objects, rejects special files, and copies through held
file descriptors. The raw extracted `package.json` bytes are hashed before,
revalidated after marker construction, and compared after npm; any change or
package-lock creation fails while retaining staging. This validates
the selected package root and peer route; it does not provide pre-materialization
quotas, guarantee registry availability, grant publication or redistribution
rights, or replace host authorization and activation.

The supported candidate.2 route is a default npm install of the canonical Codex
API artifact with the four checked-in peer pins `chord@1.1.0`, `pi-ai@1.1.0`,
`pi-durable@1.1.0`, and `typebox@1.3.27`, each within its declared peer range.
This is a bounded representative route, not a claim that all nine components
have been installed or runtime-validated.

## Catalog boundaries

The candidate catalog has exactly nine approved components: codemode,
agent-mail, codex-api, agent-profiles, web-tools, context7, antigravity-shim,
codex-voice, and hindsight. Context7 is an active experimental extension; its
credential setup, shared/unknown external quota, outbound-query disclosure, and
MIT licence remain explicit package boundaries.
`pi-durable-beads`, Lancet, goals, schedules, triggers, and other built-ins are rejected. Component
status and requirements are descriptive provenance, not proof of a passed bare
Durable or live-service gate. Service startup, credential setup, host authorization, Pocket adapters,
and activation remain explicit operator steps.

## Independent checks requested

Before acceptance, a reviewer should inspect `src/index.mjs`, the catalog
allowlist, archive/path checks, no-clobber publication, and the absence of
cleanup/overwrite operations. A distinct QA run should use retained synthetic
tarballs to exercise list/info/install/doctor, stable versus experimental opt-in,
exact version and digest failures, lifecycle suppression, repeat no-op, foreign
file, readonly/symlink target, package-manager failure, archive symlink/traversal,
and target-race cases. Both checkers must use the same frozen candidate hash.
