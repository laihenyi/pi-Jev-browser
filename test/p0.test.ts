import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { executeActions } from "../src/actions.ts";
import { extractFromPage } from "../src/extract.ts";
import { launchTestBrowser } from "./helpers.ts";

// The runtime resolves PI_BROWSER_CONFIG at import time, but the file itself is
// read on every call, so tests can rewrite it to switch policy.
const directory = mkdtempSync(join(tmpdir(), "pi-browser-p0-"));
const configPath = join(directory, "config.json");
process.env.PI_BROWSER_CONFIG = configPath;
const writeConfig = (patch: Record<string, unknown>) =>
	writeFileSync(
		configPath,
		JSON.stringify({
			outputDir: directory,
			recordVideo: false,
			headless: true,
			allowedOrigins: ["http://127.0.0.1:*"],
			...patch,
		}),
	);
writeConfig({});
after(() => rmSync(directory, { recursive: true, force: true }));

const HOME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head>
<body>
<h1>Home</h1>
<a href="/next" target="_blank">Open next</a>
<a href="/plain">Plain link</a>
<label for="email">Email</label><input id="email" required>
<label for="plan">Plan</label>
<select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
<button onclick="document.querySelector('#out').textContent = 'sent'">Send</button>
<p id="out"></p>
<div id="row" data-code="A-1">Row one</div>
<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Widget</td><td>7</td></tr></table>
</body></html>`;
const NEXT_PAGE = `<!doctype html><html><head><title>Next</title></head><body><h1>Next</h1></body></html>`;

async function startServer() {
	return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
		const server = createServer((request, response) => {
			response.setHeader("content-type", "text/html");
			response.end(request.url?.startsWith("/next") ? NEXT_PAGE : HOME_PAGE);
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string")
				return reject(new Error("no address"));
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close: () =>
					new Promise<void>((done, fail) =>
						server.close((error) => (error ? fail(error) : done())),
					),
			});
		});
	});
}

const activeState = (state: unknown) =>
	state as {
		currentUrl: string;
		activePageIndex: number;
		pages: Array<{ url: string }>;
	};

/** A popup is reported asynchronously, so wait for it instead of racing it. */
async function waitForPages(
	manager: { state: (host: never) => Promise<unknown> },
	host: unknown,
	count: number,
) {
	for (let attempt = 0; attempt < 30; attempt++) {
		if (activeState(await manager.state(host as never)).pages.length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Expected ${count} open tab(s) within 3 seconds.`);
}

const allowAll = { assertUrlAllowed: () => undefined };
const stubPolicy = {
	async choose() {
		return { operation: "DONE" };
	},
	async text() {
		return { text: null };
	},
} as never;

test("manual actions address elements by role, name and text", async () => {
	const server = await startServer();
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded" });

		await executeActions(
			page,
			[
				{ type: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
				{ type: "select", target: { role: "combobox", name: "Plan" }, value: "pro" },
				{ type: "click", target: { role: "button", name: "Send" } },
			],
			allowAll,
		);

		assert.equal(await page.inputValue("#email"), "a@b.c");
		assert.equal(await page.inputValue("#plan"), "pro");
		assert.equal(await page.textContent("#out"), "sent");

		// Visible text works as a target, including across a navigation.
		await executeActions(
			page,
			[{ type: "click", target: { text: "Plain link" } }],
			allowAll,
		);
		assert.equal(new URL(page.url()).pathname, "/plain");

		// A CSS selector is also a valid target.
		const [popup] = await Promise.all([
			page.waitForEvent("popup", { timeout: 5_000 }),
			executeActions(
				page,
				[{ type: "click", target: { selector: 'a[target="_blank"]' } }],
				allowAll,
			),
		]);
		assert.match(popup.url(), /\/next$/);
	} finally {
		await browser.close();
		await server.close();
	}
});

test("an unknown target fails loudly instead of clicking something else", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent("<button>Only button</button>");
		await assert.rejects(
			executeActions(
				page,
				[{ type: "click", target: { role: "button", name: "Missing" } }],
				allowAll,
			),
			/No element matched role button name "Missing"/,
		);
		await assert.rejects(
			executeActions(
				page,
				[{ type: "click", target: { role: "link", text: "not on this page" } }],
				allowAll,
			),
			/No element matched role link text/,
		);
		await assert.rejects(
			executeActions(
				page,
				[{ type: "click", target: { role: "button", name: "Only", nth: 3 } }],
				allowAll,
			),
			/nth 3 does not exist/,
		);
	} finally {
		await browser.close();
	}
});

test("extract reads text, tables, links and attributes without a model", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent(HOME_PAGE);

		const text = await extractFromPage(page, { selector: "#row" });
		assert.deepEqual(text.items, ["Row one"]);
		assert.equal(text.count, 1);

		const table = await extractFromPage(page, { kind: "table", selector: "table" });
		assert.deepEqual(table.items, [
			["Name", "Qty"],
			["Widget", "7"],
		]);

		const links = await extractFromPage(page, { kind: "links", selector: "a" });
		assert.equal(links.count, 2);
		assert.deepEqual(
			links.items.map((item) => (item as { text: string }).text),
			["Open next", "Plain link"],
		);

		const attribute = await extractFromPage(page, {
			kind: "attributes",
			selector: "#row",
			attribute: "data-code",
		});
		assert.deepEqual(attribute.items, ["A-1"]);

		await assert.rejects(
			extractFromPage(page, { kind: "attributes" }),
			/requires attribute/,
		);
		await assert.rejects(
			extractFromPage(page, { selector: ">>bad<<" }),
			/Extraction failed/,
		);
	} finally {
		await browser.close();
	}
});

test("denyOrigins blocks navigation before Chromium starts", async () => {
	const { PiBrowserManager } = await import("../src/runtime.ts");
	const server = await startServer();
	writeConfig({ allowedOrigins: ["http://127.0.0.1:*"], denyOrigins: [server.url] });
	const manager = new PiBrowserManager();
	try {
		await assert.rejects(
			manager.run({ url: server.url, goal: "Read the heading" }, { sessionId: "p0-deny" }, stubPolicy),
			/denyOrigins/,
		);
	} finally {
		await manager.stopAll();
		await server.close();
		writeConfig({});
	}
});

test("a new tab is reported and the run keeps observing the original page", async () => {
	writeConfig({ popups: "stay" });
	const { PiBrowserManager } = await import("../src/runtime.ts");
	const server = await startServer();
	const manager = new PiBrowserManager();
	const host = { sessionId: "p0-stay" };
	try {
		await manager.run({ url: server.url, goal: "Report the heading" }, host, stubPolicy);
		const result = await manager.actions(
			{
				actions: [{ type: "click", target: { role: "link", name: "Open next" } }],
				includeScreenshot: false,
			},
			host,
		);
		assert.ok("warnings" in result && result.warnings, "expected a tab warning");
		assert.match(String(result.warnings[0]), /A new tab opened/);
		assert.match(String(result.warnings[0]), /kept observing/);

		await waitForPages(manager, host, 2);
		const state = activeState(await manager.state(host));
		assert.equal(state.pages.length, 2);
		assert.equal(state.activePageIndex, 0, "the run must stay on the first tab");
		assert.equal(state.currentUrl, `${server.url}/`);

		const logs = manager.logs({}, host);
		assert.equal(logs.logs.filter((entry) => entry.type === "tab").length, 1);

		// The agent can move deliberately instead of being teleported.
		const activated = await manager.actions(
			{ actions: [{ type: "activate_tab", index: 1 }], includeScreenshot: false },
			host,
		);
		assert.equal(activated.state.currentUrl, `${server.url}/next`);
		assert.equal(activated.state.activePageIndex, 1);

		const closed = await manager.actions(
			{ actions: [{ type: "close_tab", index: 0 }], includeScreenshot: false },
			host,
		);
		assert.equal(closed.state.pages.length, 1);	} finally {
		await manager.stopAll();
		await server.close();
		writeConfig({});
	}
});

test("popups follow adopts the new tab when configured", async () => {
	writeConfig({ popups: "follow" });
	const { PiBrowserManager } = await import("../src/runtime.ts");
	const server = await startServer();
	const manager = new PiBrowserManager();
	const host = { sessionId: "p0-follow" };
	try {
		await manager.run({ url: server.url, goal: "Report the heading" }, host, stubPolicy);
		const result = await manager.actions(
			{
				actions: [{ type: "click", target: { role: "link", name: "Open next" } }],
				includeScreenshot: false,
			},
			host,
		);
		assert.ok(result.warnings?.some((line) => /now the observed page/.test(line)));
		await waitForPages(manager, host, 2);
		const state = activeState(await manager.state(host));
		assert.equal(state.activePageIndex, 1);
	} finally {
		await manager.stopAll();
		await server.close();
		writeConfig({});
	}
});

test("a session profile keeps cookies between browser starts", async () => {
	writeConfig({ profile: "session" });
	const { PiBrowserManager } = await import("../src/runtime.ts");
	const server = await startServer();
	const manager = new PiBrowserManager();
	const host = { sessionId: "p0-profile" };
	try {
		await manager.run({ url: server.url, goal: "Report the heading" }, host, stubPolicy);
		const first = (manager as unknown as {
			requireSession: (h: unknown) => { context: { addCookies: (c: unknown[]) => Promise<void> } };
		}).requireSession(host);
		await first.context.addCookies([
			{
				name: "pi-browser-test",
				value: "kept",
				url: server.url,
				// Without an expiry this is a session cookie, which Chromium drops on
				// exit by design and would make the test prove nothing.
				expires: Math.floor(Date.now() / 1000) + 3600,
			},
		]);
		await manager.stop(host);

		await manager.run({ url: server.url, goal: "Report the heading" }, host, stubPolicy);
		const second = (manager as unknown as {
			requireSession: (h: unknown) => {
				context: { cookies: (u?: string) => Promise<Array<{ name: string; value: string }>> };
			};
		}).requireSession(host);
		const cookies = await second.context.cookies(server.url);
		assert.ok(
			cookies.some(
				(cookie) => cookie.name === "pi-browser-test" && cookie.value === "kept",
			),
			"a cookie set in the first run must survive a restart of the same session",
		);
	} finally {
		await manager.stopAll();
		await server.close();
		writeConfig({});
	}
});
