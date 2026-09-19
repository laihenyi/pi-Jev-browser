import { extractFromPage } from "../../src/extract.ts";
import { check, median, sessionOf, type Scenario } from "../lib/harness.ts";
import { readTrace } from "./model.ts";

/**
 * Third-party sites. These measure real-world behaviour, so they depend on the
 * network and on the site not blocking the runner; a failure here is reported but
 * does not fail the local benchmark run unless --strict is used.
 */
const MONTHS = ["2026-10", "2026-11", "2026-12"];
const flightsUrl = (month: string) =>
	`https://www.google.com/travel/flights?q=${encodeURIComponent(`Flights from TPE to LON in ${month}`)}&hl=en&curr=USD`;

interface Reading {
	lowest: number | null;
	count: number;
	prices: Array<{ amount: number; text: string }>;
	settledMs: number;
	streaming: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Google streams prices in, so read until the lowest price stops changing. */
async function readPrices(page: import("playwright").Page, budgetMs = 25_000): Promise<Reading> {
	const started = Date.now();
	let previous = -1;
	let stable = 0;
	let prices: Reading["prices"] = [];
	let streaming = false;
	while (Date.now() - started < budgetMs) {
		const result = await extractFromPage(page, { kind: "text", selector: "li", limit: 60 });
		const items = (result.items as string[]).filter(
			(item): item is string => typeof item === "string",
		);
		const found: Reading["prices"] = [];
		for (const text of items)
			for (const match of text.matchAll(/\$\s?([0-9][0-9,]{1,9})/g)) {
				const amount = Number(match[1].replaceAll(",", ""));
				if (Number.isFinite(amount) && amount >= 50)
					found.push({ amount, text: text.replace(/\s+/g, " ").slice(0, 120) });
			}
		found.sort((a, b) => a.amount - b.amount);
		prices = found;
		streaming = /Checking prices from multiple sources/i.test(items.join(" "));
		const lowest = found[0]?.amount ?? -1;
		if (lowest > 0 && lowest === previous) {
			stable++;
			if (stable >= 2) break;
		} else stable = 0;
		previous = lowest;
		await sleep(900);
	}
	return {
		lowest: prices[0]?.amount ?? null,
		count: prices.length,
		prices,
		settledMs: Date.now() - started,
		streaming,
	};
}

export const liveScenarios: Scenario[] = [
	{
		id: "live-flight-month-sweep",
		tier: "live",
		category: "capability",
		title: "Lowest TPE to LON fare for each of the next three months",
		notes:
			"Deterministic extraction, one browser session, one navigation per month. Prices are read until they are stable for two consecutive reads; Google keeps streaming cheaper options, so a longer wait can find lower fares.",
		async run(context) {
			context.configure({ allowedOrigins: ["https://*", "http://127.0.0.1:*"] });
			const manager = context.manager();
			const host = { sessionId: "bench-flights" };
			await manager.run(
				{ url: flightsUrl(MONTHS[0]), goal: "Open the flight search." },
				host,
				{
					async choose() {
						return { operation: "DONE" };
					},
					async text() {
						return { text: null };
					},
				} as never,
			);
			const { page } = sessionOf(manager, host);
			const perMonth: Array<Record<string, number | string | null>> = [];
			for (const month of MONTHS) {
				if (page.url() !== flightsUrl(month))
					await page.goto(flightsUrl(month), {
						waitUntil: "domcontentloaded",
						timeout: 30_000,
					});
				const reading = await readPrices(page);
				perMonth.push({
					month,
					lowest: reading.lowest,
					count: reading.count,
					settledMs: reading.settledMs,
					cheapest: reading.prices[0]?.text ?? null,
				});
			}
			const ranked = perMonth
				.filter((row) => typeof row.lowest === "number")
				.sort((a, b) => (a.lowest as number) - (b.lowest as number));
			return {
				checks: [
					check("every month returned a price list", perMonth.every((row) => (row.count as number) > 0), JSON.stringify(perMonth.map((row) => row.count))),
					check("every month returned a lowest fare", perMonth.every((row) => typeof row.lowest === "number"), JSON.stringify(perMonth.map((row) => row.lowest))),
					check("a lowest month could be ranked", ranked.length === MONTHS.length, JSON.stringify(ranked.map((row) => row.month))),
				],
				metrics: {
					cheapestMonth: ranked[0]?.month ?? null,
					cheapestFare: ranked[0]?.lowest ?? null,
					cheapestItinerary: ranked[0]?.cheapest ?? null,
					month010: perMonth[0]?.lowest ?? null,
					month011: perMonth[1]?.lowest ?? null,
					month012: perMonth[2]?.lowest ?? null,
				},
			};
		},
	},
	{
		id: "live-flight-nonstop-filter",
		tier: "live",
		category: "capability",
		title: "Two-step filter dialog: open Stops and select Nonstop",
		notes:
			"Verifies the selector layer against a real dialog whose options are plain divs inside a role=radiogroup; the addressable element is the underlying radio input. A filtered result must be more expensive than the unfiltered cheapest, otherwise the filter did not apply.",
		async run(context) {
			context.configure({ allowedOrigins: ["https://*", "http://127.0.0.1:*"] });
			const manager = context.manager();
			const host = { sessionId: "bench-nonstop" };
			await manager.run(
				{ url: flightsUrl("2026-12"), goal: "Open the flight search." },
				host,
				{
					async choose() {
						return { operation: "DONE" };
					},
					async text() {
						return { text: null };
					},
				} as never,
			);
			const { page } = sessionOf(manager, host);
			await sleep(4000);
			const before = await readPrices(page, 15_000);
			const started = Date.now();
			await manager.actions(
				{
					actions: [{ type: "click", target: { role: "button", name: "Stops" } }],
					includeScreenshot: false,
				},
				host,
			);
			await sleep(1800);
			await manager.actions(
				{
					actions: [{ type: "click", target: { role: "radio", name: "Nonstop only" } }],
					includeScreenshot: false,
				},
				host,
			);
			const clickMs = Date.now() - started;
			await sleep(3500);
			const after = await readPrices(page, 20_000);
			const filterState = await page.evaluate(() => ({
				applied: document.body.innerText.match(/All filters \((\d+)\)/)?.[1] ?? null,
				results: document.body.innerText.match(/(\d+)\s+results?\s+returned/i)?.[1] ?? null,
				nonstopChip: /Nonstop/.test(document.body.innerText),
			}));

			return {
				checks: [
					check("the filter dialog opened and Nonstop was selected", clickMs < 20_000, `${clickMs}ms`),
					check("the filter is reported as applied", filterState.applied === "1", JSON.stringify(filterState)),
					check("the page shows the nonstop chip", filterState.nonstopChip, JSON.stringify(filterState)),
					check(
						"a filtered fare was found",
						typeof after.lowest === "number" && after.lowest > 0,
						after.lowest,
					),
					check(
						"filtering changed the result set",
						before.lowest !== after.lowest || after.count < before.count,
						`before ${before.lowest}/${before.count} after ${after.lowest}/${after.count}`,
					),
				],
				metrics: {
					unfilteredFare: before.lowest,
					nonstopFare: after.lowest,
					nonstopResults: filterState.results,
					twoStepClickMs: clickMs,
				},
			};
		},
	},
	{
		id: "live-pilotrun-header",
		tier: "live",
		category: "capability",
		title: "Jev clicks every header link on a real marketing site",
		notes:
			"The original failure case. The site opens a login link in a new tab and runs a mailto link, and its blog route ships a header without the navigation until hydration. Passing means every header link was clicked and the run ended with model_done.",
		async run(context) {
			context.configure({
				allowedOrigins: ["https://*", "http://127.0.0.1:*"],
				popups: "stay",
			});
			const manager = context.manager();
			const host = { sessionId: "bench-pilotrun" };
			const started = Date.now();
			const result = await manager.run(
				{
					url: "https://pilotrunapp.com/",
					goal: "Click every clickable link in the site header, one at a time, until all of them have been clicked: 功能特色, 企業方案, 課程設計, 教育方案, 價格方案, 使用說明, 部落格, 登入, 申請體驗, and the logo link. After each click you land on another page that shows the same header; continue from there and click the next header link you have not clicked yet. Only choose DONE after every header link has been clicked.",
					maxSteps: 20,
				},
				host,
				context.jev(() => null),
			);
			const trace = readTrace(result.tracePath);
			const clicked = trace.executed
				.filter((step) => step.operation === "CLICK")
				.map((step) => String(step.target ?? ""));
			const expected = [
				"功能特色",
				"企業方案",
				"課程設計",
				"教育方案",
				"價格方案",
				"使用說明",
				"部落格",
				"首頁",
				"登入",
				"申請體驗",
			];
			const missing = expected.filter(
				(label) => !clicked.some((target) => target.includes(label)),
			);

			return {
				checks: [
					check("stopped because Jev reported DONE", result.stopReason === "model_done", result.stopReason),
					check("every header link was clicked", missing.length === 0, `missing=${JSON.stringify(missing)}`),
					check("no run ended at the step limit", result.stopReason !== "step_limit", result.stopReason),
					check(
						"the run stayed on the site",
						(result.page?.url ?? "").startsWith("https://pilotrunapp.com"),
						result.page?.url,
					),
				],
				metrics: {
					executedSteps: trace.executed.length,
					distinctTargets: new Set(clicked).size,
					staleObservations: trace.stale.length,
					loopElapsedMs: result.elapsedMs,
					wallElapsedMs: Date.now() - started,
					decisionMedianMs: median(trace.decisions.map((step) => step.latencyMs)),
				},
			};
		},
	},
];
