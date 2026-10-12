# pi-durable-web-tools

Candidate package for web search and page fetching in Pi Durable: `web_search`, `web_fetch`, and `batch_web_fetch`.

This is a Pi Durable extension, not a Pi Pocket adapter. It takes no host object and imports no Pocket or application code. The candidate keeps the source package's MIT license, network/extraction/format/output-bound/cancellation/replay/private-spill behavior.

## Candidate status

This retained tree is an independent candidate, not a stable distribution claim. The deterministic bare-Harness checks use loopback HTTP fixtures. They do **not** prove live DuckDuckGo, Bing, DNS, TLS, external service availability, or production quota. Exact evidence and gaps are retained in the local-only candidate file `verification.json`, which is not part of the public package.

## Requirements

- Node `>=22.19` is declared by the source package. The exact locally observed runtime tuple is retained in local-only verification metadata; other Node versions are unverified.
- `@earendil-works/pi-durable` and `@earendil-works/pi-ai` must resolve from this package's module location.
- Outbound HTTP is required for real search/fetch use; tests use only isolated loopback fixtures.
- `defuddle`, `linkedom`, and `wreq-js` are optional peers. Missing optional packages are handled by the built-in paths.

## Install manually

From this candidate directory, install dependencies in an isolated package directory:

```sh
npm install --ignore-scripts
```

Then use the package from a Pi Durable harness:

```ts
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import createWebTools from "pi-durable-web-tools";

const registry = createRegistry();
registry.install(createWebTools());
const harness = await Harness.open(storage, { models, registry }, context);
```

The package does not install, enable, or replace Pocket extensions. A Pocket drop-in is a separate host concern and is not part of this candidate.

## Example and checks

`examples/bare-durable.mjs` runs the extension through a real `Harness` with a scripted provider and a loopback fixture; it never calls a live search engine. The bare test additionally proves a forbidden-source import guard and invokes search, fetch, spill, and batch through the Harness.

```sh
npm run check
npm test
npm run example
```

The test suite retains its generated fixture artifacts. It does not delete files, remove prior downloads, or perform cleanup/unlink rollback. Use a fresh, explicitly retained `TMPDIR` when running it.

## Function and limits

- `web_search` queries DuckDuckGo first and Bing RSS as fallback in live use; the answering engine is named in the result.
- `web_fetch` supports markdown, HTML, text, JSON, and raw output. Response bytes, serialized output, lines, and private spill storage are bounded.
- Same-host requests are serialized. Meta-refresh is limited and loop-protected. Binary and oversized bodies are saved under a private `0700` directory with `0600` files when possible.
- `web_fetch` and `batch_web_fetch` are unsafe to replay because they can create spill files; `web_search` is replay-safe.
- JavaScript is not executed. PDFs and other binary responses are saved, not converted.
- Live network behavior, host compatibility beyond the observed tuple, and redistribution approval remain open gates.

Read `docs/why-it-is-built-this-way.md` before changing transport, markup scanning, or output bounds. License and upstream notices are in `LICENSE`.
