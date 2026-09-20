/**
 * The contract between the decision loop and the surface it drives.
 *
 * `loop.ts` implements the part of this project that turned out to be hard:
 * bounded steps, staleness detection, an oscillation guard, a no-progress guard,
 * traces, and handing control back to the human before a consequential action.
 * None of that is web-specific, so the loop depends on this interface instead of
 * a Playwright `Page`, and it no longer imports Playwright at all.
 *
 * The browser driver lives in `observe.ts` (`browserDriver`). A desktop driver
 * would return the same `Observation` shape built from an accessibility tree,
 * with `url` carrying an application or window identifier.
 */

/** The only operations a driver has to support. Scrolling and waiting are internal. */
export type TargetOperation = "CLICK" | "TYPE_TEXT" | "SELECT";

export interface ObservedTarget {
	id: string;
	operation: TargetOperation;
	label: string;
	value: string;
	option?: string;
	role?: string;
	checked?: string;
	selected?: string;
	expanded?: string;
	href?: string;
	/**
	 * A stable, usually non-localised handle for the target: an element id or
	 * data-testid in a page, an accessibility identifier in an application. A
	 * decision layer that has this does not have to guess from translated labels.
	 */
	identifier?: string;
}

/**
 * What the decision layer reads. Everything in here is text or a small enum, so a
 * driver never has to send pixels.
 */
export interface Observation {
	/** Identifies the observed surface: a page URL today, a window id later. */
	url: string;
	title: string;
	text: string;
	targets: ObservedTarget[];
	offscreenControls?: { above: string[]; below: string[] };
	selectedOptions?: Array<{ group: string; label: string; value: string }>;
	scrollUp: boolean;
	scrollDown: boolean;
}

/**
 * One observation plus the ability to act on the surface it came from. A snapshot
 * is bound to the state it was read from: `assertFresh` and `execute` both refuse
 * to act once that state has moved, which is what keeps actions from landing on
 * whatever replaced the target in the meantime.
 */
export interface ObservationSnapshot {
	data: Observation;
	execute(
		operation: string,
		target: ObservedTarget | undefined,
		text: string | undefined,
		signal: AbortSignal,
	): Promise<void>;
	assertFresh(): Promise<void>;
	dispose(): Promise<void>;
}

export interface Driver {
	/**
	 * Identity of the observed surface. The loop compares it before and after a
	 * decision, so a run that silently moved (another tab, another window, a dialog
	 * stealing focus) stops instead of acting on a surface nobody chose. A driver may
	 * answer asynchronously when the identity has to be queried.
	 */
	id(): unknown | Promise<unknown>;
	observe(signal?: AbortSignal): Promise<ObservationSnapshot>;
	/**
	 * Classifies a read failure that the driver understands better than the generic
	 * mapping, or returns undefined to fall through to it. This is how a driver adds
	 * its own error vocabulary (a browser has navigation contexts; a desktop has
	 * windows that close) without the loop knowing those words.
	 */
	readFailureCategory?(
		error: unknown,
	): "navigation_context" | "document_not_ready" | "window_unavailable" | undefined;
}

/** The observation was invalidated before the action could run. */
export class StaleObservationError extends Error {}
