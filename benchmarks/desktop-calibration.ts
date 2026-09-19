import { desktopDriver, DESKTOP_RULES, type DesktopDriver } from "../src/drivers/desktop.ts";
import { DESKTOP_GOALS } from "./scenarios/desktop.ts";
import type { Driver, ObservationSnapshot, ObservedTarget } from "../src/driver.ts";
import { runJev } from "../src/loop.ts";
import { createJevPolicy, type JevPolicy } from "../src/policy.ts";
import type { TextGenerator } from "../src/policy.ts";

/**
 * A calibration instrument for the desktop rules text.
 *
 * Pass or fail is too blunt to steer prompt work: "it failed" does not say whether
 * the run got one step in or nine. This measures the longest correct prefix of the
 * expected press sequence, so a change that improves the plan shows up even when
 * the run still does not finish.
 *
 * Run it with the benchmark's credentials available:
 *   node benchmarks/desktop-calibration.ts [--runs=2] [--variants=C,D]
 */

const BUNDLE = "com.apple.calculator";
const EXPECTED = ["One", "Two", "Three", "Four", "Multiply", "Five", "Six", "Seven", "Eight", "Equals"];
const DESTRUCTIVE = ["AllClear", "Clear", "Delete"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENUMERATED_GOAL = DESKTOP_GOALS.enumerated;
const SHORT_GOAL = DESKTOP_GOALS.short;

interface Variant {
	name: string;
	goal: string;
	rules?: string;
	planning?: boolean;
}

const VARIANTS: Variant[] = [
	{ name: "A browser rules + enumerated goal", goal: ENUMERATED_GOAL },
	{ name: "B desktop rules + enumerated goal", goal: ENUMERATED_GOAL, rules: DESKTOP_RULES },
	{ name: "C desktop rules + short goal", goal: SHORT_GOAL, rules: DESKTOP_RULES },
	{ name: "D desktop rules + short goal + planning", goal: SHORT_GOAL, rules: DESKTOP_RULES, planning: true },
];

/** Records what was actually pressed, by identifier, which is not localised. */
function loggingDriver(inner: DesktopDriver, log: string[]): Driver {
	return {
		id: () => inner.id(),
		observe: async (): Promise<ObservationSnapshot> => {
			const snapshot = await inner.observe();
			return {
				...snapshot,
				execute: async (
					operation: string,
					target?: ObservedTarget,
					text?: string,
					signal?: AbortSignal,
				) => {
					if (operation === "CLICK" && target?.identifier) log.push(target.identifier);
					return snapshot.execute(operation, target, text, signal ?? AbortSignal.timeout(5000));
				},
			};
		},
		readFailureCategory: (error: unknown) => inner.readFailureCategory?.(error),
	};
}

/** Leading clears are harmless housekeeping; a clear after entering a digit is not. */
function analyse(presses: string[]) {
	let index = 0;
	while (index < presses.length && DESTRUCTIVE.includes(presses[index])) index++;
	const fromFirstDigit = presses.slice(index);
	let prefix = 0;
	while (prefix < EXPECTED.length && fromFirstDigit[prefix] === EXPECTED[prefix]) prefix++;
	const destructive = fromFirstDigit
		.slice(0, EXPECTED.length)
		.some((identifier, position) => position > 0 && DESTRUCTIVE.includes(identifier));
	return { prefix, destructive, fromFirstDigit };
}

/** Clears until the display reads 0: Calculator restores its last expression across a relaunch. */
async function reset(driver: DesktopDriver) {
	for (let attempt = 0; attempt < 4; attempt++) {
		const snapshot = await driver.observe();
		const clear = snapshot.data.targets.find((target) => /^(AllClear|Clear)$/.test(target.identifier ?? ""));
		if (!clear) break;
		await snapshot.execute("CLICK", clear, undefined, AbortSignal.timeout(5000));
		await sleep(400);
		const display = (await driver.observe()).data.text.replaceAll("\u200e", "");
		if ((display.match(/[\d][\d,]*/g) ?? []).every((value) => value.replaceAll(",", "") === "0")) return;
	}
}

async function runVariant(variant: Variant, text: TextGenerator) {
	const driver = desktopDriver({ bundleId: BUNDLE });
	const presses: string[] = [];
	try {
		await driver.activate();
		await reset(driver);
		const result = await runJev(
			{ goal: variant.goal, maxSteps: 16 },
			{ driver: loggingDriver(driver, presses), policy: createJevPolicy({ text, rules: variant.rules, planning: variant.planning === true }) },
		);
		const display = (await driver.observe()).data.text.replaceAll("\u200e", "").trim();
		const analysis = analyse(presses);
		return {
			prefix: analysis.prefix,
			destructive: analysis.destructive,
			presses: analysis.fromFirstDigit,
			stopReason: String(result.stopReason),
			display,
			correct: display.replaceAll(",", "").includes(String(1234 * 5678)),
			plan: result.plan?.join(" | ") ?? null,
		};
	} finally {
		await driver.close();
	}
}

const runs = Number(
	process.argv.find((argument) => argument.startsWith("--runs="))?.slice("--runs=".length) ?? 2,
);
/** --variants=C,D limits a session to the letters named, so one change can be measured alone. */
const onlyVariants = process.argv
	.find((argument) => argument.startsWith("--variants="))
	?.slice("--variants=".length)
	.split(",")
	.map((letter) => letter.trim().toUpperCase())
	.filter(Boolean);
const selected = onlyVariants?.length
	? VARIANTS.filter((variant) => onlyVariants.includes(variant.name[0]))
	: VARIANTS;
const text: TextGenerator = async () => ({ text: '{"text":null}' });
const table: Array<Record<string, unknown>> = [];

for (const variant of selected) {
	const results = [];
	for (let attempt = 0; attempt < runs; attempt++) {
		const outcome = await runVariant(variant, text);
		results.push(outcome);
		table.push({ variant: variant.name, attempt: attempt + 1, ...outcome });
		process.stdout.write(
			`\n${variant.name} #${attempt + 1}: 正確前綴 ${outcome.prefix}/${EXPECTED.length}` +
				`${outcome.correct ? " ✅ 完成" : ""}` +
				`${outcome.destructive ? " ⚠ 中途按了清除" : ""}\n` +
				`  顯示=${JSON.stringify(outcome.display)} stop=${outcome.stopReason}\n` +
				`  按下的 identifier: ${outcome.presses.join(", ")}\n` +
				(outcome.plan ? `  計畫: ${outcome.plan}\n` : ""),
		);
	}
	const best = Math.max(...results.map((result) => result.prefix));
	const mean = results.reduce((total, result) => total + result.prefix, 0) / results.length;
	console.log(`  → ${variant.name}: 最佳 ${best}/${EXPECTED.length}, 平均 ${mean.toFixed(1)}`);
}

console.log("\n=== 摘要（正確前綴長度，滿分 10）===");
for (const variant of selected) {
	const rows = table.filter((row) => row.variant === variant.name);
	console.log(
		`  ${variant.name.padEnd(38)} ${rows.map((row) => `${row.prefix}`).join(", ")}${rows.some((row) => row.correct) ? "  ← 有一次成功" : ""}`,
	);
}
const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/desktop-calibration.json", `${JSON.stringify(table, null, 2)}\n`);
console.log("\n明細寫入 /tmp/desktop-calibration.json");
process.exit(0);
