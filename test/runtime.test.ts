import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// config.ts resolves PI_BROWSER_CONFIG once at module load, so the path has to
// exist before the runtime is imported by the first test in this file.
const directory = mkdtempSync(join(tmpdir(), "pi-browser-runtime-"));
const configPath = join(directory, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({
		outputDir: directory,
		recordVideo: false,
		allowedOrigins: ["http://127.0.0.1:*"],
	}),
);
process.env.PI_BROWSER_CONFIG = configPath;

after(() => {
	rmSync(directory, { recursive: true, force: true });
});

function startServer(
	handler: Parameters<typeof createServer>[1],
): Promise<{ url: string; close: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const server = createServer(handler);
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string")
				return reject(new Error("No test server address"));
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

test("manager runs Jev end to end, reuses the browser, and cancels cleanly", async () => {
	const page = await startServer((_request, response) =>
		response.end("<title>Ready page</title><h1>Ready</h1>"),
	);

	// Stand in for the TypeSafe System One endpoint so the real client, request
	// shape, and response parsing are exercised without a paid model call.
	const decisions: string[] = [];
	const typesafe = await startServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const parsed = JSON.parse(body) as {
				model: string;
				state: string;
				questions: Record<string, { criteria: Record<string, unknown> }>;
			};
			assert.equal(parsed.model, "jev-latest");
			assert.equal(JSON.parse(parsed.state).page.url, `${page.url}/`);
			const criteria = Object.keys(parsed.questions.action.criteria);
			const choice = "DONE";
			assert.ok(criteria.includes(choice));
			decisions.push(choice);
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify({
					model: "jev-latest",
					answers: {
						action: {
							type: "choice",
							choice,
							confidence: 0.9,
							probabilities: Object.fromEntries(
								criteria.map((key) => [key, key === choice ? 0.9 : 0.01]),
							),
						},
					},
					usage: { input_tokens: 10, output_tokens: 0 },
				}),
			);
		});
	});

	const { PiBrowserManager } = await import("../src/runtime.ts");
	const { createJevPolicy } = await import("../src/policy.ts");
	const manager = new PiBrowserManager();
	const host = { sessionId: "runtime-test" };
	const policy = createJevPolicy({
		text: async () => ({ text: "unused" }),
		credentials: {
			apiKey: "offline-test-key",
			baseUrl: typesafe.url,
			model: "jev-latest",
		},
	});

	try {
		const run = await manager.run(
			{ goal: "Observe the Ready heading", url: page.url },
			host,
			policy,
		);
		assert.equal(run.status, "done_unverified");
		assert.equal(run.failure, undefined);
		assert.ok(existsSync(run.initialScreenshot.artifactPath));
		assert.ok(
			run.finalScreenshot && existsSync(run.finalScreenshot.artifactPath),
		);
		assert.ok(run.result?.some((block) => block.type === "image"));
		assert.deepEqual(decisions, ["DONE"]);

		// A DONE decision is recorded in the trace rather than in the executed steps.
		assert.ok(run.tracePath && existsSync(run.tracePath));
		const trace = readFileSync(run.tracePath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.ok(
			trace.some(
				(entry) => entry.status === "decision" && entry.operation === "DONE",
			),
		);
		assert.equal(trace.at(-1).type, "result");
		assert.equal(trace.at(-1).status, "done_unverified");

		const second = await manager.run(
			{ goal: "Observe the Ready heading" },
			host,
			policy,
		);
		assert.equal(
			second.initialScreenshot.state.startedAt,
			run.initialScreenshot.state.startedAt,
		);
		assert.notEqual(
			second.finalScreenshot?.artifactPath,
			run.finalScreenshot?.artifactPath,
		);
		assert.match(String(second.page?.text), /Ready/);
		assert.equal(second.page?.title, "Ready page");

		// A reused browser must report progress to the call in flight, not to the
		// call that originally started it.
		const secondHostEvents: string[] = [];
		const third = await manager.run(
			{ goal: "Observe the Ready heading" },
			{
				sessionId: "runtime-test",
				onEvent: (type) => secondHostEvents.push(type),
			},
			policy,
		);
		assert.equal(third.status, "done_unverified");
		assert.ok(
			secondHostEvents.includes("jev-step"),
			`expected progress events on the reusing host, got ${JSON.stringify(secondHostEvents)}`,
		);

		const state = await manager.state(host);
		assert.equal(state.active, true);
		assert.match(String(state.currentUrl), /127\.0\.0\.1/);
		assert.equal(state.pageTitle, "Ready page");

		const logs = manager.logs({}, host);
		assert.ok(logs.total > 0);
		assert.ok(
			logs.logs.some((entry) => entry.type === "navigation"),
			"expected a navigation log entry",
		);

		const waiting = manager.actions(
			{ actions: [{ type: "wait", ms: 30000 }], includeScreenshot: false },
			host,
		);
		const cancelled = assert.rejects(waiting, /abort/i);
		await assert.rejects(
			manager.actions({ actions: [{ type: "wait", ms: 1 }] }, host),
			/active/,
		);
		await manager.stop(host);
		await cancelled;
		assert.equal((await manager.state(host)).active, false);
		assert.equal((await manager.stop(host)).active, false);
	} finally {
		await manager.stopSession("runtime-test");
		await page.close();
		await typesafe.close();
	}
});

test("manager refuses navigation outside allowedOrigins", async () => {
	const { PiBrowserManager } = await import("../src/runtime.ts");
	const manager = new PiBrowserManager();
	const host = { sessionId: "origins-test" };
	const unusedPolicy = {
		async choose() {
			throw new Error("Jev must not be called for a blocked origin");
		},
		async text() {
			throw new Error("Jev must not be called for a blocked origin");
		},
	};
	try {
		// The allowlist is enforced before Chromium starts, so no browser is launched.
		await assert.rejects(
			manager.run(
				{ goal: "Visit a blocked host", url: "https://blocked.example.test" },
				host,
				unusedPolicy,
			),
			/blocked by pi-browser.config.json/,
		);
		assert.equal((await manager.state(host)).active, false);
	} finally {
		await manager.stopSession("origins-test");
	}
});
