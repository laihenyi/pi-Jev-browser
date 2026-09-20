import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { readConfig } from "../src/config.ts";
import { assertDesktopPrerequisites, runDesktop } from "../src/desktop-runtime.ts";
import type { JevPolicy } from "../src/policy.ts";

/**
 * The desktop tool's runtime against the fake helper: the allow list, the
 * permission check and the run shape are covered without macOS, Accessibility
 * permission or a GUI application.
 */

const helperPath = fileURLToPath(new URL("./fake-ax-helper.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "pi-jev-desktop-runtime-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const NODES = [
	{ index: 0, role: "AXButton", name: "1", value: "", identifier: "One", enabled: true, actions: ["AXPress"] },
	{ index: 1, role: "AXButton", name: "=", value: "", identifier: "Equals", enabled: true, actions: ["AXPress"] },
];

function configWith(desktop: { allowedBundleIds?: string[]; requireConfirmation?: boolean }) {
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

test("nothing can be driven until its bundle id is allowed", () => {
	assert.throws(
		() => assertDesktopPrerequisites({ bundleId: "com.test.app" }, configWith({}), { helperPath, platform: "darwin" }),
		/closed by default[\s\S]*allowedBundleIds/,
	);
	assert.throws(
		() =>
			assertDesktopPrerequisites(
				{ bundleId: "com.other.app" },
				configWith({ allowedBundleIds: ["com.test.app"] }),
				{ helperPath, platform: "darwin" },
			),
		/not in desktop\.allowedBundleIds \(com\.test\.app\)/,
	);
	assert.throws(
		() =>
			assertDesktopPrerequisites(
				{ bundleId: "Calculator" },
				configWith({ allowedBundleIds: ["*"] }),
				{ helperPath, platform: "darwin" },
			),
		/not a bundle id/,
	);
	assert.throws(
		() => assertDesktopPrerequisites({ bundleId: "com.test.app" }, configWith({ allowedBundleIds: ["*"] }), { helperPath, platform: "linux" }),
		/only available on macOS/,
	);
	assert.throws(
		() =>
			assertDesktopPrerequisites(
				{ bundleId: "com.test.app" },
				configWith({ allowedBundleIds: ["*"] }),
				{ helperPath: join(directory, "missing-helper"), platform: "darwin" },
			),
		/npm run build:ax-helper/,
	);
});

test("a process without Accessibility permission is told how to grant it", async () => {
	Object.assign(process.env, { FAKE_AX_NODES: JSON.stringify(NODES), FAKE_AX_UNTRUSTED: "1" });
	try {
		await assert.rejects(
			runDesktop(
				{ bundleId: "com.test.app", goal: "Press 1" },
				{ sessionId: "t" },
				scripted(["DONE"]),
				configWith({ allowedBundleIds: ["com.test.app"] }),
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
		configWith({ allowedBundleIds: ["com.test.*"] }),
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
