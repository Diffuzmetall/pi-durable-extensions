#!/usr/bin/env node
import { existsSync } from "node:fs";

/**
 * AM3 live lane gate. Like the AM2 gate it never fabricates a receipt: it reports why the lane cannot run and exits 2.
 *
 * The Pocket lanes need capabilities the current PocketHost does not publish, so a positive lane is not merely
 * unconfigured — it is refused by the adapter itself with `missing_host_capability`.
 */

const REASONS = [
	"a live Pocket fixture (AM3_LIVE_POCKET_ROOT) with an unmodified host that this assignment may load an extension into",
	"a public PocketHost capability to submit as a bound person with live person, steer-role, visibility and driver validation (A6)",
	"a live RegistryReader-backed presence source on that host (A1)",
	"ten configured cloud-worker lanes with screenshots and terminal capture",
	"a video harness for the enable-refusal and disable recording",
	"a trunk/head Pocket admission and RSS baseline on the same machine",
];

function main(): number {
	const root = process.env.AM3_LIVE_POCKET_ROOT;
	const missing = [
		...(root === undefined ? [REASONS[0]] : []),
		...(root !== undefined && !existsSync(root) ? [`the configured Pocket fixture ${root} does not exist`] : []),
		REASONS[1], REASONS[2], REASONS[3], REASONS[4], REASONS[5],
	];
	process.stderr.write([
		"UNAVAILABLE: live-pocket (exit 2, no live receipt).",
		`Missing or refused: ${missing.join("; ")}.`,
		`The default Pocket entry point answers enable with missing_host_capability on the current PocketHost: it publishes no submit-as-bound-person operation with live person, steer-role, visibility and driver validation (A6) and no live RegistryReader (A1).`,
		"Unit fixture evidence lives in test/pocket/admission.test.ts and test/pocket/install.test.ts and is not live acceptance.",
		"No live Pocket host was started, no extension was loaded into one, and no Pocket data or configuration was touched.",
		"Live lanes, cloud workers, screenshots, video, the trunk comparison and every performance budget stay blocked; this is not live acceptance.",
	].join("\n") + "\n");
	return 2;
}

process.exitCode = main();
