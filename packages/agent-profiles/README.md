# Portable agent profiles (candidate)

This candidate provides a small, Pocket-free catalog/parser for owner-managed Markdown subagent profiles. It does **not** include a launcher, a Durable extension, `SubagentsDoc`, or a replacement for Pi Pocket's native `subagent` tool.

Status: **experimental candidate**. The source snapshot has no applicable license file or source header, so this package makes no stable or distribution claim. See [NOTICE.md](./NOTICE.md).

## What it exports

- `parseProfile(text, options)` validates Markdown frontmatter and returns a normalized profile without filesystem or runtime dependencies beyond `yaml`.
- `loadProfile(directory, name)` reads exactly `<directory>/<name>.md` after validating the lowercase kebab-case name, regular-file status, 64 KiB limit, root containment, and escaped symlink rejection.
- `catalogProfiles(directory)` lists direct Markdown profile files and reports malformed entries individually instead of silently treating them as absent.
- `readProfile(directory, name)` is the explicit catalog read operation.

Supported frontmatter fields are `name`, `description`, `model`, `thinking`, and `tools`. `thinking` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; `tools` is a unique YAML string list or comma-separated string. The Markdown body must be non-empty.

## Setup and use

Measured local baseline: Node `v24.19.0`, npm `11.17.0`, Pi Durable `1.1.0`, and `yaml` `2.9.0`. The package manifest declares Node `>=22.19`, but that range is not a compatibility proof; verify the target host before use.

```sh
npm install --ignore-scripts
npm run build
node examples/read-profiles.mjs
node examples/read-profiles.mjs /absolute/path/to/owner-managed/agent-profiles
npm run check
npm test
```

The package reads only a directory explicitly passed by the embedding application. A host should create and owner-manage that directory, keep it outside untrusted checkouts, and treat profile text as instructions visible to the model. This package does not create or edit profiles, resolve models, check available tools, enforce authorization, or start providers.

## Pocket adapter boundary

The existing Pocket adapter remains responsible for native `subagent` spawn, model/tool resolution, plan and guard handling, and durable child creation. Where an adapter uses these profiles, it must append profile instructions to the new child's durable instructions in the same transaction that creates the child, before the first request is submitted. Explicit spawn options override profile defaults. This candidate deliberately does not implement that adapter or claim full spawn/restart proof.

The adapter must not import `SubagentsDoc` or Pocket internals into this package. The portable proof here is parser/catalog behavior only; it is not proof of native launcher behavior, model availability, authorization, report delivery, restart recovery, or Pocket UI behavior.

## Safety and limits

- Names are lowercase kebab-case and at most 64 characters; path traversal is rejected before filesystem access.
- Files must resolve directly inside the owner-managed root, be regular files, and stay within 64 KiB by metadata and decoded content size.
- Escaped symlinks and malformed or duplicate-key YAML are rejected. YAML aliases are disabled for conversion.
- Catalog entries preserve per-file errors for diagnosis; an empty/missing directory is an empty catalog, not proof that a suitable profile exists.
- The package does not access Pocket data, Pi agent folders, credentials, network services, live models, audio, or uploads.
- The retained local `profiles/reviewer.md` fixture is private test material and is excluded from the packed artifact. Supply an explicitly owner-managed directory when reading real profiles.

## Verification boundary

`test/portable.test.ts` invokes the exported parser, loader, and catalog against retained local fixtures and checks a positive import guard for Pocket/workspace coupling. No real Harness/Pocket spawn is applicable to this parser-only package; a native launcher or adapter must be checked separately. Test artifacts are intentionally retained and no cleanup/deletion is performed.
