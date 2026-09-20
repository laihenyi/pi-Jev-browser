import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import {
	type Driver,
	type Observation,
	type ObservationSnapshot,
	type ObservedTarget,
	StaleObservationError,
	type TargetOperation,
} from "./driver.ts";

export {
	type Observation,
	type ObservedTarget,
	StaleObservationError,
	type TargetOperation,
} from "./driver.ts";

// The closure retains actual nodes, outside page globals. Model output can only
// select an offered ID; it never becomes a selector or executable browser code.
export function isNavigationReadError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/Execution context was destroyed|Cannot find context with specified id|JSHandle is disposed|Unable to adopt element handle from a different document/.test(
			error.message,
		)
	);
}

// Wait for a usable document, not network-idle (many sites keep requests open).
export async function waitForDocument(page: Page, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const ready = await page.waitForFunction(
		() => document.readyState !== "loading" && document.body !== null,
		undefined,
		{ timeout: 5000 },
	);
	await ready.dispose();
	signal?.throwIfAborted();
}

// Retry only reads invalidated by document replacement, never a browser action.
export async function observe(page: Page, signal?: AbortSignal) {
	for (let attempt = 0; ; attempt++) {
		signal?.throwIfAborted();
		try {
			await waitForDocument(page, signal);
			return await observeDocument(page);
		} catch (error) {
			if (
				page.isClosed() ||
				(!isNavigationReadError(error) &&
					!(
						error instanceof Error &&
						error.message.includes("PI_JEV_BROWSER_DOCUMENT_NOT_READY")
					)) ||
				attempt >= 4
			)
				throw error;
			await delay(100, undefined, { signal });
		}
	}
}

async function observeDocument(page: Page) {
	const handle = await page.evaluateHandle(() => {
		const selector =
			'label[for],a[href],button,input,textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="option"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="combobox"],[role="gridcell"],[role="menuitemradio"],[role="textbox"],[role="searchbox"],[role="spinbutton"]';
		/**
		 * Open shadow roots are part of what the user sees, so their controls and
		 * text are part of what the loop sees. `querySelectorAll` stops at a shadow
		 * boundary, so every query goes through this walk instead: light DOM first,
		 * then each open shadow root in document order. Closed roots cannot be
		 * reached from outside and remain a documented limit.
		 */
		const deepQuery = <T extends Element = HTMLElement>(
			selector: string,
			root: ParentNode = document,
		): T[] => {
			const found: T[] = [];
			const walk = (node: ParentNode) => {
				found.push(...node.querySelectorAll<T>(selector));
				for (const host of node.querySelectorAll<Element>("*"))
					if (host.shadowRoot) walk(host.shadowRoot);
			};
			walk(root);
			return found;
		};
		/** The deepest element at a point, descending through open shadow roots. */
		const deepHit = (x: number, y: number): Element | null => {
			let hit = document.elementFromPoint(x, y);
			while (hit?.shadowRoot) {
				const inner = hit.shadowRoot.elementFromPoint(x, y);
				if (!inner || inner === hit) break;
				hit = inner;
			}
			return hit;
		};
		/** `contains` across shadow boundaries: a hit inside a host's shadow tree counts. */
		const encloses = (ancestor: Element | null | undefined, node: Element | null) => {
			if (!ancestor) return false;
			for (let current: Node | null = node; current; ) {
				if (current === ancestor) return true;
				const parent: Node | null = current.parentNode;
				current = parent instanceof ShadowRoot ? parent.host : parent;
			}
			return false;
		};
		const visible = (e: HTMLElement) => {
			const r = e.getBoundingClientRect();
			return (
				e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
				!e.closest('[inert],[aria-hidden="true"]') &&
				r.width > 0 &&
				r.height > 0 &&
				r.top + r.height / 2 >= 0 &&
				r.left + r.width / 2 >= 0 &&
				r.top + r.height / 2 < innerHeight &&
				r.left + r.width / 2 < innerWidth
			);
		};
		const receivesPointer = (e: HTMLElement) => {
			const r = e.getBoundingClientRect();
			const hit = deepHit(r.x + r.width / 2, r.y + r.height / 2);
			return (
				encloses(e, hit) ||
				(e instanceof HTMLLabelElement && encloses(e.control, hit))
			);
		};

		const read = () => {
			if (!document.body || document.readyState === "loading")
				throw new Error("PI_JEV_BROWSER_DOCUMENT_NOT_READY");
			const nodes: HTMLElement[] = [];
			const targets: ObservedTarget[] = [];
			const offscreenControls = {
				above: [] as string[],
				below: [] as string[],
			};
			for (const e of deepQuery(selector)) {
				if (targets.length >= 200) break;
				const rect = e.getBoundingClientRect();
				const associated = e instanceof HTMLLabelElement ? e.control : e;
				if (
					associated &&
					associated.matches(
						"input,select,textarea,[role=radio],[role=checkbox],[role=combobox]",
					) &&
					!associated.matches(":disabled,:checked") &&
					!e.closest('[inert],[aria-hidden="true"],[aria-disabled="true"]') &&
					e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
					rect.width > 0 &&
					rect.height > 0
				) {
					const direction =
						rect.bottom <= 0
							? "above"
							: rect.top >= innerHeight
								? "below"
								: undefined;
					if (direction && offscreenControls[direction].length < 50) {
						const name = (
							e.getAttribute("aria-label") ||
							e.innerText ||
							e.getAttribute("title") ||
							""
						)
							.trim()
							.slice(0, 300);
						if (name && !offscreenControls[direction].includes(name))
							offscreenControls[direction].push(name);
					}
				}

				if (
					!visible(e) ||
					!receivesPointer(e) ||
					e.matches(":disabled") ||
					e.closest('[aria-disabled="true"]')
				)
					continue;
				if (
					e.getAttribute("role") === "gridcell" &&
					e.querySelector("button,[role=button]")
				)
					continue;
				const control = e instanceof HTMLLabelElement ? e.control : e;
				if (!control || control.matches(":disabled")) continue;
				const input = control as HTMLInputElement;
				if (["password", "file", "hidden"].includes(input.type)) continue;
				const label = (
					e.getAttribute("aria-label") ||
					(e.getAttribute("aria-labelledby") || "")
						.split(/\s+/)
						.map(
							(id) =>
								// Ids are scoped to the tree the element lives in.
								(e.getRootNode() as Document | ShadowRoot).getElementById(id)
									?.textContent || "",
						)
						.join(" ")
						.trim() ||
					Array.from(input.labels || [])
						.map((l) => l.textContent)
						.join(" ") ||
					e.innerText ||
					e.getAttribute("placeholder") ||
					e.getAttribute("title") ||
					input.type ||
					e.tagName
				)
					.trim()
					.slice(0, 300);
				const value = String(
					input.value ??
						(e.isContentEditable || e.getAttribute("role") === "combobox"
							? e.innerText
							: ""),
				);
				const nodeId = String(new Set(nodes).size + 1);
				const add = (
					operation: TargetOperation,
					option?: string,
					optionLabel?: string,
					optionIndex?: number,
				) => {
					nodes.push(e);
					targets.push({
						id: option !== undefined ? `${nodeId}:${optionIndex}` : nodeId,
						operation,
						label: optionLabel ? `${label} → ${optionLabel}` : label,
						value: value.slice(0, 1000),
						role:
							control.getAttribute("role") ||
							(["radio", "checkbox"].includes(input.type)
								? input.type
								: e.tagName.toLowerCase()),
						href: e instanceof HTMLAnchorElement ? e.href : undefined,
						checked:
							e.getAttribute("aria-checked") ??
							(["checkbox", "radio"].includes(input.type)
								? String(input.checked)
								: undefined),
						selected: e.getAttribute("aria-selected") ?? undefined,
						expanded: e.getAttribute("aria-expanded") ?? undefined,
						...(option !== undefined ? { option } : {}),
					});
				};
				if (e instanceof HTMLSelectElement) {
					for (const o of e.options) {
						if (targets.length >= 200) break;
						if (!o.selected && !o.disabled && !o.closest("optgroup[disabled]"))
							add("SELECT", o.value, o.label, o.index);
					}
				} else {
					const editable =
						!input.readOnly &&
						e.getAttribute("aria-readonly") !== "true" &&
						(e instanceof HTMLTextAreaElement ||
							e.isContentEditable ||
							(e instanceof HTMLInputElement &&
								["text", "search", "email", "url", "tel", "number"].includes(
									e.type,
								)));
					if (editable) add("TYPE_TEXT");
					add("CLICK");
				}
			}
			const words: string[] = [];
			const range = document.createRange();
			let length = 0;
			// A TreeWalker does not enter shadow roots, so a host is a cue to walk its
			// root before continuing; the shadow text lands where the host is.
			const readText = (root: Node) => {
				const walker = document.createTreeWalker(
					root,
					NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
					{
						acceptNode: (node) =>
							node.nodeType === Node.TEXT_NODE ||
							(node as Element).shadowRoot
								? NodeFilter.FILTER_ACCEPT
								: NodeFilter.FILTER_SKIP,
					},
				);
				while (length < 6000) {
					const node = walker.nextNode();
					if (!node) break;
					if (node.nodeType === Node.ELEMENT_NODE) {
						const shadow = (node as Element).shadowRoot;
						if (shadow) readText(shadow);
						continue;
					}
					const parent = node.parentElement;
					const text = node.textContent?.trim();
					if (
						!text ||
						!parent ||
						parent.closest(
							'script,style,noscript,[inert],[aria-hidden="true"]',
						) ||
						!parent.checkVisibility({
							checkOpacity: true,
							checkVisibilityCSS: true,
						})
					)
						continue;
					range.selectNodeContents(node);
					const r = range.getBoundingClientRect();
					if (
						r.width &&
						r.height &&
						r.bottom > 0 &&
						r.top < innerHeight &&
						r.right > 0 &&
						r.left < innerWidth
					) {
						words.push(text);
						length += text.length;
					}
				}
			};
			readText(document.body);
			const data: Observation = {
				offscreenControls,
				selectedOptions: deepQuery<HTMLInputElement>(
					"input[type=radio]:checked,input[type=checkbox]:checked",
				)
					.filter((e) => !e.closest('[aria-hidden="true"],[inert]'))
					.slice(0, 50)
					.map((e) => ({
						group: e.name,
						label: Array.from(e.labels ?? [])
							.map((l) => l.textContent?.trim() ?? "")
							.join(" ")
							.slice(0, 300),
						value: e.value,
					})),
				url: location.href,
				title: document.title,
				text: words.join("\n").slice(0, 6000),
				targets,
				scrollUp: scrollY > 0,
				scrollDown:
					scrollY + innerHeight < document.documentElement.scrollHeight - 2,
			};
			// Include form/ARIA state and link destinations even when they don't alter labels.
			const signature = JSON.stringify([
				data,
				scrollX,
				scrollY,
				nodes.map((e) => [
					e.getAttribute("href"),
					e.getAttribute("aria-checked"),
					e.getAttribute("aria-selected"),
					e.getAttribute("aria-expanded"),
					(e as HTMLInputElement).checked,
					(e as HTMLInputElement).value,
					(e as HTMLInputElement).readOnly,
					e.getAttribute("aria-readonly"),
				]),
			]);
			const formState = JSON.stringify(
				deepQuery('input,textarea,select,[contenteditable="true"]').map((e) => [
					(e as HTMLInputElement).value,
					(e as HTMLInputElement).checked,
					e.getAttribute("aria-checked"),
				]),
			);
			const links = nodes.map((e) => e.getAttribute("href"));
			return { nodes, data, signature, formState, links };
		};
		const original = read();
		return { original, read, deepHit, encloses };
	});
	try {
		const data = await handle.evaluate((h) => h.original.data);
		return {
			data,
			async assertFresh() {
				const fresh = await handle.evaluate((h) => {
					const current = h.read();
					return (
						current.signature === h.original.signature &&
						current.nodes.length === h.original.nodes.length &&
						current.nodes.every((e, i) => e === h.original.nodes[i])
					);
				});
				if (!fresh)
					throw new StaleObservationError(
						"Page changed; observe again before acting.",
					);
			},
			async execute(
				operation: string,
				target: ObservedTarget | undefined,
				text: string | undefined,
				signal: AbortSignal,
			) {
				signal.throwIfAborted();
				const nodeHandle = await handle
					.evaluateHandle((h, target) => {
						const current = h.read();
						/**
						 * Names whatever is intercepting the pointer. A bare "covered" tells the
						 * agent that something is in the way but not what to do about it, and a cookie
						 * banner or modal is exactly the case where the next step is obvious once known.
						 */
							// Name what intercepted the pointer. A bare "covered" tells the agent that
							// something is in the way but not what to do about it, and a cookie banner
							// or modal is exactly the case where the next action is obvious once known.
							const cover = (element: Element | null) => {
								if (!element) return "an unrendered point";
								const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
								const label = (
									element.getAttribute("aria-label") ??
									element.getAttribute("title") ??
									element.textContent ??
									""
								)
									.replace(/\s+/g, " ")
									.trim()
									.slice(0, 80);
								const id = element.id ? `#${element.id}` : "";
								const firstClass =
									typeof element.className === "string" && element.className.trim()
										? `.${element.className.trim().split(/\s+/)[0]}`
										: "";
								return `${role}${id}${firstClass}${label ? ` labelled ${JSON.stringify(label)}` : ""}`;
							};
						if (target === undefined || target.operation === "TYPE_TEXT") {
							if (
								current.signature !== h.original.signature ||
								current.nodes.length !== h.original.nodes.length ||
								current.nodes.some((e, i) => e !== h.original.nodes[i])
							)
								throw new Error("Page changed; observe again before acting.");
						}
						if (target === undefined) return null;
						const index = h.original.data.targets.findIndex(
							(t) => t.id === target.id && t.operation === target.operation,
						);
						const node = h.original.nodes[index];
						if (!node?.isConnected)
							throw new Error("Observed target disappeared.");
						const currentIndex = current.nodes.findIndex(
							(e, i) =>
								e === node &&
								current.data.targets[i]?.operation === target.operation &&
								current.data.targets[i]?.option === target.option,
						);
						if (currentIndex < 0) {
							// The node is still connected but no longer offered, which means something
							// is now covering it. Say what, so the next step is a dismissal rather than
							// a guess.
							const rect = node.getBoundingClientRect();
							const blocker = h.deepHit(
								rect.x + rect.width / 2,
								rect.y + rect.height / 2,
							);
							throw new Error(`Observed target is covered by ${cover(blocker)}.`);
						}
						const before = h.original.data.targets[index];
						const after = current.data.targets[currentIndex];
						if (
							current.data.url !== h.original.data.url ||
							current.formState !== h.original.formState ||
							current.links[currentIndex] !== h.original.links[index] ||
							JSON.stringify({ ...before, id: null }) !==
								JSON.stringify({ ...after, id: null })
						)
							throw new Error("Page changed; target or form state changed.");
						const r = node.getBoundingClientRect();
						const hit = h.deepHit(r.x + r.width / 2, r.y + r.height / 2);
						if (
							!h.encloses(node, hit) &&
							!(node instanceof HTMLLabelElement && h.encloses(node.control, hit))
						) {
							throw new Error(`Observed target is covered by ${cover(hit)}.`);
						}
						return node instanceof HTMLLabelElement &&
							h.encloses(node.control, hit)
							? node.control
							: node;
					}, target)
					.catch((error) => {
						if (
							/Page changed;|Observed target disappeared|Observed target is covered/.test(
								String(error),
							)
						)
							throw new StaleObservationError(String(error));
						throw error;
					});
				try {
					signal.throwIfAborted();
					const element = nodeHandle.asElement();
					// A failed mutation is never retried by this loop.
					if (operation === "CLICK" && element)
						// Wait for click-triggered navigation before evaluating another action.
						await element.click({ timeout: 10000 });
					else if (operation === "TYPE_TEXT" && element && text !== undefined)
						await element.fill(text, { timeout: 2000 });
					else if (
						operation === "SELECT" &&
						element &&
						target?.option !== undefined
					)
						await element.selectOption(target.option, { timeout: 2000 });
					else if (operation === "SCROLL_DOWN" || operation === "SCROLL_UP")
						await page.evaluate(
							(direction) =>
								window.scrollBy({
									top: direction * innerHeight * 0.5,
									behavior: "instant",
								}),
							operation === "SCROLL_DOWN" ? 1 : -1,
						);
					else if (operation === "WAIT")
						await new Promise((resolve) => setTimeout(resolve, 150));
					else throw new Error("Unsupported observed action.");
				} finally {
					await nodeHandle.dispose();
				}
			},
			dispose: () => handle.dispose(),
		};
	} catch (error) {
		await handle.dispose().catch(() => undefined);
		throw error;
	}
}

/**
 * The browser implementation of the loop's Driver contract.
 *
 * Everything Playwright-specific about driving a surface lives here, including the
 * error vocabulary the loop must not know about: a destroyed execution context is
 * a navigation in progress, and a document that never became readable is a browser
 * condition rather than a generic failure.
 */
export function browserDriver(getPage: () => Page): Driver {
	return {
		// The page object is the surface identity: the manager swaps it when the run
		// moves to another tab, and the loop stops instead of acting on the new one.
		id: () => getPage(),
		observe: (signal?: AbortSignal) => observe(getPage(), signal),
		readFailureCategory(error: unknown) {
			if (isNavigationReadError(error)) return "navigation_context";
			if (
				error instanceof Error &&
				error.message.includes("PI_JEV_BROWSER_DOCUMENT_NOT_READY")
			)
				return "document_not_ready";
			return undefined;
		},
	};
}
