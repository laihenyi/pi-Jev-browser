import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { executeActions } from "../src/actions.ts";
import { detectFrameProvider, frameAtPoint, frameWarning } from "../src/frames.ts";
import { launchTestBrowser } from "./helpers.ts";

// The runtime resolves PI_JEV_BROWSER_CONFIG at import time.
const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-frames-"));
const configPath = join(directory, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({
		outputDir: directory,
		recordVideo: false,
		headless: true,
		allowedOrigins: ["http://127.0.0.1:*"],
	}),
);
process.env.PI_JEV_BROWSER_CONFIG = configPath;
after(() => rmSync(directory, { recursive: true, force: true }));

const FRAME_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Frame page</title></head>
<body style="margin:0">
<h1 style="position:absolute;left:20px;top:20px">Frame page</h1>
<iframe title="embedded widget" src="/inner.html"
        style="position:absolute;left:20px;top:120px;width:300px;height:100px;border:1px solid #999"></iframe>
</body></html>`;

const INNER_PAGE = `<!doctype html><html><body style="margin:0">
<button style="width:120px;height:40px" onclick="window.__innerClicked = true">inner</button>
</body></html>`;

async function startServer() {
	return new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
		const server = createServer((request, response) => {
			response.setHeader("content-type", "text/html");
			response.end(request.url?.startsWith("/inner") ? INNER_PAGE : FRAME_PAGE);
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

test("classifies known anti-bot frame providers", () => {
	assert.equal(
		detectFrameProvider("https://www.google.com/recaptcha/api2/anchor?k=x"),
		"reCAPTCHA",
	);
	assert.equal(detectFrameProvider("https://newassets.hcaptcha.com/captcha/v1"), "hCaptcha");
	assert.equal(
		detectFrameProvider("https://challenges.cloudflare.com/turnstile/v0/api.js"),
		"Cloudflare challenge",
	);
	assert.equal(detectFrameProvider("https://example.com/widget"), undefined);
	assert.equal(detectFrameProvider("about:blank"), undefined);
	assert.equal(detectFrameProvider(""), undefined);
});

test("frame warnings name the origin, position and provider", () => {
	const warning = frameWarning("click", 100.4, 160.6, {
		origin: "https://www.google.com",
		src: "https://www.google.com/recaptcha/api2/anchor",
		provider: "reCAPTCHA",
	});
	assert.match(warning, /click at \(100, 161\)/);
	assert.match(warning, /https:\/\/www\.google\.com/);
	assert.match(warning, /\[reCAPTCHA\]/);
	assert.match(warning, /raw coordinate click/);
});

test("coordinate clicks over a frame are reported, main-frame clicks are not", async () => {
	const server = await startServer();
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.goto(server.url, { waitUntil: "domcontentloaded" });

		// Detection: the point over the iframe resolves to the iframe element.
		const overFrame = await frameAtPoint(page, 100, 160);
		assert.ok(overFrame, "expected a frame hit over the iframe");
		assert.equal(overFrame.origin, server.url);
		assert.equal(await frameAtPoint(page, 100, 30), undefined);

		const hits: string[] = [];
		await executeActions(page, [{ type: "click", x: 100, y: 160 }], {
			assertUrlAllowed: () => undefined,
			onFrameHit: (info) => hits.push(info.warning),
		});
		assert.equal(hits.length, 1);
		assert.match(hits[0], new RegExp(server.url.replace(/[.:]/g, "\\$&")));
		// The click really did land in the frame.
		const inner = page.frames().find((frame) => frame.url().includes("/inner"));
		assert.ok(inner, "expected the inner frame");
		assert.equal(
			await inner.evaluate(
				() => Boolean((window as unknown as { __innerClicked?: boolean }).__innerClicked),
			),
			true,
		);

		hits.length = 0;
		await executeActions(page, [{ type: "click", x: 100, y: 30 }], {
			assertUrlAllowed: () => undefined,
			onFrameHit: (info) => hits.push(info.warning),
		});
		assert.deepEqual(hits, [], "a main-frame click must not warn");
	} finally {
		await browser.close();
		await server.close();
	}
});

test("jev_actions surfaces frame warnings and logs them", async () => {
	const server = await startServer();
	const { PiBrowserManager } = await import("../src/runtime.ts");
	const manager = new PiBrowserManager();
	const host = { sessionId: "frames-test" };
	// A stub policy keeps this test offline; no Jev decision is needed here.
	const policy = {
		async choose() {
			return { operation: "DONE" };
		},
		async text() {
			throw new Error("Unexpected helper");
		},
	};
	try {
		// Clicking before a browser exists must fail cleanly rather than warn.
		await assert.rejects(
			manager.actions(
				{ actions: [{ type: "click", x: 100, y: 160 }], includeScreenshot: false },
				host,
			),
			/No browser is active/,
		);

		await manager.run(
			{ url: server.url, goal: "Report the page heading and stop." },
			host,
			policy,
		);

		const result = await manager.actions(
			{ actions: [{ type: "click", x: 100, y: 160 }], includeScreenshot: false },
			host,
		);
		assert.ok("warnings" in result && result.warnings, "expected frame warnings");
		assert.equal(result.warnings?.length, 1);
		assert.match(String(result.warnings?.[0]), /landed inside a frame/);

		const logs = manager.logs({}, host);
		const security = logs.logs.filter(
			(entry) => entry.type === "security" && entry.level === "warning",
		);
		assert.equal(security.length, 1);
		assert.match(security[0].text, /landed inside a frame/);
	} finally {
		await manager.stop(host);
		await server.close();
	}
});
