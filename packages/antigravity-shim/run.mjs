/** Entry point: install the loader hooks, then start the shim. */
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
await import("./src/server.ts");
