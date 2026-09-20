import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { StaleObservationError } from "../src/driver.ts";
import { desktopDriver, type DesktopDriver } from "../src/drivers/desktop.ts";

/**
 * These tests drive the desktop driver against a fake helper that speaks the same
 * line protocol as the Swift one. No macOS, no accessibility permission and no GUI
 * application, so the mapping and the staleness contract are covered on any machine.
 * The real helper is exercised by the desktop benchmark tier instead.
 */

const helperPath = fileURLToPath(new URL("./fake-ax-helper.mjs", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "pi-jev-desktop-"));
after(() => rmSync(directory, { recursive: true, force: true }));

const NODES = [
	{ index: 0, role: "AXButton", name: "7", value: "", identifier: "Seven", enabled: true, actions: ["AXPress"] },
	{ index: 1, role: "AXButton", name: "乘", value: "", identifier: "Multiply", enabled: true, actions: ["AXPress"] },
	{ index: 2, role: "AXTextArea", name: "Search", value: "hello", identifier: "SearchField", enabled: true, actions: ["AXSetValue"] },
	{ index: 3, role: "AXButton", name: "Disabled", value: "", identifier: "Off", enabled: false, actions: [] },
	{ index: 4, role: "AXButton", name: "", value: "", identifier: "", enabled: true, actions: ["AXPress"] },
];

function driverWith(
	environment: Record<string, string>,
	previous?: DesktopDriver,
): { driver: DesktopDriver; log: string } {
	void previous;
	const log = join(directory, `calls-${Math.random().toString(36).slice(2)}.jsonl`);
	Object.assign(process.env, {
		FAKE_AX_NODES: JSON.stringify(NODES),
		FAKE_AX_LOG: log,
		FAKE_AX_SIGNATURE: "sig-1",
		FAKE_AX_FRONT: "com.test.app",
		...environment,
	});
	return { driver: desktopDriver({ bundleId: "com.test.app", helperPath }), log };
}

const calls = (log: string) =>
	readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line).request as Record<string, unknown>);

test("the accessibility tree becomes addressable targets", async () => {
	const { driver } = driverWith({ FAKE_AX_TEXT: "1234" });
	try {
		const snapshot = await driver.observe();
		assert.equal(snapshot.data.url, "desktop://com.test.app/Fake window");
		assert.equal(snapshot.data.title, "Fake window");
		assert.equal(snapshot.data.text, "1234");
		// A disabled control is not offered, and an unnamed one falls back to its role
		// so the decision layer still has something to reason about.
		// A multi-line field that cannot confirm also gets a Return target of its own,
		// so submitting (sending, in a chat) is a step the decision layer chooses by name.
		assert.deepEqual(
			snapshot.data.targets.map((target) => target.id),
			["0", "1", "2", "2:return", "4"],
		);
		const [seven, multiply, field, submit] = snapshot.data.targets;
		assert.equal(submit.label, "⏎ Search");
		assert.equal(submit.role, "submit");
		assert.equal(submit.operation, "CLICK");
		assert.equal(seven.label, "7");
		assert.equal(seven.identifier, "Seven");
		assert.equal(seven.operation, "CLICK");
		assert.equal(multiply.label, "乘");
		assert.equal(multiply.identifier, "Multiply");
		assert.equal(field.operation, "TYPE_TEXT", "a text field is typed into, not pressed");
		assert.equal(snapshot.data.targets[4].label, "AXButton", "unnamed targets fall back to role");
	} finally {
		await driver.close();
	}
});

test("clicking a target is an accessibility action carrying the observed signature", async () => {
	const { driver, log } = driverWith({});
	try {
		const snapshot = await driver.observe();
		await snapshot.execute("CLICK", snapshot.data.targets[1], undefined, AbortSignal.timeout(5000));
		const press = calls(log).find((call) => call.cmd === "press");
		assert.ok(press, "a press must have been sent");
		assert.equal(press.index, 1);
		assert.equal(press.signature, "sig-1", "the action is bound to the observation it came from");
		assert.equal(press.bundleId, "com.test.app");
	} finally {
		await driver.close();
	}
});

test("typing goes through setvalue and needs no coordinates", async () => {
	const { driver, log } = driverWith({});
	try {
		const snapshot = await driver.observe();
		await snapshot.execute("TYPE_TEXT", snapshot.data.targets[2], "zebra", AbortSignal.timeout(5000));
		const set = calls(log).find((call) => call.cmd === "setvalue");
		assert.ok(set, "a setvalue must have been sent");
		assert.equal(set.value, "zebra");
		assert.equal(set.index, 2);
	} finally {
		await driver.close();
	}
});

test("an action on a surface that moved is reported as stale, not as a failure", async () => {
	const { driver } = driverWith({});
	try {
		const snapshot = await driver.observe();
		// The application changed after the observation, so the helper refuses.
		await driver.call({ cmd: "setsignature", value: "sig-2" });
		await assert.rejects(
			snapshot.execute("CLICK", snapshot.data.targets[0], undefined, AbortSignal.timeout(5000)),
			(error: unknown) => error instanceof StaleObservationError,
		);
	} finally {
		await driver.close();
	}
});

test("assertFresh re-reads and rejects a tree that changed", async () => {
	const { driver } = driverWith({});
	try {
		const snapshot = await driver.observe();
		await snapshot.assertFresh();
		await driver.call({ cmd: "setsignature", value: "sig-2" });
		await assert.rejects(snapshot.assertFresh(), (error: unknown) => error instanceof StaleObservationError);
	} finally {
		await driver.close();
	}
});

test("scrolling is a no-op instead of a lie", async () => {
	const { driver, log } = driverWith({});
	try {
		const snapshot = await driver.observe();
		await snapshot.execute("SCROLL_DOWN", undefined, undefined, AbortSignal.timeout(5000));
		assert.equal(
			calls(log).filter((call) => call.cmd === "press" || call.cmd === "setvalue").length,
			0,
			"the accessibility tree has no scroll semantics, so nothing may be sent",
		);
	} finally {
		await driver.close();
	}
});

test("the surface identity is the driven application's instance, whatever is frontmost", async () => {
	// A human has switched to another application: the identity must not move with them.
	const { driver, log } = driverWith({ FAKE_AX_FRONT: "com.other.app", FAKE_AX_PID: "777" });
	try {
		assert.equal(await driver.id(), "desktop://com.test.app/pid/777");
		assert.equal(await driver.id(), "desktop://com.test.app/pid/777");
		assert.deepEqual(await driver.ping(), { trusted: true });
		assert.equal(calls(log).some((request) => request.cmd === "front"), false);
	} finally {
		await driver.close();
	}
});

test("a missing helper is reported with the build command", async () => {
	const driver = desktopDriver({
		bundleId: "com.test.app",
		helperPath: join(directory, "does-not-exist"),
	});
	await assert.rejects(driver.observe(), /npm run build:ax-helper/);
	await driver.close();
});

test("a vanished window is classified, not reported as an unexpected error", async () => {
	const { driver } = driverWith({});
	try {
		assert.equal(driver.readFailureCategory?.(new Error("application com.test.app has no window")), "window_unavailable");
		assert.equal(driver.readFailureCategory?.(new Error("no running application with bundle id com.test.app")), "window_unavailable");
		assert.equal(driver.readFailureCategory?.(new Error("something else")), undefined);
	} finally {
		await driver.close();
	}
});

test("only elements inside the window are targets; the rest are named as offscreen", async () => {
	const nodes = [
		{ index: 0, role: "AXButton", name: "Inside", value: "", identifier: "", enabled: true, actions: ["AXPress"], x: 10, y: 120, w: 40, h: 20 },
		{ index: 1, role: "AXButton", name: "Above", value: "", identifier: "", enabled: true, actions: ["AXPress"], x: 10, y: 20, w: 40, h: 20 },
		{ index: 2, role: "AXLink", name: "Below", value: "", identifier: "", enabled: true, actions: ["AXPress"], x: 10, y: 900, w: 40, h: 20 },
		{ index: 3, role: "AXButton", name: "", value: "", identifier: "", enabled: true, actions: ["AXPress"], x: 10, y: 950, w: 40, h: 20 },
		{ index: 4, role: "AXButton", name: "Zero", value: "", identifier: "", enabled: true, actions: ["AXPress"], x: 10, y: 130, w: 0, h: 0 },
		{ index: 5, role: "AXButton", name: "No frame", value: "", identifier: "", enabled: true, actions: ["AXPress"] },
	];
	const { driver } = driverWith({
		FAKE_AX_NODES: JSON.stringify(nodes),
		FAKE_AX_WINDOW_FRAME: JSON.stringify({ x: 0, y: 100, w: 800, h: 600 }),
	});
	try {
		const snapshot = await driver.observe();
		assert.deepEqual(
			snapshot.data.targets.map((t) => [t.id, t.label]),
			[["0", "Inside"], ["5", "No frame"]],
			"offscreen and zero-sized elements are not offered; indices stay the helper's",
		);
		assert.deepEqual(snapshot.data.offscreenControls, { above: ["Above"], below: ["Below"] });
		await snapshot.dispose();
	} finally {
		await driver.close();
	}
});
