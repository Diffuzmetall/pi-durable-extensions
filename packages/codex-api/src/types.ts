import type { ToolExecutionApi } from "@earendil-works/pi-durable";

/** Explicit trust-boundary input supplied by an embedding host. */
export type CodexAuthorizationRequest = {
  readonly conversationId: ToolExecutionApi["conversationId"];
  readonly api: ToolExecutionApi;
};

/**
 * Capabilities required by the portable core. The core never discovers requesters,
 * reads host configuration, or constructs upload paths on its own.
 */
export type CodexHost = {
  readonly authorize: (
    request: CodexAuthorizationRequest,
  ) => boolean | Promise<boolean>;
  /** Return only the current conversation's upload root, or undefined to disable uploads. */
  readonly uploadRoot?: (
    conversationId: string,
  ) => string | undefined | Promise<string | undefined>;
};
