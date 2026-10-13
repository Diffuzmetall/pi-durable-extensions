const gate = process.argv.slice(2).join(" ") || "unspecified";
const lines = [
	`UNAVAILABLE: ${gate} (exit 2, no receipt).`,
	gates(),
	"This gate never fabricates a live run, a benchmark number, a screenshot, or a delivery receipt, and it deletes no file.",
].join("\n");
console.error(lines);
process.exitCode = 2;

function gates() {
	if (gate === "perf") {
		return [
			"No trunk/head baseline and no measurement machine profile is supplied, so the plan's performance budgets are not measured and must not be reported as passed:",
			"p95 turn regression > 10% and > 20 ms (AM1); extension hook p95 <= 5 ms with 0 CLI calls; p95 event-to-admission <= 20 s, idle CPU delta <= 1 point, RSS delta <= 20 MiB (AM2);",
			"Pocket admission p95 regression > 10% and > 20 ms, adapter p95 <= 100 ms, event-to-visible-input <= 20 s (AM3).",
			"The perf lane additionally needs a live Mail project for delivery measurement and a Pocket host for the adapter lane, neither of which this assignment may touch.",
			"`npm --prefix packages/agent-mail-identity run bench -- <am1|am2|pocket>` therefore exits 2 instead of printing a number. Unit fixtures are not a benchmark.",
		].join(" ");
	}
	return [
		`No configured live Mail project, cloud-worker receipts, terminal capture, video, or trunk baseline is supplied, and a real Pocket wake stays blocked by missing_host_capability on the current PocketHost.`,
		"AM1, AM2 and AM3 are implemented and verified as durable unit fixtures on real SQLite only; live delivery, performance measurement and Pocket wake remain blocked.",
		"Fixture tests are not a substitute for live acceptance.",
	].join(" ");
}
