import { register } from "node:module";

register("../hooks.mjs", import.meta.url);
await import("./server.ts");
