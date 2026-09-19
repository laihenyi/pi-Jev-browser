import type { Page } from "playwright";

export interface FrameHit {
	/** Origin of the frame that would receive the pointer. */
	origin: string;
	/** Full src (truncated) for the log. */
	src: string;
	title?: string;
	/** Known anti-bot provider, when the frame belongs to one. */
	provider?: string;
}

/**
 * The automatic Jev loop acts on DOM nodes captured from the main frame and can
 * never reach frame content. This tool's clicks are raw coordinate events, which
 * the browser does route across frame boundaries, so any click that lands on a
 * frame is reported instead of happening silently.
 */
export async function frameAtPoint(
	page: Page,
	x: number,
	y: number,
): Promise<FrameHit | undefined> {
	return page.evaluate(
		({ x, y }) => {
			const element = document.elementFromPoint(x, y);
			if (!(element instanceof HTMLIFrameElement)) return undefined;
			const raw = element.getAttribute("src") ?? "";
			let origin: string;
			try {
				origin = raw ? new URL(raw, location.href).origin : "(srcdoc)";
			} catch {
				origin = "(unparseable src)";
			}
			return {
				origin,
				src: raw.slice(0, 300),
				title: element.getAttribute("title") ?? undefined,
			};
		},
		{ x, y },
	);
}

const PROVIDERS: Array<{ test: (url: URL) => boolean; name: string }> = [
	{
		test: (url) =>
			url.hostname.endsWith("google.com") && url.pathname.startsWith("/recaptcha"),
		name: "reCAPTCHA",
	},
	{
		test: (url) => url.hostname.endsWith("hcaptcha.com"),
		name: "hCaptcha",
	},
	{
		test: (url) =>
			url.hostname === "challenges.cloudflare.com" ||
			(url.hostname.endsWith("cloudflare.com") &&
				/challenge|turnstile/i.test(url.pathname)),
		name: "Cloudflare challenge",
	},
];

export function detectFrameProvider(src: string): string | undefined {
	let url: URL;
	try {
		url = new URL(src);
	} catch {
		return undefined;
	}
	return PROVIDERS.find((provider) => provider.test(url))?.name;
}

/** Human-readable warning recorded on the tool result and in browser_logs. */
export function frameWarning(
	action: string,
	x: number,
	y: number,
	hit: FrameHit,
): string {
	const provider = hit.provider ? ` [${hit.provider}]` : "";
	return `A ${action} at (${Math.round(x)}, ${Math.round(y)}) landed inside a frame from ${hit.origin}${provider}. The automatic Jev loop never interacts with frame content; this was a raw coordinate click.`;
}
