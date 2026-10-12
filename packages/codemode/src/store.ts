import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

/** Durable codemode values owned by this package, scoped to one conversation. */
export const CodemodeStoreDoc = defineDoc<{ values: Record<string, JsonValue> }>({
    kind: "codemode.store",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ values: {} }),
});
