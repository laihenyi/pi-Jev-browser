import assert from "node:assert/strict";
import test from "node:test";
import type { Observation, ObservedTarget } from "../src/driver.ts";
import { verificationGate } from "../src/gate.ts";

const target = (label: string, role = "button"): ObservedTarget => ({
	id: label,
	operation: "CLICK",
	label,
	value: "",
	role,
});
const page = (patch: Partial<Observation>): Observation => ({
	url: "https://example.test/",
	title: "Page",
	text: "",
	targets: [],
	scrollUp: false,
	scrollDown: false,
	...patch,
});

test("a plain-HTML gate is recognised from its text and a control that would pass it", () => {
	const gate = verificationGate(
		page({
			title: "Human verification required",
			text: "Confirm you are a person before continuing.",
			targets: [target("I am a person", "radio"), target("Verify and continue")],
		}),
	);
	assert.deepEqual(gate, { phrase: "Human verification", target: "I am a person" });
});

test("the usual CAPTCHA wordings are recognised", () => {
	for (const text of [
		"I'm not a robot",
		"Verify you are human",
		"Please complete the CAPTCHA to continue",
		"Checking your browser before accessing the site",
		"Press and hold the button",
	]) {
		const gate = verificationGate(page({ text, targets: [target("Verify")] }));
		assert.ok(gate, text);
	}
});

test("text about verification without a control to pass it is not a gate", () => {
	assert.equal(
		verificationGate(
			page({
				text: "How CAPTCHA systems tell humans from bots: a history.",
				targets: [target("Read more"), target("Share")],
			}),
		),
		undefined,
	);
});

test("a verify button without gate text is not a gate", () => {
	assert.equal(
		verificationGate(
			page({
				text: "We sent a code to your address.",
				targets: [target("Verify email")],
			}),
		),
		undefined,
	);
});

test("controls that leave the gate are not evidence of one", () => {
	assert.equal(
		verificationGate(
			page({ text: "Are you a robot?", targets: [target("Close"), target("Learn more")] }),
		),
		undefined,
	);
});
