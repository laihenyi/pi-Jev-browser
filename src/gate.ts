import type { Observation } from "./driver.ts";

/**
 * Human-verification gates are refused before any decision is made.
 *
 * The REVIEW rule tells the decision layer to stop at a CAPTCHA, and on the real
 * reCAPTCHA demo it does, but only because that widget lives in an iframe the loop
 * cannot see. Given the same gate as plain DOM controls it clicked through and
 * reported success (benchmark `jev-verification-gate`, a documented gap until now).
 * Whether to complete a challenge that exists to keep automation out is not a
 * judgement call to leave to a model, so the loop makes it: when the observed text
 * announces a gate and a control offers to pass it, the run ends in needs_review
 * before the policy is consulted.
 *
 * Both conditions are required. Text alone would stop on an article about CAPTCHAs;
 * a control alone would stop on every "Verify email" button. The cost of a false
 * positive is a handoff to the human, never a wrong action, so the phrases lean
 * towards recall within that constraint.
 */
const GATE_TEXT =
	/\b(?:captcha|recaptcha|hcaptcha|turnstile|human verification|verification (?:challenge|required)|verify (?:that )?you(?:'re| are) (?:a )?(?:human|person)|are you (?:a )?(?:human|robot)|i(?:'m| am) not a robot|not a robot|confirm (?:that )?you(?:'re| are) (?:a )?(?:human|person)|prove (?:that )?you(?:'re| are) (?:not a robot|(?:a )?human)|press and hold|slide to verify|checking your browser)\b/i;

const GATE_TARGET = /verif|robot|human|person|captcha|challenge|press and hold|slide|continue|i am|i'm/i;

/** Controls that leave the gate rather than pass it are not evidence of one. */
const NOT_A_GATE_TARGET = /^(?:close|dismiss|cancel|back|go back|help|learn more|privacy|terms)$/i;

export interface VerificationGate {
	/** The phrase that announced the gate, as it appeared. */
	phrase: string;
	/** The label of the control that would pass it. */
	target: string;
}

export function verificationGate(observation: Observation): VerificationGate | undefined {
	const phrase = GATE_TEXT.exec(`${observation.title}\n${observation.text}`)?.[0];
	if (!phrase) return undefined;
	const target = observation.targets.find(
		(candidate) =>
			GATE_TARGET.test(candidate.label) && !NOT_A_GATE_TARGET.test(candidate.label.trim()),
	);
	if (!target) return undefined;
	return { phrase, target: target.label };
}
