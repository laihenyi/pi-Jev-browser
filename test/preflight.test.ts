import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// config.ts resolves PI_JEV_BROWSER_CONFIG once at module load, so it has to be set
// before index.ts is imported. This file deliberately has no TypeSafe key.
const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-preflight-"));
const configPath = join(directory, "config.json");
writeFileSync(
	configPath,
	JSON.stringify({ outputDir: directory, recordVideo: false }),
);
process.env.PI_JEV_BROWSER_CONFIG = configPath;
delete process.env.TYPESAFE_API_KEY;
delete process.env.PI_JEV_BROWSER_TEXT_MODEL;

after(() => {
	rmSync(directory, { recursive: true, force: true });
});

test("jev_run reports a missing Jev credential before starting Chromium", async () => {
	const { default: register } = await import("../index.ts");
	const tools: Array<{ name: string; execute: (...args: unknown[]) => unknown }> = [];
	register({
		registerTool: (tool: { name: string }) => {
			tools.push(tool as never);
		},
		on: () => undefined,
	} as never);
	const tool = tools.find((candidate) => candidate.name === "jev_run");
	assert.ok(tool, "expected jev_run to be registered");

	const statuses: Array<string | undefined> = [];
	let modelLookups = 0;
	const ctx = {
		sessionManager: { getSessionId: () => "preflight" },
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
		},
		model: undefined,
		modelRegistry: {
			get complete() {
				modelLookups++;
				throw new Error("the model must not be called");
			},
		},
	};

	await assert.rejects(
		Promise.resolve(
			tool.execute(
				"call-1",
				{ goal: "Open example.com", url: "https://example.com" },
				undefined,
				undefined,
				ctx,
			),
		),
		/TYPESAFE_API_KEY/,
	);
	// withStatus never ran, so the failure happened before any browser work.
	assert.deepEqual(statuses, []);
	assert.equal(modelLookups, 0);
});
