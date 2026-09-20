import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, workingDir } from "./env.ts";
import { AGENT_DIR, readConfig, readConfigFile } from "../../src/config.ts";
import type { RunStep } from "../../src/loop.ts";
import type { JevPolicy } from "../../src/policy.ts";
import { createJevPolicy } from "../../src/policy.ts";
import { PiBrowserManager } from "../../src/runtime.ts";
import { startFixtures, type FixtureServer } from "./fixtures.ts";

export type Tier = "local" | "model" | "live" | "desktop";
export type Category = "regression" | "capability" | "limitation";

export interface Check {
	name: string;
	passed: boolean;
	detail?: string;
}

export interface ScenarioOutcome {
	checks: Check[];
	metrics?: Record<string, number | string | null>;
}

export interface Scenario {
	id: string;
	tier: Tier;
	category: Category;
	title: string;
	/** What a failure means, and what the scenario deliberately does not test. */
	notes: string;
	/** True when "passing" means the documented gap is still present. */
	documentsGap?: boolean;
	/**
	 * False when the scenario never calls a model, so it can run without a
	 * credential. Defaults to true for every tier except `local`.
	 */
	needsCredentials?: boolean;
	/** Returns a reason to skip when the host cannot run this scenario at all. */
	skip?(context: ScenarioContext): Promise<string | undefined> | string | undefined;
	run(context: ScenarioContext): Promise<ScenarioOutcome>;
}

export interface ScenarioContext {
	fixtures: FixtureServer;
	/** Rewrite the benchmark config before the next tool call. */
	configure(patch: Record<string, unknown>): void;
	manager(): PiBrowserManager;
	/** Jev policy backed by a scripted text helper, so no pi model is required. */
	jev(
		answerFor: (goal: string) => string | null,
		rules?: string,
		options?: { planning?: boolean },
	): JevPolicy;
	outputDir: string;
	hasCredentials: boolean;
}

export interface ScenarioResult {
	id: string;
	tier: Tier;
	category: Category;
	title: string;
	status: "passed" | "failed" | "skipped";
	checks: Check[];
	metrics: Record<string, number | string | null>;
	elapsedMs: number;
	error?: string;
}

/**
 * The runtime reads PI_JEV_BROWSER_CONFIG once, but re-reads the file on every call,
 * so one benchmark-owned file can hold per-scenario settings. env.ts sets that
 * path before config.ts is imported.
 */

/** Model settings come from the user's normal config; the benchmark only overrides browser policy. */
function modelSettings() {
	try {
		const raw = readConfigFile(join(AGENT_DIR, "pi-jev-browser.config.json"));
		return {
			typesafe: raw.typesafe as Record<string, unknown> | undefined,
			textHelper: raw.textHelper as Record<string, unknown> | undefined,
		};
	} catch {
		return { typesafe: undefined, textHelper: undefined };
	}
}

export function hasCredentials() {
	const settings = modelSettings().typesafe;
	return Boolean(
		process.env.TYPESAFE_API_KEY?.trim() ||
			(typeof settings?.apiKey === "string" && settings.apiKey.trim()),
	);
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
	const started = Date.now();
	const fixtures = await startFixtures();
	const outputDir = join(workingDir, scenario.id);
	const managers: PiBrowserManager[] = [];
	let current: Record<string, unknown> = {
		outputDir,
		recordVideo: false,
		headless: true,
		showCursor: false,
		showClickIndicators: false,
		allowedOrigins: ["http://127.0.0.1:*"],
		profile: "off",
		popups: "stay",
	};
	const write = () => writeFileSync(configPath, JSON.stringify(current));
	write();
	// Fail loudly if the runtime is still reading a different file, because every
	// scenario below depends on its own browser policy.
	const effective = readConfig();
	if (effective.outputDir !== outputDir)
		throw new Error(
			`Benchmark config was ignored: runtime read outputDir ${effective.outputDir}. Check PI_JEV_BROWSER_CONFIG handling.`,
		);
	const context: ScenarioContext = {
		fixtures,
		outputDir,
		hasCredentials: hasCredentials(),
		configure(patch) {
			current = { ...current, ...patch };
			write();
		},
		manager() {
			const manager = new PiBrowserManager();
			managers.push(manager);
			return manager;
		},
		jev(answerFor, rules, options) {
			const settings = modelSettings();
			return createJevPolicy({
				rules,
				planning: options?.planning === true,
				credentials: process.env.TYPESAFE_API_KEY
					? undefined
					: settings.typesafe
						? ({
								apiKey: settings.typesafe.apiKey,
								baseUrl: settings.typesafe.baseUrl,
								model: settings.typesafe.model,
							} as never)
						: undefined,
				// A text generator returns the raw model output, which the policy parses as
				// JSON, so the scripted helper has to speak the same protocol.
				text: async (_input) => {
					const answer = answerFor(_input.prompt);
					return {
						text:
							answer === null
								? '{"text":null}'
								: JSON.stringify({ text: answer }),
					};
				},
			});
		},
	};

	try {
		const reason = await scenario.skip?.(context);
		if (reason)
			return {
				id: scenario.id,
				tier: scenario.tier,
				category: scenario.category,
				title: scenario.title,
				status: "skipped",
				checks: [],
				metrics: {},
				elapsedMs: Date.now() - started,
				error: reason,
			};
		const outcome = await scenario.run(context);
		const passed = outcome.checks.every((check) => check.passed);
		return {
			id: scenario.id,
			tier: scenario.tier,
			category: scenario.category,
			title: scenario.title,
			// A limitation scenario passes when the documented gap is still there.
			status: (scenario.documentsGap ? !passed : passed) ? "passed" : "failed",
			checks: outcome.checks,
			metrics: outcome.metrics ?? {},
			elapsedMs: Date.now() - started,
		};
	} catch (error) {
		return {
			id: scenario.id,
			tier: scenario.tier,
			category: scenario.category,
			title: scenario.title,
			status: "failed",
			checks: [{ name: "scenario completed", passed: false }],
			metrics: {},
			elapsedMs: Date.now() - started,
			error: error instanceof Error ? error.message.split("\n")[0] : String(error),
		};
	} finally {
		for (const manager of managers) await manager.stopAll().catch(() => undefined);
		await fixtures.close().catch(() => undefined);
	}
}

export async function cleanupHarness() {
	rmSync(workingDir, { recursive: true, force: true });
}

export const check = (
	name: string,
	passed: boolean,
	detail?: unknown,
): Check => ({
	name,
	passed,
	detail: detail === undefined ? undefined : String(detail).slice(0, 200),
});

export function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return Math.round(sorted[Math.floor(sorted.length / 2)]);
}

/**
 * Records every loop step for a scenario that drives `runJev` itself (the desktop
 * tier has no manager writing a trace). A failed run then says what was pressed,
 * instead of leaving only the application's final state to reason from.
 */
export function stepRecorder(outputDir: string, name: string) {
	const steps: RunStep[] = [];
	const tracePath = join(outputDir, `${name}.trace.jsonl`);
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(tracePath, "");
	return {
		steps,
		tracePath,
		async onStep(step: RunStep) {
			steps.push(step);
			appendFileSync(tracePath, `${JSON.stringify(step)}\n`);
		},
		/** Executed targets in order, for a metric that survives the run's own summary. */
		executed: () =>
			steps
				.filter((step) => step.status === "executed")
				.map((step) => `${step.operation}:${step.target ?? ""}`),
	};
}

/** The live session behind a host key, for verification and DOM assertions. */
export function sessionOf(
	manager: PiBrowserManager,
	host: { sessionId: string },
) {
	return (
		manager as unknown as {
			requireSession: (h: unknown) => {
				page: import("playwright").Page;
				context: import("playwright").BrowserContext;
			};
		}
	).requireSession(host);
}

/** A policy that stops immediately; used when a scenario only needs a browser. */
export const idlePolicy = {
	async choose() {
		return { operation: "DONE" };
	},
	async text() {
		return { text: null };
	},
} as never;
