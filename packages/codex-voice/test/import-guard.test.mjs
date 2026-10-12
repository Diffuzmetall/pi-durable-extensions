import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const sourcePaths = ["src/index.ts", "src/types.ts", "src/transcription.ts"];

test("portable source has no Pocket/workspace imports or dynamic source discovery", async () => {
    for (const path of sourcePaths) {
        const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
        const imports = [...source.matchAll(/(?:import|export)\s+(?:[^\n]*?from\s+)?["']([^"']+)["']/g)].map(
            (match) => match[1],
        );
        assert.deepEqual(
            imports.filter((value) => /pocket|workspace|pi-pocket|\.\.\/\.\.\//i.test(value)),
            [],
            `${path} contains a forbidden import`,
        );
        assert.equal(/(?:readFile|readdir|process\.env|fetch\s*\()/u.test(source), false, `${path} discovers host state`);
    }
});
