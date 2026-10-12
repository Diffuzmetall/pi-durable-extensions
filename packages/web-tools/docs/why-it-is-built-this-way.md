# Why it is built this way

Four constraints here are invisible in the code that implements them, and each one cost a measurable
failure when it was missing. A change that removes one of these guards will look harmless.

## 1. The plain client fetches pages; the impersonating one rescues them

`wreq-js` impersonates a browser's TLS and HTTP fingerprint, which is what gets a page that refuses a
plain client to answer at all. It is the wrong default anyway: cancelling a response through it does
not close the server's response promptly — measured across eight variants, including a per-request
`Transport`, a `Session`, an `AbortController` and reading to the end — while the global client closes
it 1.7–7.3 ms after cancellation. Because requests to one host are serialized, a response that stays
open overlaps the next request to that host.

So: the global client goes first, `wreq-js` is tried only when the plain client was refused (401,
403, 405, 406, 409, 429, 503) or never answered, and a refused body is drained to its end — bounded by
a byte and time cap — before the host's turn is released. Past that cap the socket may still be
finishing; the code says so rather than claiming a guarantee it cannot keep.

## 2. Search engines throttle by client address, not by fingerprint

DuckDuckGo's no-JavaScript endpoint answers HTTP 202 with a challenge page once a few requests arrive
quickly. Neither workaround helps: `lite.duckduckgo.com` shares the same bucket, and `wreq-js`
receives the identical 202. Requests are therefore spaced about a second apart, and a second engine
is kept, because the ban outlives a single call.

The second engine is Bing's **RSS feed** (`&format=rss`), not its HTML page: the HTML results page
returned unrelated pages, a foreign-language Wikipedia article and once a browser download page for
the same query, while the feed carries the same ranking as clean, parseable XML. The engine that
answered is named in the result, because the two differ visibly in quality.

## 3. Page markup is walked in one pass, never with a backtracking pattern

A lazy body such as `<script>[\s\S]*?</script>` makes the engine re-scan the rest of the document for
every tag that never closes. 640 KB of unclosed `<script>` held the event loop for 11.8 seconds — in
the host process, for every session, not just the call — and a 40,000-character attribute cost 1.8 s
the same way. A hand-written single pass brought both to 2–4 ms.

The same pass decides what is *active* markup, because inert text must not move a fetch:

- A refresh or an alternate link inside a comment, a `<script>`, a `<style>`, a `<textarea>`, a
  `<template>`, a `<noscript>` or a quoted attribute value is not something a browser acts on.
- A tag name starts immediately after `<` or `</`: `< main>` is text.
- HTML ignores a trailing slash on its own elements: `<main/>` opens `main`, it does not close it.
- A raw-text element ends only at its exact closing name: `</scripture>` does not close a script.

Work is bounded too: a body larger than half a megabyte is read through a window anchored at the
page's own `<main>`/`<article>`/`<body>` when it names one, and the result says the extraction was
partial.

## 4. "Bounded output" means the final serialized bytes

Bounding the text field is not enough. A 100 KB `<title>` rode out beside a short body; 40,000
control characters serialized into 240 KB of JSON escapes; five individually compliant pages
overflowed a batch. The representation the caller receives is measured in bytes, after escaping,
with metadata included, and a batch shares one aggregate budget across its pages. `format: "json"`
must stay parseable at every size — a harness that cuts an over-long result hands a model invalid
JSON with no way to tell.

A saved body is the continuation of what was returned, so the returned text is its beginning. The
one exception is an extraction from a window of an enormous page: there the file holds the part of
the page that was read, and the answer says exactly that. A path that silently holds something else
is worse than no path.

## Also worth knowing

- Every optional dependency sits behind a caught dynamic import: a host update can prune
  `node_modules`, and a module that fails to load takes the whole capability with it.
- Search results are extracted from the cleaned page (Defuddle over a linkedom DOM) rather than by
  hand-parsing snippets, and the same extractor serves a single page fetch.
- Before installing a tool that searches or fetches, check its name: `web_search` has collided with
  another package's tool before, and a host may replace a tool whose name is taken.
