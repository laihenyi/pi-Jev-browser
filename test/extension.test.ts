import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import register from "../index.ts";

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: Parameters<typeof Value.Check>[0];
	promptSnippet?: string;
	promptGuidelines?: string[];
	executionMode?: string;
	execute: unknown;
}

function loadExtension() {
	const tools: RegisteredTool[] = [];
	const events: string[] = [];
	register({
		registerTool: (tool: RegisteredTool) => {
			tools.push(tool);
		},
		on: (event: string) => {
			events.push(event);
		},
	} as unknown as Parameters<typeof register>[0]);
	return { tools, events };
}

function toolNamed(tools: RegisteredTool[], name: string) {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected a ${name} tool`);
	return tool;
}

test("registers the complete Pi Jev Browser tool surface", () => {
	const { tools, events } = loadExtension();
	assert.deepEqual(
		tools.map((tool) => tool.name),
		[
			"jev_run",
			"jev_actions",
			"jev_extract",
			"jev_state",
			"jev_logs",
			"jev_stream",
			"jev_stop",
			"jev_desktop",
		],
	);
	for (const tool of tools) {
		assert.ok(tool.label.length > 0, `${tool.name} needs a label`);
		assert.ok(tool.description.length > 40, `${tool.name} needs a description`);
		assert.ok(tool.promptSnippet, `${tool.name} needs a prompt snippet`);
		assert.equal(tool.executionMode, "sequential");
		assert.equal(typeof tool.execute, "function");
	}
	assert.deepEqual(events, ["session_shutdown"]);
});

test("jev_run guidelines carry the safety contract and name their tools", () => {
	const { tools } = loadExtension();
	const guidelines = toolNamed(tools, "jev_run").promptGuidelines ?? [];
	const joined = guidelines.join("\n");
	assert.match(joined, /untrusted third-party content/);
	assert.match(joined, /prompt injection/);
	assert.match(joined, /explicit approval for that exact transmission/);
	assert.match(joined, /done_unverified/);
	assert.match(joined, /tracePath/);
	assert.match(joined, /jev_actions/);
	assert.match(joined, /jev_run/);
	for (const guideline of guidelines)
		assert.doesNotMatch(guideline, /\bthis tool\b/i);
	const actionGuidelines =
		toolNamed(tools, "jev_actions").promptGuidelines ?? [];
	assert.ok(actionGuidelines.some((line) => line.includes("jev_run")));
	assert.equal(
		guidelines.filter((line) => line.includes("untrusted third-party content"))
			.length,
		1,
		"shared safety text is attached once so the system prompt does not duplicate it",
	);
	const stopGuidelines = toolNamed(tools, "jev_stop").promptGuidelines ?? [];
	assert.ok(stopGuidelines.some((line) => line.includes("jev_stop")));
});

test("jev_run parameters enforce the documented bounds", () => {
	const { tools } = loadExtension();
	const schema = toolNamed(tools, "jev_run").parameters;
	assert.equal(Value.Check(schema, { goal: "Find cats" }), true);
	assert.equal(
		Value.Check(schema, { goal: "Find cats", url: "https://example.test" }),
		true,
	);
	assert.equal(
		Value.Check(schema, { goal: "Find cats", maxSteps: 60, minProbability: 1 }),
		true,
	);
	assert.equal(Value.Check(schema, {}), false);
	assert.equal(Value.Check(schema, { goal: "" }), false);
	assert.equal(Value.Check(schema, { goal: "x".repeat(12001) }), false);
	assert.equal(Value.Check(schema, { goal: "cats", maxSteps: 61 }), false);
	assert.equal(Value.Check(schema, { goal: "cats", minProbability: 2 }), false);
	assert.equal(Value.Check(schema, { goal: "cats", extra: 1 }), false);
});

test("jev_actions parameters accept the flat action schema", () => {
	const { tools } = loadExtension();
	const schema = toolNamed(tools, "jev_actions").parameters;
	assert.equal(
		Value.Check(schema, {
			actions: [
				{ type: "click", x: 1, y: 2 },
				{ type: "keypress", keys: ["CTRL", "Enter"] },
				{ type: "drag", path: [[0, 0], { x: 5, y: 5 }] },
				{ type: "wait", ms: 500 },
			],
		}),
		true,
	);
	assert.equal(Value.Check(schema, { actions: [] }), false);
	assert.equal(Value.Check(schema, { actions: [{ type: "teleport" }] }), false);
	assert.equal(
		Value.Check(schema, {
			actions: Array.from({ length: 51 }, () => ({ type: "screenshot" })),
		}),
		false,
	);
	assert.equal(Value.Check(schema, { actions: [{ type: "wait", ms: 60000 }] }), false);
});

test("jev_stream and jev_logs parameters stay bounded", () => {
	const { tools } = loadExtension();
	assert.equal(
		Value.Check(toolNamed(tools, "jev_stream").parameters, {
			action: "start",
			intervalMs: 250,
		}),
		true,
	);
	assert.equal(
		Value.Check(toolNamed(tools, "jev_stream").parameters, { action: "watch" }),
		false,
	);
	assert.equal(
		Value.Check(toolNamed(tools, "jev_stream").parameters, {
			action: "start",
			intervalMs: 100,
		}),
		false,
	);
	assert.equal(
		Value.Check(toolNamed(tools, "jev_logs").parameters, {
			afterId: 0,
			limit: 1000,
		}),
		true,
	);
	assert.equal(
		Value.Check(toolNamed(tools, "jev_logs").parameters, { limit: 1001 }),
		false,
	);
});

test("jev_state and jev_stop accept only an empty object", () => {
	const { tools } = loadExtension();
	for (const name of ["jev_state", "jev_stop"]) {
		const schema = toolNamed(tools, name).parameters;
		assert.equal(Value.Check(schema, {}), true);
		assert.equal(Value.Check(schema, { unexpected: true }), false);
	}
});

test("jev_desktop is strict about its arguments and carries the desktop contract", () => {
	const { tools } = loadExtension();
	const tool = toolNamed(tools, "jev_desktop");
	assert.ok(Value.Check(tool.parameters, { bundleId: "com.apple.calculator", goal: "Compute 2 + 2" }));
	assert.equal(Value.Check(tool.parameters, { goal: "no bundle id" }), false);
	assert.equal(Value.Check(tool.parameters, { bundleId: "com.apple.calculator", goal: "x", url: "https://a" }), false);
	const joined = (tool.promptGuidelines ?? []).join("\n");
	assert.match(joined, /untrusted/);
	assert.match(joined, /allowedBundleIds|allowed in the user's configuration/);
	assert.match(joined, /needs_review/);
	assert.match(joined, /done_unverified/);
	assert.match(joined, /never edit that file yourself/);
	assert.match(tool.description, /Closed by default/);
});
