import assert from "node:assert/strict";
import test from "node:test";
import { type Observation } from "../src/observe.ts";
import {
	buildPlanQuestion,
	buildQuestions,
	createJevPolicy,
	describePlanStep,
	PLANNING_RULES,
	plannedGoal,
	createPiTextGenerator,
	createTypeSafeClient,
	parseText,
	type JevPolicy,
} from "../src/policy.ts";

const observation: Observation = {
	url: "https://example.test",
	title: "Search",
	text: "Search",
	scrollUp: false,
	scrollDown: true,
	targets: [
		{ id: "1", operation: "TYPE_TEXT", label: "Query", value: "" },
		{ id: "2", operation: "CLICK", label: "Search", value: "" },
	],
};

test("one question compares concrete actions against scrolling and terminal choices", () => {
	const q = buildQuestions(observation, "Find cats");
	assert.equal(q.action.type, "choice");
	assert.deepEqual(Object.keys(q.action.criteria), [
		"WAIT",
		"BLOCKED",
		"REVIEW",
		"DONE",
		"TYPE_TEXT:1",
		"CLICK:2",
		"SCROLL_DOWN",
	]);
	const checked = buildQuestions(
		{
			...observation,
			targets: [
				{
					id: "3",
					operation: "CLICK",
					label: "Small",
					value: "small",
					role: "radio",
					checked: "true",
				},
			],
		},
		"Choose small",
	);
	assert.ok(!Object.hasOwn(checked.action.criteria, "CLICK:3"));
	assert.ok(
		!Object.hasOwn(
			buildQuestions({ ...observation, text: "" }, "Finish").action.criteria,
			"DONE",
		),
	);
	assert.ok(
		Object.hasOwn(
			buildQuestions({ ...observation, scrollUp: true }, "Finish").action
				.criteria,
			"SCROLL_UP",
		),
	);
	const instructions = q.action.instructions as Record<string, unknown>;
	assert.equal(instructions.goal, "Find cats");
	assert.match(String(instructions.rules), /untrusted data/);
	const target = q.action.criteria["CLICK:2"] as Record<string, string | null>;
	assert.equal(target.operation, "CLICK");
	assert.equal(target.option, null);
});

test("text helper returns a value, declines explicitly, or fails loudly", () => {
	assert.deepEqual(parseText('{"text":"cats"}'), { text: "cats" });
	// {"text":null} is the documented way for the helper to decline a value.
	assert.deepEqual(parseText('{"text":null}'), { refused: true });
	for (const value of [
		"{}",
		'{"text":""}',
		'{"text":"   "}',
		'{"text":"cat","action":"click"}',
		'{"value":"cat"}',
		"not json",
		"[]",
		"5",
		"null",
		JSON.stringify({ text: "x".repeat(2001) }),
	]) {
		assert.throws(() => parseText(value));
	}
});

test("text helper tolerates formatting noise but keeps shape validation", () => {
	assert.deepEqual(parseText('```json\n{"text":"cats"}\n```'), { text: "cats" });
	assert.deepEqual(parseText('Here is the value: {"text":"cats"}'), { text: "cats" });
	assert.deepEqual(parseText('{"text":"cats"} trailing prose'), { text: "cats" });
	assert.deepEqual(parseText('{"text":"a{b}c"}'), { text: "a{b}c" });
	assert.deepEqual(parseText('{"text":"quote \\" and brace }"}'), {
		text: 'quote " and brace }',
	});
	// Formatting tolerance must not weaken the shape checks.
	assert.deepEqual(parseText('```json\n{"text":null}\n```'), { refused: true });
	assert.throws(() => parseText('{"text":"cat","action":"click"}'));
	assert.throws(() => parseText("no object here"));
});

test("the System One request carries one decision question and maps the answer", async () => {
	const requests: Array<{ url: string; body: Record<string, any>; headers: Headers }> =
		[];
	const client = createTypeSafeClient(
		{
			apiKey: "offline-test-key",
			baseUrl: "https://typesafe.example.test",
			model: "jev-latest",
		},
		{
			fetch: async (input, init) => {
				const body = JSON.parse(String(init?.body));
				requests.push({
					url: String(input),
					body,
					headers: new Headers(init?.headers),
				});
				const choices = Object.keys(body.questions.action.criteria);
				return Response.json({
					model: "jev-latest",
					answers: {
						action: {
							type: "choice",
							choice: "CLICK:2",
							confidence: 0.87,
							probabilities: Object.fromEntries(
								choices.map((choice) => [
									choice,
									choice === "CLICK:2" ? 0.87 : 0.01,
								]),
							),
						},
					},
					usage: { input_tokens: 120, output_tokens: 0 },
				});
			},
		},
	);
	const policy = createJevPolicy({
		text: async () => ({ text: '{"text":"cats"}' }),
		client,
	});
	const result = await policy.choose(
		observation,
		"Search",
		[{ action: "Query", kind: "TYPE_TEXT", page_changed: true }],
		new AbortController().signal,
	);
	assert.equal(requests.length, 1);
	assert.match(requests[0].url, /\/v1\/systemone$/);
	assert.equal(
		requests[0].headers.get("authorization"),
		"Bearer offline-test-key",
	);
	assert.equal(requests[0].body.model, "jev-latest");
	assert.deepEqual(Object.keys(requests[0].body.questions), ["action"]);
	const state = JSON.parse(requests[0].body.state);
	assert.equal(state.page.url, "https://example.test");
	assert.deepEqual(state.recentActions, [
		{ action: "Query", kind: "TYPE_TEXT", page_changed: true },
	]);
	assert.equal(result.operation, "CLICK");
	assert.equal(result.target?.id, "2");
	assert.equal(result.probability, 0.87);
	assert.equal(result.providerConfidence, 0.87);
});

test("unoffered or malformed Jev answers fail instead of acting", async () => {
	const answer = (value: unknown) =>
		createTypeSafeClient(
			{ apiKey: "key", baseUrl: "https://typesafe.example.test", model: "m" },
			{ fetch: async () => Response.json({ model: "m", answers: { action: value }, usage: { input_tokens: 1, output_tokens: 0 } }) },
		);
	const policyFor = (value: unknown): JevPolicy =>
		createJevPolicy({ text: async () => ({ text: "x" }), client: answer(value) });
	await assert.rejects(
		policyFor({ type: "choice", choice: "TELEPORT", confidence: 1, probabilities: {} }).choose(
			observation,
			"Search",
			[],
			new AbortController().signal,
		),
		/unoffered action/,
	);
	await assert.rejects(
		policyFor({ type: "noul", noul: 0.5 }).choose(
			observation,
			"Search",
			[],
			new AbortController().signal,
		),
		/unoffered action/,
	);
});

test("text decisions are parsed and their helper usage returned", async () => {
	const policy = createJevPolicy({
		text: async () => ({
			text: '{"text":"cats"}',
			usage: {
				input: 5,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 7,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		}),
		client: createTypeSafeClient(
			{ apiKey: "key", baseUrl: "https://typesafe.example.test", model: "m" },
			{ fetch: async () => Response.json({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }) },
		),
	});
	const generated = await policy.text(
		observation,
		"Search for cats",
		observation.targets[0],
		[],
		new AbortController().signal,
	);
	assert.equal(generated.text, "cats");
	assert.equal(generated.usage?.totalTokens, 7);
});

test("pi text generator uses the active model and session", async () => {
	const calls: Array<Record<string, any>> = [];
	const ctx = {
		model: { id: "flash", provider: "test" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			getAvailable: () => [],
			complete: async (
				model: unknown,
				context: unknown,
				options: unknown,
			) => {
				calls.push({ model, context, options });
				return {
					content: [{ type: "text", text: '{"text":"cats"}' }],
					usage: {
						input: 5,
						output: 2,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 7,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		},
		sessionManager: { getSessionId: () => "session-1" },
	};
	const generate = createPiTextGenerator(ctx as never);
	const result = await generate({
		system: "system prompt",
		prompt: "prompt",
		signal: new AbortController().signal,
	});
	assert.equal(result.text, '{"text":"cats"}');
	assert.equal(result.usage?.totalTokens, 7);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model.id, "flash");
	assert.equal(calls[0].context.systemPrompt, "system prompt");
	assert.equal(calls[0].options.sessionId, "session-1");
	assert.equal(
		calls[0].options.maxTokens,
		4096,
		"reasoning tokens share the helper budget",
	);
	assert.equal(calls[0].options.maxRetries, 2);
});

test("pi text generator resolves a configured provider/model override", async () => {
	const found = { id: "haiku", provider: "anthropic" };
	const ctx = {
		model: { id: "flash", provider: "test" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: (provider: string, id: string) =>
				provider === "anthropic" && id === "haiku" ? found : undefined,
			getAvailable: () => [],
			complete: async () => ({
				content: [{ type: "text", text: "{}" }],
				usage: undefined,
			}),
		},
		sessionManager: { getSessionId: () => "session-1" },
	};
	const generate = createPiTextGenerator(ctx as never, "anthropic/haiku");
	await generate({
		system: "s",
		prompt: "p",
		signal: new AbortController().signal,
	});
	assert.equal(ctx.modelRegistry.hasConfiguredAuth(), true);
});

test("pi text generator reports missing or ambiguous model configuration", async () => {
	const baseRegistry = {
		hasConfiguredAuth: () => true,
		find: () => undefined,
		getAvailable: () => [
			{ id: "shared", provider: "a" },
			{ id: "shared", provider: "b" },
		],
		complete: async () => ({ content: [], usage: undefined }),
	};
	const missing = createPiTextGenerator({
		model: undefined,
		modelRegistry: baseRegistry,
		sessionManager: { getSessionId: () => "s" },
	} as never);
	await assert.rejects(
		missing({ system: "s", prompt: "p", signal: new AbortController().signal }),
		/No active pi model/,
	);

	const unknown = createPiTextGenerator({
		model: { id: "flash", provider: "test" },
		modelRegistry: baseRegistry,
		sessionManager: { getSessionId: () => "s" },
	} as never, "missing/model");
	await assert.rejects(
		unknown({ system: "s", prompt: "p", signal: new AbortController().signal }),
		/was not found/,
	);

	const ambiguous = createPiTextGenerator({
		model: { id: "flash", provider: "test" },
		modelRegistry: baseRegistry,
		sessionManager: { getSessionId: () => "s" },
	} as never, "shared");
	await assert.rejects(
		ambiguous({ system: "s", prompt: "p", signal: new AbortController().signal }),
		/is ambiguous/,
	);

	const unauthenticated = createPiTextGenerator({
		model: { id: "flash", provider: "test" },
		modelRegistry: { ...baseRegistry, hasConfiguredAuth: () => false, getAvailable: () => [] },
		sessionManager: { getSessionId: () => "s" },
	} as never);
	await assert.rejects(
		unauthenticated({
			system: "s",
			prompt: "p",
			signal: new AbortController().signal,
		}),
		/No authentication is configured/,
	);
});

test("the plan question offers every target plus PLAN_COMPLETE and NO_PLAN, and carries the plan so far", () => {
	const q = buildPlanQuestion(observation, "Search for cats", ['type into "Query"']);
	assert.equal(q.step.type, "choice");
	assert.deepEqual(Object.keys(q.step.criteria), ["PLAN_COMPLETE", "NO_PLAN", "TYPE_TEXT:1", "CLICK:2"]);
	const instructions = q.step.instructions as Record<string, unknown>;
	assert.equal(instructions.goal, "Search for cats");
	assert.deepEqual(instructions.planSoFar, ['type into "Query"']);
	assert.equal(instructions.rules, PLANNING_RULES);
	// Planning never offers the executing loop's terminal choices: nothing is acted on.
	assert.equal("DONE" in q.step.criteria, false);
	assert.equal("WAIT" in q.step.criteria, false);
});

test("plan steps are written label first with the stable identifier, and the planned goal enumerates them", () => {
	assert.equal(
		describePlanStep({ id: "3", operation: "CLICK", label: "1", value: "", identifier: "One" }),
		'press "1" (identifier One)',
	);
	assert.equal(describePlanStep({ id: "4", operation: "TYPE_TEXT", label: "Query", value: "" }), 'type into "Query"');
	assert.equal(
		describePlanStep({ id: "5", operation: "SELECT", label: "Tier", value: "", option: "pro" }),
		'select "Tier" → pro',
	);
	const goal = plannedGoal("Compute 1 + 1", ['press "1"', 'press "+"']);
	assert.match(goal, /^Compute 1 \+ 1\n/);
	assert.match(goal, /\n1\. press "1"\n2\. press "\+"\n/);
});

/** A System One stub that answers the plan question from a script, recording each request. */
function planningClient(answers: string[]) {
	const states: Array<Record<string, any>> = [];
	let call = 0;
	const client = createTypeSafeClient(
		{ apiKey: "offline-test-key", baseUrl: "https://typesafe.example.test", model: "jev-latest" },
		{
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body));
				states.push({ state: JSON.parse(body.state), questions: body.questions });
				const choice = answers[Math.min(call++, answers.length - 1)];
				const choices = Object.keys(body.questions.step.criteria);
				return Response.json({
					model: "jev-latest",
					answers: {
						step: {
							type: "choice",
							choice,
							confidence: 0.9,
							probabilities: Object.fromEntries(choices.map((c) => [c, c === choice ? 0.9 : 0.01])),
						},
					},
					usage: { input_tokens: 10, output_tokens: 0 },
				});
			},
		},
	);
	return { client, states };
}

test("planning chooses one step at a time against the unchanged observation until PLAN_COMPLETE", async () => {
	const { client, states } = planningClient(["TYPE_TEXT:1", "CLICK:2", "PLAN_COMPLETE"]);
	const policy = createJevPolicy({ text: async () => ({ text: "x" }), client, planning: true });
	assert.ok(policy.plan);
	const plan = await policy.plan(observation, "Search for cats", new AbortController().signal);
	assert.deepEqual(plan, ['type into "Query"', 'press "Search"']);
	assert.equal(states.length, 3);
	// Each request carries the same observation and the plan built so far.
	assert.deepEqual(states.map((s) => s.state.planSoFar), [[], ['type into "Query"'], ['type into "Query"', 'press "Search"']]);
	assert.ok(states.every((s) => s.state.page.url === "https://example.test"));
	assert.ok(states.every((s) => Object.keys(s.questions).join() === "step"));
});

test("planning yields no plan when the model declines, never converges, or plans nothing", async () => {
	const declined = createJevPolicy({ text: async () => ({ text: "x" }), client: planningClient(["NO_PLAN"]).client, planning: true });
	assert.equal(await declined.plan!(observation, "Search", new AbortController().signal), null);

	const empty = createJevPolicy({ text: async () => ({ text: "x" }), client: planningClient(["PLAN_COMPLETE"]).client, planning: true });
	assert.equal(await empty.plan!(observation, "Search", new AbortController().signal), null);

	const looping = planningClient(["CLICK:2"]);
	const bounded = createJevPolicy({ text: async () => ({ text: "x" }), client: looping.client, planning: { maxSteps: 4 } });
	assert.equal(await bounded.plan!(observation, "Search", new AbortController().signal), null);
	assert.equal(looping.states.length, 4);

	await assert.rejects(
		createJevPolicy({ text: async () => ({ text: "x" }), client: planningClient(["TELEPORT"]).client, planning: true }).plan!(
			observation,
			"Search",
			new AbortController().signal,
		),
		/unoffered plan step/,
	);
});

test("planning is off unless asked for", () => {
	const policy = createJevPolicy({ text: async () => ({ text: "x" }), client: planningClient([]).client });
	assert.equal(policy.plan, undefined);
});
