import type { Page } from "playwright";

export interface ExtractInput {
	/** What to read. Defaults to "text". */
	kind?: "text" | "table" | "links" | "attributes";
	/** CSS selector for the elements to read. Defaults to the document. */
	selector?: string;
	/** Attribute name, required by kind "attributes". */
	attribute?: string;
	/** Maximum number of elements to read; capped so a huge DOM cannot stall a call. */
	limit?: number;
}

export interface ExtractResult {
	kind: string;
	selector?: string;
	count: number;
	items: unknown[];
	truncated: boolean;
}

const MAX_LIMIT = 200;
const MAX_TEXT = 4000;
const MAX_ITEM_TEXT = 500;
const MAX_CELLS = 30;

/**
 * Deterministic extraction, so a repeatable read never depends on a model
 * decision. The page stays untrusted data: the caller decides what it means.
 */
export async function extractFromPage(
	page: Page,
	input: ExtractInput,
): Promise<ExtractResult> {
	const kind = input.kind ?? "text";
	const limit = Math.min(
		MAX_LIMIT,
		Math.max(1, Math.floor(input.limit ?? 50)),
	);
	if (kind === "attributes" && !input.attribute?.trim())
		throw new Error('kind "attributes" requires attribute.');

	try {
		return (await page.evaluate(
			({ kind, selector, attribute, limit, maxText, maxItemText, maxCells }) => {
				const roots = selector
					? Array.from(document.querySelectorAll(selector))
					: [document.documentElement];
				const truncate = (value: string, cap: number) =>
					value.length > cap ? `${value.slice(0, cap)}…` : value;
				const items: unknown[] = [];
				let truncated = false;

				if (kind === "table") {
					const table = roots.find(
						(node): node is HTMLTableElement => node instanceof HTMLTableElement,
					);
					if (!table) return { kind, selector, count: 0, items: [], truncated: false };
					const rows = Array.from(table.querySelectorAll("tr"));
					for (const row of rows.slice(0, limit)) {
						const cells = Array.from(row.querySelectorAll("th,td")).map((cell) =>
							truncate((cell.textContent ?? "").trim().replace(/\s+/g, " "), maxItemText),
						);
						items.push(cells.slice(0, maxCells));
					}
					return {
						kind,
						selector,
						count: rows.length,
						items,
						truncated: rows.length > limit,
					};
				}

				let used = 0;
				for (const node of roots) {
					if (items.length >= limit) {
						truncated = true;
						break;
					}
					const element = node as HTMLElement;
					if (kind === "links") {
						if (!(element instanceof HTMLAnchorElement)) continue;
						const href = element.href;
						if (!href) continue;
						items.push({
							text: truncate(
								(element.textContent ?? "").trim().replace(/\s+/g, " "),
								maxItemText,
							),
							href,
						});
						continue;
					}
					if (kind === "attributes") {
						const value = element.getAttribute(attribute as string);
						if (value === null) continue;
						items.push(truncate(value, maxItemText));
						continue;
					}
					const text = (element.innerText ?? element.textContent ?? "")
						.trim()
						.replace(/\s+/g, " ");
					if (!text) continue;
					const remaining = maxText - used;
					if (remaining <= 0) {
						truncated = true;
						break;
					}
					const value = truncate(text, Math.min(maxItemText, remaining));
					used += value.length;
					items.push(value);
				}
				return { kind, selector, count: roots.length, items, truncated };
			},
			{
				kind,
				selector: input.selector,
				attribute: input.attribute,
				limit,
				maxText: MAX_TEXT,
				maxItemText: MAX_ITEM_TEXT,
				maxCells: MAX_CELLS,
			},
		)) as ExtractResult;
	} catch (error) {
		// Playwright reports an invalid selector as a generic evaluation failure.
		throw new Error(
			`Extraction failed for selector ${JSON.stringify(input.selector ?? "document")}: ${
				error instanceof Error ? error.message.split("\n")[0] : String(error)
			}`,
		);
	}
}
