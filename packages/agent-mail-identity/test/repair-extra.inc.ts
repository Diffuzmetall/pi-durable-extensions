import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

export async function fixtureDirectory(prefix: string) {
	const root = fileURLToPath(new URL("./fixtures/runtime/", import.meta.url));
	await mkdir(root, { recursive: true });
	return mkdtemp(join(root, prefix));
}
