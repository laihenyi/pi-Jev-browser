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
	{ index: 2, role: "AXTextField", name: "Search", value: "hello", identifier: "SearchField", enabled: true, actions: ["AXSetValue"] },
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
		assert.deepEqual(
			snapshot.data.targets.map((target) => target.id),
			["0", "1", "2", "4"],
		);
		const [seven, multiply, field] = snapshot.data.targets;
		assert.equal(seven.label, "7");
		assert.equal(seven.identifier, "Seven");
		assert.equal(seven.operation, "CLICK");
		assert.equal(multiply.label, "乘");
		assert.equal(multiply.identifier, "Multiply");
		assert.equal(field.operation, "TYPE_TEXT", "a text field is typed into, not pressed");
		assert.equal(snapshot.data.targets[3].label, "AXButton", "unnamed targets fall back to role");
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

test("the surface identity comes from the frontmost application", async () => {
	const { driver } = driverWith({ FAKE_AX_FRONT: "com.other.app" });
	try {
		assert.equal(await driver.id(), "desktop://front/com.other.app");
		assert.deepEqual(await driver.ping(), { trusted: true });
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
