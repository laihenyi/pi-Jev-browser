import { setTimeout as delay } from "node:timers/promises";
import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import {
	type Driver,
	type Observation,
	type ObservationSnapshot,
	type ObservedTarget,
	StaleObservationError,
} from "./driver.ts";
import { failureCategory, describeError } from "./errors.ts";
import { verificationGate } from "./gate.ts";
import { type JevPolicy, plannedGoal } from "./policy.ts";

export const DEFAULT_TIMEOUT_MS = 100_000;
export const MAX_TIMEOUT_MS = 600_000;

export interface RunInput {
	goal: string;
	maxSteps?: number;
	minProbability?: number;
	/**
	 * Wall-clock budget for the whole run. Defaults to 100 seconds, which fits a
	 * single page or one application window; a task that waits on page loads or
	 * a text helper on every step needs more. Capped at ten minutes.
	 */
	timeoutMs?: number;
}
export interface RunStep {
	step: number;
	operation: string;
	target?: string;
	probability?: number;
	providerConfidence?: unknown;
	status:
		| "attempted"
		| "executed"
		| "decision"
		| "plan"
		| "stale"
		| "text_unavailable";
	latencyMs: number;
	reason?: string;
}

/** Why the loop stopped, independent of the model-reported status. */
export type StopReason =
	| "model_done"
	| "model_blocked"
	| "model_review"
	| "verification_gate"
	| "submit_review"
	| "min_probability"
	| "step_limit"
	| "evaluation_limit"
	| "repeated_action"
	| "stale_observations"
	| "no_progress"
	| "scroll_oscillation"
	| "text_unavailable"
	| "cancelled"
	| "error";

/** Bounded page state captured with the last observation, for agent verification. */
export interface ObservedPage {
	url: string;
	title: string;
	text: string;
}

/**
 * Search results routinely finish rendering after document.readyState is
 * complete, so a DONE decision is only trusted against a settled page.
 */
const DONE_SETTLE_MS = 400;
/** Bounded so a page with a live clock cannot stall the loop forever. */
const MAX_DONE_SETTLE_RETRIES = 2;
/**
 * Alternating SCROLL_UP/SCROLL_DOWN is a two-cycle: repeated_action needs three
 * identical actions, and the no-progress window excludes SCROLL so that a normal
 * scroll sweep is not mistaken for being stuck.
 *
 * Progress cannot be measured by "did the observation change": the observed text
 * is only the part inside the viewport, so every scroll changes it. Direction
 * reversals are counted instead, and any non-scroll action resets the counter.
 * Five alternating scrolls means the loop is oscillating, not exploring.
 */
const MAX_SCROLL_REVERSALS = 4;

/**
 * Identical actions that produced a state this run has already seen. A toggle needs
 * two states to cycle, so the third such action is the earliest honest signal.
 */
const MAX_STATE_REPEATS = 3;
/**
 * Backstop for a control whose every press yields a state that was never seen
 * before. "New state" is not the same as "progress", and an observation cannot
 * tell them apart, so this bounds the damage instead of deciding the question.
 * Deliberately generous: entering twelve identical digits in a row is legitimate.
 */
const MAX_IDENTICAL_ACTIONS = 12;
export type RunStatus =
	| "done_unverified"
	| "blocked"
	| "needs_review"
	| "uncertain"
	| "step_limit"
	| "evaluation_limit"
	| "interrupted";

export interface ActionHistory {
	action: string;
	kind: string;
	text?: string;
	page_changed: boolean;
}
export interface RunMemory {
	goal: string;
	actions: ActionHistory[];
}

export async function runJev(
	input: RunInput,
	options: {
		/**
		 * The surface to drive. The loop knows nothing about how it is observed or
		 * acted on, which is what lets the same loop drive a desktop later.
		 */
		driver: Driver;
		signal?: AbortSignal;
		onStep?: (step: RunStep) => Promise<void>;
		policy: JevPolicy;
		memory?: RunMemory;
		/** Receives the raw error so the caller can log full local diagnostics. */
		onFailure?: (error: unknown, stage: string) => void | Promise<void>;
	},
) {
	if (
		typeof input.goal !== "string" ||
		!input.goal.trim() ||
		input.goal.length > 12000
	)
		throw new Error("goal must contain 1–12000 characters.");
	const maxSteps = input.maxSteps ?? 20;
	if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 60)
		throw new Error("maxSteps must be an integer from 1 to 60.");
	const minProbability = input.minProbability;
	if (
		minProbability !== undefined &&
		(!Number.isFinite(minProbability) ||
			minProbability < 0 ||
			minProbability > 1)
	)
		throw new Error("minProbability must be from 0 to 1.");
	const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS)
		throw new Error(`timeoutMs must be an integer from 1000 to ${MAX_TIMEOUT_MS}.`);
	const signal = AbortSignal.any([
		AbortSignal.timeout(timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	signal.throwIfAborted();
	const policy = options.policy;
	const steps: RunStep[] = [];
	const usage = emptyUsage();
	const memory = options.memory ?? { goal: input.goal, actions: [] };
	if (memory.goal !== input.goal) {
		memory.goal = input.goal;
		memory.actions = [];
	}
	let executed = 0;
	let stage = "observation";
	let lastPage: ObservedPage | undefined;
	/**
	 * The goal the decisions are made against. It starts as the user's words and, when
	 * the policy can plan, becomes those words plus the enumerated plan. The user's
	 * goal itself is never rewritten: memory and reporting keep the original.
	 */
	let goal = input.goal;
	let plan: string[] | undefined;
	let planned = false;
	let lastActionKey: string | undefined;
	/**
	 * Identical actions are only suspicious when they stop producing new state.
	 * Counting them outright was wrong: pressing the same digit three times is
	 * legitimate input, and each press changed the window, so the run was stopped for
	 * making progress. A toggle cycles through states it has already produced, while
	 * entering a digit keeps producing states it has not.
	 */
	let repeatStates: string[] = [];
	let stateRepeats = 0;
	let identicalActions = 0;
	const transitions = new Map<string, number>();
	// Controls that were pressed and changed nothing, twice. A header that carries
	// the sought name, a label that happens to be clickable: offering them again
	// only invites the same no-op, so they leave the question for the rest of the
	// run. Two strikes, not one, so a control that merely needed a moment to load
	// is not written off.
	const inertPresses = new Map<string, number>();
	/** Consecutive non-scroll actions that changed neither the surface nor the question. */
	let fruitless = 0;
	const inert = new Set<string>();
	// Labels read off pixels differ by a space or a separator between reads
	// ("上午9:02", "上午 9:02"), which must not make the same control a new one.
	const loose = (value: string) => value.replace(/[\s\p{P}]+/gu, "");
	const keyOf = (target: ObservedTarget | undefined) =>
		target ? target.identifier || `${target.role ?? ""}|${loose(target.label)}` : "";
	const offered = (data: Observation): Observation =>
		inert.size === 0
			? data
			: { ...data, targets: data.targets.filter((t) => !inert.has(keyOf(t))) };
	let consecutiveStale = 0;
	let scrollDirection: string | undefined;
	let scrollReversals = 0;
	let doneSettleRetries = 0;
	const warnings: string[] = [];
	const textCache = new Map<string, { text: string | null; usage?: ModelUsage }>();
	const started = performance.now();
	let failure: { stage: string; category: string; detail?: string } | undefined;
	// The observation taken after an action is the state the next decision is made
	// on, so it is carried into the next evaluation instead of being read again.
	// On a desktop surface a read is the expensive part of a step.
	let carried: ObservationSnapshot | undefined;
	const finish = (status: RunStatus, message: string, stopReason: StopReason) => {
		void carried?.dispose().catch(() => undefined);
		carried = undefined;
		return {
		failure,
		status,
		message,
		stopReason,
		steps,
		elapsedMs: Math.round(performance.now() - started),
		usage: usage.totalTokens > 0 ? usage : undefined,
		page: lastPage,
		warnings: warnings.length > 0 ? warnings : undefined,
		plan,
	};
	};
	try {
		for (
			let evaluation = 1;
			evaluation <= maxSteps * 2 && executed < maxSteps;
			evaluation++
		) {
			const step = executed + 1;
			stage = "observation";
			signal.throwIfAborted();
			const surface = await options.driver.id();
			const snapshot = carried ?? (await options.driver.observe(signal));
			carried = undefined;
			lastPage = {
				url: snapshot.data.url,
				title: snapshot.data.title,
				text: snapshot.data.text,
			};
			try {
				// A human-verification gate is refused before the policy is consulted: it is
				// not a decision the model gets to make, and the trace says why the run ended.
				const gate = verificationGate(snapshot.data);
				if (gate) {
					await options.onStep?.({
						step,
						operation: "REVIEW",
						target: gate.target,
						status: "decision",
						reason: "verification_gate",
						latencyMs: 0,
					});
					return finish(
						"needs_review",
						`The page presents a human-verification gate (${JSON.stringify(gate.phrase)}, with a control labelled ${JSON.stringify(gate.target)}). Jev does not complete verification challenges; hand this step to the user.`,
						"verification_gate",
					);
				}
				if (!planned && policy.plan) {
					// Plan once, from the initial state, before anything is acted on. A plan
					// that could not be made leaves the goal as the user wrote it.
					planned = true;
					stage = "planning";
					const planStarted = performance.now();
					const result = await policy.plan(snapshot.data, input.goal, signal);
					signal.throwIfAborted();
					if (result && result.length > 0) {
						plan = result;
						goal = plannedGoal(input.goal, result);
					}
					await options.onStep?.({
						step,
						operation: "PLAN",
						status: "plan",
						reason: result && result.length > 0 ? result.join(" | ") : "no_plan",
						latencyMs: Math.round(performance.now() - planStarted),
					});
				}
				const decisionStarted = performance.now();
				stage = "evaluation";
				const decision = await policy.choose(
					offered(snapshot.data),
					goal,
					memory.actions,
					signal,
				);
				signal.throwIfAborted();
				await options.onStep?.({
					step,
					operation: decision.operation,
					target: decision.target?.label,
					probability: decision.probability,
					providerConfidence: decision.providerConfidence,
					status: "decision",
					latencyMs: Math.round(performance.now() - decisionStarted),
				});
				if (!["CLICK", "SELECT"].includes(decision.operation))
					await snapshot.assertFresh();
				// A driver that moved underneath the run must not be acted on.
				if (surface !== (await options.driver.id()))
					throw new StaleObservationError("Active tab changed.");
				if (decision.operation === "REVIEW")
					return finish(
						"needs_review",
						"The agent must inspect the page and handle the next action with appropriate user authorization.",
						"model_review",
					);
				// Return in a field that cannot confirm through its own controls sends a
				// message or runs a command. That is not a step the model gets to take on
				// its own: the rules ask it to review first, and on a chat composer it
				// pressed first and reviewed after. The loop refuses it mechanically.
				if (decision.target?.role === "submit") {
					await options.onStep?.({
						step,
						operation: "REVIEW",
						target: decision.target.label,
						status: "decision",
						reason: "submit_review",
						latencyMs: Math.round(performance.now() - decisionStarted),
					});
					return finish(
						"needs_review",
						`The next step submits ${JSON.stringify(decision.target.label)} (Return in a field with no confirm control), which sends or executes what was typed. Hand this step to the user.`,
						"submit_review",
					);
				}
				if (decision.operation === "BLOCKED")
					return finish(
						"blocked",
						"Jev cannot advance this goal with supported actions.",
						"model_blocked",
					);
				if (
					minProbability !== undefined &&
					(decision.probability === undefined ||
						!Number.isFinite(decision.probability) ||
						decision.probability < minProbability)
				) {
					return finish(
						"uncertain",
						"Selected-choice probability did not meet the requested minProbability; inspect the decision trace.",
						"min_probability",
					);
				}
				if (decision.operation === "DONE") {
					// Re-read after a short settle: a loading shell that already has page
					// chrome can otherwise look like proof of completion.
					await delay(DONE_SETTLE_MS, undefined, { signal });
					const settled = await options.driver.observe(signal);
					let changed: boolean;
					try {
						changed =
							JSON.stringify(settled.data) !== JSON.stringify(snapshot.data);
					} finally {
						await settled.dispose().catch(() => undefined);
					}
					if (changed && doneSettleRetries < MAX_DONE_SETTLE_RETRIES) {
						doneSettleRetries++;
						await options.onStep?.({
							step,
							operation: "DONE",
							status: "stale",
							reason: "page_changed_before_done",
							latencyMs: Math.round(performance.now() - decisionStarted),
						});
						continue;
					}
					if (changed)
						warnings.push(
							"page_changed_during_done_check",
						);
					// The agent verifies against this, so report the freshest text.
					lastPage = {
						url: settled.data.url,
						title: settled.data.title,
						text: settled.data.text,
					};
					return finish(
						"done_unverified",
						"Jev believes the goal is complete. The agent must independently verify the outcome.",
						"model_done",
					);
				}
				let text: string | undefined;
				if (decision.operation === "TYPE_TEXT") {
					if (!decision.target) throw new Error("Missing text target.");
					stage = "text_helper";
					const cacheKey = JSON.stringify([
						snapshot.data,
						goal,
						decision.target,
						memory.actions,
					]);
					let generated = textCache.get(cacheKey);
					if (generated === undefined) {
						generated = await policy.text(
							snapshot.data,
							goal,
							decision.target,
							memory.actions,
							signal,
						);
						textCache.set(cacheKey, generated);
					}
					addUsage(usage, generated.usage);
					if (generated.text === null) {
						// The helper declined to invent a value. Only the agent knows the
						// user's intent, so hand the field back instead of failing the run.
						await options.onStep?.({
							step,
							operation: "TYPE_TEXT",
							target: decision.target.label,
							status: "text_unavailable",
							reason: "helper_declined",
							latencyMs: Math.round(performance.now() - decisionStarted),
						});
						return finish(
							"needs_review",
							`The text helper declined to produce a value for the field ${JSON.stringify(decision.target.label)}. Supply the value with jev_actions or clarify the goal, then run again.`,
							"text_unavailable",
						);
					}
					text = generated.text;
				}
				if (surface !== (await options.driver.id()))
					throw new StaleObservationError("Active tab changed.");
				signal.throwIfAborted();
				const entry: RunStep = {
					step,
					operation: decision.operation,
					target: decision.target?.label,
					probability: decision.probability,
					providerConfidence: decision.providerConfidence,
					status: "attempted",
					latencyMs: Math.round(performance.now() - decisionStarted),
				};
				steps.push(entry);
				await options.onStep?.({ ...entry });
				stage = "action";
				try {
					await snapshot.execute(
						decision.operation,
						decision.target,
						text,
						signal,
					);
				} catch (error) {
					if (error instanceof StaleObservationError) steps.pop();
					throw error;
				}
				executed++;
				entry.status = "executed";
				consecutiveStale = 0;
				// The guard key names the control, not its position: on a page that
				// re-renders (a video site, a search result list) the same button gets
				// a new index on every observation, and a guard keyed on the index
				// would see twelve different actions where a person sees one.
				const actionKey = `${decision.operation}:${
					decision.target
						? decision.target.identifier ||
							`${decision.target.role ?? ""}|${decision.target.label}`
						: ""
				}`;
				await options.onStep?.({ ...entry });
				// Let event handlers render before the next read, without screenshot or network-idle waits.
				await delay(
					decision.target?.role === "radio" || decision.operation === "SELECT"
						? 600
						: decision.operation === "TYPE_TEXT" ||
								decision.operation.startsWith("SCROLL")
							? 150
							: 350,
					undefined,
					{
						signal,
					},
				);
				stage = "post_action_observation";
				const after = await options.driver.observe(signal);
				try {
					const pageChanged =
						loose(JSON.stringify(after.data)) !== loose(JSON.stringify(snapshot.data));
					let withdrawn = false;
					const stateKey = loose(JSON.stringify(after.data));
					if (decision.target && !decision.operation.startsWith("SCROLL")) {
						const key = keyOf(decision.target);
						const strikes = pageChanged ? 0 : (inertPresses.get(key) ?? 0) + 1;
						inertPresses.set(key, strikes);
						if (strikes >= 2 && !inert.has(key)) {
							inert.add(key);
							withdrawn = true;
							// Withdrawing a control changes the question even though the surface
							// did not move, so the no-progress count starts again from here.
							fruitless = 0;
						}
					}
					if (decision.operation !== "WAIT" && !decision.operation.startsWith("SCROLL"))
						fruitless = pageChanged ? 0 : fruitless + 1;
					memory.actions.push({
						action: decision.target?.label ?? decision.operation,
						kind: decision.operation,
						text,
						page_changed: pageChanged,
					});
					memory.actions.splice(0, Math.max(0, memory.actions.length - 10));
					// The repeat guard lives here, after the state is known, because an identical
					// action is only suspicious when it stops producing new state.
					const sameAction =
						decision.target !== undefined &&
						actionKey === lastActionKey &&
						!decision.operation.startsWith("SCROLL");
					if (sameAction) {
						identicalActions++;
						// A repeat whose result this run already saw is a cycle, not progress: a
						// toggle returns to where it was, an entry field keeps moving forward.
						if (!pageChanged || repeatStates.includes(stateKey)) stateRepeats++;
					} else {
						identicalActions = 1;
						stateRepeats = pageChanged ? 0 : 1;
						repeatStates = [loose(JSON.stringify(snapshot.data))];
					}
					if (pageChanged) {
						repeatStates.push(stateKey);
						if (repeatStates.length > 8) repeatStates.shift();
					}
					lastActionKey = actionKey;
					if (stateRepeats >= MAX_STATE_REPEATS) {
						// A widget that toggles on click, or re-renders without advancing, keeps
						// "succeeding" while the goal stands still.
						return finish(
							"blocked",
							`${decision.operation} on ${JSON.stringify(decision.target?.label ?? actionKey)} executed ${stateRepeats} times without producing a new state. The control likely toggles or needs manual handling; continue with jev_actions.`,
							"repeated_action",
						);
					}
					if (identicalActions >= MAX_IDENTICAL_ACTIONS) {
						// Backstop for the undecidable case: a control whose every press yields a
						// state that was never seen. Whether that is progress cannot be read off the
						// observation, so this bounds the damage instead of deciding the question.
						return finish(
							"blocked",
							`${decision.operation} on ${JSON.stringify(decision.target?.label ?? actionKey)} executed ${identicalActions} times in a row with changing state. Stopping before the step budget is consumed; continue with jev_actions if the goal is still worth pursuing.`,
							"repeated_action",
						);
					}
					// A two-control cycle (tab A, tab B, tab A, ...) never repeats an action
					// consecutively, so the guards above cannot see it. The same action
					// landing on the same state three times is a cycle whatever else runs
					// in between.
					const transition = `${actionKey}\u0000${stateKey}`;
					const seen =
						decision.target !== undefined && !decision.operation.startsWith("SCROLL")
							? (transitions.get(transition) ?? 0) + 1
							: 0;
					if (seen > 0) transitions.set(transition, seen);
					// An action that has led to this same state before produces nothing new,
					// whether the surface moved or not (a bubble that highlights on click, a
					// tab that reopens): its control is withdrawn from the next question, as
					// a control that changes nothing is. The block below is for a policy that
					// keeps choosing it anyway.
					if (seen === 2 && decision.target && !inert.has(keyOf(decision.target))) {
						inert.add(keyOf(decision.target));
						withdrawn = true;
						fruitless = 0;
					}
					// A control withdrawn this step cannot be chosen again, so the cycle it
					// made is over; stopping now would end a run the next question fixes.
					if (seen >= MAX_STATE_REPEATS && !withdrawn)
						return finish(
							"blocked",
							`${decision.operation} on ${JSON.stringify(decision.target?.label ?? actionKey)} led to the same state ${seen} times; the run is cycling. Continue with jev_actions or revise the goal.`,
							"repeated_action",
						);
					// Only state-changing actions count as progress claims. A scroll changes
					// what the agent sees by definition, and the page text of a long document
					// often stays identical until new content comes into view.
					if (fruitless >= 3)
						return finish(
							"blocked",
							"Three actions produced no observable progress.",
							"no_progress",
						);
					if (decision.operation.startsWith("SCROLL")) {
						scrollReversals =
							decision.operation === scrollDirection || scrollDirection === undefined
								? 0
								: scrollReversals + 1;
						scrollDirection = decision.operation;
					} else {
						scrollDirection = undefined;
						scrollReversals = 0;
					}
					if (scrollReversals >= MAX_SCROLL_REVERSALS)
						return finish(
							"blocked",
							`Scroll direction alternated ${scrollReversals} times, so the loop is oscillating rather than exploring. Continue with jev_actions or revise the goal.`,
							"scroll_oscillation",
						);
					carried = after;
				} finally {
					if (carried !== after) await after.dispose().catch(() => undefined);
				}
			} catch (error) {
				if (!(error instanceof StaleObservationError)) throw error;
				consecutiveStale++;
				await options.onStep?.({
					step,
					operation: "REOBSERVE",
					status: "stale",
					reason: /covered/.test(error.message)
						? "target_unavailable"
						: /disappeared/.test(error.message)
							? "target_disappeared"
							: "observation_changed",
					latencyMs: 0,
				});
				if (consecutiveStale >= 4)
					return finish(
						"blocked",
						`Four consecutive observations were invalidated before an action could run, so the page changed on every attempt. Continue with jev_actions; this widget is outside the automatic DOM loop.`,
						"stale_observations",
					);
			} finally {
				await snapshot.dispose().catch(() => undefined);
			}
		}
		return finish(
			executed >= maxSteps ? "step_limit" : "evaluation_limit",
			executed >= maxSteps
				? "Action budget reached. Inspect current progress before continuing."
				: "Evaluation budget reached because decisions could not be executed. Inspect stale reasons in the trace.",
			executed >= maxSteps ? "step_limit" : "evaluation_limit",
		);
	} catch (error) {
		await carried?.dispose().catch(() => undefined);
		try {
			await options.onFailure?.(error, stage);
		} catch {
			/* Diagnostics must never mask the original failure. */
		}
		const forModel =
			failureCategory(error) === "configuration" ||
			failureCategory(error) === "text_helper_invalid_output";
		failure = {
			stage,
			category: forModel
				? failureCategory(error)
				: signal.aborted
					? "cancelled"
					: (options.driver.readFailureCategory?.(error) ??
						(error instanceof Error && error.name === "TimeoutError"
							? "timeout"
							: "unexpected_error")),
			detail: describeError(error),
		};
		// Provider errors may contain request bodies with page text. Tool output keeps
		// only a safe summary; the full error goes to the run's errors.log instead.
		// An attempted action may have taken effect and is never retried.
		return finish(
			"interrupted",
			forModel && error instanceof Error
				? `Run failed during ${stage}: ${error.message}`
				: signal.aborted
					? "Run cancelled or timed out. Inspect the page before any further actions."
					: `Run failed during ${stage} [${describeError(error)}]. Read errors.log in the run directory for the full provider error; attempted actions may have taken effect and were not retried.`,
			signal.aborted ? "cancelled" : "error",
		);
	}
}

function emptyUsage(): ModelUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsage(target: ModelUsage, usage: ModelUsage | undefined) {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost.input += usage.cost?.input ?? 0;
	target.cost.output += usage.cost?.output ?? 0;
	target.cost.cacheRead += usage.cost?.cacheRead ?? 0;
	target.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
	target.cost.total += usage.cost?.total ?? 0;
}
