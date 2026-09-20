import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { configurationError } from "./errors.ts";
import type { PiBrowserConfig } from "./types.ts";

/** pi's global config directory (`~/.pi/agent`). */
export const AGENT_DIR = join(homedir(), ".pi", "agent");

export const CONFIG_PATH =
	process.env.PI_JEV_BROWSER_CONFIG?.trim() ||
	join(AGENT_DIR, "pi-jev-browser.config.json");

const DEFAULT_CONFIG: PiBrowserConfig = {
	allowedOrigins: ["http://*", "https://*"],
	denyOrigins: [],
	requireConfirmation: [],
	headless: true,
	recordVideo: true,
	showCursor: true,
	showClickIndicators: true,
	outputDir: join(AGENT_DIR, "pi-jev-browser"),
	viewport: { width: 1280, height: 720 },
	stream: { enabled: false, intervalMs: 1000 },
	popups: "stay",
	profile: "session",
	profileDir: join(AGENT_DIR, "pi-jev-browser-profile"),
	desktop: { requireConfirmation: true },
};

export function readConfigFile(path = CONFIG_PATH): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw configurationError(
			`Cannot read ${path}. Check permissions and that it is a file.`,
		);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw configurationError(
			`${path} is not valid JSON. Fix the file or remove it to use defaults.`,
		);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw configurationError(`${path} must contain a JSON object.`);
	return raw as Record<string, unknown>;
}

export function readConfig(path = CONFIG_PATH): PiBrowserConfig {
	// Only browser settings leave this reader; credentials stay out of browser state.
	const raw = readConfigFile(path) as Partial<PiBrowserConfig>;

	const viewport = {
		width: boundedInteger(
			raw.viewport?.width,
			640,
			2560,
			DEFAULT_CONFIG.viewport.width,
		),
		height: boundedInteger(
			raw.viewport?.height,
			480,
			1600,
			DEFAULT_CONFIG.viewport.height,
		),
	};
	const allowedOrigins = originList(raw.allowedOrigins, DEFAULT_CONFIG.allowedOrigins);

	return {
		allowedOrigins,
		denyOrigins: originList(raw.denyOrigins, DEFAULT_CONFIG.denyOrigins),
		requireConfirmation: originList(
			raw.requireConfirmation,
			DEFAULT_CONFIG.requireConfirmation,
		),
		headless: raw.headless !== false,
		recordVideo: raw.recordVideo !== false,
		showCursor: raw.showCursor !== false,
		showClickIndicators: raw.showClickIndicators !== false,
		outputDir:
			typeof raw.outputDir === "string" && raw.outputDir.trim()
				? resolve(expandHome(raw.outputDir))
				: DEFAULT_CONFIG.outputDir,
		viewport,
		stream: {
			enabled: raw.stream?.enabled === true,
			intervalMs: boundedInteger(
				raw.stream?.intervalMs,
				250,
				10_000,
				DEFAULT_CONFIG.stream.intervalMs,
			),
		},
		popups: raw.popups === "follow" ? "follow" : "stay",
		profile:
			raw.profile === "shared" || raw.profile === "off"
				? raw.profile
				: "session",
		profileDir:
			typeof raw.profileDir === "string" && raw.profileDir.trim()
				? resolve(expandHome(raw.profileDir))
				: DEFAULT_CONFIG.profileDir,
		desktop: {
			requireConfirmation: raw.desktop?.requireConfirmation !== false,
		},
	};
}

function originList(value: unknown, fallback: string[]) {
	return Array.isArray(value)
		? value.filter(
				(entry): entry is string =>
					typeof entry === "string" && entry.trim().length > 0,
			)
		: fallback;
}

export function isUrlAllowed(value: string, patterns: string[]): boolean {
	if (value === "about:blank") return true;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;

	return patterns.some((pattern) => {
		const normalized = pattern.trim();
		if (!normalized) return false;
		const expression = `^${escapeRegExp(normalized).replaceAll("\\*", ".*")}$`;
		return new RegExp(expression, "i").test(url.origin);
	});
}

export function expandHome(value: string) {
	return value.replace(/^~(?=$|\/)/, homedir());
}

function boundedInteger(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
) {
	return typeof value === "number" && Number.isInteger(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
