import assert from "node:assert/strict";
import { test } from "node:test";
import { runHarnessProbe } from "../examples/harness.mjs";

test("real in-memory Pi Durable Harness invokes the adapter with deterministic fixtures", async () => {
    const result = await runHarnessProbe();
    assert.deepEqual(result, {
        settled: "done",
        invocations: 1,
        fixtureCalls: 1,
        globalFetchCalls: 0,
        response: "fixture harness complete",
        kinds: ["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"],
    });
});
