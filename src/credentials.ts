import { CONFIG_PATH, readConfigFile } from "./config.ts";
import { configurationError } from "./errors.ts";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_MODEL = "jev-latest";

export interface JevCredentials {
	apiKey: string;
	baseUrl: string;
	model: string;
}

/**
 * Read per run without mutating process.env or exposing credentials to Chromium.
 * Precedence: environment, then the JSON configuration file.
 */
export function readJevCredentials(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): JevCredentials {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const typesafe = raw.typesafe as
		| { apiKey?: unknown; baseUrl?: unknown; model?: unknown }
		| undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";

	const apiKey = value(env.TYPESAFE_API_KEY) || value(typesafe?.apiKey);
	if (!apiKey)
		throw configurationError(
			`The jev_run Jev loop requires TYPESAFE_API_KEY in the pi process environment or typesafe.apiKey in ${path}.`,
		);

	return {
		apiKey,
		baseUrl:
			value(env.TYPESAFE_BASE_URL) || value(typesafe?.baseUrl) || DEFAULT_BASE_URL,
		model:
			value(env.TYPESAFE_DEFAULT_MODEL) ||
			value(typesafe?.model) ||
			DEFAULT_MODEL,
	};
}

/** Optional override for the pi model that generates field text. */
export function readTextHelperModel(
	options: { path?: string; env?: NodeJS.ProcessEnv } = {},
): string | undefined {
	const path = options.path ?? CONFIG_PATH;
	const env = options.env ?? process.env;
	const raw = readConfigFile(path);
	const textHelper = raw.textHelper as { model?: unknown } | undefined;
	const value = (input: unknown) =>
		typeof input === "string" ? input.trim() : "";
	return value(env.PI_JEV_BROWSER_TEXT_MODEL) || value(textHelper?.model) || undefined;
}
