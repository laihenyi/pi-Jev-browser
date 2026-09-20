#!/usr/bin/env node
import "./lib/env.ts";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupHarness,
	hasCredentials,
	runScenario,
	type Scenario,
	type ScenarioResult,
	type Tier,
} from "./lib/harness.ts";
import { desktopScenarios } from "./scenarios/desktop.ts";
import { localScenarios } from "./scenarios/local.ts";
import { liveScenarios } from "./scenarios/live.ts";
import { modelScenarios } from "./scenarios/model.ts";
import { texteditScenarios } from "./scenarios/textedit.ts";

const all: Scenario[] = [
	...localScenarios,
	...modelScenarios,
	...liveScenarios,
	...desktopScenarios,
	...texteditScenarios,
];
const byId = new Map(all.map((scenario) => [scenario.id, scenario]));
const resultsDir = join(import.meta.dirname, "results");

function parseArgs(argv: string[]) {
	const options = {
		suite: "local" as "local" | "model" | "live" | "desktop" | "all",
		only: [] as string[],
		repeat: 1,
		json: undefined as string | undefined,
		strict: false,
		list: false,
	};
	for (const argument of argv) {
		if (argument === "--list") options.list = true;
		else if (argument === "--strict") options.strict = true;
		else if (argument.startsWith("--suite="))
			options.suite = argument.slice("--suite=".length) as typeof options.suite;
		else if (argument.startsWith("--only="))
			options.only = argument
				.slice("--only=".length)
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
		else if (argument.startsWith("--repeat="))
			options.repeat = Math.max(1, Number(argument.slice("--repeat=".length)) || 1);
		else if (argument.startsWith("--json="))
			options.json = argument.slice("--json=".length);
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));

if (options.list) {
	for (const tier of ["local", "model", "live", "desktop"] as Tier[]) {
		console.log(`\n${tier}:`);
		for (const scenario of all.filter((entry) => entry.tier === tier))
			console.log(`  ${scenario.id.padEnd(28)} ${scenario.category.padEnd(11)} ${scenario.title}`);
	}
	process.exit(0);
}

const tiers: Tier[] =
	options.suite === "all"
		? (["local", "model", "live", "desktop"] as Tier[])
		: [options.suite];
let selected = all.filter((scenario) => tiers.includes(scenario.tier));
if (options.only.length > 0)
	selected = selected.filter((scenario) => options.only.includes(scenario.id));

if (selected.length === 0) {
	console.error(`No scenarios matched suite=${options.suite} only=${options.only.join(",")}`);
	process.exit(2);
}

const credentials = hasCredentials();
if (
	selected.some(
		(scenario) => scenario.tier !== "local" && scenario.needsCredentials !== false,
	) &&
	!credentials
) {
	console.error(
		"Model and live scenarios need a TypeSafe credential (TYPESAFE_API_KEY or typesafe.apiKey in pi-jev-browser.config.json).",
	);
}

const results: ScenarioResult[] = [];
for (const scenario of selected) {
	if (scenario.tier !== "local" && scenario.needsCredentials !== false && !credentials) {
		results.push({
			id: scenario.id,
			tier: scenario.tier,
			category: scenario.category,
			title: scenario.title,
			status: "skipped",
			checks: [],
			metrics: {},
			elapsedMs: 0,
			error: "no TypeSafe credential",
		});
		console.log(`\n—— SKIP ${scenario.id} (no credential)`);
		continue;
	}
	const runs: ScenarioResult[] = [];
	for (let attempt = 1; attempt <= options.repeat; attempt++) {
		process.stdout.write(
			`\n—— ${scenario.id} ${options.repeat > 1 ? `(${attempt}/${options.repeat}) ` : ""}`,
		);
		const result = await runScenario(scenario);
		runs.push(result);
		process.stdout.write(`${result.status.toUpperCase()} (${(result.elapsedMs / 1000).toFixed(1)}s)`);
		if (result.error) process.stdout.write(`\n   error: ${result.error}`);
		const gapScenario = byId.get(scenario.id)?.documentsGap === true;
		for (const entry of result.checks)
			if (!entry.passed)
				process.stdout.write(
					`\n   ${gapScenario ? "gap" : "✗"} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`,
				);
	}
	// A scenario passes only if every repetition passed.
	const merged: ScenarioResult = {
		...runs[0],
		status: runs.every((run) => run.status === "passed") ? "passed" : "failed",
		elapsedMs: runs.reduce((total, run) => total + run.elapsedMs, 0),
		metrics:
			options.repeat > 1
				? { ...runs[0].metrics, repetitions: options.repeat }
				: runs[0].metrics,
	};
	results.push(merged);
}

await cleanupHarness();

// ------------------------------------------------------------------ report
const label = (result: ScenarioResult) => {
	if (result.status === "skipped") return "SKIP";
	// A limitation scenario passes while the gap is still present.
	if (byId.get(result.id)?.documentsGap) return result.status === "passed" ? "GAP" : "GONE";
	return result.status === "passed" ? "PASS" : "FAIL";
};
console.log("\n\n=== Capability benchmark ===\n");
console.log(
	`${"scenario".padEnd(28)} ${"tier".padEnd(6)} ${"category".padEnd(11)} ${"result".padEnd(5)}  time`,
);
for (const result of results)
	console.log(
		`${result.id.padEnd(28)} ${result.tier.padEnd(6)} ${result.category.padEnd(11)} ${label(result).padEnd(5)}  ${(result.elapsedMs / 1000).toFixed(1)}s`,
	);

const metrics = results.filter((result) => Object.keys(result.metrics).length > 0);
if (metrics.length > 0) {
	console.log("\nmetrics:");
	for (const result of metrics)
		console.log(`  ${result.id}: ${JSON.stringify(result.metrics)}`);
}

const failed = results.filter((result) => result.status === "failed");
const blocking = failed.filter(
	(result) => result.tier === "local" || result.tier === "model" || options.strict,
);
console.log(
	`\n${results.filter((r) => r.status === "passed").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "skipped").length} skipped`,
);
const gaps = results.filter(
	(result) => byId.get(result.id)?.documentsGap && result.status === "passed",
);
if (gaps.length > 0) {
	console.log(
		`\nGAP = the documented limitation is still present (${gaps.map((gap) => gap.id).join(", ")}).`,
	);
	for (const gap of gaps) console.log(`  ${gap.id}: ${byId.get(gap.id)?.notes}`);
}
if (failed.length > 0 && failed.length !== blocking.length)
	console.log(`(${failed.length - blocking.length} live failure(s) are environment-dependent and do not affect the exit code unless --strict)`);

const payload = {
	startedAt: new Date().toISOString(),
	suite: options.suite,
	repeat: options.repeat,
	results,
};
mkdirSync(resultsDir, { recursive: true });
const target = options.json ?? join(resultsDir, `${Date.now()}.json`);
writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
appendFileSync(join(resultsDir, "history.jsonl"), `${JSON.stringify(payload)}\n`);
console.log(`\nwrote ${target}`);

process.exit(blocking.length > 0 ? 1 : 0);
