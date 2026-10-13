#!/usr/bin/env node
import { existsSync } from "node:fs";

/**
 * AM2 live lane gate. It is deliberately fail-closed: this file never fabricates a live watcher run, a benchmark
 * number, or a delivery receipt. It reports why the lane cannot run and exits 2.
 */

const REASONS = [
	"a live Durable host fixture path (AM2_LIVE_FIXTURE) that this assignment may open",
	"a live Agent Mail project and existing agent identity (AM2_LIVE_PROJECT, AM2_LIVE_AGENT) that may receive production events",
	"ten configured cloud-worker lanes with screenshots and terminal capture",
	"a video harness for the crash-and-recovery recording",
	"a trunk/head performance baseline on the same machine",
];

function main(): number {
	const fixture = process.env.AM2_LIVE_FIXTURE;
	const project = process.env.AM2_LIVE_PROJECT;
	const agent = process.env.AM2_LIVE_AGENT;
	const missing = [
		...(fixture === undefined ? [REASONS[0]] : []),
		...(project === undefined || agent === undefined ? [REASONS[1]] : []),
		REASONS[2], REASONS[3], REASONS[4],
	];
	if (fixture !== undefined && !existsSync(fixture)) missing.push(`the configured fixture ${fixture} does not exist`);
	// The remaining lanes are unavailable even when a fixture is configured: a positive lane would need production
	// mailbox effects and cloud workers, which this assignment denies and which no local fixture can substitute for.
	process.stderr.write([
		"UNAVAILABLE: live-am2 (exit 2, no live receipt).",
		`Missing or refused: ${missing.join("; ")}.`,
		"The packaged CLI listing over `am inbox-events` is unit-verified against the contract read from the live CLI, but no lane ran end to end.",
		"Unit fixture evidence lives in test/delivery.test.ts, test/watcher.test.ts and test/am-cli.test.ts and is not live acceptance.",
		"Pocket wake stays blocked: it needs the Pocket admission capability the current PocketHost does not provide, and no live project may be touched here.",
	].join("\n") + "\n");
	return 2;
}

process.exitCode = main();
