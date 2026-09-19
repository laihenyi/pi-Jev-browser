import { extractFromPage } from "../../src/extract.ts";
import { runJev } from "../../src/loop.ts";
import { browserDriver } from "../../src/observe.ts";
import { check, idlePolicy, sessionOf, type Scenario } from "../lib/harness.ts";

const allowAll = { assertUrlAllowed: () => undefined };

/** Narrow the manager state union once, so scenario assertions stay readable. */
const activeState = (state: unknown) =>
	state as {
		currentUrl: string;
		activePageIndex: number;
		pages: Array<{ url: string }>;
	};

export const localScenarios: Scenario[] = [
	{
		id: "manual-selectors",
		tier: "local",
		category: "regression",
		title: "Selector layer targets elements by role, name and label",
		notes:
			"Verifies the deterministic execution layer, not Jev. The form submit is confirmed server-side, so a click that never dispatched cannot pass.",
		async run(context) {
			const manager = context.manager();
			const host = { sessionId: "bench-selectors" };
			await manager.run(
				{ url: context.fixtures.url, goal: "Open the fixture home page." },
				host,
				idlePolicy,
			);
			const { page } = sessionOf(manager, host);

			await manager.actions(
				{
					actions: [
						{
							type: "fill",
							target: { role: "textbox", name: "Search query" },
							value: "zebra",
						},
						{ type: "select", target: { role: "combobox", name: "Tier" }, value: "pro" },
					],
					includeScreenshot: false,
				},
				host,
			);
			const filled = await page.inputValue("#q");
			const selected = await page.inputValue("#tier");

			await manager.actions(
				{ actions: [{ type: "click", target: { role: "button", name: "Search" } }], includeScreenshot: false },
				host,
			);
			await page.waitForLoadState("domcontentloaded").catch(() => undefined);
			const submitted = context.fixtures.requests.filter((path) =>
				path.startsWith("/result"),
			);

			await manager.actions(
				{ actions: [{ type: "click", target: { role: "link", name: "Alpha" } }], includeScreenshot: false },
				host,
			);
			await page.waitForLoadState("domcontentloaded").catch(() => undefined);

			return {
				checks: [
					check("fill writes the requested value", filled === "zebra", filled),
					check("select chooses the requested option", selected === "pro", selected),
					check(
						"clicking submit reached the server with the typed query",
						submitted.some((path) => path.includes("q=zebra")),
						JSON.stringify(submitted),
					),
					check(
						"click by role=link navigated to the link target",
						page.url().endsWith("/nav/one"),
						page.url(),
					),
				],
			};
		},
	},
	{
		id: "manual-extract",
		tier: "local",
		category: "capability",
		title: "jev_extract reads text, tables, links and attributes",
		notes:
			"Deterministic read with no model call. Assertions compare exact values, so a partial or hallucinated read fails.",
		async run(context) {
			const manager = context.manager();
			const host = { sessionId: "bench-extract" };
			await manager.run(
				{ url: context.fixtures.url, goal: "Open the fixture home page." },
				host,
				idlePolicy,
			);
			const { page } = sessionOf(manager, host);

			const text = await extractFromPage(page, { selector: "#row" });
			const table = await extractFromPage(page, { kind: "table", selector: "#plan" });
			const links = await extractFromPage(page, { kind: "links", selector: "nav a" });
			const attribute = await extractFromPage(page, {
				kind: "attributes",
				selector: "#row",
				attribute: "data-code",
			});

			return {
				checks: [
					check(
						"text kind returns the element text",
						JSON.stringify(text.items) === '["Row one"]',
						JSON.stringify(text.items),
					),
					check(
						"table kind returns rows of cells",
						JSON.stringify(table.items) ===
							'[["Plan","Seats"],["Starter","5"],["Team","25"]]',
						JSON.stringify(table.items),
					),
					check("links kind returns every nav link", links.count === 5, links.count),
					check(
						"attributes kind returns the attribute value",
						JSON.stringify(attribute.items) === '["A-1"]',
						JSON.stringify(attribute.items),
					),
				],
			};
		},
	},
	{
		id: "manual-frame-audit",
		tier: "local",
		category: "regression",
		title: "A coordinate click that lands in a frame is recorded and the click reaches the frame",
		notes:
			"Two things are asserted: the frame origin is reported, and the click really did cross into the frame. Reporting a frame hit without the click landing would be a false positive.",
		async run(context) {
			const manager = context.manager();
			const host = { sessionId: "bench-frame" };
			await manager.run(
				{ url: context.fixtures.url, goal: "Open the fixture home page." },
				host,
				idlePolicy,
			);
			const { page } = sessionOf(manager, host);

			const box = await page.locator("iframe").boundingBox();
			if (!box) throw new Error("the fixture iframe is missing; this scenario cannot run");
			const result = await manager.actions(
				{
					actions: [
						{
							type: "click",
							x: Math.round(box.x + box.width / 2),
							y: Math.round(box.y + box.height / 2),
						},
					],
					includeScreenshot: false,
				},
				host,
			);
			const inner = page.frames().find((frame) => frame.url().includes("/inner"));
			const innerClicked = inner
				? await inner.evaluate(
						() =>
							Boolean((window as unknown as { __innerClicked?: boolean }).__innerClicked),
					)
				: false;
			const logs = manager.logs({}, host);
			const security = logs.logs.filter((entry) => entry.type === "security");
			const warnings = "warnings" in result ? (result.warnings ?? []) : [];

			return {
				checks: [
					check("frame origin reported in warnings", warnings.some((line) => /landed inside a frame/.test(line)), warnings[0]),
					check("warning names the fixture origin", warnings.some((line) => line.includes(context.fixtures.url)), context.fixtures.url),
					check("a security log entry was written", security.length === 1, security.length),
					check("the click actually reached the frame", innerClicked, innerClicked),
					check("a non-frame click stays unreported", await (async () => {
						const plain = await manager.actions(
							{ actions: [{ type: "click", x: 5, y: 5 }], includeScreenshot: false },
							host,
						);
						return "warnings" in plain ? (plain.warnings ?? []).length === 0 : false;
					})(), "click at (5,5)"),
				],
			};
		},
	},
	{
		id: "manual-popup-stay",
		tier: "local",
		category: "regression",
		title: "A new tab is reported and never hijacks the observed page",
		notes:
			"Regression for the bug where any popup silently became the observed page. Also checks that the agent can move tabs deliberately.",
		async run(context) {
			context.configure({ popups: "stay" });
			const manager = context.manager();
			const host = { sessionId: "bench-popup" };
			await manager.run(
				{ url: context.fixtures.url, goal: "Open the fixture home page." },
				host,
				idlePolicy,
			);

			const result = await manager.actions(
				{ actions: [{ type: "click", target: { role: "link", name: "Outbound" } }], includeScreenshot: false },
				host,
			);
			for (let attempt = 0; attempt < 30; attempt++) {
				if ((await manager.state(host)).pages.length >= 2) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			const state = activeState(await manager.state(host));
			const warnings = "warnings" in result ? (result.warnings ?? []) : [];
			const activated = await manager.actions(
				{ actions: [{ type: "activate_tab", index: 1 }], includeScreenshot: false },
				host,
			);

			return {
				checks: [
					check("popup reported", warnings.some((line) => /A new tab opened/.test(line)), warnings[0]),
					check("result states the run stayed put", warnings.some((line) => /kept observing/.test(line))),
					check("two tabs are open", state.pages.length === 2, state.pages.length),
					check(
						"observed page is still the first tab",
						state.activePageIndex === 0 && state.currentUrl === `${context.fixtures.url}/`,
						`index=${state.activePageIndex} url=${state.currentUrl}`,
					),
					check(
						"activate_tab moves the observed page on request",
						activated.state.currentUrl === `${context.fixtures.url}/outbound`,
						activated.state.currentUrl,
					),
					check(
						"tab switches are logged",
						manager.logs({}, host).logs.some((entry) => entry.type === "tab"),
					),
				],
			};
		},
	},
	{
		id: "manual-deny-origin",
		tier: "local",
		category: "regression",
		title: "denyOrigins blocks navigation before Chromium starts",
		notes: "A deny rule must win over allowedOrigins and must not require a browser launch.",
		async run(context) {
			context.configure({
				allowedOrigins: ["http://127.0.0.1:*"],
				denyOrigins: [`${context.fixtures.url}`],
			});
			const manager = context.manager();
			const start = Date.now();
			let message = "";
			try {
				await manager.run(
					{ url: `${context.fixtures.url}/`, goal: "Open the fixture home page." },
					{ sessionId: "bench-deny" },
					idlePolicy,
				);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			return {
				checks: [
					check("navigation refused", /denyOrigins/.test(message), message),
					check("refused quickly, so no browser was launched", Date.now() - start < 3000, `${Date.now() - start}ms`),
				],
			};
		},
	},
	{
		id: "session-profile",
		tier: "local",
		category: "regression",
		title: "A session profile keeps a persistent cookie across browser restarts",
		notes:
			"Uses a cookie with an expiry: a session cookie would be dropped by Chromium by design and would prove nothing.",
		async run(context) {
			context.configure({ profile: "session" });
			const manager = context.manager();
			const host = { sessionId: "bench-profile" };
			await manager.run(
				{ url: context.fixtures.url, goal: "Open the fixture home page." },
				host,
				idlePolicy,
			);
			await sessionOf(manager, host).context.addCookies([
				{
					name: "bench-persist",
					value: "kept",
					url: context.fixtures.url,
					expires: Math.floor(Date.now() / 1000) + 3600,
				},
			]);
			await manager.stop(host);
			await manager.run(
				{ url: context.fixtures.url, goal: "Open the fixture home page." },
				host,
				idlePolicy,
			);
			const cookies = await sessionOf(manager, host).context.cookies(context.fixtures.url);
			return {
				checks: [
					check(
						"persistent cookie survived the restart",
						cookies.some((cookie) => cookie.name === "bench-persist"),
						cookies.map((cookie) => cookie.name).join(","),
					),
				],
			};
		},
	},
	{
		id: "loop-scroll-oscillation",
		tier: "local",
		category: "regression",
		title: "Alternating scroll directions stop the loop instead of burning the budget",
		notes:
			"Uses a scripted policy so the guard itself is measured. Before the fix this burned 10+ steps to step_limit.",
		async run(context) {
			const manager = context.manager();
			const host = { sessionId: "bench-oscillation" };
			await manager.run(
				{ url: context.fixtures.url, goal: "Read the bottom of the page." },
				host,
				idlePolicy,
			);
			const { page } = sessionOf(manager, host);
			let calls = 0;
			const result = await runJev(
				{ goal: "Find a control that does not exist on this page.", maxSteps: 12 },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose() {
							calls++;
							return {
								operation: calls % 2 === 1 ? "SCROLL_DOWN" : "SCROLL_UP",
							} as never;
						},
						async text() {
							return { text: null };
						},
					},
				},
			);
			return {
				checks: [
					check("stopped on the oscillation guard", result.stopReason === "scroll_oscillation", result.stopReason),
					check("stopped after five scrolls, not at the budget", calls === 5, `calls=${calls}`),
				],
				metrics: { scrolls: calls, elapsedMs: result.elapsedMs },
			};
		},
	},
	{
		id: "loop-no-progress",
		tier: "local",
		category: "regression",
		title: "Three different inert actions stop the loop as no_progress",
		notes:
			"Each click targets a different control, so only the page-progress guard can catch it; the repeated-action guard cannot.",
		async run(context) {
			const manager = context.manager();
			const host = { sessionId: "bench-noprogress" };
			await manager.run(
				{ url: `${context.fixtures.url}/inert`, goal: "Click exactly one control." },
				host,
				idlePolicy,
			);
			const { page } = sessionOf(manager, host);
			const labels = ["Inert one", "Inert two", "Inert three"];
			let calls = 0;
			const result = await runJev(
				{ goal: "Advance the goal with these controls.", maxSteps: 8 },
				{
					driver: browserDriver(() => page),
					policy: {
						async choose(observation) {
							const label = labels[calls++];
							return {
								operation: "CLICK",
								target: observation.targets.find((target) => target.label === label),
							} as never;
						},
						async text() {
							return { text: null };
						},
					},
				},
			);
			return {
				checks: [
					check("stopped as no_progress", result.stopReason === "no_progress", result.stopReason),
					check("three distinct actions were tried", calls === 3, `calls=${calls}`),
				],
			};
		},
	},
];
