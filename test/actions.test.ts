import assert from "node:assert/strict";
import test from "node:test";
import { normalizeKey, parseActions } from "../src/actions.ts";

test("normalizes browser key aliases", () => {
	assert.equal(normalizeKey("CTRL"), "Control");
	assert.equal(normalizeKey("ARROWDOWN"), "ArrowDown");
	assert.equal(normalizeKey("a"), "a");
});

test("rejects empty, oversized, or malformed action batches", () => {
	assert.throws(() => parseActions([]), /at least one/);
	assert.throws(() => parseActions("click"), /at least one/);
	assert.throws(
		() => parseActions(Array.from({ length: 51 }, () => ({ type: "screenshot" }))),
		/limited to 50/,
	);
	assert.throws(() => parseActions([null]), /must be an object/);
	assert.throws(() => parseActions([{ type: "teleport" }]), /not a supported/);
});

test("requires the fields each action type needs", () => {
	assert.throws(
		() => parseActions([{ type: "click", x: 1 }]),
		/needs x and y coordinates, or a target element/,
	);
	assert.throws(
		() => parseActions([{ type: "click", target: { role: "link" }, x: 1, y: 2 }]),
		/either x\/y coordinates or target, not both/,
	);
	assert.throws(
		() => parseActions([{ type: "fill", target: { role: "textbox" } }]),
		/value must be/,
	);
	assert.throws(
		() => parseActions([{ type: "select", value: "x" }]),
		/target is required/,
	);
	assert.throws(
		() => parseActions([{ type: "click", target: { name: "Blog" } }]),
		/needs at least one of role, text, or selector/,
	);
	assert.throws(
		() => parseActions([{ type: "click", target: { name: "Blog", text: "Blog" } }]),
		/name needs role/,
	);
	assert.throws(
		() => parseActions([{ type: "activate_tab" }]),
		/index must be a finite number/,
	);
	assert.throws(
		() => parseActions([{ type: "scroll", deltaY: 10 }]),
		/deltaX must be/,
	);
	assert.throws(() => parseActions([{ type: "type" }]), /text must be/);
	assert.throws(() => parseActions([{ type: "keypress", keys: [] }]), /keys must be/);
	assert.throws(() => parseActions([{ type: "wait", ms: -1 }]), /not be negative/);
	assert.throws(() => parseActions([{ type: "navigate", url: "  " }]), /url must be/);
	assert.throws(
		() => parseActions([{ type: "click", x: 1, y: 1, button: "thumb" }]),
		/button must be/,
	);
	assert.throws(
		() => parseActions([{ type: "drag", path: [{ x: 1, y: 1 }] }]),
		/at least two points/,
	);
	assert.throws(
		() => parseActions([{ type: "drag", path: [[0, 0], "end"] }]),
		/must be \[x, y\]/,
	);
});

test("normalizes valid actions and drops absent optional fields", () => {
	assert.deepEqual(
		parseActions([
			{ type: "click", x: 10, y: 20, button: "right", keys: ["CTRL"] },
			{ type: "scroll", deltaX: 0, deltaY: 400, x: 5, y: 5 },
			{ type: "type", text: "cats" },
			{ type: "wait" },
			{ type: "keypress", keys: ["Enter"] },
			{ type: "drag", path: [[0, 0], [10, 10], { x: 20, y: 20 }] },
			{ type: "move", x: 1, y: 2 },
			{ type: "screenshot" },
			{ type: "navigate", url: "https://example.test" },
			{ type: "back" },
			{ type: "forward" },
			{ type: "reload" },
		]),
		[
			{ type: "click", x: 10, y: 20, button: "right", keys: ["CTRL"] },
			{ type: "scroll", deltaX: 0, deltaY: 400, x: 5, y: 5 },
			{ type: "type", text: "cats" },
			{ type: "wait" },
			{ type: "keypress", keys: ["Enter"] },
			{ type: "drag", path: [[0, 0], [10, 10], { x: 20, y: 20 }] },
			{ type: "move", x: 1, y: 2 },
			{ type: "screenshot" },
			{ type: "navigate", url: "https://example.test" },
			{ type: "back" },
			{ type: "forward" },
			{ type: "reload" },
		],
	);
	assert.deepEqual(parseActions([{ type: "click", x: 1, y: 2 }]), [
		{ type: "click", x: 1, y: 2 },
	]);
});
