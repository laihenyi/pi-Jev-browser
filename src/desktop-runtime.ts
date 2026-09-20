import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
	defaultHelperPath,
	desktopDriver,
	DESKTOP_RULES,
	type DesktopDriver,
} from "./drivers/desktop.ts";
import { configurationError, diagnosticRecord } from "./errors.ts";
import { runJev, type RunInput, type RunStep } from "./loop.ts";
import type { JevPolicy } from "./policy.ts";
import type { PiBrowserConfig, ToolHost } from "./types.ts";

/**
 * The desktop counterpart of PiBrowserManager.run: the same decision loop, driven
 * through the macOS accessibility tree instead of a browser.
 *
 * Everything that makes this safe to expose as a tool lives here rather than in
 * the driver: the platform and helper checks that turn a missing prerequisite into
 * a setup message and the Accessibility-permission check. Any installed
 * application can be driven, as with computer use; confirmation is the
 * extension's job, because it needs the UI.
 */

const execFileAsync = promisify(execFile);

export interface DesktopRunInput extends RunInput {
	bundleId: string;
	/** Start the application if it is not running. Off by default. */
	launch?: boolean;
	/** Bring the application to the front before the run. On by default. */
	activate?: boolean;
	/** Plan the steps from the first observation before acting. On by default. */
	plan?: boolean;
}

export interface DesktopRuntimeOptions {
	helperPath?: string;
	/** Overridable for tests; the real check is process.platform. */
	platform?: NodeJS.Platform;
}

/** Everything a caller needs to check before the run exists, without a helper process. */
export function assertDesktopPrerequisites(
	input: Pick<DesktopRunInput, "bundleId">,
	config: PiBrowserConfig,
	options: DesktopRuntimeOptions = {},
) {
	if ((options.platform ?? process.platform) !== "darwin")
		throw configurationError(
			"jev_desktop drives macOS applications through the accessibility tree and is only available on macOS.",
		);
	const helperPath = options.helperPath ?? defaultHelperPath();
	if (!existsSync(helperPath))
		throw configurationError(
			`The accessibility helper is not built. Run: npm run build:ax-helper (expected ${helperPath}).`,
		);
	if (!/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(input.bundleId))
		throw configurationError(
			`"${input.bundleId}" is not a bundle id. Use the reverse-DNS form, for example com.apple.calculator.`,
		);
	return helperPath;
}

async function isRunning(driver: DesktopDriver, bundleId: string) {
	const response = await driver.call({ cmd: "instance", bundleId });
	return response.ok === true;
}

/**
 * A process exists well before its first window does: Word, for one, spends
 * seconds between launch and its template gallery. After a cold start the run
 * waits for a window, so the first observation is of the application and not of
 * the gap. An application that was already running is not waited for: no window
 * there is a real state the loop reports as window_unavailable.
 */
export async function waitForWindow(
	driver: Pick<DesktopDriver, "call">,
	bundleId: string,
	deadlineMs = 30_000,
	intervalMs = 250,
): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		const response = await driver.call({ cmd: "observe", bundleId });
		if (response.ok === true) return true;
		if (!/no window|not responding|still launching/i.test(String(response.error)))
			return false;
		if (Date.now() >= deadline) return false;
		await sleep(intervalMs);
	}
}

export async function runDesktop(
	input: DesktopRunInput,
	host: ToolHost,
	policy: JevPolicy,
	config: PiBrowserConfig,
	options: DesktopRuntimeOptions = {},
) {
	const helperPath = assertDesktopPrerequisites(input, config, options);
	const driver = desktopDriver({ bundleId: input.bundleId, helperPath });
	const outputDir = join(config.outputDir, "desktop");
	await mkdir(outputDir, { recursive: true });
	const tracePath = join(outputDir, `${input.bundleId}-${randomUUID()}.jsonl`);
	const errorsLogPath = join(outputDir, "errors.log");
	try {
		const { trusted } = await driver.ping();
		if (!trusted)
			throw configurationError(
				"This process is not trusted for Accessibility. Grant it in System Settings › Privacy & Security › Accessibility (the terminal or application that runs pi), then try again.",
			);
		if (!(await isRunning(driver, input.bundleId))) {
			if (!input.launch)
				throw configurationError(
					`${input.bundleId} is not running. Start it, or call again with launch: true.`,
				);
			await execFileAsync("open", ["-b", input.bundleId]);
			// A browser's cold start can take well over ten seconds on a busy machine.
			for (let attempt = 0; attempt < 120 && !(await isRunning(driver, input.bundleId)); attempt++)
				await sleep(250);
			if (!(await isRunning(driver, input.bundleId)))
				throw configurationError(`${input.bundleId} did not start within 30 seconds.`);
			if (!(await waitForWindow(driver, input.bundleId)))
				throw configurationError(
					`${input.bundleId} started but showed no window within 30 seconds. Open a window in it, then try again.`,
				);
		}
		if (input.activate !== false) await driver.activate();
		host.onEvent?.("desktop-start", { bundleId: input.bundleId });
		const result = await runJev(
			{
				goal: input.goal,
				maxSteps: input.maxSteps,
				minProbability: input.minProbability,
				timeoutMs: input.timeoutMs,
			},
			{
				driver,
				policy,
				signal: host.signal,
				onStep: async (step: RunStep) => {
					await appendFile(tracePath, `${JSON.stringify(step)}\n`);
					host.onEvent?.("jev-step", step);
				},
				onFailure: async (error, stage) => {
					await appendFile(errorsLogPath, `${diagnosticRecord(error, { stage })}\n`);
				},
			},
		);
		await appendFile(tracePath, `${JSON.stringify({ type: "result", ...result })}\n`);
		// The freshest window state, so the agent verifies against what is there now.
		let window: { title: string; text: string; targets: number } | undefined;
		try {
			const snapshot = await driver.observe();
			window = {
				title: snapshot.data.title,
				text: snapshot.data.text,
				targets: snapshot.data.targets.length,
			};
		} catch {
			/* the application may have closed during the run; the result says so */
		}
		return {
			...result,
			bundleId: input.bundleId,
			tracePath,
			errorsLogPath: result.failure ? errorsLogPath : undefined,
			window,
		};
	} finally {
		await driver.close();
	}
}

/** The rules and planning setting the desktop tool runs with. */
export const DESKTOP_POLICY_OPTIONS = { rules: DESKTOP_RULES } as const;
