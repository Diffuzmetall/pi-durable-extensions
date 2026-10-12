import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { CodexHost } from "./types.ts";

export type PocketAdapterOptions = {
  /** Pocket supplies its existing data directory only at the optional adapter boundary. */
  readonly dataDir: string;
  /** Structural requester seam; no Pocket module is imported by this package. */
  readonly requesterOf: (
    conversationId: ToolExecutionApi["conversationId"],
  ) => string | undefined | Promise<string | undefined>;
  /** Optional test/host seam; default preserves Pocket's owner-role config semantics. */
  readonly ownerIds?: () => readonly string[] | Promise<readonly string[]>;
};

/**
 * Optional adapter for a Pocket host. It preserves owner-only authorization and
 * conversation upload containment without coupling the portable core to Pocket.
 */
export function createPocketAdapter(options: PocketAdapterOptions): CodexHost {
  return {
    async authorize({ conversationId }) {
      const requester = await options.requesterOf(conversationId);
      if (!requester) return false;
      let owners: readonly string[];
      try {
        owners = options.ownerIds
          ? await options.ownerIds()
          : (
              JSON.parse(
                await readFile(join(options.dataDir, "config.json"), "utf8"),
              ) as { users?: Array<{ id?: string; role?: string }> }
            ).users
              ?.filter((user) => user.role === "owner" && typeof user.id === "string")
              .map((user) => user.id as string) ?? [];
      } catch {
        return false;
      }
      return owners.includes(requester);
    },
    uploadRoot(conversationId) {
      return join(options.dataDir, "uploads", conversationId);
    },
  };
}
