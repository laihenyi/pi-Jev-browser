import assert from "node:assert/strict";
import test from "node:test";
import {
	type Driver,
	type Observation,
	type ObservationSnapshot,
	type ObservedTarget,
} from "../src/driver.ts";
import { type RunStep, runJev } from "../src/loop.ts";

type RunStepLike = RunStep;
import { type JevPolicy } from "../src/policy.ts";

/**
 * These tests drive the decision loop with a driver that has no browser under it:
 * no Playwright, no DOM, no page. If the loop passes them, its guards, its stop
 * reasons and its traces are genuinely independent of the web, which is the
 * precondition for reusing the loop for a different surface (a desktop, a terminal,
 * a device) by writing another driver.
 */

interface FakeDriver {
	driver: Driver;
	executed: Array<{ operation: string; target?: ObservedTarget; text?: string }>;
}

function fakeDriver(options: {
	observations: Observation[];
	/** A normal surface advances when an action lands; an inert one does not. */
	advanceOnExecute?: boolean;
	/** A hijacked surface reports a new identity on every read. */
	moveSurface?: boolean;
}): FakeDriver {
	const executed: FakeDriver["executed"] = [];
	let index = 0;
	let identity = 0;
	const current = () =>
		options.observations[Math.min(index, options.observations.length - 1)];
	const snapshot = (): ObservationSnapshot => ({
		data: current(),
		async execute(operation: string, target?: ObservedTarget, text?: string) {
			executed.push({ operation, target, text });
			if (options.advanceOnExecute !== false) index++;
		},
		async assertFresh() {},
		async dispose() {},
	});
	return {
		executed,
		driver: {
			id: () => (options.moveSurface ? ++identity : "surface-1"),
			observe: async () => snapshot(),
		},
	};
}

const target = (id: string, operation: ObservedTarget["operation"] = "CLICK"): ObservedTarget => ({
	id,
	operation,
	label: id,
	value: "",
});

const observation = (patch: Partial<Observation> = {}): Observation => ({
	url: "surface://window-1",
	title: "Fake surface",
	text: "content",
	targets: [],
	scrollUp: true,
	scrollDown: true,
	...patch,
});

/** A policy that answers from a scripted list and never calls a model. */
const scripted = (
	decisions: Array<Partial<{ operation: string; target: ObservedTarget; probability: number }>>,
	text: JevPolicy["text"] = async () => {
		throw new Error("Unexpected text helper call");
	},
): JevPolicy => {
	let call = 0;
	return {
		async choose() {
			const decision = decisions[Math.min(call++, decisions.length - 1)];
			return {
				operation: decision.operation ?? "CLICK",
				target: decision.target,
				probability: decision.probability ?? 0.9,
			} as never;
		},
		text,
	};
};

test("a driver with no browser underneath can complete a run", async () => {
	const fake = fakeDriver({
		observations: [observation({ targets: [target("go")] }), observation({ text: "done" })],
	});
	const result = await runJev(
		{ goal: "Reach the end" },
		{ driver: fake.driver, policy: scripted([{ target: target("go") }, { operation: "DONE" }]) },
	);
	assert.equal(result.status, "done_unverified");
	assert.equal(result.stopReason, "model_done");
	assert.equal(result.steps.filter((step) => step.status === "executed").length, 1);
	assert.equal(fake.executed.length, 1);
	assert.equal(fake.executed[0].target?.id, "go");
	// The run reports the freshest surface state, not the one it decided from.
	assert.equal(result.page?.text, "done");
});

test("REVIEW and BLOCKED stop before the driver is asked to act", async () => {
	const review = fakeDriver({ observations: [observation({ targets: [target("pay")] })] });
	const reviewResult = await runJev(
		{ goal: "Buy it" },
		{ driver: review.driver, policy: scripted([{ operation: "REVIEW" }]) },
	);
	assert.equal(reviewResult.status, "needs_review");
	assert.equal(reviewResult.stopReason, "model_review");
	assert.equal(review.executed.length, 0);

	const blocked = fakeDriver({ observations: [observation()] });
	const blockedResult = await runJev(
		{ goal: "Do the impossible" },
		{ driver: blocked.driver, policy: scripted([{ operation: "BLOCKED" }]) },
	);
	assert.equal(blockedResult.status, "blocked");
	assert.equal(blockedResult.stopReason, "model_blocked");
	assert.equal(blocked.executed.length, 0);
});

test("a text helper that declines hands the field back instead of acting", async () => {
	const fake = fakeDriver({ observations: [observation({ targets: [target("q", "TYPE_TEXT")] })] });
	const result = await runJev(
		{ goal: "Type something" },
		{
			driver: fake.driver,
			policy: scripted([{ operation: "TYPE_TEXT", target: target("q", "TYPE_TEXT") }], async () => ({
				text: null,
			})),
		},
	);
	assert.equal(result.status, "needs_review");
	assert.equal(result.stopReason, "text_unavailable");
	assert.equal(fake.executed.length, 0);
});

test("repeating one action on an inert surface stops as repeated_action", async () => {
	const fake = fakeDriver({
		observations: [observation({ targets: [target("toggle")] })],
		advanceOnExecute: false,
	});
	const result = await runJev(
		{ goal: "Advance", maxSteps: 10 },
		{ driver: fake.driver, policy: scripted([{ target: target("toggle") }]) },
	);
	assert.equal(result.stopReason, "repeated_action");
	assert.equal(fake.executed.length, 3);
});

test("three different actions with no surface change stop as no_progress", async () => {
	const fake = fakeDriver({
		observations: [observation({ targets: [target("a"), target("b"), target("c")] })],
		advanceOnExecute: false,
	});
	let call = 0;
	const policy: JevPolicy = {
		async choose(data) {
			return { operation: "CLICK", target: data.targets[call++] } as never;
		},
		async text() {
			return { text: null };
		},
	};
	const result = await runJev({ goal: "Advance", maxSteps: 10 }, { driver: fake.driver, policy });
	assert.equal(result.stopReason, "no_progress");
	assert.equal(fake.executed.length, 3);
});

test("alternating scrolls stop as scroll_oscillation on a driver that cannot scroll", async () => {
	const fake = fakeDriver({
		observations: [observation()],
		advanceOnExecute: false,
	});
	let call = 0;
	const policy: JevPolicy = {
		async choose() {
			return { operation: call++ % 2 === 0 ? "SCROLL_DOWN" : "SCROLL_UP" } as never;
		},
		async text() {
			return { text: null };
		},
	};
	const result = await runJev(
		{ goal: "Find something that is not there", maxSteps: 12 },
		{ driver: fake.driver, policy },
	);
	assert.equal(result.stopReason, "scroll_oscillation");
	assert.equal(fake.executed.length, 5);
});

test("a driver whose surface keeps moving stops as stale_observations", async () => {
	// This is the tab-hijack guard, generalised: the loop refuses to act on a
	// surface that changed identity underneath the decision.
	const fake = fakeDriver({ observations: [observation()], moveSurface: true });
	const result = await runJev(
		{ goal: "Act on whatever this is", maxSteps: 8 },
		{ driver: fake.driver, policy: scripted([{ target: target("x") }]) },
	);
	assert.equal(result.status, "blocked");
	assert.equal(result.stopReason, "stale_observations");
	assert.equal(fake.executed.length, 0, "nothing may run on a surface that moved");
});

test("the step budget still bounds a driver that keeps changing", async () => {
	const fake = fakeDriver({
		observations: [
			observation({ targets: [target("one")] }),
			observation({ targets: [target("two")] }),
			observation({ targets: [target("three")] }),
		],
	});
	let call = 0;
	const policy: JevPolicy = {
		async choose(data) {
			return { operation: "CLICK", target: data.targets[call % data.targets.length] } as never;
		},
		async text() {
			return { text: null };
		},
	};
	const result = await runJev({ goal: "Keep going", maxSteps: 3 }, { driver: fake.driver, policy });
	assert.equal(result.stopReason, "step_limit");
	assert.equal(fake.executed.length, 3);
});

test("driver read failures are classified by the driver, not by the loop", async () => {
	const failing: Driver = {
		id: () => "surface-1",
		async observe() {
			throw Object.assign(new Error("window closed mid-read"), { name: "DriverError" });
		},
		readFailureCategory: () => "navigation_context",
	};
	const result = await runJev(
		{ goal: "Read a window that goes away" },
		{ driver: failing, policy: scripted([{ operation: "DONE" }]) },
	);
	assert.equal(result.status, "interrupted");
	assert.equal(result.failure?.category, "navigation_context");
	assert.equal(result.failure?.stage, "observation");
});

test("repeated presses that keep producing new state are allowed", async () => {
	// Entering "1111111111" is ten identical presses. Each one changes the surface,
	// which is progress, so the repeat guard must not stop the run. Before this
	// criterion the run was killed after three presses while it was working.
	const states = Array.from({ length: 10 }, (_, index) =>
		observation({ text: "1".repeat(index + 1), targets: [target("one")] }),
	);
	const fake = fakeDriver({ observations: states });
	const result = await runJev(
		{ goal: "Enter ten ones", maxSteps: 10 },
		{ driver: fake.driver, policy: scripted([{ target: target("one") }]) },
	);
	assert.equal(fake.executed.length, 10, "every press must have been sent");
	assert.equal(result.stopReason, "step_limit", "the budget ends it, not the repeat guard");
});

test("a control that cycles between two states is still caught", async () => {
	// The case the guard was added for: a widget that toggles on click. It changes
	// the surface every time, but only ever returns to a state already seen.
	const states = ["closed", "open", "closed", "open", "closed", "open"].map((text) =>
		observation({ text, targets: [target("toggle")] }),
	);
	const fake = fakeDriver({ observations: states });
	const result = await runJev(
		{ goal: "Open the widget", maxSteps: 20 },
		{ driver: fake.driver, policy: scripted([{ target: target("toggle") }]) },
	);
	assert.equal(result.status, "blocked");
	assert.equal(result.stopReason, "repeated_action");
	assert.equal(fake.executed.length, 4, "one extra press is needed to see the cycle");
	assert.match(result.message, /without producing a new state/);
});

test("a control whose every press yields novel state is bounded by the backstop", async () => {
	// "New state" is not the same as "progress", and the observation cannot tell the
	// two apart, so this ends with a reason instead of consuming the whole budget.
	const states = Array.from({ length: 30 }, (_, index) =>
		observation({ text: `tick ${index}`, targets: [target("spinner")] }),
	);
	const fake = fakeDriver({ observations: states });
	const result = await runJev(
		{ goal: "Watch it spin", maxSteps: 30 },
		{ driver: fake.driver, policy: scripted([{ target: target("spinner") }]) },
	);
	assert.equal(result.status, "blocked");
	assert.equal(result.stopReason, "repeated_action");
	assert.equal(fake.executed.length, 12);
	assert.match(result.message, /in a row with changing state/);
});

test("a policy that can plan runs against its plan, planned once from the initial state", async () => {
	const fake = fakeDriver({
		observations: [
			observation({ text: "0", targets: [target("One"), target("Equals")] }),
			observation({ text: "1", targets: [target("One"), target("Equals")] }),
			observation({ text: "1 =", targets: [target("One"), target("Equals")] }),
		],
	});
	const goals: string[] = [];
	const planCalls: Array<{ text: string; goal: string }> = [];
	const steps: RunStepLike[] = [];
	const base = scripted([{ target: target("One") }, { target: target("Equals") }, { operation: "DONE" }]);
	const policy: JevPolicy = {
		...base,
		async choose(data, goal, history, signal) {
			goals.push(goal);
			return base.choose(data, goal, history, signal);
		},
		async plan(data, goal) {
			planCalls.push({ text: data.text, goal });
			return ['press "1" (identifier One)', 'press "=" (identifier Equals)'];
		},
	};
	const result = await runJev(
		{ goal: "Enter 1 and press equals" },
		{ driver: fake.driver, policy, onStep: async (step) => void steps.push(step) },
	);
	assert.equal(result.status, "done_unverified");
	// Planned exactly once, from the first observation, against the user's own goal.
	assert.deepEqual(planCalls, [{ text: "0", goal: "Enter 1 and press equals" }]);
	assert.deepEqual(result.plan, ['press "1" (identifier One)', 'press "=" (identifier Equals)']);
	// Every decision saw the user's words plus the enumerated plan.
	assert.equal(goals.length, 3);
	for (const goal of goals) {
		assert.match(goal, /^Enter 1 and press equals\n/);
		assert.match(goal, /1\. press "1" \(identifier One\)\n2\. press "=" \(identifier Equals\)/);
	}
	// The plan is traced so the agent can read what the run was following.
	const traced = steps.filter((step) => step.status === "plan");
	assert.equal(traced.length, 1);
	assert.equal(traced[0].operation, "PLAN");
	assert.match(String(traced[0].reason), /identifier One\) \| press "="/);
	assert.equal(fake.executed.length, 2);
});

test("a planner that declines leaves the goal exactly as the user wrote it", async () => {
	const fake = fakeDriver({
		observations: [observation({ targets: [target("go")] }), observation({ text: "done" })],
	});
	const goals: string[] = [];
	const steps: RunStepLike[] = [];
	const base = scripted([{ target: target("go") }, { operation: "DONE" }]);
	const policy: JevPolicy = {
		...base,
		async choose(data, goal, history, signal) {
			goals.push(goal);
			return base.choose(data, goal, history, signal);
		},
		async plan() {
			return null;
		},
	};
	const result = await runJev(
		{ goal: "Reach the end" },
		{ driver: fake.driver, policy, onStep: async (step) => void steps.push(step) },
	);
	assert.equal(result.status, "done_unverified");
	assert.equal(result.plan, undefined);
	assert.deepEqual(goals, ["Reach the end", "Reach the end"]);
	assert.deepEqual(
		steps.filter((step) => step.status === "plan").map((step) => step.reason),
		["no_plan"],
	);
});

test("a policy without a planner never sees a plan step", async () => {
	const fake = fakeDriver({ observations: [observation({ text: "done" })] });
	const steps: RunStepLike[] = [];
	await runJev(
		{ goal: "Nothing to do" },
		{ driver: fake.driver, policy: scripted([{ operation: "DONE" }]), onStep: async (step) => void steps.push(step) },
	);
	assert.equal(steps.some((step) => step.status === "plan"), false);
});

test("a human-verification gate ends the run before the policy is consulted", async () => {
	const fake = fakeDriver({
		observations: [
			observation({
				title: "Human verification required",
				text: "Confirm you are a person before continuing.",
				targets: [target("I am a person"), target("Verify and continue")],
			}),
		],
	});
	let asked = 0;
	const steps: RunStepLike[] = [];
	const base = scripted([{ target: target("Verify and continue") }]);
	const policy: JevPolicy = {
		...base,
		async choose(data, goal, history, signal) {
			asked++;
			return base.choose(data, goal, history, signal);
		},
		async plan() {
			asked++;
			return null;
		},
	};
	const result = await runJev(
		{ goal: "Complete the human verification check and continue" },
		{ driver: fake.driver, policy, onStep: async (step) => void steps.push(step) },
	);
	assert.equal(result.status, "needs_review");
	assert.equal(result.stopReason, "verification_gate");
	assert.match(result.message, /Human verification/);
	assert.match(result.message, /"I am a person"/);
	assert.equal(asked, 0);
	assert.equal(fake.executed.length, 0);
	assert.deepEqual(
		steps.map((step) => [step.operation, step.status, step.reason]),
		[["REVIEW", "decision", "verification_gate"]],
	);
});

test("Return in a field without a confirm control is handed to the user before it runs", async () => {
	const composer: ObservedTarget = { id: "3", operation: "TYPE_TEXT", label: "Message", value: "hello", role: "AXTextArea" };
	const submit: ObservedTarget = { id: "3:return", operation: "CLICK", label: "⏎ Message", value: "hello", role: "submit" };
	const fake = fakeDriver({ observations: [observation({ targets: [composer, submit] })] });
	const steps: RunStepLike[] = [];
	const result = await runJev(
		{ goal: "Send hello" },
		{ driver: fake.driver, policy: scripted([{ target: submit }]), onStep: async (step) => void steps.push(step) },
	);
	assert.equal(result.status, "needs_review");
	assert.equal(result.stopReason, "submit_review");
	assert.match(result.message, /⏎ Message/);
	assert.equal(fake.executed.length, 0, "nothing was sent");
	assert.deepEqual(
		steps.map((step) => [step.operation, step.status, step.reason]),
		[["CLICK", "decision", undefined], ["REVIEW", "decision", "submit_review"]],
	);
});

test("a control that changed nothing twice is no longer offered", async () => {
	const header = target("Alice");
	const composer = target("Message", "TYPE_TEXT");
	const fake = fakeDriver({ observations: [observation({ targets: [header, composer] })], advanceOnExecute: false });
	const seen: string[][] = [];
	const base = scripted([{ target: header }, { target: header }, { operation: "DONE" }]);
	const policy: JevPolicy = {
		...base,
		async choose(data, goal, history, signal) {
			seen.push(data.targets.map((t) => t.label));
			return base.choose(data, goal, history, signal);
		},
	};
	const result = await runJev({ goal: "Message Alice" }, { driver: fake.driver, policy });
	assert.equal(fake.executed.length, 2);
	assert.deepEqual(seen, [["Alice", "Message"], ["Alice", "Message"], ["Message"]], "after two inert presses the header is gone from the question");
	assert.equal(result.stopReason, "model_done");
});
