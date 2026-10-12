import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodexHost } from "./types.ts";

export type Host = CodexHost;
export type CodexRuntime = {
  cwd: string;
  signal: AbortSignal;
  models: ToolExecutionApi["models"];
  fetch: typeof globalThis.fetch;
  model(modelId?: string): Model<Api>;
  request(path: string, body?: unknown): Promise<unknown>;
  images(
    paths?: string[],
    recentCount?: number,
  ): Promise<Array<{ data: string; mimeType: string }>>;
  close(): void;
};
const ROOT = "https://chatgpt.com/backend-api/codex/";
const ROUTES = new Set([
  "alpha/search",
  "images/generations",
  "images/edits",
  "../wham/usage",
]);
const IMAGE_BYTES = 20 * 1024 * 1024;
const JSON_BYTES = 160 * 1024 * 1024;
const DENIED = "Codex tools are available only to the Pocket owner requester.";

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
  );
}

export function imageMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) {
    return "image/jpeg";
  }
  if (
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    b.length >= 6 &&
    ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6))
  ) {
    return "image/gif";
  }
  throw new Error(
    "Image must be PNG, JPEG, WebP or GIF with valid file magic.",
  );
}

// Test seams do not read the real app configuration or resolve real credentials.
export type RuntimeOptions = {
  fetch?: typeof fetch;
  deadlineMs?: number;
};

export async function makeRuntime(
  api: ToolExecutionApi,
  context: Context,
  host: Host,
  options: RuntimeOptions = {},
): Promise<CodexRuntime> {
  try {
    const allowed = await host.authorize({
      conversationId: api.conversationId,
      api,
    });
    if (!allowed) {
      throw new Error(DENIED);
    }
  } catch {
    throw new Error(DENIED);
  }
  context.abortSignal?.throwIfAborted();
  const agent = await api.agent(context);
  if (!agent.cwd) {
    throw new Error("Codex tools require a local session working directory.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Codex call cancelled."));
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  if (context.abortSignal?.aborted) {
    abort();
  }
  const timer = setTimeout(
    () => controller.abort(new Error("Codex call deadline exceeded.")),
    options.deadlineMs ?? 180_000,
  );
  const signal = controller.signal;
  const check = () => signal.throwIfAborted();
  const bounded = <T>(operation: Promise<T>): Promise<T> => {
    if (signal.aborted) {
      return Promise.reject(new Error("Codex call cancelled or timed out."));
    }
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        signal.removeEventListener("abort", cancelled);
        reject(new Error("Codex call cancelled or timed out."));
      };
      signal.addEventListener("abort", cancelled, { once: true });
      void operation
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", cancelled));
    });
  };
  let catalog: readonly Model<Api>[];
  try {
    const status = await bounded(
      api.models.checkAuth("openai-codex", { signal }),
    );
    if (status?.type !== "oauth") {
      throw new Error("auth");
    }
    catalog = await bounded(
      api.models.getAvailable("openai-codex", { signal }),
    );
    check();
  } catch {
    clearTimeout(timer);
    context.abortSignal?.removeEventListener("abort", abort);
    controller.abort();
    throw new Error(
      "Codex OAuth unavailable or cancelled; sign in through native Models.",
    );
  }
  const model = (id?: string): Model<Api> => {
    check();
    const chosen =
      id ??
      (agent.model?.provider === "openai-codex"
        ? agent.model.modelId
        : catalog[0]?.id);
    const result = catalog.find((m) => m.id === chosen);
    if (!result) {
      throw new Error(
        "Requested Codex model is not in the native catalog; select an available openai-codex model.",
      );
    }
    return result;
  };
  // Native ProviderRequestOptions.fetch is typeof globalThis.fetch; preserve native SSE parsing.
  let responsesRequested = false;
  const nativeFetch: typeof globalThis.fetch = async (input, init) => {
    check();
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      throw new Error("Codex responses endpoint is not allowed.");
    }
    if (
      url.href !== `${ROOT}responses` ||
      url.username ||
      url.password ||
      (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase() !== "POST"
    ) {
      throw new Error("Codex responses endpoint or method is not allowed.");
    }
    if (responsesRequested) {
      throw new Error("Codex responses retry is not allowed.");
    }
    responsesRequested = true;
    const callerSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const combined = callerSignal
      ? AbortSignal.any([signal, callerSignal])
      : signal;
    try {
      combined.throwIfAborted();
      return await bounded(
        (options.fetch ?? globalThis.fetch)(input, {
          ...init,
          redirect: "error",
          signal: combined,
        }),
      );
    } catch {
      throw new Error(
        combined.aborted
          ? "Codex call cancelled or timed out."
          : "Codex responses request failed; no retry was made.",
      );
    }
  };
  return {
    cwd: agent.cwd,
    fetch: nativeFetch,
    models: api.models,
    signal,
    model,
    close() {
      clearTimeout(timer);
      context.abortSignal?.removeEventListener("abort", abort);
      controller.abort(new Error("Codex runtime closed."));
    },
    async request(path, body) {
      check();
      if (
        !ROUTES.has(path) ||
        (path === "../wham/usage" && body !== undefined)
      ) {
        throw new Error("Codex endpoint or method is not allowed.");
      }
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload && Buffer.byteLength(payload) > JSON_BYTES) {
        throw new Error("Codex request exceeds byte limit.");
      }
      let auth;
      try {
        const status = await bounded(
          api.models.checkAuth("openai-codex", { signal }),
        );
        check();
        if (status?.type !== "oauth") {
          throw new Error("auth");
        }
        auth = await bounded(api.models.getAuth("openai-codex", { signal }));
        check();
      } catch {
        throw new Error(
          signal.aborted
            ? "Codex call cancelled or timed out."
            : "Codex OAuth unavailable; sign in through native Models.",
        );
      }
      const key = auth?.auth.apiKey;
      let account: unknown;
      try {
        const claims = JSON.parse(
          Buffer.from(key?.split(".")[1] ?? "", "base64url").toString("utf8"),
        );
        account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
      } catch {
        // Native Codex auth supplies the access token; never return it or its claims.
      }
      if (!key || typeof account !== "string" || !account) {
        throw new Error(
          "Codex OAuth account is unavailable; sign in through native Models.",
        );
      }
      let response: Response;
      try {
        response = await bounded(
          (options.fetch ?? fetch)(new URL(path, ROOT), {
            method: payload === undefined ? "GET" : "POST",
            redirect: "error",
            signal,
            headers: {
              Authorization: `Bearer ${key}`,
              "ChatGPT-Account-Id": account,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: payload,
          }),
        );
      } catch {
        throw new Error(
          signal.aborted
            ? "Codex call cancelled or timed out."
            : "Codex network request failed; no retry was made.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(
          `Codex request failed (HTTP ${response.status}); no retry was made.`,
        );
      }
      if (Number(response.headers.get("content-length")) > JSON_BYTES) {
        await response.body?.cancel();
        throw new Error("Codex response exceeds byte limit.");
      }
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Codex returned an empty response.");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          check();
          const { done, value } = await bounded(reader.read());
          if (done) {
            break;
          }
          size += value.byteLength;
          if (size > JSON_BYTES) {
            throw new Error("limit");
          }
          chunks.push(value);
        }
        check();
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          signal.aborted
            ? "Codex call cancelled or timed out."
            : "Codex response is invalid or exceeds byte limit.",
        );
      } finally {
        reader.releaseLock();
      }
    },
    async images(paths, recentCount) {
      check();
      if (paths === undefined && recentCount === undefined) {
        return [];
      }
      if (paths !== undefined && recentCount !== undefined) {
        throw new Error("Use image paths or recent images, not both.");
      }
      if (paths !== undefined) {
        if (!paths.length || paths.length > 5) {
          throw new Error("Provide 1–5 image paths.");
        }
        const root = await realpath(agent.cwd!);
        const uploadRoot = host.uploadRoot
          ? await host.uploadRoot(String(api.conversationId))
          : undefined;
        const uploads = uploadRoot
          ? await realpath(uploadRoot).catch(() => undefined)
          : undefined;
        const result = [];
        for (const path of paths) {
          check();
          let handle;
          try {
            const file = await realpath(resolve(agent.cwd!, path));
            if (!inside(root, file) && !(uploads && inside(uploads, file))) {
              throw new Error("outside");
            }
            handle = await open(
              file,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            // Verify the actual opened object too: parent symlink swaps must not escape containment.
            const opened = await realpath(`/proc/self/fd/${handle.fd}`);
            if (
              !inside(root, opened) &&
              !(uploads && inside(uploads, opened))
            ) {
              throw new Error("outside");
            }
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size === 0 || stat.size > IMAGE_BYTES) {
              throw new Error("size");
            }
            const bytes = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < bytes.length) {
              check();
              const { bytesRead } = await handle.read(
                bytes,
                offset,
                bytes.length - offset,
                offset,
              );
              if (!bytesRead) {
                throw new Error("short");
              }
              offset += bytesRead;
            }
            result.push({
              data: bytes.toString("base64"),
              mimeType: imageMime(bytes),
            });
          } catch {
            throw new Error(
              "Image path must be a valid bounded image inside cwd or this conversation's uploads.",
            );
          } finally {
            await handle?.close();
          }
        }
        check();
        return result;
      }
      if (
        !Number.isInteger(recentCount) ||
        recentCount! < 1 ||
        recentCount! > 5
      ) {
        throw new Error("Provide a recent image count from 1 to 5.");
      }
      // Read current fork-aware native entries, respecting the active head and context edits.
      const entries = await api.commit(async (tx) => {
        const head = await tx.latestHeadMarker(api.conversationId);
        const page = await tx.scanEntries(
          {
            conversationId: api.conversationId,
            minEntryId: head?.head,
            order: "descending",
          },
          200,
        );
        return page.items;
      }, context);
      const edits = new Map();
      for (const entry of entries) {
        for (const edit of entry.edits ?? []) {
          if (!edits.has(edit.target)) {
            edits.set(edit.target, edit);
          }
        }
      }
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const entry of entries) {
        const edit = edits.get(entry.id);
        const messages = edit ? (edit.messages ?? []) : (entry.model ?? []);
        for (const message of [...messages].reverse()) {
          if (typeof message.content === "string") {
            continue;
          }
          for (const item of [...message.content].reverse()) {
            if (item.type === "image") {
              if (
                item.data.length > Math.ceil(IMAGE_BYTES / 3) * 4 ||
                item.data.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
              ) {
                throw new Error(
                  "Recent image exceeds limits or has invalid encoding.",
                );
              }
              const bytes = Buffer.from(item.data, "base64");
              if (
                bytes.length > IMAGE_BYTES ||
                bytes.toString("base64") !== item.data
              ) {
                throw new Error(
                  "Recent image exceeds limits or has invalid encoding.",
                );
              }
              const mimeType = imageMime(bytes);
              if (mimeType !== item.mimeType) {
                throw new Error("Recent image type does not match file magic.");
              }
              images.push({ data: item.data, mimeType });
              if (images.length === recentCount) {
                return images.reverse();
              }
            }
          }
        }
      }
      throw new Error(
        `Requested ${recentCount} recent images, but only ${images.length} available in the current native transcript (last 200 entries); reduce the count or provide explicit paths.`,
      );
    },
  };
}

export function usageText(value: unknown): string {
  const obj = value as {
    rate_limit?: {
      primary_window?: { used_percent?: number; reset_after_seconds?: number };
      secondary_window?: {
        used_percent?: number;
        reset_after_seconds?: number;
      };
    };
  };
  const lines = ["Codex subscription quota (account identity masked):"];
  for (const [label, window] of [
    ["Primary", obj?.rate_limit?.primary_window],
    ["Secondary", obj?.rate_limit?.secondary_window],
  ] as const) {
    if (
      window &&
      typeof window.used_percent === "number" &&
      Number.isFinite(window.used_percent)
    ) {
      const reset = window.reset_after_seconds;
      lines.push(
        `${label}: ${Math.max(0, Math.min(100, window.used_percent))}% used${typeof reset === "number" && Number.isFinite(reset) ? `; resets in ${Math.max(0, Math.round(reset))}s` : ""}.`,
      );
    }
  }
  if (lines.length === 1) {
    lines.push("Quota windows unavailable in this response.");
  }
  return lines.join("\n");
}

export function createUsageTool(host: Host) {
  return defineTool({
    name: "codex_usage",
    description:
      "Manually read Codex subscription quota; account masked, no credit inventory or redemption.",
    parameters: Type.Object({}, { additionalProperties: false }),
    replay: "unsafe",
    execute: async (_args, api, context) => {
      const runtime = await makeRuntime(api, context, host);
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: usageText(await runtime.request("../wham/usage")),
            },
          ],
        };
      } finally {
        runtime.close();
      }
    },
  });
}
