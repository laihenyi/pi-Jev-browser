import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { runJev } from "../../src/loop.ts";
import type { JevPolicy } from "../../src/policy.ts";
import { defaultHelperPath, desktopDriver, DESKTOP_RULES, type DesktopDriver } from "../../src/drivers/desktop.ts";
import { check, type Scenario } from "../lib/harness.ts";

/**
 * The desktop tier drives real macOS applications through their accessibility tree,
 * using the same decision loop as the browser tier.
 *
 * Verification is arithmetic rather than visual: the expected value of 1234 × 5678
 * is computed here and compared against what the application reports, so nothing is
 * taken on trust from either the agent or its own summary.
 */

const execFileAsync = promisify(execFile);
const BUNDLE = "com.apple.calculator";

/**
 * The two goals the desktop tier measures against each other. The enumerated one is
 * the working recipe; the short one is kept because it documents the boundary.
 */
export const DESKTOP_GOALS = {
	enumerated:
		"Enter 1234 × 5678 on this calculator, step by step: press 1, then 2, then 3, then 4, then the Multiply button, then 5, then 6, then 7, then 8, then Equals. Never press Clear, All Clear, Delete or Back. Use the recent actions to see which steps you already completed. Choose DONE when the display shows the result.",
	short:
		"Compute 1234 times 5678 on this calculator and stop when the display shows the result.",
};
const CALCULATOR_APP = "/System/Applications/Calculator.app";
const EXPECTED = String(1234 * 5678);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The digits of 1234 × 5678 by accessibility identifier, which is not localised. */
const SEQUENCE = [
	"One",
	"Two",
	"Three",
	"Four",
	"Multiply",
	"Five",
	"Six",
	"Seven",
	"Eight",
	"Equals",
];

async function isRunning(): Promise<boolean> {
	try {
		await execFileAsync("pgrep", ["-x", "Calculator"]);
		return true;
	} catch {
		return false;
	}
}

async function hostSkipReason(): Promise<string | undefined> {
	if (process.platform !== "darwin")
		return "the desktop tier drives macOS applications through the accessibility tree";
	if (!existsSync(defaultHelperPath()))
		return "the accessibility helper is not built (npm run build:ax-helper)";
	if (!existsSync(CALCULATOR_APP)) return "Calculator is not installed";
	if (!(await isRunning())) {
		await execFileAsync("open", ["-a", CALCULATOR_APP]).catch(() => undefined);
		for (let attempt = 0; attempt < 16; attempt++) {
			await sleep(500);
			if (await isRunning()) break;
		}
		if (!(await isRunning())) return "Calculator did not start";
	}
	// A running application can still have no window: closing the last window leaves
	// some applications alive, and `open` on a running application does not create
	// one. Relaunch so the tier always starts from a readable window.
	if (!(await hasWindow())) {
		await execFileAsync("osascript", ["-e", 'tell application "Calculator" to quit']).catch(
			() => undefined,
		);
		await sleep(1000);
		await execFileAsync("open", ["-a", CALCULATOR_APP]).catch(() => undefined);
		for (let attempt = 0; attempt < 16; attempt++) {
			await sleep(500);
			if (await hasWindow()) break;
		}
		if (!(await hasWindow())) return "Calculator is running without a window";
	}
	return undefined;
}

/** An application that is running without a window cannot be observed or driven. */
async function hasWindow(): Promise<boolean> {
	const driver = desktopDriver({ bundleId: BUNDLE });
	try {
		await driver.observe();
		return true;
	} catch {
		return false;
	} finally {
		await driver.close();
	}
}

/**
 * The display shows both the expression and the result ("1,234×5,678\n7,006,652"),
 * with thousands separators. Verification compares the values the application
 * reports, not the formatting, so the expected value is computed here and each
 * number on screen is normalised before it is compared.
 */
function displayValues(display: string): string[] {
	return (display.match(/[\d][\d,]*/g) ?? []).map((value) => value.replaceAll(",", ""));
}

/** Reads the display until it stops changing, so a slow render is not read as a wrong answer. */
async function displayText(driver: DesktopDriver, budgetMs = 4000): Promise<string> {
	const started = Date.now();
	let previous = "";
	while (Date.now() - started < budgetMs) {
		const text = (await driver.observe()).data.text.replaceAll("\u200e", "").trim();
		if (text && text === previous) return text;
		previous = text;
		await sleep(250);
	}
	return previous;
}

async function reset(driver: DesktopDriver) {
	const snapshot = await driver.observe();
	// The clear button is "AllClear" before an entry and "Clear" afterwards.
	const clear = snapshot.data.targets.find((target) =>
		/^(AllClear|Clear)$/.test(target.identifier ?? ""),
	);
	if (clear)
		await snapshot.execute("CLICK", clear, undefined, AbortSignal.timeout(5000));
	// Let the display settle so the first press does not race a fresh launch.
	await displayText(driver);
}

async function pressIdentifier(driver: DesktopDriver, identifier: string) {
	// A freshly launched application can expose its controls a moment late, so the
	// lookup is retried before it is treated as a missing control.
	let snapshot = await driver.observe();
	let target = snapshot.data.targets.find(
		(candidate) => candidate.identifier === identifier,
	);
	for (let attempt = 0; !target && attempt < 8; attempt++) {
		await sleep(250);
		snapshot = await driver.observe();
		target = snapshot.data.targets.find((candidate) => candidate.identifier === identifier);
	}
	if (!target)
		throw new Error(
			`no target with identifier ${identifier}; available: ${snapshot.data.targets
				.map((candidate) => candidate.identifier ?? candidate.label)
				.join(", ")}`,
		);
	await snapshot.execute("CLICK", target, undefined, AbortSignal.timeout(5000));
	await sleep(300);
}

export const desktopScenarios: Scenario[] = [
	{
		id: "desktop-calculator-deterministic",
		tier: "desktop",
		category: "capability",
		needsCredentials: false,
		title: "The accessibility driver presses a real application and the arithmetic is verified",
		notes:
			"No model is involved. This measures the driver: whether accessibility identifiers address the right buttons, whether the actions land, and whether the application's own display matches an expected value computed outside it.",
		skip: hostSkipReason,
		async run(context) {
			void context;
			const driver = desktopDriver({ bundleId: BUNDLE });
			try {
				await driver.activate();
				await reset(driver);
				const started = Date.now();
				for (const identifier of SEQUENCE) await pressIdentifier(driver, identifier);
				const elapsedMs = Date.now() - started;
				const display = await displayText(driver);
				return {
					checks: [
						check(
							"the application reports the arithmetic result",
							displayValues(display).includes(EXPECTED),
							`${display} → ${JSON.stringify(displayValues(display))}`,
						),
						check(
							"the display also shows the operands that were pressed",
							["1234", "5678"].every((value) => displayValues(display).includes(value)),
							display,
						),
					],
					metrics: {
						presses: SEQUENCE.length,
						pressMs: elapsedMs,
						display,
						expected: EXPECTED,
					},
				};
			} finally {
				await driver.close();
			}
		},
	},
	{
		id: "desktop-repeat-guard",
		tier: "desktop",
		category: "regression",
		needsCredentials: false,
		title: "Repeated presses that keep changing the application are not treated as stuck",
		notes:
			"Regression for the guard that counted identical actions: pressing one digit six times produced six different displays and was still stopped as repeated_action. A scripted policy is used, so the loop's guard is measured without model variance.",
		skip: hostSkipReason,
		async run(context) {
			void context;
			const driver = desktopDriver({ bundleId: BUNDLE });
			try {
				await driver.activate();
				await reset(driver);
				let calls = 0;
				const policy: JevPolicy = {
					async choose(snapshot) {
						calls++;
						return {
							operation: "CLICK",
							target: snapshot.targets.find((target) => target.identifier === "One"),
							probability: 0.9,
						} as never;
					},
					async text() {
						return { text: null };
					},
				};
				const result = await runJev(
					{ goal: "Press the same digit repeatedly", maxSteps: 6 },
					{ driver, policy },
				);
				const display = await displayText(driver);
				return {
					checks: [
						check("the run was not stopped as a repeat", result.stopReason !== "repeated_action", result.stopReason),
						check("all six presses were executed", calls === 6, `calls=${calls}`),
						check(
							"the display kept advancing, so the presses were progress",
							displayValues(display).includes("1".repeat(6)),
							display,
						),
						check("it ended on the step budget, not on the guard", result.stopReason === "step_limit", result.stopReason),
					],
					metrics: { presses: calls, display, stopReason: result.stopReason },
				};
			} finally {
				await driver.close();
			}
		},
	},
	{
		id: "desktop-calculator-entry",
		tier: "desktop",
		category: "capability",
		needsCredentials: true,
		title: "Jev completes a ten-step entry in a desktop application",
		notes:
			"The working recipe, found with benchmarks/desktop-calibration.ts: a goal that enumerates the steps plus a rules text that makes the next step mechanical. Both were required; neither alone got past a two-press prefix. The goal carries the plan because the decision layer re-derives its position from the window text on every step and does not invent a plan.",
		skip: hostSkipReason,
		async run(context) {
			const driver = desktopDriver({ bundleId: BUNDLE });
			try {
				await driver.activate();
				await reset(driver);
				const result = await runJev(
					{ goal: DESKTOP_GOALS.enumerated, maxSteps: 16 },
					{ driver, policy: context.jev(() => null, DESKTOP_RULES) },
				);
				const display = await displayText(driver);
				const stepTargets = result.steps
					.filter((step) => step.status === "executed")
					.map((step) => String(step.target ?? ""));
				return {
					checks: [
						check(
							"the display shows the requested result",
							displayValues(display).includes(EXPECTED),
							display,
						),
						check("the run did not exhaust its step budget", result.stopReason !== "step_limit", result.stopReason),
						check(
							"no control that undoes the entry was pressed",
							!stepTargets.some((label) => /^(清除|全部清除|刪除|Clear|Delete)$/.test(label)),
							JSON.stringify(stepTargets),
						),
						check("Jev reported DONE", result.stopReason === "model_done", result.stopReason),
					],
					metrics: {
						executedSteps: stepTargets.length,
						stopReason: result.stopReason,
						display,
						expected: EXPECTED,
						loopElapsedMs: result.elapsedMs,
					},
				};
			} finally {
				await driver.close();
			}
		},
	},
	{
		id: "desktop-goal-needs-a-plan",
		tier: "desktop",
		category: "limitation",
		needsCredentials: true,
		documentsGap: true,
		title: "Jev holds an enumerated plan but does not invent one",
		notes:
			"Known gap, asserted on purpose: the same task with a short goal fails. Measured with the calibration tool, the calibrated rules plus a short goal reached a correct prefix of 1 of 10 presses, while the same rules with an enumerated goal reached 10 of 10, so the difference is the plan in the goal and not the rules. The scenario asserts the desired behaviour, so it shows as GAP while the limitation exists and turns into FAIL once the decision layer works out its own plan.",
		skip: hostSkipReason,
		async run(context) {
			const driver = desktopDriver({ bundleId: BUNDLE });
			try {
				await driver.activate();
				await reset(driver);
				const result = await runJev(
					{ goal: DESKTOP_GOALS.short, maxSteps: 16 },
					{ driver, policy: context.jev(() => null, DESKTOP_RULES) },
				);
				const display = await displayText(driver);
				return {
					checks: [
						check(
							"the display shows the requested result from a short goal alone",
							displayValues(display).includes(EXPECTED),
							display,
						),
						check("Jev reported DONE", result.stopReason === "model_done", result.stopReason),
					],
					metrics: {
						executedSteps: result.steps.filter((step) => step.status === "executed").length,
						stopReason: result.stopReason,
						display,
						expected: EXPECTED,
					},
				};
			} finally {
				await driver.close();
			}
		},
	},
];

