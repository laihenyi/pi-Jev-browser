import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.ts";
import { assertDesktopPrerequisites, runDesktop, waitForWindow } from "../src/desktop-runtime.ts";
import { desktopDriver } from "../src/drivers/desktop.ts";
import type { JevPolicy } from "../src/policy.ts";

/**
 * The desktop tool's runtime against the fake helper: the prerequisite checks,
 * the permission check and the run shape are covered without macOS,
 * Accessibility permission or a GUI application.
 */

const helperPath = fileURLToPath(new URL("./fake-ax-helper.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "pi-jev-desktop-runtime-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const NODES = [
	{ index: 0, role: "AXButton", name: "1", value: "", identifier: "One", enabled: true, actions: ["AXPress"] },
	{ index: 1, role: "AXButton", name: "=", value: "", identifier: "Equals", enabled: true, actions: ["AXPress"] },
];

function configWith(desktop: { requireConfirmation?: boolean } = {}) {
	const base = readConfig(join(directory, "missing.json"));
	return { ...base, outputDir: directory, desktop: { ...base.desktop, ...desktop } };
}

const scripted = (operations: string[]): JevPolicy => {
	let call = 0;
	return {
		async choose(observation) {
			const wanted = operations[Math.min(call++, operations.length - 1)];
			const target = observation.targets.find((candidate) => candidate.identifier === wanted);
			return { operation: target ? "CLICK" : wanted, target, probability: 0.9 } as never;
		},
		async text() {
			return { text: null };
		},
	};
};

test("any bundle id passes the prerequisites; the host, helper and id shape are still checked", () => {
	// No allow list: an application the user never named in the config is fine.
	assert.equal(
		assertDesktopPrerequisites({ bundleId: "com.never.listed" }, configWith(), { helperPath, platform: "darwin" }),
		helperPath,
	);
	assert.throws(
		() =>
			assertDesktopPrerequisites(
				{ bundleId: "Calculator" },
				configWith(),
				{ helperPath, platform: "darwin" },
			),
		/not a bundle id/,
	);
	assert.throws(
		() => assertDesktopPrerequisites({ bundleId: "com.test.app" }, configWith(), { helperPath, platform: "linux" }),
		/only available on macOS/,
	);
	assert.throws(
		() =>
			assertDesktopPrerequisites(
				{ bundleId: "com.test.app" },
				configWith(),
				{ helperPath: join(directory, "missing-helper"), platform: "darwin" },
			),
		/npm run build:ax-helper/,
	);
});

test("a cold start waits for the first window instead of observing the gap", async () => {
	const log = join(directory, "cold-start.jsonl");
	Object.assign(process.env, { FAKE_AX_NODES: JSON.stringify(NODES), FAKE_AX_LOG: log, FAKE_AX_NO_WINDOW_CALLS: "3" });
	const driver = desktopDriver({ bundleId: "com.test.app", helperPath });
	try {
		assert.equal(await waitForWindow(driver, "com.test.app", 5_000, 10), true);
		const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).request.cmd);
		assert.deepEqual(calls, ["observe", "observe", "observe", "observe"]);
		// The deadline still bounds an application that never shows a window.
		process.env.FAKE_AX_NO_WINDOW_CALLS = "1000";
		const late = desktopDriver({ bundleId: "com.test.app", helperPath });
		try {
			assert.equal(await waitForWindow(late, "com.test.app", 100, 10), false);
		} finally {
			await late.close?.();
		}
	} finally {
		delete process.env.FAKE_AX_NO_WINDOW_CALLS;
		delete process.env.FAKE_AX_LOG;
		await driver.close?.();
	}
});

test("a process without Accessibility permission is told how to grant it", async () => {
	Object.assign(process.env, { FAKE_AX_NODES: JSON.stringify(NODES), FAKE_AX_UNTRUSTED: "1" });
	try {
		await assert.rejects(
			runDesktop(
				{ bundleId: "com.test.app", goal: "Press 1" },
				{ sessionId: "t" },
				scripted(["DONE"]),
				configWith(),
				{ helperPath, platform: "darwin" },
			),
			/Privacy & Security › Accessibility/,
		);
	} finally {
		delete process.env.FAKE_AX_UNTRUSTED;
	}
});

test("a run drives the application, writes a trace and returns the final window", async () => {
	const log = join(directory, "calls.jsonl");
	Object.assign(process.env, {
		FAKE_AX_NODES: JSON.stringify(NODES),
		FAKE_AX_LOG: log,
		FAKE_AX_SIGNATURE: "sig-1",
		FAKE_AX_NEXT_SIGNATURE: "sig-2",
		FAKE_AX_TEXT: "1",
	});
	const events: string[] = [];
	const result = await runDesktop(
		{ bundleId: "com.test.app", goal: "Press 1, then equals" },
		{ sessionId: "t", onEvent: (type) => void events.push(type) },
		scripted(["One", "DONE"]),
		configWith(),
		{ helperPath, platform: "darwin" },
	);
	assert.equal(result.status, "done_unverified");
	assert.equal(result.bundleId, "com.test.app");
	assert.equal(result.steps.filter((step) => step.status === "executed").length, 1);
	assert.deepEqual(result.window, { title: "Fake window", text: "1", targets: 2 });
	assert.ok(result.tracePath.startsWith(join(directory, "desktop")));
	const trace = readFileSync(result.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(trace.some((row) => row.status === "executed" && row.target === "1"));
	assert.equal(trace.at(-1)?.type, "result");
	assert.deepEqual(events.slice(0, 1), ["desktop-start"]);
	assert.ok(events.includes("jev-step"));
	const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).request.cmd);
	// Permission, liveness, focus, then the loop; the helper is quit at the end.
	assert.deepEqual(calls.slice(0, 3), ["ping", "instance", "activate"]);
	assert.equal(calls.at(-1), "quit");
	assert.ok(calls.includes("press"));
});
