import type { Browser, BrowserContext, Page, Video } from "playwright";

/**
 * Browser settings only. Credentials live in credentials.ts and never enter
 * browser state.
 */
export interface PiBrowserConfig {
	allowedOrigins: string[];
	/** Checked before allowedOrigins, so a deny rule always wins. */
	denyOrigins: string[];
	/** Origins whose tool calls require an explicit user confirmation first. */
	requireConfirmation: string[];
	headless: boolean;
	recordVideo: boolean;
	showCursor: boolean;
	showClickIndicators: boolean;
	outputDir: string;
	viewport: { width: number; height: number };
	stream: { enabled: boolean; intervalMs: number };
	/**
	 * "stay" keeps observing the page the run started on when a site opens a new
	 * tab; "follow" adopts the new tab as the observed page. Either way the new tab
	 * is reported, because silently moving the run to another origin is a bug.
	 */
	popups: "stay" | "follow";
	/**
	 * "session" keeps one profile per conversation (log in once, reuse it in later
	 * runs of the same session), "shared" reuses one profile everywhere, "off"
	 * starts clean every run.
	 */
	profile: "session" | "shared" | "off";
	profileDir: string;
}

/**
 * Deterministic element addressing for manual actions. Nothing here is decided
 * by a model, so the same call always targets the same element.
 */
export interface ElementTarget {
	/** HTML/ARIA role, for example "link", "button", "textbox", "combobox". */
	role?: string;
	/** Accessible name, matched case-insensitively as a substring. */
	name?: string;
	/** Visible text, matched case-insensitively as a substring. */
	text?: string;
	/** CSS selector, when role/name is not specific enough. */
	selector?: string;
	/** Zero-based index when several elements match. */
	nth?: number;
}

export type BrowserAction =
	| {
			type: "click" | "double_click";
			/** Coordinate click. Either x/y or target is required. */
			x?: number;
			y?: number;
			/** Element click resolved with Playwright locators. */
			target?: ElementTarget;
			button?: "left" | "right" | "wheel";
			keys?: string[];
	  }
	| { type: "fill"; target: ElementTarget; value: string }
	| { type: "select"; target: ElementTarget; value: string }
	| { type: "scroll"; x?: number; y?: number; deltaX: number; deltaY: number }
	| { type: "type"; text: string }
	| { type: "wait"; ms?: number }
	| { type: "keypress"; keys: string[] }
	| {
			type: "drag";
			path: Array<{ x: number; y: number } | [number, number]>;
			button?: "left" | "right" | "wheel";
	  }
	| { type: "move"; x: number; y: number }
	| { type: "screenshot" }
	| { type: "navigate"; url: string }
	| { type: "activate_tab" | "close_tab"; index: number }
	| { type: "back" | "forward" | "reload" };

/**
 * Tool result content, structurally compatible with pi's TextContent | ImageContent.
 */
export type ToolContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface BrowserLogEntry {
	id: number;
	timestamp: string;
	type:
		| "console"
		| "pageerror"
		| "requestfailed"
		| "download"
		| "navigation"
		| "tab"
		| "security";
	level: string;
	text: string;
	url?: string;
}

export interface BrowserState {
	active: boolean;
	currentUrl?: string;
	pageTitle?: string;
	pages: Array<{ index: number; title: string; url: string }>;
	/** Index into pages for the tab the run is observing. */
	activePageIndex?: number;
	startedAt?: string;
	viewport: { width: number; height: number };
}

export interface ActiveBrowserSession {
	/** Present for launched browsers; a persistent context owns its own browser. */
	browser?: Browser;
	context: BrowserContext;
	page: Page;
	video?: Video;
	id: string;
	outputDir: string;
	startedAt: string;
	logs: BrowserLogEntry[];
	nextLogId: number;
	/** Notices that must reach the next tool result, such as tab switches. */
	notices: string[];
	stream?: StreamController;
}

export interface StreamController {
	url: string;
	stop(): Promise<void>;
}

/**
 * Host-side request data. pi passes a live AbortSignal and a real session id,
 * so neither has to be simulated the way the Cline JSON IPC transport required.
 */
export interface ToolHost {
	sessionId: string;
	signal?: AbortSignal;
	onEvent?: (type: string, payload: unknown) => void;
}
