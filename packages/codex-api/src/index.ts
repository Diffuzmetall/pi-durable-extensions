/** Owner-only Codex Ask, Search, Image and manual quota tools using native Pocket Models. */
import { defineExtension } from "@earendil-works/pi-durable";
import { createAskTool } from "./ask.ts";
import { createSearchTool } from "./search.ts";
import { createImageTool } from "./image.ts";
import { createUsageTool, type Host } from "./runtime.ts";

export { makeRuntime, imageMime, inside, usageText, createUsageTool } from "./runtime.ts";
export type { CodexRuntime, RuntimeOptions, Host } from "./runtime.ts";
export { createPocketAdapter } from "./adapter.ts";
export type { PocketAdapterOptions } from "./adapter.ts";
export type { CodexAuthorizationRequest, CodexHost } from "./types.ts";

export default function createCodexApi(host: Host) {
  return defineExtension({
    name: "codex-api",
    tools: [
      createAskTool(host),
      createSearchTool(host),
      createImageTool(host),
      createUsageTool(host),
    ],
  });
}
