/** Convert unknown thrown values to safe diagnostic text without exposing host internals. */
export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
