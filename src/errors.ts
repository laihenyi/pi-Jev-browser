/**
 * Failure classification and redaction.
 *
 * Configuration and text-helper-output problems are authored here and safe to
 * show the model. Provider errors are not: they can embed the outgoing request
 * body, which contains page text and field values. Those are reduced to a safe
 * structural summary in tool output and written in full to the run's local
 * `errors.log`, which never enters the model context.
 */
const CONFIGURATION = "JevConfigurationError";
const TEXT_OUTPUT = "JevTextOutputError";

function branded(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

export function configurationError(message: string): Error {
	return branded(CONFIGURATION, message);
}

export function isConfigurationError(error: unknown): boolean {
	return error instanceof Error && error.name === CONFIGURATION;
}

/** The text helper produced something that is not a usable field value. */
export function textOutputError(message: string): Error {
	return branded(TEXT_OUTPUT, message);
}

export function isTextOutputError(error: unknown): boolean {
	return error instanceof Error && error.name === TEXT_OUTPUT;
}

export function failureCategory(error: unknown): string {
	if (isConfigurationError(error)) return "configuration";
	if (isTextOutputError(error)) return "text_helper_invalid_output";
	return "unexpected_error";
}

/**
 * A bounded, credential-free summary. Only errors authored by this extension
 * expose their message.
 */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return `thrown ${typeof error}`;
	const status = numericField(error, ["statusCode", "status", "code"]);
	const label = `${error.name || "Error"}${status === undefined ? "" : ` HTTP ${status}`}`;
	return isConfigurationError(error) || isTextOutputError(error)
		? `${label}: ${error.message}`
		: label;
}

/** Full diagnostic text for the local run log. Never returned to the model. */
export function diagnosticRecord(
	error: unknown,
	context: Record<string, unknown> = {},
): string {
	const base = { timestamp: new Date().toISOString(), ...context };
	if (!(error instanceof Error))
		return JSON.stringify({ ...base, thrown: String(error) }, null, 2);
	return JSON.stringify(
		{
			...base,
			name: error.name,
			message: error.message,
			stack: error.stack,
		},
		null,
		2,
	);
}

function numericField(error: Error, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = (error as unknown as Record<string, unknown>)[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	const response = (error as unknown as { response?: { status?: unknown } }).response;
	if (response && typeof response.status === "number") return response.status;
	return undefined;
}
