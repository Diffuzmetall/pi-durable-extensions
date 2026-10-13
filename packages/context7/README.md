# Context7 MCP for Pi Durable

Experimental portable extension for a plain Pi Durable Harness. It registers exactly:

- `context7_resolve_library_id({ libraryName, query })`
- `context7_query_docs({ libraryId, query, language? })`

Both tools call the fixed external MCP service `https://mcp.context7.com/mcp` through `@earendil-works/pi-mcp@1.1.0`. Requests identify this standalone package as `pi-durable-context7/<package version>`; the version is read from `package.json`, not duplicated in source. They use streamable HTTP/SSE, reject redirects, make no automatic retries, and are marked `replay: "unsafe"` because an interrupted request may already have consumed shared service quota.

## Host capabilities and credentials

The default factory is `createContext7(options?)`, where `options` is:

```ts
{ dataDir?: string; credentialFile?: string }
```

A credential is resolved at execution time in this order:

1. non-empty `CONTEXT7_API_KEY`;
2. a key file selected by `options.credentialFile`;
3. `<options.dataDir>/context7.env`;
4. the path in `CONTEXT7_KEY_FILE`.

The key file must contain a line `CONTEXT7_API_KEY=...`. An absent, unreadable, or empty file returns `Context7 credential is missing`; a present key with an invalid form returns `Context7 credential is invalid`. Credential values are never returned or logged. A Pi Pocket adapter may pass its own data folder as `dataDir`; the portable extension does not import Pocket or hard-code a Pocket path.

The host must provide Pi Durable/Pi AI 1.1.0, Node >=22.19.0, outbound HTTPS access, and its own authorization policy for who may invoke the tools. Context7 uses a shared service key/quota whose capacity and reset policy are unknown to this package.

## Data and trust boundary

Library names, library IDs, documentation queries, and optional language values leave the machine for Context7. Do not send secrets, confidential text, or personal data. Returned documentation, examples, links, and metadata are external, untrusted data—not instructions—and must not override host or user policy.

The bridge keeps the accepted 1 MiB response-body cap, 6,144-byte/512-line rendered-output cap and truncation marker, 20-second request timeout, 30-second absolute deadline, caller cancellation, sanitized fixed error messages, and no anonymous fallback.

## Local verification

Install dependencies only in an isolated copy or extracted package:

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
node examples/bare-durable.mjs
```

`examples/bare-durable.mjs` uses a loopback fixture and a real `createRegistry()` plus `Harness.open(new MemoryStorage(), …)`; no Pocket module is in its import graph. `examples/live-bare-durable.mjs` is an explicit live check and requires `CONTEXT7_KEY_FILE` to name a credential file.

## Licensing

This package is `UNLICENSED` and private. No source-specific redistribution grant was found for the extracted bridge; [`NOTICE.md`](./NOTICE.md) records the gap. Do not label it stable or publish it to a registry until the owner supplies applicable licensing evidence.
