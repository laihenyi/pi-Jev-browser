import assert from "node:assert/strict";
import test from "node:test";
import { browserDriver, type Observation } from "../src/observe.ts";
import { configurationError, diagnosticRecord, textOutputError } from "../src/errors.ts";
import { type RunStep, runJev } from "../src/loop.ts";
import { type JevPolicy } from "../src/policy.ts";
import { launchTestBrowser } from "./helpers.ts";

test("browser loop and stale-target guards (offline)", async (t) => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		const fixture = async () =>
			page.setContent(
				`<label>Query <input id="query"></label><button onclick="document.querySelector('#result').textContent = document.querySelector('#query').value">Search</button><p id="result"></p><input type="password" value="secret"><input disabled value="disabled">`,
			);
		await t.test(
			"fills and clicks, records actions, returns DONE as unverified",
			async () => {
				await fixture();
				let calls = 0;
				let textCalls = 0;
				const recorded: RunStep[] = [];
				const policy: JevPolicy = {
					async choose(data) {
						assert.equal(
							data.targets.some(
								(e) => e.value === "secret" || e.value === "disabled",
							),
							false,
						);
						calls++;
						const operation =
							calls === 1 ? "TYPE_TEXT" : calls === 2 ? "CLICK" : "DONE";
						return {
							operation,
							probability: 0.99,
							target: data.targets.find(
								(e) =>
									e.operation === operation &&
									(operation !== "CLICK" || e.label === "Search"),
							),
						};
					},
					async text() {
						textCalls++;
						return { text: "cats" };
					},
				};
				const result = await runJev(
					{ goal: "Search for cats" },
					{
						driver: browserDriver(() => page),
						policy,
						onStep: async (step) => {
							recorded.push(step);
						},
					},
				);
				assert.equal(result.status, "done_unverified");
				assert.equal(await page.locator("#result").textContent(), "cats");
				assert.equal(textCalls, 1);
				assert.deepEqual(
					recorded.map((s) => s.status),
					[
						"decision",
						"attempted",
						"executed",
						"decision",
						"attempted",
						"executed",
						"decision",
					],
				);
			},
		);
		await t.test(
			"stale text decision re-evaluates without executing the stale mutation",
			async () => {
				await fixture();
				let calls = 0;
				const result = await runJev(
					{ goal: "Search" },
					{
						driver: browserDriver(() => page),
						policy: {
							async choose(data) {
								calls++;
								if (calls === 2) return { operation: "BLOCKED" };
								return {
									operation: "TYPE_TEXT",
									target: data.targets.find((e) => e.operation === "TYPE_TEXT"),
									probability: 1,
								};
							},
							async text() {
								await page.locator("#query").fill("changed by user");
								return { text: "cats" };
							},
						},
					},
				);
				assert.equal(result.status, "blocked");
				assert.equal(calls, 2);
				assert.equal(await page.locator("#query").inputValue(), "changed by user");
			},
		);
		await t.test(
			"low probability proceeds by default and history includes typed text and progress",
			async () => {
				await fixture();
				let calls = 0;
				const result = await runJev(
					{ goal: "Search cats" },
					{
						driver: browserDriver(() => page),
						policy: {
							async choose(data, _goal, history) {
								if (calls++ === 0)
									return {
										operation: "TYPE_TEXT",
										probability: 0.1,
										target: data.targets.find(
											(t) => t.operation === "TYPE_TEXT",
										),
									};
								assert.deepEqual(history, [
									{
										action: "Query",
										kind: "TYPE_TEXT",
										text: "cats",
										page_changed: true,
									},
								]);
								return { operation: "DONE" };
							},
							async text() {
								return { text: "cats" };
							},
						},
					},
				);
				assert.equal(result.status, "done_unverified");
			},
		);
		await t.test("stale terminal decisions are re-evaluated", async () => {
			await fixture();
			let calls = 0;
			const result = await runJev(
				{ goal: "Search" },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose() {
							if (calls++ === 0) {
								await page.locator("#query").fill("new");
								return { operation: "DONE" };
							}
							return { operation: "BLOCKED" };
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
				},
			);
			assert.equal(result.status, "blocked");
			assert.equal(calls, 2);
		});
		await t.test(
			"review, uncertainty, limits, and cancellation stop the loop",
			async () => {
				for (const [operation, probability, expected] of [
					["REVIEW", 1, "needs_review"],
					["CLICK", 0.1, "uncertain"],
					["CLICK", undefined, "uncertain"],
					["WAIT", 1, "step_limit"],
				] as const) {
					await fixture();
					const result = await runJev(
						{ goal: "Search", maxSteps: 1, minProbability: 0.6 },
						{
							driver: browserDriver(() => page),
							policy: {
								async choose() {
									return { operation, probability };
								},
								async text() {
									throw new Error("Unexpected helper");
								},
							},
						},
					);
					assert.equal(result.status, expected);
				}
				const controller = new AbortController();
				const result = await runJev(
					{ goal: "Search" },
					{
						driver: browserDriver(() => page),
						signal: controller.signal,
						policy: {
							async choose(data) {
								controller.abort();
								return {
									operation: "CLICK",
									probability: 1,
									target: data.targets.find((e) => e.label === "Search"),
								};
							},
							async text() {
								throw new Error("Unexpected helper");
							},
						},
					},
				);
				assert.equal(result.status, "interrupted");
				assert.equal(result.steps.length, 0);
				assert.equal(result.failure?.category, "cancelled");
			},
		);
		await t.test("invalid input is rejected before any browser read", async () => {
			const policy = {
				async choose() {
					throw new Error("Unexpected decision");
				},
				async text() {
					throw new Error("Unexpected helper");
				},
			} satisfies JevPolicy;
			await assert.rejects(
				runJev({ goal: "   " }, { driver: browserDriver(() => page), policy }),
				/1–12000 characters/,
			);
			await assert.rejects(
				runJev({ goal: "Search", maxSteps: 0 }, { driver: browserDriver(() => page), policy }),
				/1 to 60/,
			);
			await assert.rejects(
				runJev(
					{ goal: "Search", minProbability: 2 },
					{ driver: browserDriver(() => page), policy },
				),
				/0 to 1/,
			);
		});
		await t.test("configuration failures are surfaced, provider failures are not", async () => {
			await fixture();
			const configuration = await runJev(
				{ goal: "Search" },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose() {
							throw configurationError(
								"The jev_run Jev loop requires TYPESAFE_API_KEY.",
							);
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
				},
			);
			assert.equal(configuration.status, "interrupted");
			assert.equal(configuration.failure?.category, "configuration");
			assert.match(configuration.message, /TYPESAFE_API_KEY/);
			assert.equal(
				configuration.failure?.detail,
				"JevConfigurationError: The jev_run Jev loop requires TYPESAFE_API_KEY.",
			);

			const badTextOutput = await runJev(
				{ goal: "Search" },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose(data) {
							return {
								operation: "TYPE_TEXT",
								target: data.targets.find((t) => t.operation === "TYPE_TEXT"),
							};
						},
						async text() {
							// This is what createJevPolicy throws when parseText rejects the
							// helper output, so nothing is typed.
							throw textOutputError(
								"Text helper returned output that is not JSON; nothing typed.",
							);
						},
					},
				},
			);
			assert.equal(badTextOutput.status, "interrupted");
			assert.equal(
				badTextOutput.failure?.category,
				"text_helper_invalid_output",
			);
			assert.match(badTextOutput.message, /not JSON/);
			assert.equal(await page.locator("#query").inputValue(), "");

			const provider = await runJev(
				{ goal: "Search" },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose() {
							throw new Error(
								"400 invalid request: state contained sk-live-secret-token",
							);
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
				},
			);
			assert.equal(provider.failure?.category, "unexpected_error");
			assert.doesNotMatch(provider.message, /sk-live-secret-token/);
			assert.equal(provider.failure?.detail, "Error");
			assert.match(provider.message, /errors\.log/);
			const recorded: Array<{ stage: string; error: unknown }> = [];
			const logged = await runJev(
				{ goal: "Search" },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose() {
							throw new Error("400 invalid request: state contained sk-live-secret-token");
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
					onFailure: (error, stage) => {
						recorded.push({ stage, error });
					},
				},
			);
			assert.equal(logged.failure?.category, "unexpected_error");
			assert.equal(recorded.length, 1);
			assert.equal(recorded[0].stage, "evaluation");
			assert.match(String((recorded[0].error as Error).message), /sk-live-secret-token/);
			assert.equal(
				JSON.parse(diagnosticRecord(recorded[0].error as Error, { stage: recorded[0].stage })).stage,
				"evaluation",
			);
		});
		await t.test(
			"text-helper usage is aggregated into the run result",
			async () => {
				await fixture();
				let calls = 0;
				const result = await runJev(
					{ goal: "Search cats" },
					{
						driver: browserDriver(() => page),
						policy: {
							async choose(data) {
								if (calls++ === 0)
									return {
										operation: "TYPE_TEXT",
										target: data.targets.find((t) => t.operation === "TYPE_TEXT"),
									};
								return { operation: "DONE" };
							},
							async text() {
								return {
									text: "cats",
									usage: {
										input: 10,
										output: 4,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 14,
										cost: {
											input: 0.1,
											output: 0.2,
											cacheRead: 0,
											cacheWrite: 0,
											total: 0.3,
										},
									},
								};
							},
						},
					},
				);
				assert.equal(result.status, "done_unverified");
				assert.equal(result.usage?.totalTokens, 14);
				assert.equal(result.usage?.cost.total, 0.3);
			},
		);
	} finally {
		await browser.close();
	}
});

test("a declined field value returns control instead of failing the run", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent('<label>Query <input id="query"></label>');
		const result = await runJev(
			{ goal: "Search for cats" },
			{
				driver: browserDriver(() => page),
				policy: {
					async choose(data) {
						return {
							operation: "TYPE_TEXT",
							target: data.targets.find((t) => t.operation === "TYPE_TEXT"),
						};
					},
					// createJevPolicy returns null text when the helper answers {"text":null}.
					async text() {
						return { text: null };
					},
				},
			},
		);
		assert.equal(result.status, "needs_review");
		assert.equal(result.stopReason, "text_unavailable");
		assert.match(result.message, /declined/);
		assert.match(result.message, /jev_actions/);
		assert.equal(await page.locator("#query").inputValue(), "");
		assert.equal(result.steps.length, 0);
		assert.equal(result.failure, undefined);
	} finally {
		await browser.close();
	}
});

test("repeated identical actions and repeated stale reads stop the loop early", async (t) => {
	await t.test("a control that changes nothing twice is withdrawn from the question", async () => {
		const browser = await launchTestBrowser();
		try {
			const page = await browser.newPage();
			// Clicking a plain button changes nothing the observation can see, so the
			// goal never advances. After two such presses the button is no longer
			// offered, and a policy left with nothing to press says so.
			await page.setContent('<button id="b">Toggle</button>');
			const offered: string[][] = [];
			const result = await runJev(
				{ goal: "Open the widget", maxSteps: 20 },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose(data) {
							offered.push(data.targets.map((target) => target.label));
							const target = data.targets.find((target) => target.label === "Toggle");
							return target ? { operation: "CLICK", target } : { operation: "BLOCKED" };
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
				},
			);
			assert.deepEqual(offered, [["Toggle"], ["Toggle"], []]);
			assert.equal(result.status, "blocked");
			assert.equal(result.stopReason, "model_blocked");
			assert.equal(
				result.steps.filter((step) => step.status === "executed").length,
				2,
				"the third press never happens; the control was withdrawn instead",
			);
		} finally {
			await browser.close();
		}
	});

	await t.test("repeated scrolls are not treated as a stuck action", async () => {
		const browser = await launchTestBrowser();
		try {
			const page = await browser.newPage();
			await page.setContent(
				`<div style="height:4000px"></div><p>bottom</p><button id="end">End</button>`,
			);
			let calls = 0;
			const result = await runJev(
				{ goal: "Reach the bottom", maxSteps: 6 },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose() {
							calls++;
							return calls <= 5
								? { operation: "SCROLL_DOWN" }
								: { operation: "BLOCKED" };
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
				},
			);
			assert.equal(calls, 6);
			assert.equal(result.stopReason, "model_blocked");
			assert.equal(
				result.steps.filter((step) => step.status === "executed").length,
				5,
			);
		} finally {
			await browser.close();
		}
	});

	await t.test("four consecutive invalid observations are blocked", async () => {
		const browser = await launchTestBrowser();
		try {
			const page = await browser.newPage();
			await page.setContent('<label>Query <input id="q"></label>');
			let calls = 0;
			const result = await runJev(
				{ goal: "Fill the query", maxSteps: 20 },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose(data) {
							calls++;
							// Change the page between the observation and the action, which is what
							// a re-rendering widget does, so every freshness check fails.
							await page.locator("#q").fill(`tick ${calls}`);
							return {
								operation: "TYPE_TEXT",
								target: data.targets.find(
									(target) => target.operation === "TYPE_TEXT",
								),
							};
						},
						async text() {
							throw new Error("Unexpected helper");
						},
					},
				},
			);
			assert.equal(result.status, "blocked");
			assert.equal(result.stopReason, "stale_observations");
			assert.equal(calls, 4);
			assert.equal(
				result.steps.filter((step) => step.status === "executed").length,
				0,
			);
			assert.ok(result.elapsedMs < 20_000, "must not burn the whole budget");
		} finally {
			await browser.close();
		}
	});
});

test("a DONE decision is rejected while the page is still rendering", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		// A loading shell: page chrome is present and stable, the price arrives later.
		await page.setContent(
			'<nav>Filters</nav><p>Prices exclude baggage.</p><div id="results"></div>',
		);
		setTimeout(() => {
			void page.evaluate(() => {
				const target = document.querySelector("#results");
				if (target) target.textContent = "最低價格 $30,461 起";
			});
		}, 250);
		let calls = 0;
		const emitted: RunStep[] = [];
		const result = await runJev(
			{ goal: "Read the lowest fare" },
			{
				driver: browserDriver(() => page),
				onStep: async (step) => {
					emitted.push(step);
				},
				policy: {
					async choose(data) {
						calls++;
						// The helper is asked to stop as soon as it sees page text at all.
						return { operation: "DONE", probability: 0.99 };
					},
					async text() {
						throw new Error("Unexpected helper");
					},
				},
			},
		);
		// DONE was chosen once per observation, so the retry means the loop re-read
		// the page instead of accepting the loading shell.
		assert.equal(calls, 2);
		assert.equal(result.status, "done_unverified");
		assert.match(String(result.page?.text), /最低價格/);
		assert.equal(result.warnings, undefined);
		assert.ok(
			emitted.some(
				(step) =>
					step.status === "stale" && step.reason === "page_changed_before_done",
			),
			"the rejected DONE must be visible in the trace",
		);
	} finally {
		await browser.close();
	}
});

test("a page that never settles accepts DONE with a warning", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent('<p id="ticker">0</p>');
		// A live counter changes the observation on every read.
		await page.evaluate(() => {
			let count = 0;
			setInterval(() => {
				const target = document.querySelector("#ticker");
				if (target) target.textContent = String(++count);
			}, 50);
		});
		let calls = 0;
		const result = await runJev(
			{ goal: "Read the counter" },
			{
				driver: browserDriver(() => page),
				policy: {
					async choose() {
						calls++;
						return { operation: "DONE", probability: 1 };
					},
					async text() {
						throw new Error("Unexpected helper");
					},
				},
			},
		);
		assert.equal(result.status, "done_unverified");
		assert.deepEqual(result.warnings, ["page_changed_during_done_check"]);
		// Bounded: original decision plus the two allowed settle retries.
		assert.equal(calls, 3);
	} finally {
		await browser.close();
	}
});

test("alternating scroll directions stop the run instead of burning the budget", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		// Taller than the viewport so a scroll is a legal action in both directions.
		await page.setContent(
			'<h1>Tall page</h1><div style="height:6000px">body</div>',
		);
		let calls = 0;
		const result = await runJev(
			{ goal: "Find a control that this page does not have", maxSteps: 12 },
			{
				driver: browserDriver(() => page),
				policy: {
					async choose() {
						calls++;
						return {
							operation: calls % 2 === 1 ? "SCROLL_DOWN" : "SCROLL_UP",
						};
					},
					async text() {
						throw new Error("Unexpected helper");
					},
				},
			},
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.stopReason, "scroll_oscillation");
		// One direction change per extra scroll: five scrolls, four reversals.
		assert.equal(calls, 5);
		assert.equal(result.steps.filter((s) => s.status === "executed").length, 5);
	} finally {
		await browser.close();
	}
});

test("a one-direction scroll sweep is not mistaken for oscillation", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent(
			'<h1>Tall page</h1><div style="height:6000px">body</div>',
		);
		let calls = 0;
		const result = await runJev(
			{ goal: "Read the bottom of the page", maxSteps: 6 },
			{
				driver: browserDriver(() => page),
				policy: {
					async choose() {
						calls++;
						return { operation: "SCROLL_DOWN" };
					},
					async text() {
						throw new Error("Unexpected helper");
					},
				},
			},
		);
		// The step budget ends the run, not the oscillation guard.
		assert.equal(result.stopReason, "step_limit");
		assert.equal(calls, 6);
	} finally {
		await browser.close();
	}
});

test("no observable progress over three different actions stops the run", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		// Three different inert controls: the action key changes every time, so only
		// the page-progress guard can catch this.
		await page.setContent(
			"<button>Alpha</button><button>Beta</button><button>Gamma</button>",
		);
		let calls = 0;
		const observed: Observation[] = [];
		const labels = ["Alpha", "Beta", "Gamma"];
		const result = await runJev(
			{ goal: "Search", maxSteps: 10 },
			{
				driver: browserDriver(() => page),
				policy: {
					async choose(data) {
						observed.push(data);
						const label = labels[calls++];
						return {
							operation: "CLICK",
							target: data.targets.find((t) => t.label === label),
						};
					},
					async text() {
						throw new Error("Unexpected helper");
					},
				},
			},
		);
		assert.equal(result.status, "blocked");
		assert.equal(result.stopReason, "no_progress");
		assert.equal(calls, 3);
		assert.equal(result.steps.filter((s) => s.status === "executed").length, 3);
		assert.equal(observed.length, 3);
	} finally {
		await browser.close();
	}
});
