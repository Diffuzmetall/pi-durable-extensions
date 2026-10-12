/**
 * Web search and page fetching for Pi: web_search asks DuckDuckGo's no-JavaScript endpoint (Bing when
 * it refuses) and gives back each query's results as numbered markdown plus a list of links to open;
 * web_fetch and batch_web_fetch open pages and return their readable text. A port of pi-smart-web-search and
 * pi-smart-fetch -- both pi-CLI extensions -- so the search and extraction pipeline is theirs
 * (wreq-js-style fetch -> linkedom -> Defuddle, and the markdown layout of their markdown.ts, MIT,
 * (c) Joe Matthews and Thinkscape); what is left behind is their terminal rendering, and this module
 * carries no dependencies of its own: Defuddle and linkedom are used when they are installed beside
 * Pi Pocket, and the built-in stripper takes over when they are not. Page requests go through the
 * global fetch client first, with wreq-js as the rescue for a page that refuses it; searches always
 * use the global client.
 * Private and loopback addresses deliberately stay fetchable for local development (as in Pocket's browser).
 * Host queues are per module instance and original hostname only: native redirects do not take the
 * destination host's turn, and old calls overlapping a reload have independent queues.
 */
import { readFile, mkdir, open, unlink, chmod, lstat, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

// A browser's user agent: both search engines answer a bare client differently, and worse.
const USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

/** DuckDuckGo returns ten results per page, so ten is the most a query can be trimmed to. */
const MIN_RESULTS_PER_QUERY = 1;
const MAX_RESULTS_PER_QUERY = 10;
const DEFAULT_RESULTS_PER_QUERY = 5;
/** Text kept per result snippet when the engine gives no cleaned markdown of its own. */
const SNIPPET_CHARS = 300;
/** Text kept per fetched page unless the call asks for another size. */
const DEFAULT_MAX_CHARS = 8000;
const MAX_MAX_CHARS = 40000;
const FETCH_TIMEOUT_MS = 15_000;
/** DuckDuckGo answers HTTP 202 to requests that arrive too fast, so requests are spaced out. */
const MIN_MS_BETWEEN_FETCHES = 1_000;

let lastFetchAt = 0;
let requestsQueued: Promise<void> = Promise.resolve();

/** Wait long enough that the next request does not look like a burst -- and wait by taking a turn, so
 * two searches running at once cannot wake together and send a pair of requests anyway. */
async function waitTurn(): Promise<void> {
    const mine = requestsQueued.then(async () => {
        const elapsed = Date.now() - lastFetchAt;
        if (elapsed < MIN_MS_BETWEEN_FETCHES) {
            await new Promise((resolve) => setTimeout(resolve, MIN_MS_BETWEEN_FETCHES - elapsed));
        }
        lastFetchAt = Date.now();
    });
    // A failed request must not break the line for the ones behind it.
    requestsQueued = mine.catch(() => undefined);
    return mine;
}

async function get(url: string, accept: string): Promise<Response> {
    await waitTurn();
    const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: accept, "Accept-Language": "en-US,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // DuckDuckGo serves its rate-limit challenge with 202 rather than an error status.
    if (response.status === 202) throw new Error("the search engine rate-limited this request");
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return response;
}

// ===== HTML, without a DOM ==============================================================
// Used when linkedom is not installed, and for the tag-shaped fields of Bing's feed.

const NAMED: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
};

export function decodeEntities(text: string): string {
    return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
        if (body.startsWith("#")) {
            const code =
                body.startsWith("#x") || body.startsWith("#X")
                    ? Number.parseInt(body.slice(2), 16)
                    : Number.parseInt(body.slice(1), 10);
            // A page can name a code point that does not exist; that is not worth an exception.
            return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : whole;
        }
        return NAMED[body.toLowerCase()] ?? whole;
    });
}

/** Elements whose content is never prose. */
const SILENT_ELEMENTS = new Set([
    "script",
    "style",
    "noscript",
    "svg",
    "template",
    "iframe",
    "form",
    "textarea",
    "nav",
    "footer",
    "header",
    "aside",
]);
/** Elements whose content is text as written, not markup to be read. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);
/** A closing tag after which the line is meant to end. */
const BLOCK_END_ELEMENTS = new Set([
    "p",
    "div",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "section",
    "blockquote",
    "pre",
    "table",
    "article",
    "main",
]);

/**
 * Where a tag ends. Quotes matter: a `>` inside an attribute value is text, not the end of the tag,
 * and markup-shaped text in there must not be read as markup.
 */
function tagEnd(html: string, open: number): number {
    let quote = 0;
    for (let at = open + 1; at < html.length; at++) {
        const code = html.charCodeAt(at);
        if (quote) {
            if (code === quote) quote = 0;
            continue;
        }
        if (code === 34 || code === 39) quote = code;
        else if (code === 62) return at;
    }
    return -1;
}

/** A character HTML treats as whitespace between tokens. */
function isHtmlSpace(code: number): boolean {
    return code === 32 || (code >= 9 && code <= 13);
}

interface ScannedTag {
    name: string;
    closing: boolean;
    /** The tag's own text, without the angle brackets. */
    raw: string;
    /** Original offsets, never taken from a Unicode-folded copy. */
    start: number;
    end: number;
    /** A raw-text element's content, which was not read as markup. */
    content?: string;
}

/**
 * Walk a document's tags once, in order, handing each one and the text before it to `visit`; stop
 * when it returns false. Returns where the walk stopped, so a caller can take the text after it.
 *
 * Hand-written rather than a regular expression on purpose: a lazy body such as
 * `<script>[\s\S]*?</script>` makes the engine re-scan the rest of the document for every tag that
 * never closes, and a 640,000-byte page of unclosed `<script>` held the event loop for twelve
 * seconds -- in the server process, for everyone. This is linear in the size of the document.
 */
function scanTags(html: string, visit: (tag: ScannedTag, textBefore: string) => boolean | void): number {
    let at = 0;

    while (at < html.length) {
        const open = html.indexOf("<", at);
        // No more tags: what is left is text, and the caller needs to know where it starts.
        if (open < 0) return at;
        const textBefore = html.slice(at, open);

        if (html.startsWith("<!--", open)) {
            const end = html.indexOf("-->", open + 4);
            at = end < 0 ? html.length : end + 3;
            if (visit({ name: "", closing: false, raw: "", start: open, end: at }, textBefore) === false) return at;
            continue;
        }

        // A declaration -- `<!doctype html>`, a CDATA section -- is markup, not prose, and it is not
        // an element either, so nothing downstream should ever see it as text.
        if (html.charCodeAt(open + 1) === 33) {
            const end = html.indexOf(">", open);
            if (end < 0) return open;
            at = end + 1;
            continue;
        }

        const close = tagEnd(html, open);
        if (close < 0) {
            visit({ name: "", closing: false, raw: "", start: open, end: html.length }, textBefore);
            return html.length;
        }
        const raw = html.slice(open + 1, close);
        // A tag name starts right after `<` or `</`: `< main>` is not an element, and whitespace
        // there means the whole thing is text, as a browser also treats it.
        const named = /^(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>]|$)/.exec(raw);
        if (!named) {
            at = open + 1;
            continue;
        }
        const closing = named[1] === "/";
        const name = named[2]!.toLowerCase();
        at = close + 1;
        // HTML ignores a trailing slash on its own elements: `<main/>` opens main, and a browser
        // does not close it until it sees `</main>`. Reading it as self-closing would lose the
        // article, and would expose whatever sits inside `<template/>`.
        const tag = { name, closing, raw, start: open, end: at };

        if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
            // Match against the original: Unicode lowercasing can change the string's length.
            const closingTag = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
            closingTag.lastIndex = at;
            const match = closingTag.exec(html);
            const end = match?.index ?? -1;
            const after = end < 0 ? -1 : tagEnd(html, end);
            if (after < 0) {
                visit({ ...tag, content: html.slice(at) }, textBefore);
                return html.length;
            }
            if (visit({ ...tag, content: html.slice(at, end) }, textBefore) === false) return after + 1;
            at = after + 1;
            continue;
        }

        if (visit(tag, textBefore) === false) return at;
    }

    return html.length;
}

/** First outermost active main, otherwise first outermost active article. */
function articleBody(html: string): string | undefined {
    const silent: string[] = [];
    const candidates = new Map<string, { start: number; depth: number; body?: string }>();
    scanTags(html, (tag) => {
        if (silent.length) {
            if (tag.closing && silent.at(-1) === tag.name) silent.pop();
            else if (!tag.closing && SILENT_ELEMENTS.has(tag.name) && !RAW_TEXT_ELEMENTS.has(tag.name)) silent.push(tag.name);
            return;
        }
        if (SILENT_ELEMENTS.has(tag.name)) {
            if (!tag.closing && !RAW_TEXT_ELEMENTS.has(tag.name)) silent.push(tag.name);
            return;
        }
        if (tag.name !== "main" && tag.name !== "article") return;
        let candidate = candidates.get(tag.name);
        if (!tag.closing) {
            if (!candidate) candidates.set(tag.name, candidate = { start: tag.end, depth: 0 });
            if (candidate.body === undefined) candidate.depth++;
        } else if (tag.closing && candidate && candidate.depth > 0 && --candidate.depth === 0) {
            candidate.body = html.slice(candidate.start, tag.start);
            if (tag.name === "main") return false;
        }
    });
    return candidates.get("main")?.body ?? candidates.get("article")?.body;
}

/** The readable text of an HTML fragment, with blocks on their own lines. */
export function htmlToText(html: string): string {
    if (html.length > MAX_EXTRACTION_CHARS) html = readWindow(html).text;
    const scope = articleBody(html) ?? html;
    const parts: string[] = [];
    const openSilent: string[] = [];

    const stoppedAt = scanTags(scope, (tag, textBefore) => {
        const insideSilent = openSilent.length > 0;
        // The text between the last tag and this one belongs to the reader unless it sits inside an
        // element whose content is not prose -- a closing tag is reached the same way an opening one is.
        if (!insideSilent && textBefore) parts.push(textBefore);

        if (tag.closing) {
            if (openSilent.at(-1) === tag.name) openSilent.pop();
            if (openSilent.length === 0 && BLOCK_END_ELEMENTS.has(tag.name)) parts.push("\n");
            return;
        }
        if (insideSilent) {
            if (SILENT_ELEMENTS.has(tag.name) && !RAW_TEXT_ELEMENTS.has(tag.name)) openSilent.push(tag.name);
            return;
        }
        if (SILENT_ELEMENTS.has(tag.name)) {
            // A raw-text element is handed over whole, with no closing visit, so it is not entered.
            if (!RAW_TEXT_ELEMENTS.has(tag.name)) openSilent.push(tag.name);
            return;
        }

        if (tag.content) parts.push(tag.content);
        if (tag.name === "br") parts.push("\n");
    });

    // Text with no markup left in front of it belongs to the reader. A tail that starts with `<`
    // is markup the walk refused to read (an unclosed comment or tag), and none of it is prose.
    const tail = scope.slice(stoppedAt);
    if (openSilent.length === 0 && !tail.startsWith("<")) parts.push(tail);

    return decodeEntities(parts.join(""))
        .replace(/[ \t\u00a0]+/g, " ")
        .split("\n")
        .map((line) => line.trim())
        // Page chrome repeats itself (menu items, "More options", "Skip to content"); a line that
        // says the same as the one above it is dropped, as is a blank one following a blank one.
        .filter((line, at, all) => (line === all[at - 1] ? false : line !== "" || all[at - 1] !== ""))
        .join("\n")
        .trim();
}

function titleOf(html: string, fallback: string): string {
    let title: string | undefined;
    // Through the same active scan as everything else: a `<title>` inside a template or an SVG is
    // not the page's title, and the text is decoded here rather than stripped a second time, which
    // would eat a literal `<` in a title such as "2 < 3".
    scanActiveTags(html, (tag) => {
        if (tag.name === "title") {
            title = tag.content ?? "";
            return false;
        }
        return;
    });

    const text = title ? decodeEntities(title).replace(/\s+/g, " ").trim() : "";
    return text || fallback;
}

// ===== The setting both packages read ===================================================
// `smartWebSearch.resultsPerQuery` in `~/.pi/agent/settings.json` first, then the project's
// `.pi/settings.json`, which wins. A value outside 1-10 is pulled back into range and a file that
// is missing or not valid JSON leaves the default in place.

/**
 * Where Pi keeps its settings, asked of Pi's own CLI when it is installed and named directly when it
 * is not: this module is a Pi Durable extension, and Pi Durable has no opinion about that folder.
 */
async function agentDir(): Promise<string> {
    try {
        const { getAgentDir } = await import("@earendil-works/pi-coding-agent" as string);
        return getAgentDir();
    } catch {
        return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    }
}

interface SettingsFile {
    smartWebSearch?: { resultsPerQuery?: unknown };
}

async function readResultsPerQueryFrom(file: string): Promise<number | undefined> {
    let settings: SettingsFile;
    try {
        settings = JSON.parse(await readFile(file, "utf-8")) as SettingsFile;
    } catch {
        return undefined;
    }

    const configured = settings?.smartWebSearch?.resultsPerQuery;
    if (typeof configured !== "number" || !Number.isFinite(configured)) return undefined;
    return Math.floor(configured);
}

export async function loadResultsPerQuery(agentDir: string, projectDir: string): Promise<number> {
    let resultsPerQuery = DEFAULT_RESULTS_PER_QUERY;

    for (const file of [join(agentDir, "settings.json"), join(projectDir, ".pi", "settings.json")]) {
        const configured = await readResultsPerQueryFrom(file);
        if (configured !== undefined) {
            resultsPerQuery = Math.min(
                MAX_RESULTS_PER_QUERY,
                Math.max(MIN_RESULTS_PER_QUERY, configured),
            );
        }
    }

    return resultsPerQuery;
}

// ===== The engines ======================================================================

export interface Found {
    title: string;
    url: string;
    snippet?: string;
}

/** One query's answer: the markdown the model reads, and the links it is told to open. */
export interface SearchAnswer {
    engine: string;
    /** Defuddle's markdown of the results page, or the same written from what the parser found. */
    markdown: string;
    links: Found[];
}

/** Unwrap DuckDuckGo's `/l/?uddg=…` redirect to the destination it hides. */
export function unwrapDuckDuckGo(href: string): string {
    const escaped = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    return escaped ? decodeURIComponent(escaped) : href;
}

/** Unwrap Bing's `/ck/a?…&u=a1<base64url>` redirect. */
export function unwrapBing(href: string): string {
    const encoded = /[?&]u=a1([^&]+)/.exec(href)?.[1];
    if (!encoded) return href;
    try {
        return Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
        return href;
    }
}

/** The markdown one result makes: its title as a heading, then its address, then its snippet. */
function markdownOf(found: Found[]): string {
    return found
        .map((result) =>
            [`## ${result.title}`, result.url, result.snippet ?? ""].filter((line) => line !== "").join("\n"),
        )
        .join("\n\n");
}

// The same two engines, whichever is installed. Loading them is one attempt, remembered.
let domTools: Promise<
    | {
          parseHTML: (html: string) => { document: unknown };
          Defuddle: (
              input: unknown,
              url: string,
              options: { markdown: boolean; removeImages: boolean },
          ) => Promise<PageMetadata & { title?: string; content?: string; published?: string }>;
      }
    | undefined
> | undefined;

function loadDomTools(): NonNullable<typeof domTools> {
    domTools ??= (async () => {
        try {
            const [{ Defuddle }, { parseHTML }] = await Promise.all([
                import("defuddle/node" as string),
                import("linkedom" as string),
            ]);
            return { parseHTML, Defuddle };
        } catch {
            return undefined;
        }
    })();
    return domTools;
}

/** Delete every result past the first `count`, before anything reads the page, as pi-smart-web-search does. */
export function keepFirstResults(page: { querySelectorAll: (selector: string) => unknown }, count: number): void {
    const results = Array.from(page.querySelectorAll("div.result") as ArrayLike<{ remove: () => void }>);
    for (const surplus of results.slice(count)) surplus.remove();
}

/** Every result link on the page, in the engine's ranked order, repeats and all. */
export function readResultLinks(page: {
    querySelectorAll: (selector: string) => unknown;
}): Found[] {
    return Array.from(
        page.querySelectorAll("a.result__a") as ArrayLike<{ textContent?: string; getAttribute: (name: string) => string | null }>,
    ).map((anchor) => ({
        title: (anchor.textContent ?? "").trim(),
        url: decodeEntities(unwrapDuckDuckGo(decodeEntities(anchor.getAttribute("href") ?? ""))),
    }));
}

async function duckDuckGo(query: string, resultsPerQuery: number): Promise<SearchAnswer> {
    const response = await get(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        "text/html,application/xhtml+xml",
    );
    const html = await response.text();
    const finalUrl = response.url || "https://duckduckgo.com/";

    const dom = await loadDomTools();
    if (dom) {
        try {
            const page = dom.parseHTML(html).document;
            // Remove advertising before trimming or extraction, so ranking stays organic.
            for (const ad of Array.from((page as { querySelectorAll: (s: string) => ArrayLike<{ remove: () => void }> }).querySelectorAll(".result--ad, .result--sponsored, [data-testid='ad']"))) ad.remove();
            // Trim first, then read, so the snippets and the link list describe the same results.
            keepFirstResults(page as { querySelectorAll: (selector: string) => unknown }, resultsPerQuery);
            const extraction = await dom.Defuddle(page, finalUrl, { markdown: true, removeImages: true });
            const markdown = String(extraction.content ?? "").trim();
            const links = readResultLinks(page as { querySelectorAll: (selector: string) => unknown });
            // A page whose markup gives Defuddle no result headings would leave the numbered link
            // list standing without numbered results above it; the parser below writes both.
            if (markdown && links.length > 0 && /^## /m.test(markdown)) return { engine: "duckduckgo", markdown, links };
        } catch {
            // A page that no longer parses is not a reason to fail the search: the parser below reads it.
        }
    }

    // Without Defuddle: the same two facts, read out of the markup by hand.
    const found: Found[] = [];
    for (const block of html.matchAll(
        /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi,
    )) {
        if (/\bresult--(?:ad|sponsored)\b|data-testid=["']ad["']/i.test(block[0])) continue;
        const link = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block[0]);
        if (!link) continue;
        const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block[0]);
        found.push({
            title: htmlToText(link[2]!).split("\n")[0]!.trim() || link[1]!,
            url: decodeEntities(unwrapDuckDuckGo(decodeEntities(link[1]!))),
            snippet: snippet ? htmlToText(snippet[1]!).slice(0, SNIPPET_CHARS) : undefined,
        });
    }

    if (found.length === 0) throw new Error("DuckDuckGo returned a page with no results in it");
    const trimmed = found.slice(0, resultsPerQuery);
    return { engine: "duckduckgo", markdown: markdownOf(trimmed), links: trimmed };
}

async function bing(query: string, resultsPerQuery: number): Promise<SearchAnswer> {
    const fromFeed = await bingFeed(query).catch(() => [] as Found[]);
    const trimmed = (fromFeed.length > 0 ? fromFeed : await bingHtml(query)).slice(0, resultsPerQuery);
    return { engine: "bing", markdown: markdownOf(trimmed), links: trimmed };
}

// The same search as the feed Bing builds for machines: no page markup to guess at, and the result
// order is the one its HTML page shows.
async function bingFeed(query: string): Promise<Found[]> {
    const response = await get(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=20&setlang=en`,
        "application/rss+xml,application/xml,text/xml",
    );
    const feed = await response.text();
    const found: Found[] = [];

    for (const item of feed.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
        const field = (name: string) =>
            new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i")
                .exec(item[1]!)?.[1]
                ?.replace(/<!\[CDATA\[|\]\]>/g, "")
                .trim();
        const url = field("link");
        if (!url) continue;
        const description = field("description");
        found.push({
            title: decodeEntities(field("title") ?? "") || url,
            url: decodeEntities(url),
            snippet: description ? htmlToText(description).slice(0, SNIPPET_CHARS) : undefined,
        });
    }

    if (found.length === 0) throw new Error("Bing's feed carried no results");
    return found;
}

async function bingHtml(query: string): Promise<Found[]> {
    const response = await get(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`,
        "text/html,application/xhtml+xml",
    );
    const html = await response.text();
    const found: Found[] = [];

    for (const block of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/gi)) {
        const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block[0]);
        if (!link) continue;
        const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block[0]);
        found.push({
            title: htmlToText(link[2]!).split("\n")[0]!.trim() || link[1]!,
            url: unwrapBing(decodeEntities(link[1]!)),
            snippet: snippet ? htmlToText(snippet[1]!).slice(0, SNIPPET_CHARS) : undefined,
        });
    }

    if (found.length === 0) throw new Error("Bing returned a page with no results in it");
    return found;
}

export { bing, duckDuckGo };

/** One query, against every engine in turn. Failure of the last one is thrown. */
// DuckDuckGo ranks better but throttles fast (HTTP 202) under a burst, and its ban covers both the
// /html and the /lite endpoint -- one bucket, so asking the other one is no help. Nor does a
// browser-shaped TLS fingerprint: wreq-js, which pi-smart-* fetch through, gets the same 202. Bing
// always answers, which its results sometimes do not deserve. So DuckDuckGo is asked first, and a
// rate-limit makes it step aside for a while: a minute at first, doubling while the ban holds, up to
// five. A reload forgets that, and it costs nothing but one attempt.
const FIRST_PAUSE_MS = 60_000;
const LONGEST_PAUSE_MS = 300_000;

let pauseMs = FIRST_PAUSE_MS;
let rateLimitedAt: number | undefined;

export async function searchOne(query: string, resultsPerQuery: number): Promise<SearchAnswer> {
    const withinPause = rateLimitedAt !== undefined && Date.now() - rateLimitedAt < pauseMs;
    const engines: [string, (query: string, count: number) => Promise<SearchAnswer>][] = withinPause
        ? [
              ["bing", bing],
              ["duckduckgo", duckDuckGo],
          ]
        : [
              ["duckduckgo", duckDuckGo],
              ["bing", bing],
          ];
    const failures: string[] = [];

    for (const [engine, run] of engines) {
        try {
            const answer = await run(query, resultsPerQuery);
            if (engine === "duckduckgo") {
                rateLimitedAt = undefined;
                pauseMs = FIRST_PAUSE_MS;
            }
            return answer;
        } catch (caught) {
            const reason = caught instanceof Error ? caught.message : String(caught);
            if (engine === "duckduckgo" && /rate-limited/.test(reason)) {
                // Asking again the moment the ban lifts is what got it extended; wait longer each time.
                pauseMs = rateLimitedAt === undefined ? pauseMs : Math.min(pauseMs * 2, LONGEST_PAUSE_MS);
                rateLimitedAt = Date.now();
            }
            failures.push(`${engine}: ${reason}`);
        }
    }

    throw new Error(`no search engine answered (${failures.join("; ")})`);
}

// ===== The markdown the model reads ======================================================
// Lifted from pi-smart-web-search's markdown.ts (MIT, (c) Joe Matthews): its layout is what the
// tool's own description promises, and it is pure text handling. Two sections are built separately
// and joined -- the numbered results, then the links to open. Both number the same results in the
// same order, so result 1 above is link 1 below.

export const SEARCH_RESULTS_HEADER = "# Search results by query";
export const LINK_SUMMARY_HEADER = "# Read these pages";
export const FETCH_TOOL_NAME = "web_fetch";
export const FETCH_INSTRUCTION =
    `Open the most relevant links below before answering -- ${FETCH_TOOL_NAME} for a single page, or ` +
    "batch_web_fetch for several. Pick the few that best answer the question rather than the whole list. These " +
    "previews are brief and may be out of date; skip fetching only if they already fully answer the question.";

export interface QueryProgress {
    query: string;
    ok: boolean;
    engine?: string;
    markdown?: string;
    links?: Found[];
    error?: string;
}

/** Number each result heading, so the snippets state the engine's ranking instead of merely following it. */
export function numberResultHeadings(markdown: string): string {
    let resultNumber = 0;
    return markdown.replace(/^## /gm, () => {
        resultNumber += 1;
        return `## ${resultNumber}. `;
    });
}

/** Push every heading down one level, so result titles sit under the query heading added later. */
export function demoteHeadings(markdown: string): string {
    return markdown.replace(/^(#{1,5}) /gm, "#$1 ");
}

// A bare URL never contains a space, so a space is what separates a real label from one.
function labelReadsAsProse(label: string): boolean {
    return /\s/.test(label.trim());
}

/** Turn every markdown link into plain text, keeping whichever half says something. */
export function flattenMarkdownLinks(markdown: string): string {
    return markdown.replace(
        /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
        (_whole, label: string, address: string) => (labelReadsAsProse(label) ? label : address),
    );
}

/** Replace DuckDuckGo's redirect links with where they actually go. */
export function expandRedirectLinks(markdown: string): string {
    return markdown.replace(
        /(?:https?:)?\/\/(?:[a-z0-9-]+\.)?duckduckgo\.com\/l\/\?[^)\s"'<>]*?\buddg=([^&)\s"'<>]+)[^)\s"'<>]*/gi,
        (_whole, escapedUrl: string) => decodeURIComponent(escapedUrl),
    );
}

export function cleanUpLinks(markdown: string): string {
    return flattenMarkdownLinks(expandRedirectLinks(markdown));
}

export function renderQuerySection(entry: QueryProgress): string {
    const heading = `## Query: "${entry.query}"`;
    if (!entry.ok) return `${heading}\n_search failed: ${entry.error ?? "unknown"}_\n`;

    const cleaned = cleanUpLinks(entry.markdown ?? "");
    const snippets = demoteHeadings(numberResultHeadings(cleaned));
    const engine = entry.engine ? ` _(${entry.engine})_\n` : "\n";
    return `${heading}${engine}${snippets || "_no content extracted_"}\n`;
}

export function renderSearchResults(searches: QueryProgress[]): string {
    return [SEARCH_RESULTS_HEADER, ...searches.map(renderQuerySection)].join("\n");
}

export function renderLinkSummary(searches: QueryProgress[]): string {
    const blocks: string[] = [];

    for (const entry of searches) {
        const links = entry.links ?? [];
        if (!entry.ok || links.length === 0) continue;
        const numbered = links.map((link, index) => `${index + 1}. [${link.title}](${link.url})`);
        blocks.push(`## ${entry.query}\n${numbered.join("\n")}`);
    }

    if (blocks.length === 0) return "";
    return [LINK_SUMMARY_HEADER, "", FETCH_INSTRUCTION, "", blocks.join("\n\n")].join("\n");
}

export function renderToolResult(searches: QueryProgress[]): string {
    const summary = renderLinkSummary(searches);
    const sections = [renderSearchResults(searches)];
    if (summary) sections.push(summary);
    return sections.join("\n");
}

// ===== Fetching a page ==================================================================

export type FetchFormat = "markdown" | "html" | "text" | "json" | "raw";
interface PageMetadata {
    author?: string;
    site?: string;
    publishedDate?: string;
    language?: string;
    description?: string;
}
const PAGE_METADATA_KEYS = ["author", "site", "publishedDate", "language", "description"] as const;
const BOUNDED_METADATA_KEYS = ["url", "finalUrl", "title", "contentType", "note", "sourceUrl", ...PAGE_METADATA_KEYS] as const;

export interface FetchedPage extends PageMetadata {
    url: string;
    finalUrl: string;
    title: string;
    text: string;
    contentType: string;
    format: FetchFormat;
    truncated: boolean;
    extractor: string;
    note?: string;
    filePath?: string;
    fileSize?: number;
    /** What the saved file holds: the answer's own text, or the part of the page it was read from. */
    fileHolds?: "answer" | "source";
    sourceUrl?: string;
}

// Per-instance, original-hostname serialization including body reads/cancellation; native HTTP
// redirects bypass destination queues, and calls spanning a reload use independent instances.
const pageHostTails = new Map<string, Promise<void>>();
const MAX_BODY_BYTES = 20_000_000;
const MAX_FILE_BYTES = 500_000_000;
/** Only this prefix is synchronously scanned; large bodies bypass DOM extraction. */
const MAX_EXTRACTION_CHARS = 512_000;
/** Ordinary documents stay intact; oversized ones need only enough source for a 40KB answer. */
const LARGE_BODY_WINDOW_CHARS = 256_000;

/**
 * The part of a large body worth reading. Scanning is linear but a document of dense tags still
 * costs a tenth of a millisecond per kilobyte, and this runs in the server's event loop, so the
 * walk is given a bounded slice -- taken from the page's own main content when it names one, or
 * from the start when it does not.
 */
function readWindow(body: string): { text: string; windowed: boolean } {
    if (body.length <= MAX_EXTRACTION_CHARS) return { text: body, windowed: false };
    // The anchor is looked for in a bounded head only: searching eighteen megabytes for `<main>`
    // costs more than the scan it is meant to protect, and main content starts early in practice.
    const head = body.slice(0, MAX_EXTRACTION_CHARS);
    const anchor = /<(?:main|article|body)[\s/>]/i.exec(head)?.index ?? 0;
    return { text: body.slice(anchor, anchor + LARGE_BODY_WINDOW_CHARS), windowed: true };
}

function mediaType(header: string): string { return header.split(";", 1)[0]!.trim().toLowerCase(); }
function isHtml(header: string): boolean {
    return ["", "text/html", "application/xhtml+xml"].includes(mediaType(header));
}
function isText(header: string): boolean {
    const type = mediaType(header);
    return isHtml(header) || type.startsWith("text/") ||
        ["application/json", "application/xml", "application/javascript"].includes(type) ||
        /\+(?:json|xml)$/.test(type);
}

/** Bytes a refused response may finish with, and how long that is worth waiting for. */
const DRAIN_LIMIT_BYTES = 512_000;
const DRAIN_LIMIT_MS = 1_500;

/**
 * Deal with a response nobody is going to read, before the host's turn is given up. Cancelling
 * alone is not enough: the wreq transport keeps the socket open for a while after its stream is
 * cancelled, so a slow 404 would overlap the next request to the same host. Reading the body to its
 * end closes it for certain, and refusal bodies are small enough to read to the end.
 *
 * The boundary, stated plainly: past the cap above, or past the wait, the body is cut and the
 * socket may still be finishing while the next request to this host begins. Nothing here can see
 * the socket close through this transport, so that residual overlap is accepted, not denied.
 */
async function cancelBody(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) return;
    let seen = 0;
    const deadline = setTimeout(() => void reader.cancel().catch(() => undefined), DRAIN_LIMIT_MS);
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return; // Complete: the connection can close and the host is free.
            seen += value?.byteLength ?? 0;
            if (seen >= DRAIN_LIMIT_BYTES) return;
        }
    } catch {
        // A stream that fails while being discarded has nothing more to give.
    } finally {
        clearTimeout(deadline);
        try { await reader.cancel(); } catch { /* Already gone. */ }
        reader.releaseLock();
    }
}

/** Transports decompress before yielding chunks: this bounds decoded bytes, not compressed length. */
async function readBodyBytes(response: Response, limit: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) throw new Error(`body exceeds ${limit} byte (${Math.round(limit / 1e6)} MB) limit`);
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel();
        throw error;
    } finally { reader.releaseLock(); }

    const whole = new Uint8Array(bytes);
    let at = 0;
    for (const chunk of chunks) {
        whole.set(chunk, at);
        at += chunk.byteLength;
    }
    return whole;
}

function decodeText(bytes: Uint8Array, contentType: string): string {
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1];
    try { return new TextDecoder(charset ?? "utf-8").decode(bytes); }
    catch { return new TextDecoder("utf-8").decode(bytes); }
}

/** A body with NUL bytes, or a crowd of control characters, is a file a text reader would wreck. */
function looksBinary(bytes: Uint8Array): boolean {
    const sample = bytes.subarray(0, 4096);
    if (sample.length === 0) return false;
    let odd = 0;
    for (const byte of sample) {
        if (byte === 0) return true;
        if (byte < 9 || (byte > 13 && byte < 32)) odd++;
    }
    return odd / sample.length > 0.1;
}

const DOWNLOAD_FOLDER = join(tmpdir(), "pi-durable-web-tools");
/** A ceiling for the folder as a whole: each file has its own cap, the disk has none. */
const MAX_FOLDER_BYTES = 200_000_000;

/**
 * The folder downloads go in, private to this account. A path that is not a plain directory -- a
 * symlink someone else made, say -- is refused rather than written through.
 */
async function downloadFolder(): Promise<string> {
    await mkdir(DOWNLOAD_FOLDER, { recursive: true, mode: 0o700 });
    const info = await lstat(DOWNLOAD_FOLDER);
    if (!info.isDirectory()) throw new Error(`${DOWNLOAD_FOLDER} is not a directory`);
    try { await chmod(DOWNLOAD_FOLDER, 0o700); } catch { /* Not ours to change: leave it as it is. */ }
    return DOWNLOAD_FOLDER;
}

// Transient reservations survive module reloads; disk remains the committed source of truth.
const quotaKey = Symbol.for("pi-durable.web-tools.download-quota");
const quotaGlobal = globalThis as typeof globalThis & { [quotaKey]?: {
    tail: Promise<void>; active: Map<string, { size: number; at: number }>; committed: number;
} };
const quota = quotaGlobal[quotaKey] ??= { tail: Promise.resolve(), active: new Map(), committed: 0 };

/**
 * A reservation that nobody refreshed for this long is treated as abandoned. The map lives in the
 * process, so a save cut short by a reload or an abort would otherwise keep its bytes counted for
 * the life of the process and wedge every later download behind a budget that is not really spent.
 */
const RESERVATION_TTL_MS = 60_000;

function activeBytes(): number {
    const now = Date.now();
    let total = 0;
    for (const [path, entry] of quota.active) {
        if (now - entry.at > RESERVATION_TTL_MS) {
            quota.active.delete(path);
            continue;
        }
        total += entry.size;
    }
    return total;
}

async function quotaTurn<T>(run: () => Promise<T>): Promise<T> {
    const mine = quota.tail.then(run);
    quota.tail = mine.then(() => undefined, () => undefined);
    return mine;
}

async function folderBytes(folder: string): Promise<number> {
    let total = 0;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile() || quota.active.has(join(folder, entry.name))) continue;
        try {
            const info = await stat(join(folder, entry.name));
            // Blocks, not apparent size: the budget is about the disk, and a sparse file (a test
            // fixture, a tool that seeks) can report gigabytes while occupying nothing.
            total += typeof info.blocks === "number" ? info.blocks * 512 : info.size;
        } catch { /* Gone already. */ }
    }
    return total;
}

function downloadName(finalUrl: string): string {
    let candidate = "";
    let host = "";
    try {
        const url = new URL(finalUrl);
        candidate = decodeURIComponent(basename(url.pathname));
        host = url.hostname;
    } catch { /* A URL that will not parse is named by what it is. */ }
    const name = (candidate || host || "download").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
    return name.slice(0, 120) || "download";
}

/**
 * Write one download. A write that fails leaves nothing behind, and a folder already over budget
 * stops the download with a sentence naming it -- deleting someone's files to make room is not this
 * tool's business.
 */
async function withDownloadFile<T>(
    finalUrl: string,
    write: (file: Awaited<ReturnType<typeof open>>, reserve: (bytes: number) => Promise<void>) => Promise<T>,
    expectedBytes = 0,
): Promise<{ filePath: string; fileSize: number }> {
    const filePath = join(DOWNLOAD_FOLDER, `${randomUUID()}-${downloadName(finalUrl)}`);
    const reserve = (bytes: number) => quotaTurn(async () => {
        const inFlight = activeBytes();
        const held = quota.active.get(filePath)?.size ?? 0;
        const size = Math.max(bytes, held);
        if (quota.committed + inFlight - held + size > MAX_FOLDER_BYTES) {
            throw new Error(`${DOWNLOAD_FOLDER} download folder budget (${MAX_FOLDER_BYTES} bytes) exceeded; remove some downloads before fetching another file`);
        }
        quota.active.set(filePath, { size, at: Date.now() });
    });
    const file = await quotaTurn(async () => {
        await downloadFolder();
        quota.committed = await folderBytes(DOWNLOAD_FOLDER);
        const inFlight = activeBytes();
        if (quota.committed + inFlight + expectedBytes > MAX_FOLDER_BYTES) {
            throw new Error(
                `${DOWNLOAD_FOLDER} download folder budget (${MAX_FOLDER_BYTES} bytes) exceeded: ` +
                `on disk ${quota.committed}, in flight ${inFlight}, this file ${expectedBytes}; ` +
                "remove some downloads before fetching another file",
            );
        }
        const file = await open(filePath, "wx", 0o600);
        quota.active.set(filePath, { size: expectedBytes, at: Date.now() });
        return file;
    });
    try {
        await write(file, reserve);
        const { size } = await file.stat();
        await file.close();
        await quotaTurn(async () => { quota.active.delete(filePath); quota.committed += size; });
        return { filePath, fileSize: size };
    } catch (error) {
        try {
            await file.close();
        } finally {
            await unlink(filePath).catch(() => undefined); // Only this failed download's own file.
            await quotaTurn(async () => {
                quota.active.delete(filePath);
                quota.committed = await folderBytes(DOWNLOAD_FOLDER);
            });
        }
        throw error;
    }
}

async function saveBinary(response: Response, finalUrl: string): Promise<{ filePath: string; fileSize: number }> {
    const reader = response.body?.getReader();
    try {
        return await withDownloadFile(finalUrl, async (file, reserve) => {
            if (!reader) return;
            let written = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                written += value.byteLength;
                if (written > MAX_FILE_BYTES) throw new Error(`binary body exceeds ${MAX_FILE_BYTES} byte (500 MB) limit`);
                await reserve(written);
                // FileHandle.write may write fewer bytes than requested.
                let offset = 0;
                while (offset < value.byteLength) {
                    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
                    if (!bytesWritten) throw new Error("download write made no progress");
                    offset += bytesWritten;
                }
            }
        }, Math.max(0, Number(response.headers.get("content-length")) || 0));
    } catch (error) {
        await reader?.cancel();
        throw error;
    } finally { reader?.releaseLock(); }
}

/** A body already read into memory (an untyped response that turned out to be a file, or text too
 * long to return whole) written out the same way. */
async function saveBytes(bytes: Uint8Array, finalUrl: string): Promise<{ filePath: string; fileSize: number }> {
    return withDownloadFile(finalUrl, async (file) => {
        await file.write(bytes, 0, bytes.byteLength);
    }, bytes.byteLength);
}

async function readPage(url: string, textOnly = false): Promise<{ body: string; finalUrl: string; asText: string; filePath?: string; fileSize?: number }> {
    const host = new URL(url).hostname;
    const previous = pageHostTails.get(host) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    pageHostTails.set(host, tail);
    await previous;
    try {
        const headers = {
            "User-Agent": USER_AGENT,
            Accept: "text/html,application/xhtml+xml,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
        };
        const answer = async (response: Response) => {
            const asText = response.headers.get("content-type") ?? "";
            const finalUrl = response.url || url;
            const declared = mediaType(asText);
            // A stated text type is taken at its word; a stated other type is a file; no type at all
            // is checked against what actually arrives, because a headerless PDF is still a PDF.
            const textish = isText(asText) && declared !== "";
            const limit = textish || declared === "" ? MAX_BODY_BYTES : MAX_FILE_BYTES;
            try {
                if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
                if (Number(response.headers.get("content-length") ?? 0) > limit) {
                    throw new Error(`declared body exceeds ${limit} byte (${limit / 1e6} MB) limit`);
                }
                if (!textish && declared !== "") {
                    if (textOnly) throw new Error("alternate response is not text");
                    return { body: "", finalUrl, asText, ...await saveBinary(response, finalUrl) };
                }

                const bytes = await readBodyBytes(response, limit);
                if (declared === "" && looksBinary(bytes)) {
                    if (textOnly) throw new Error("alternate response is not text");
                    return { body: "", finalUrl, asText, ...await saveBytes(bytes, finalUrl) };
                }
                return { body: decodeText(bytes, asText), finalUrl, asText };
            } catch (error) {
                // Readers release their lock before reaching here. Also covers pre-read rejection
                // and failures creating a download, so no rejected response keeps streaming.
                await cancelBody(response);
                throw error;
            }
        };
        // The plain client goes first, because it releases the connection promptly when a response
        // is refused: measured at 1.7-7.3 ms, where cancelling a wreq-js body leaves the server's
        // response open for good (its abort listener is removed before the Response is handed back,
        // and closing a Transport or a Session does not help). wreq-js is kept for what it is good
        // at -- a browser-shaped TLS fingerprint, which is what gets a page that refuses the plain
        // client to answer at all -- and only where the plain client was refused or never answered.
        const rescueStatuses = new Set([401, 403, 405, 406, 409, 429, 503]);
        let browserFetch: ((url: string, options: object) => Promise<Response>) | undefined;
        try { ({ fetch: browserFetch } = await import("wreq-js" as string)); }
        catch { browserFetch = undefined; }

        let plain: Response | undefined;
        try {
            plain = await fetch(url, {
                headers, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
        } catch { plain = undefined; } // A transport failure is the other reason to try wreq-js.

        const refused = plain !== undefined && !plain.ok && rescueStatuses.has(plain.status);
        if (browserFetch && (plain === undefined || refused)) {
            if (plain) await cancelBody(plain);
            let rescued: Response | undefined;
            try {
                rescued = await browserFetch(url, {
                    browser: "chrome_147", os: "windows", timeout: FETCH_TIMEOUT_MS,
                    redirect: "follow", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
            } catch { rescued = undefined; }
            if (rescued) return await answer(rescued);
        }

        if (plain) return await answer(plain);
        throw new Error(`${url} could not be reached`);
    } finally {
        release();
        if (pageHostTails.get(host) === tail) pageHostTails.delete(host);
    }
}

/**
 * Visit only the tags the page itself acts on. Tags inside an element whose content is not markup
 * -- a script, a style, a noscript, a template, a quoted attribute's worth of text -- are skipped,
 * together with everything nested in them.
 */
function scanActiveTags(html: string, visit: (tag: ScannedTag) => boolean | void): void {
    const open: string[] = [];
    scanTags(html, (tag) => {
        if (tag.closing) {
            if (open.at(-1) === tag.name) open.pop();
            return;
        }

        // A raw-text element arrives once, with its content, and never with a closing visit: it is
        // entered and left here rather than kept open, or nothing after it would ever be read.
        const containsMarkup = SILENT_ELEMENTS.has(tag.name) && !RAW_TEXT_ELEMENTS.has(tag.name);
        if (open.length > 0) {
            if (containsMarkup) open.push(tag.name);
            return;
        }
        if (containsMarkup) {
            open.push(tag.name);
            return;
        }

        return visit(tag);
    });
}

function attributesOf(tag: string): Map<string, string> {
    const attributes = new Map<string, string>();
    const length = tag.length;
    let at = 0;
    // Skip the element name. Every step below consumes a name, a value or a delimiter, so the walk
    // never reads a character twice: a tag with a 40,000-character attribute is linear.
    while (at < length && !isHtmlSpace(tag.charCodeAt(at))) at++;
    while (at < length) {
        while (at < length && (isHtmlSpace(tag.charCodeAt(at)) || tag[at] === "/" || tag[at] === ">")) at++;
        const start = at;
        while (at < length) {
            const code = tag.charCodeAt(at);
            if (isHtmlSpace(code) || code === 61 || code === 47 || code === 62) break;
            at++;
        }
        const name = tag.slice(start, at).toLowerCase();
        if (!name) { at++; continue; }
        while (at < length && isHtmlSpace(tag.charCodeAt(at))) at++;
        let value = "";
        if (tag[at] === "=") {
            at++;
            while (at < length && isHtmlSpace(tag.charCodeAt(at))) at++;
            const quote = tag[at] === '"' || tag[at] === "'" ? tag[at++] : undefined;
            const valueStart = at;
            if (quote) {
                while (at < length && tag[at] !== quote) at++;
                value = tag.slice(valueStart, at);
                if (at < length) at++;
            } else {
                while (at < length) {
                    const code = tag.charCodeAt(at);
                    if (isHtmlSpace(code) || code === 62) break;
                    at++;
                }
                value = tag.slice(valueStart, at);
            }
        }
        if (!attributes.has(name)) attributes.set(name, decodeEntities(value));
    }
    return attributes;
}

function httpTarget(href: string, baseUrl: string): string | undefined {
    try {
        const target = new URL(href, baseUrl);
        if (["http:", "https:"].includes(target.protocol)) return target.toString();
    } catch { /* Ignore malformed targets. */ }
    return undefined;
}

/**
 * Both of these read real tags, in one linear pass, and only real ones: markup inside a comment, a
 * script, a textarea or a quoted attribute is not a tag a browser acts on, and text that merely
 * looks like one there must not move the fetch.
 */
function refreshTarget(body: string, baseUrl: string): string | undefined {
    let found: string | undefined;
    scanActiveTags(body, (tag) => {
        if (tag.name !== "meta") return;
        const attributes = attributesOf(tag.raw);
        if (attributes.get("http-equiv")?.toLowerCase() !== "refresh") return;
        const match = /^\s*(\d+(?:\.\d+)?)\s*;\s*url\s*=\s*(.+?)\s*$/i.exec(attributes.get("content") ?? "");
        if (!match || Number(match[1]) >= 30) return;
        const target = httpTarget(match[2]!.replace(/^['"]|['"]$/g, ""), baseUrl);
        if (target) {
            found = target;
            return false;
        }
        return;
    });
    return found;
}

/**
 * Representations a page may advertise as an alternate for each format. A stylesheet served at an
 * advertised markdown link is not one of them, and neither is a page that only claims the type.
 */
function acceptsAlternate(type: string, format: FetchFormat): boolean {
    const accepted = mediaType(type);
    switch (format) {
        case "markdown":
        case "text":
            return accepted === "text/markdown" || accepted === "text/plain";
        case "json":
            return accepted === "application/json" || accepted.endsWith("+json");
        default:
            return false;
    }
}

function alternateTarget(body: string, baseUrl: string, format: FetchFormat): string | undefined {
    if (!["markdown", "text", "json"].includes(format)) return undefined;

    let found: string | undefined;
    scanActiveTags(body, (tag) => {
        if (tag.name !== "link") return;
        const attributes = attributesOf(tag.raw);
        if (!attributes.get("rel")?.toLowerCase().split(/\s+/).includes("alternate")) return;
        if (!acceptsAlternate(attributes.get("type") ?? "", format)) return;
        const target = httpTarget(attributes.get("href") ?? "", baseUrl);
        if (target && target !== baseUrl) {
            found = target;
            return false;
        }
        return;
    });
    return found;
}

export async function fetchPage(url: string, maxChars: number, format: FetchFormat = "markdown", maxLines = 1900): Promise<FetchedPage> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`${url} is not a URL`); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`only http and https can be fetched, not ${parsed.protocol}`);
    const visited = new Set<string>();
    let nextUrl = parsed.toString();
    let result: Awaited<ReturnType<typeof readPage>>;
    for (let followed = 0; ; followed++) {
        visited.add(nextUrl);
        result = await readPage(nextUrl);
        visited.add(result.finalUrl);
        const window = result.body.length > MAX_EXTRACTION_CHARS ? readWindow(result.body).text : result.body;
        const target = result.body.length <= MAX_EXTRACTION_CHARS && isHtml(result.asText) && htmlToText(window).length < 300
            ? refreshTarget(window, result.finalUrl) : undefined;
        if (!target) break;
        if (visited.has(target)) throw new Error(`meta refresh loop at ${result.finalUrl}`);
        if (followed >= 5) throw new Error(`meta refresh limit (5) exceeded at ${result.finalUrl}`);
        nextUrl = target;
    }
    const { body, finalUrl, asText } = result;
    const base = { url, finalUrl, title: finalUrl, contentType: asText, format, truncated: false };
    if (result.filePath) {
        const saved = { ...base, extractor: "download", filePath: result.filePath, fileSize: result.fileSize };
        return boundPage({ ...saved, text: `Saved ${result.filePath} (${asText || "unknown content type"}, ${result.fileSize} bytes)` }, maxChars, maxLines, "");
    }

    const html = isHtml(asText);
    const windowed = body.length > MAX_EXTRACTION_CHARS;
    const window = windowed ? readWindow(body).text : body;
    let title = html ? titleOf(window, finalUrl) : finalUrl;
    let chosen = html ? htmlToText(window) : body;
    let extractor = html ? "built-in" : "verbatim";
    let note: string | undefined;
    const metadata: PageMetadata = {};

    // The page Defuddle cleaned is the source of four formats: markdown is it as markdown, html is
    // it as markup, and text and json read the words out of it. Stripping the raw page instead
    // hands back its navigation and footers.
    if (html && !windowed && ["markdown", "text", "json", "html"].includes(format)) {
        const dom = await loadDomTools();
        let extraction: (PageMetadata & { title?: string; content?: string; published?: string }) | undefined;
        if (dom) try {
            extraction = await dom.Defuddle(dom.parseHTML(body).document, finalUrl,
                format === "markdown" ? { markdown: true, removeImages: true } : { markdown: false, removeImages: true });
        } catch { extraction = undefined; }
        if (format === "json" && extraction) {
            for (const key of PAGE_METADATA_KEYS) {
                const value = extraction[key === "publishedDate" ? "published" : key];
                if (typeof value === "string" && value.trim()) metadata[key] = value.trim();
            }
        }
        const cleaned = String(extraction?.content ?? "").trim();
        const extracted = ["markdown", "html"].includes(format) ? cleaned : htmlToText(cleaned);
        if (extracted.length > 200) {
            chosen = extracted;
            title = String(extraction?.title ?? "").trim() || title;
            extractor = "defuddle";
        } else if (format === "html") {
            chosen = body;
            extractor = "source";
            note = "no article was found, so the page's own source is shown";
        } else note = dom
            ? "the extractor kept too little of this page, so its raw text is shown: menus and footers are in there too"
            : "read with the built-in stripper (defuddle is not installed): menus and footers are in there too";
    } else if (html && ["raw", "html"].includes(format)) {
        chosen = window;
        extractor = "source";
    }

    let sourceUrl: string | undefined;
    // One alternate hop only, and only for the representation the page advertised: without that
    // check a stylesheet served at an advertised markdown link would pass for an article.
    if (html && ["markdown", "text", "json"].includes(format) && chosen.trim().length < 200) {
        const target = alternateTarget(window, finalUrl, format);
        if (target) try {
            const alternate = await readPage(target, true);
            if (!alternate.filePath && acceptsAlternate(alternate.asText, format) && alternate.body.trim().length > chosen.trim().length) {
                chosen = alternate.body;
                sourceUrl = alternate.finalUrl;
                extractor = "alternate";
                note = `Content from alternate URL: ${sourceUrl}`;
            }
        } catch { /* A failed alternate leaves the original answer unchanged. */ }
    }

    if (windowed) note = `Extraction limited: the body is large, so ${LARGE_BODY_WINDOW_CHARS} characters of its main content were read`;
    // A windowed answer was never produced whole, so the file that accompanies it holds the page's
    // own source; every other shortened answer saves the text that was shortened, so what is
    // returned is the beginning of what was saved.
    const sourceIsNeeded = windowed && !sourceUrl;
    return boundPage({
        ...base, ...metadata, title, text: chosen, truncated: windowed, extractor,
        ...(note ? { note } : {}), ...(sourceUrl ? { sourceUrl } : {}),
    }, maxChars, maxLines, sourceIsNeeded ? window : chosen, sourceIsNeeded ? "source" : "answer");
}

/** Bound the representation, not just the text field: escaping, metadata and notes all count. */
async function boundPage(
    page: FetchedPage,
    maxChars: number,
    maxLines: number,
    whole: string,
    holds: "answer" | "source" = "answer",
): Promise<FetchedPage> {
    const fits = (text: string) => text.length <= maxChars && Buffer.byteLength(text) <= maxChars && text.split("\n").length <= maxLines;
    const prefix = (text: string, size: number) => {
        if (size > 0 && /[\uD800-\uDBFF]/.test(text[size - 1] ?? "")) size--;
        return text.slice(0, size);
    };
    // A valid JSON alternate/body can pass through only if the final representation fits whole.
    if (page.format === "json" && page.extractor !== "download" && !page.truncated &&
        (!isHtml(page.contentType) || page.sourceUrl) && fits(page.text)) {
        try { JSON.parse(page.text); return page; } catch { /* Use a bounded object. */ }
    }
    const fullText = page.text;
    let metadataShortened = false;
    for (const key of BOUNDED_METADATA_KEYS) {
        const value = page[key];
        // A shortened field says so with its ellipsis; it is not a reason to claim the body was cut.
        if (value && value.length > 200) {
            page[key] = prefix(value, 199) + "…";
            metadataShortened = true;
        }
    }
    // Said out loud, so a short title is not mistaken for the page's own.
    if (metadataShortened) page.note = [page.note, "the page's own metadata was shortened to fit"].filter((line) => line).join("; ");
    const representation = (text: string) => page.format === "json"
        ? JSON.stringify({
            url: page.url, finalUrl: page.finalUrl, title: page.title, contentType: page.contentType,
            extractor: page.extractor, text, truncated: page.truncated,
            ...Object.fromEntries(PAGE_METADATA_KEYS.filter((key) => page[key]).map((key) => [key, page[key]])),
            ...(page.note ? { note: page.note } : {}),
            ...(page.sourceUrl ? { sourceUrl: page.sourceUrl } : {}),
            ...(page.filePath ? { filePath: page.filePath, bytes: page.fileSize } : {}),
        })
        : renderPage({ ...page, text });
    let head = prefix(fullText, maxChars);
    if (head !== fullText || !fits(representation(head))) page.truncated = true;
    if (page.truncated && !page.filePath) {
        try {
            Object.assign(page, await saveBytes(new TextEncoder().encode(whole), page.sourceUrl ?? page.finalUrl));
            page.fileHolds = holds;
        } catch (error) {
            // A download folder that cannot take the file must not cost the caller the answer: what
            // was read is still returned, bounded, and the reason it was not saved is said plainly.
            const reason = error instanceof Error ? error.message : String(error);
            page.note = [page.note, `the rest was not saved: ${reason}`].filter((line) => line).join("; ");
        }
    }
    // Metadata alone must fit even when it contains JSON escapes, multibyte text or line breaks.
    while (!fits(representation(""))) {
        let reduced = false;
        for (const key of BOUNDED_METADATA_KEYS) {
            const value = page[key];
            if (value && value.length > 1) { page[key] = prefix(value, Math.floor(value.length / 2)); reduced = true; }
        }
        if (!reduced) throw new Error("output budget is too small to name the saved body");
    }
    if (!fits(representation(head))) {
        let low = 0, high = head.length;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (fits(representation(prefix(head, mid)))) low = mid;
            else high = mid - 1;
        }
        head = prefix(head, low);
    }
    page.text = page.format === "json" ? representation(head) : head;
    return page;
}

export function renderPage(page: FetchedPage): string {
    // JSON stays JSON: the path of a saved body is a field inside it, not a line in front of it.
    if (page.format === "json") return page.text;

    const notes = [
        page.truncated
            ? page.filePath
                ? page.fileHolds === "source"
                    ? `(shortened; the part of the page that was read is at ${page.filePath})`
                    : `(shortened; the full text is at ${page.filePath})`
                : `(first ${page.text.length} characters of the page)`
            : "",
        page.note ?? "",
    ].filter((line) => line !== "");

    if (page.format !== "markdown" || !isHtml(page.contentType)) {
        return [...notes, page.text].filter((line) => line !== "").join("\n\n");
    }

    return [`# ${page.title}`, page.finalUrl, ...notes, "", page.text].join("\n");
}

// ===== Tools ============================================================================

const search = defineTool({
    name: "web_search",
    description:
        "Search the web and get each query's results as numbered markdown, then a list of links to open. " +
        "Use it for anything that changes over time (versions, prices, dates, releases, news) and then " +
        "web_fetch the few best links.",
    parameters: Type.Object({
        searches: Type.Array(Type.String({ description: "A search query" }), {
            minItems: 1,
            maxItems: 6,
            description:
                "One to six queries, each searched on its own page: one for a narrow lookup, two or " +
                "three for a topic with distinct angles. More queries costs more time, not better luck.",
        }),
    }),
    // Searching twice reads the web twice and changes nothing.
    replay: "safe",
    execute: async (args, api, context) => {
        const agent = await api.agent(context);
        const resultsPerQuery = await loadResultsPerQuery(await agentDir(), agent.cwd ?? process.cwd());
        const searches: QueryProgress[] = [];

        for (const query of args.searches) {
            try {
                const answer = await searchOne(query, resultsPerQuery);
                searches.push({ query, ok: true, engine: answer.engine, markdown: answer.markdown, links: answer.links });
                api.output(renderQuerySection(searches.at(-1)!));
            } catch (caught) {
                // One failed query does not lose the others: it goes in the answer as its own note.
                const reason = caught instanceof Error ? caught.message : String(caught);
                searches.push({ query, ok: false, error: reason });
                api.output(renderQuerySection(searches.at(-1)!));
            }
        }

        // Every call failed: that is an error the model should see as one, and can retry differently.
        if (searches.every((entry) => !entry.ok)) {
            throw new Error(renderToolResult(searches));
        }

        return { content: [{ type: "text" as const, text: renderToolResult(searches) }] };
    },
});

const formatParameter = Type.Optional(Type.Union([
    Type.Literal("markdown"), Type.Literal("html"), Type.Literal("text"), Type.Literal("json"), Type.Literal("raw"),
], { description: "Output format (default markdown)" }));

const fetchTool = defineTool({
    name: "web_fetch",
    description:
        "Open one web page and get its readable text (title, final URL, content). Use it on the links " +
        "web_search returns, or when given a URL to read.",
    parameters: Type.Object({
        url: Type.String({ description: "The http or https URL of one page" }),
        format: formatParameter,
        maxChars: Type.Optional(
            Type.Integer({
                minimum: 1000,
                maximum: MAX_MAX_CHARS,
                description: `How much text to keep (default ${DEFAULT_MAX_CHARS})`,
            }),
        ),
    }),
    // Downloads create files; an interrupted call must not replay and create another one.
    execute: async (args) => {
        const page = await fetchPage(args.url, Math.min(args.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS), args.format);
        return { content: [{ type: "text" as const, text: renderPage(page) }] };
    },
});

const batchFetchTool = defineTool({
    name: "batch_web_fetch",
    description: "Read one to five web pages; returns readable text or an error for each URL.",
    parameters: Type.Object({
        requests: Type.Array(Type.Object({
            url: Type.String(),
            format: formatParameter,
            maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_MAX_CHARS })),
        }), { minItems: 1, maxItems: 5 }),
    }),
    // Downloads create files, so batch fetch is also unsafe to replay.
    execute: async (args) => {
        const results: string[] = new Array(args.requests.length);
        // The harness allows 50 KiB / 2000 lines for the entire call, not for each page.
        const share = Math.floor(48_000 / args.requests.length);
        const lineShare = Math.floor(1900 / args.requests.length);
        let cursor = 0;
        async function worker(): Promise<void> {
            while (cursor < args.requests.length) {
                const index = cursor++;
                const request = args.requests[index]!;
                const heading = `## Page ${index + 1}: ${request.url.replace(/[\r\n]/g, "").slice(0, 200)}`;
                const budget = Math.min(request.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS, share - Buffer.byteLength(heading) - 10);
                try {
                    const page = await fetchPage(request.url, budget, request.format, lineShare - 5);
                    results[index] = `${heading}\n\n${renderPage(page)}`;
                } catch (caught) {
                    const reason = caught instanceof Error ? caught.message : String(caught);
                    results[index] = `${heading}\n\nError: ${reason.replace(/[\r\n]/g, " ").slice(0, Math.floor(budget / 4))}`;
                }
            }
        }
        await Promise.all(Array.from({ length: Math.min(3, args.requests.length) }, () => worker()));
        return { content: [{ type: "text" as const, text: results.join("\n\n---\n\n") }] };
    },
});

const GUIDANCE =
    "Your memory of the web goes stale: versions, prices, releases, dates and current events must be looked " +
    "up with web_search, then web_fetch to read the few most relevant links it returns. Both take a moment, " +
    "so search for what changes the answer rather than for everything the question touches.";

export default function createWebTools() {
    return defineExtension({
        name: "web-tools",
        tools: [search, fetchTool, batchFetchTool],
        sections: [section("web_tools", () => GUIDANCE)],
    });
}
