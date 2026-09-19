import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { detectFrameProvider, frameAtPoint, frameWarning } from "./frames.ts";
import type { BrowserAction, ElementTarget } from "./types.ts";

export interface ActionOptions {
	assertUrlAllowed: (url: string) => void;
	signal?: AbortSignal;
	/** Called when a coordinate click lands on a frame, before it is dispatched. */
	onFrameHit?: (
		info: { action: string; x: number; y: number; warning: string },
	) => void;
	/** Called when a tab action changes which page the caller should observe. */
	onActivePageChange?: (page: Page) => void;
}

async function reportFrameHit(
	page: Page,
	action: string,
	x: number,
	y: number,
	options: ActionOptions,
) {
	if (!options.onFrameHit) return;
	const hit = await frameAtPoint(page, x, y).catch(() => undefined);
	if (!hit) return;
	const provider = detectFrameProvider(hit.src);
	options.onFrameHit({
		action,
		x,
		y,
		warning: frameWarning(action, x, y, { ...hit, provider }),
	});
}

/**
 * Validate untrusted tool input into a concrete BrowserAction list.
 *
 * The tool schema is deliberately flat (one object shape for every action), which
 * models follow more reliably than a deeply nested union. That means the schema
 * cannot express per-action required fields, so the boundary validates them here
 * and fails with a precise message instead of passing undefined to Playwright.
 */
export function parseActions(input: unknown): BrowserAction[] {
	if (!Array.isArray(input) || input.length === 0) {
		throw new Error("actions must contain at least one browser action.");
	}
	if (input.length > 50) {
		throw new Error("A single browser_actions call is limited to 50 actions.");
	}
	return input.map((action, index) => parseAction(action, index));
}

function parseAction(value: unknown, index: number): BrowserAction {
	const label = `actions[${index}]`;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object.`);
	const action = value as Record<string, unknown>;
	const type = action.type;

	const requiredNumber = (field: string) => {
		const fieldValue = action[field];
		if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue))
			throw new Error(`${label}.${field} must be a finite number.`);
		return fieldValue;
	};
	const button = () => {
		const value = action.button;
		if (value === undefined) return undefined;
		if (value !== "left" && value !== "right" && value !== "wheel")
			throw new Error(
				`${label}.button must be "left", "right", or "wheel".`,
			);
		return value;
	};
	const keys = () => {
		const value = action.keys;
		if (
			!Array.isArray(value) ||
			value.length === 0 ||
			value.some((key) => typeof key !== "string" || !key.trim())
		)
			throw new Error(`${label}.keys must be a non-empty array of key names.`);
		return value as string[];
	};

	switch (type) {
		case "click":
		case "double_click": {
			const buttonValue = button();
			const target = parseElementTarget(action.target, `${label}.target`);
			const x = optionalNumber(action.x, `${label}.x`);
			const y = optionalNumber(action.y, `${label}.y`);
			if (target && (x !== undefined || y !== undefined))
				throw new Error(
					`${label} must use either x/y coordinates or target, not both.`,
				);
			if (!target && (x === undefined || y === undefined))
				throw new Error(
					`${label} needs x and y coordinates, or a target element.`,
				);
			return {
				type,
				...(target ? { target } : { x: x as number, y: y as number }),
				...(buttonValue === undefined ? {} : { button: buttonValue }),
				...(action.keys === undefined ? {} : { keys: keys() }),
			};
		}
		case "fill":
		case "select": {
			const target = parseElementTarget(action.target, `${label}.target`);
			if (!target) throw new Error(`${label}.target is required.`);
			if (typeof action.value !== "string" || !action.value.trim())
				throw new Error(`${label}.value must be a non-empty string.`);
			return { type, target, value: action.value };
		}
		case "activate_tab":
		case "close_tab": {
			const tabIndex = requiredNumber("index");
			if (!Number.isInteger(tabIndex) || tabIndex < 0)
				throw new Error(`${label}.index must be a non-negative integer.`);
			return { type, index: tabIndex };
		}
		case "scroll": {
			const x = optionalNumber(action.x, `${label}.x`);
			const y = optionalNumber(action.y, `${label}.y`);
			return {
				type,
				deltaX: requiredNumber("deltaX"),
				deltaY: requiredNumber("deltaY"),
				...(x === undefined ? {} : { x }),
				...(y === undefined ? {} : { y }),
			};
		}
		case "type":
			if (typeof action.text !== "string")
				throw new Error(`${label}.text must be a string.`);
			return { type, text: action.text };
		case "wait": {
			if (action.ms === undefined) return { type };
			const ms = requiredNumber("ms");
			if (ms < 0) throw new Error(`${label}.ms must not be negative.`);
			return { type, ms };
		}
		case "keypress":
			return { type, keys: keys() };
		case "drag": {
			const buttonValue = button();
			return {
				type,
				path: parsePath(action.path, label),
				...(buttonValue === undefined ? {} : { button: buttonValue }),
			};
		}
		case "move":
			return { type, x: requiredNumber("x"), y: requiredNumber("y") };
		case "screenshot":
		case "back":
		case "forward":
		case "reload":
			return { type };
		case "navigate":
			if (typeof action.url !== "string" || !action.url.trim())
				throw new Error(`${label}.url must be a non-empty string.`);
			return { type, url: action.url };
		default:
			throw new Error(
				`${label}.type is not a supported browser action: ${String(type)}.`,
			);
	}
}

/**
 * Manual actions address elements by role/name/text/CSS so a call is repeatable
 * without a model decision. Coordinates stay supported for canvas-like surfaces.
 */
function parseElementTarget(
	value: unknown,
	label: string,
): ElementTarget | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(
			`${label} must be an object with role, name, text, selector, or nth.`,
		);
	const record = value as Record<string, unknown>;
	const textField = (field: string) => {
		const entry = record[field];
		if (entry === undefined) return undefined;
		if (typeof entry !== "string" || !entry.trim())
			throw new Error(`${label}.${field} must be a non-empty string.`);
		return entry;
	};
	const target: ElementTarget = {};
	const selector = textField("selector");
	const role = textField("role");
	const name = textField("name");
	const text = textField("text");
	if (selector) target.selector = selector;
	if (role) target.role = role;
	if (name) target.name = name;
	if (text) target.text = text;
	const nth = record.nth;
	if (nth !== undefined) {
		if (!Number.isInteger(nth) || (nth as number) < 0)
			throw new Error(`${label}.nth must be a non-negative integer.`);
		target.nth = nth as number;
	}
	if (!target.selector && !target.role && !target.text)
		throw new Error(`${label} needs at least one of role, text, or selector.`);
	if (target.name && !target.role)
		throw new Error(
			`${label}.name needs role as well, so the accessible name is matched against the right kind of element.`,
		);
	return target;
}

function describeTarget(target: ElementTarget) {
	return (
		[
			target.selector ? `selector ${JSON.stringify(target.selector)}` : undefined,
			target.role ? `role ${target.role}` : undefined,
			target.name ? `name ${JSON.stringify(target.name)}` : undefined,
			target.text ? `text ${JSON.stringify(target.text)}` : undefined,
		]
			.filter(Boolean)
			.join(" ") || "target"
	);
}

/** Resolve a deterministic locator, preferring the first visible match. */
async function resolveLocator(page: Page, target: ElementTarget) {
	let base = target.selector
		? page.locator(target.selector)
		: target.role
			? page.getByRole(
					target.role as Parameters<Page["getByRole"]>[0],
					target.name ? { name: target.name } : {},
				)
			: page.getByText(target.text as string, { exact: false });
	// Never silently drop a specified field: role plus text means both must match.
	if (target.text && (target.selector || target.role))
		base = base.filter({ hasText: target.text });
	// A previous action in the same batch may still be navigating, so wait for the
	// element to exist instead of reading an empty document mid-navigation.
	const exists = await base
		.first()
		.waitFor({ state: "attached", timeout: 5_000 })
		.then(() => true)
		.catch(() => false);
	if (!exists)
		throw new Error(`No element matched ${describeTarget(target)}.`);
	const count = await base.count();
	if (target.nth !== undefined) {
		if (target.nth >= count)
			throw new Error(
				`${describeTarget(target)} matched ${count} elements, so nth ${target.nth} does not exist.`,
			);
		return base.nth(target.nth);
	}
	for (let index = 0; index < Math.min(count, 20); index++) {
		const candidate = base.nth(index);
		if (await candidate.isVisible().catch(() => false)) return candidate;
	}
	return base.first();
}

function optionalNumber(value: unknown, label: string) {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`${label} must be a finite number.`);
	return value;
}

function parsePath(
	value: unknown,
	label: string,
): Array<{ x: number; y: number } | [number, number]> {
	if (!Array.isArray(value) || value.length < 2)
		throw new Error(`${label}.path must contain at least two points.`);
	return value.map((point, index) => {
		if (Array.isArray(point)) {
			if (
				point.length !== 2 ||
				point.some(
					(coordinate) =>
						typeof coordinate !== "number" || !Number.isFinite(coordinate),
				)
			)
				throw new Error(
					`${label}.path[${index}] must be [x, y] with finite numbers.`,
				);
			return [point[0], point[1]] as [number, number];
		}
		if (point && typeof point === "object") {
			const { x, y } = point as { x?: unknown; y?: unknown };
			if (
				typeof x !== "number" ||
				!Number.isFinite(x) ||
				typeof y !== "number" ||
				!Number.isFinite(y)
			)
				throw new Error(`${label}.path[${index}] must have finite x and y.`);
			return { x, y };
		}
		throw new Error(`${label}.path[${index}] must be [x, y] or an {x, y} object.`);
	});
}

export async function executeActions(
	page: Page,
	input: unknown,
	options: ActionOptions,
): Promise<void> {
	const actions = parseActions(input);
	for (const action of actions) {
		assertActive(options.signal);
		switch (action.type) {
			case "click":
			case "double_click": {
				const modifiers = (action.keys ?? []).map(normalizeKey) as Array<
					"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift"
				>;
				const clickOptions = {
					button: normalizeButton(action.button),
					clickCount: action.type === "double_click" ? 2 : 1,
					modifiers,
					timeout: 5_000,
				};
				if (action.target) {
					const locator = await resolveLocator(page, action.target);
					await locator.click(clickOptions);
					break;
				}
				const x = action.x as number;
				const y = action.y as number;
				await reportFrameHit(page, action.type, x, y, options);
				await page.mouse.click(x, y, clickOptions);
				break;
			}
			case "fill": {
				const locator = await resolveLocator(page, action.target);
				await locator.fill(action.value, { timeout: 5_000 });
				break;
			}
			case "select": {
				const locator = await resolveLocator(page, action.target);
				await locator.selectOption(action.value, { timeout: 5_000 });
				break;
			}
			case "activate_tab": {
				const tabs = page.context().pages();
				const tab = tabs[action.index];
				if (!tab)
					throw new Error(
						`Tab ${action.index} does not exist; ${tabs.length} tab(s) are open.`,
					);
				await tab.bringToFront();
				options.onActivePageChange?.(tab);
				break;
			}
			case "close_tab": {
				const tabs = page.context().pages();
				const tab = tabs[action.index];
				if (!tab)
					throw new Error(
						`Tab ${action.index} does not exist; ${tabs.length} tab(s) are open.`,
					);
				if (tabs.length === 1)
					throw new Error("Cannot close the only open tab.");
				const fallback = tabs.find((candidate) => candidate !== tab);
				await tab.close();
				if (tab === page && fallback) options.onActivePageChange?.(fallback);
				break;
			}
			case "scroll":
				if (typeof action.x === "number" && typeof action.y === "number") {
					await page.mouse.move(action.x, action.y);
				}
				await page.mouse.wheel(action.deltaX, action.deltaY);
				break;
			case "type":
				await page.keyboard.type(action.text);
				break;
			case "wait":
				await delay(
					Math.min(30_000, Math.max(0, action.ms ?? 1000)),
					options.signal,
				);
				break;
			case "keypress":
				await page.keyboard.press(action.keys.map(normalizeKey).join("+"));
				break;
			case "drag": {
				const points = action.path.map((point) =>
					Array.isArray(point) ? { x: point[0], y: point[1] } : point,
				);
				await reportFrameHit(page, action.type, points[0].x, points[0].y, options);
				await executeDrag(page, action.path, normalizeButton(action.button));
				break;
			}
			case "move":
				await page.mouse.move(action.x, action.y);
				break;
			case "screenshot":
				break;
			case "navigate":
				options.assertUrlAllowed(action.url);
				await page.goto(action.url, {
					waitUntil: "domcontentloaded",
					timeout: 30_000,
				});
				break;
			case "back":
				await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
				break;
			case "forward":
				await page.goForward({
					waitUntil: "domcontentloaded",
					timeout: 30_000,
				});
				break;
			case "reload":
				await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
				break;
			default:
				throw new Error(
					`Unsupported browser action: ${String((action as { type?: unknown }).type)}`,
				);
		}
	}
}

export function normalizeKey(value: string): string {
	const key = value.trim();
	const lookup = key.toUpperCase();
	const aliases: Record<string, string> = {
		CTRL: "Control",
		CONTROL: "Control",
		CMD: "Meta",
		COMMAND: "Meta",
		META: "Meta",
		ALT: "Alt",
		OPTION: "Alt",
		SHIFT: "Shift",
		ENTER: "Enter",
		RETURN: "Enter",
		ESC: "Escape",
		ESCAPE: "Escape",
		SPACE: "Space",
		TAB: "Tab",
		BACKSPACE: "Backspace",
		DELETE: "Delete",
		DEL: "Delete",
		HOME: "Home",
		END: "End",
		PGUP: "PageUp",
		PAGEUP: "PageUp",
		PGDN: "PageDown",
		PAGEDOWN: "PageDown",
		UP: "ArrowUp",
		ARROWUP: "ArrowUp",
		DOWN: "ArrowDown",
		ARROWDOWN: "ArrowDown",
		LEFT: "ArrowLeft",
		ARROWLEFT: "ArrowLeft",
		RIGHT: "ArrowRight",
		ARROWRIGHT: "ArrowRight",
	};
	return aliases[lookup] ?? (key.length === 1 ? key : key);
}

function normalizeButton(value?: "left" | "right" | "wheel") {
	if (!value || value === "left") return "left" as const;
	if (value === "right") return "right" as const;
	if (value === "wheel") return "middle" as const;
	throw new Error(`Unsupported mouse button: ${String(value)}`);
}

async function executeDrag(
	page: Page,
	path: Array<{ x: number; y: number } | [number, number]>,
	button: "left" | "right" | "middle",
) {
	if (!Array.isArray(path) || path.length < 2) {
		throw new Error("drag requires a path with at least two points.");
	}
	const points = path.map((point) =>
		Array.isArray(point) ? { x: point[0], y: point[1] } : point,
	);
	await page.mouse.move(points[0].x, points[0].y);
	await page.mouse.down({ button });
	try {
		for (const point of points.slice(1)) {
			await page.mouse.move(point.x, point.y, { steps: 5 });
		}
	} finally {
		await page.mouse.up({ button });
	}
}

function assertActive(signal?: AbortSignal) {
	if (signal?.aborted) throw new Error("Browser action was aborted.");
}

async function delay(ms: number, signal?: AbortSignal) {
	await sleep(ms, undefined, { signal });
}
