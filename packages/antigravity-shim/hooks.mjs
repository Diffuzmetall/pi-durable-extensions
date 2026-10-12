/**
 * Loader hooks that let a standalone process import the installed
 * npm:pi-antigravity sources: its files are .ts and its internal imports say
 * "./x.js".
 *
 * - resolve: "./x.js" (or an absolute "…/x.js") that does not exist is retried as ".ts"
 * - load: .ts is stripped/transformed here, because Node's own type stripping
 *   skips anything under node_modules, which is where the package lives.
 */
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js")) {
        try {
            return await nextResolve(specifier, context);
        } catch (error) {
            const retried = await nextResolve(`${specifier.slice(0, -3)}.ts`, context).catch(
                () => undefined,
            );

            if (retried !== undefined) {
                return retried;
            }

            throw error;
        }
    }

    return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
        return {
            format: "module",
            shortCircuit: true,
            source: stripTypeScriptTypes(await readFile(fileURLToPath(url), "utf8"), {
                mode: "transform",
            }),
        };
    }

    return nextLoad(url, context);
}
