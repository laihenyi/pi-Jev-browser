import { setTimeout as delay } from "node:timers/promises";
import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import type { Page } from "playwright";
import { failureCategory, describeError } from "./errors.ts";
import {
	isNavigationReadError,
	observe,
	StaleObservationError,
} from "./observe.ts";
import { type JevPolicy } from "./policy.ts";

export interface RunInput {
	goal: string;
	maxSteps?: number;
	minProbability?: number;
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
		page: () => Page;
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
	const signal = AbortSignal.any([
		AbortSignal.timeout(100_000),
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
	let lastActionKey: string | undefined;
	let repeatedActions = 0;
	let consecutiveStale = 0;
	let scrollDirection: string | undefined;
	let scrollReversals = 0;
	let doneSettleRetries = 0;
	const warnings: string[] = [];
	const textCache = new Map<string, { text: string | null; usage?: ModelUsage }>();
	const started = performance.now();
	let failure: { stage: string; category: string; detail?: string } | undefined;
	const finish = (status: RunStatus, message: string, stopReason: StopReason) => ({
		failure,
		status,
		message,
		stopReason,
		steps,
		elapsedMs: Math.round(performance.now() - started),
		usage: usage.totalTokens > 0 ? usage : undefined,
		page: lastPage,
		warnings: warnings.length > 0 ? warnings : undefined,
	});
	try {
		for (
			let evaluation = 1;
			evaluation <= maxSteps * 2 && executed < maxSteps;
			evaluation++
		) {
			const step = executed + 1;
			stage = "observation";
			signal.throwIfAborted();
			const page = options.page();
			const snapshot = await observe(page, signal);
			lastPage = {
				url: snapshot.data.url,
				title: snapshot.data.title,
				text: snapshot.data.text,
			};
			try {
				const decisionStarted = performance.now();
				stage = "evaluation";
				const decision = await policy.choose(
					snapshot.data,
					input.goal,
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
				if (page !== options.page())
					throw new StaleObservationError("Active tab changed.");
				if (decision.operation === "REVIEW")
					return finish(
						"needs_review",
						"The agent must inspect the page and handle the next action with appropriate user authorization.",
						"model_review",
					);
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
					const settled = await observe(options.page(), signal);
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
						input.goal,
						decision.target,
						memory.actions,
					]);
					let generated = textCache.get(cacheKey);
					if (generated === undefined) {
						generated = await policy.text(
							snapshot.data,
							input.goal,
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
							`The text helper declined to produce a value for the field ${JSON.stringify(decision.target.label)}. Supply the value with browser_actions or clarify the goal, then run again.`,
							"text_unavailable",
						);
					}
					text = generated.text;
				}
				if (page !== options.page())
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
				const actionKey = `${decision.operation}:${decision.target?.id ?? ""}`;
				repeatedActions =
					decision.target !== undefined &&
					actionKey === lastActionKey &&
					!decision.operation.startsWith("SCROLL")
						? repeatedActions + 1
						: 1;
				lastActionKey = actionKey;
				await options.onStep?.({ ...entry });
				if (repeatedActions >= 3) {
					// Some widgets toggle on click or re-render after every interaction, so
					// identical actions keep "succeeding" while the goal never advances.
					return finish(
						"blocked",
						`${decision.operation} on ${JSON.stringify(decision.target?.label ?? actionKey)} executed ${repeatedActions} times without advancing the goal. The control likely toggles or needs manual handling; continue with browser_actions.`,
						"repeated_action",
					);
				}
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
				const after = await observe(options.page(), signal);
				try {
					const pageChanged =
						JSON.stringify(after.data) !== JSON.stringify(snapshot.data);
					memory.actions.push({
						action: decision.target?.label ?? decision.operation,
						kind: decision.operation,
						text,
						page_changed: pageChanged,
					});
					memory.actions.splice(0, Math.max(0, memory.actions.length - 10));
					// Only state-changing actions count as progress claims. A scroll changes
					// what the agent sees by definition, and the page text of a long document
					// often stays identical until new content comes into view.
					const recent = memory.actions
						.filter(
							(a) => a.kind !== "WAIT" && !a.kind.startsWith("SCROLL"),
						)
						.slice(-3);
					if (recent.length === 3 && recent.every((a) => !a.page_changed))
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
							`Scroll direction alternated ${scrollReversals} times, so the loop is oscillating rather than exploring. Continue with browser_actions or revise the goal.`,
							"scroll_oscillation",
						);
				} finally {
					await after.dispose().catch(() => undefined);
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
						`Four consecutive observations were invalidated before an action could run, so the page changed on every attempt. Continue with browser_actions; this widget is outside the automatic DOM loop.`,
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
					: isNavigationReadError(error)
						? "navigation_context"
						: error instanceof Error && error.name === "TimeoutError"
							? "timeout"
							: error instanceof Error &&
									/createTreeWalker|PI_BROWSER_DOCUMENT_NOT_READY/.test(error.message)
								? "document_not_ready"
								: "unexpected_error",
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
