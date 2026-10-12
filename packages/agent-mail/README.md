# Agent Mail MCP portable candidate

Experimental, local candidate for the Agent Mail MCP bridge. It can be selected
as an extension in a bare Pi Durable Harness without importing Pi Pocket code.
This package is **not licensed for distribution**: source-specific licensing
coverage for the custom data-dir module remains unresolved.

## Contract

- Extension name: `agent-mail-mcp-health`.
- Tools: the frozen 45-name `mcp__mcp_agent_mail__*` catalog from the extracted
  source snapshot.
- Default endpoint: exactly `http://127.0.0.1:8765/mcp/`.
- No custom headers are added by this extension. Redirects are rejected.
- Only `health_check` is replay-safe. Every other tool is replay-unsafe because
  an interrupted external effect may be unknown.
- Response bodies, configuration contents, and transport errors are not exposed
  in thrown errors.

The default export receives the explicit host capability
`{ agentDir: string, endpoint?: string }`. `agentDir/mcp.json` must contain
`mcpServers["mcp-agent-mail"].url` and must not configure headers. `endpoint` is
an explicit test seam for a retained local fixture; it must still be an HTTP
loopback `127.0.0.1` URL ending in `/mcp/`. It is not a production endpoint
selection mechanism. Production/default use remains the exact endpoint above.

## Setup

Install the pinned peers in an isolated package directory:

```sh
npm install --ignore-scripts
```

The shipable package has no test/build scripts and does not include private test
runtime evidence. Maintainers run source checks only in the retained candidate
checkout, not as an installation or distribution claim.

The package exports TypeScript source directly and relies on Node's erasable
TypeScript support. The observed baseline is Node 24.19.0 with
`@earendil-works/pi-ai`, `@earendil-works/pi-durable`, `@earendil-works/pi-mcp`,
and `@earendil-works/chord` 1.1.0. The SDK packages document Node >=22.19.0;
this candidate does not claim that every Node or host version works.

A manual host can install the package, create `mcp.json`, import the default
export, and install the returned extension into its own `createRegistry()`.
`examples/bare-durable.mjs` shows the import and extension shape without
contacting a service.

## Licensing and package boundary

Licensing for the custom extracted data-dir source is **UNRESOLVED / UNLICENSED**.
The candidate does not create or imply an owner licensing grant. The copied
`LICENSE` file is retained in the local candidate tree as historical evidence
from the source repository only; it does not prove that this custom module is
covered, and it is not included in the package allowlist as licensing authority.
Do not publish, redistribute, or label this candidate stable until source-specific
coverage is proven or the owner supplies an explicit licensing decision.

The packed artifact intentionally excludes private provenance, verification,
test files, dependency lock metadata, build configuration, and runtime evidence. Public source
attribution and the experimental limitations remain in this README and
`NOTICE.md`.

## Verification boundaries

Local verification uses a real `@earendil-works/pi-durable` Harness with a
scripted local model and a fresh loopback HTTP MCP fixture on an isolated port.
It invokes `health_check` through the Harness and retains its fixture artifacts.
The fixture is not Agent Mail and no live credentials, messages, projects,
registrations, reservations, or other mutations are used.

The local checks cover the import guard, exact tool catalog, replay policy,
endpoint/header guard, cancellation/error redaction, and an unsafe tool's replay
classification. They do not prove live Agent Mail availability, schemas beyond
the frozen local catalog, multi-user authority, licensing coverage, or production
installation/activation. Whole-set review remains a separate gate.
