import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readJevCredentials,
	readTextHelperModel,
} from "../src/credentials.ts";

test("credential file handles JSON syntax, precedence, reloads and missing keys", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-browser-credentials-"));
	const path = join(directory, "config.json");
	try {
		assert.throws(() => readJevCredentials({ path, env: {} }), /TYPESAFE_API_KEY/);
		writeFileSync(
			path,
			JSON.stringify({
				typesafe: {
					apiKey: "file-test-key",
					baseUrl: "https://typesafe.example.test",
					model: "jev-preview",
				},
				textHelper: { model: "anthropic/claude-haiku-4" },
			}),
			{ mode: 0o600 },
		);
		assert.deepEqual(readJevCredentials({ path, env: {} }), {
			apiKey: "file-test-key",
			baseUrl: "https://typesafe.example.test",
			model: "jev-preview",
		});
		assert.equal(readTextHelperModel({ path, env: {} }), "anthropic/claude-haiku-4");
		assert.deepEqual(
			readJevCredentials({
				path,
				env: {
					TYPESAFE_API_KEY: "env-test-key",
					TYPESAFE_BASE_URL: "https://env.example.test",
					TYPESAFE_DEFAULT_MODEL: "jev-1.13.0",
				},
			}),
			{
				apiKey: "env-test-key",
				baseUrl: "https://env.example.test",
				model: "jev-1.13.0",
			},
		);
		assert.equal(
			readJevCredentials({ path, env: { TYPESAFE_API_KEY: "  " } }).apiKey,
			"file-test-key",
		);
		assert.equal(
			readTextHelperModel({ path, env: { PI_BROWSER_TEXT_MODEL: "openai/gpt-5" } }),
			"openai/gpt-5",
		);
		writeFileSync(
			path,
			JSON.stringify({ typesafe: { apiKey: "changed-test-key" } }),
		);
		assert.equal(
			readJevCredentials({ path, env: {} }).apiKey,
			"changed-test-key",
		);
		assert.deepEqual(readJevCredentials({ path, env: {} }), {
			apiKey: "changed-test-key",
			baseUrl: "https://api.typesafe.ai",
			model: "jev-latest",
		});
		assert.equal(readTextHelperModel({ path, env: {} }), undefined);
		writeFileSync(path, "{}");
		assert.throws(() => readJevCredentials({ path, env: {} }), /TYPESAFE_API_KEY/);
		writeFileSync(path, "{invalid");
		assert.throws(() => readJevCredentials({ path, env: {} }), /is not valid JSON/);
		assert.throws(
			() => readJevCredentials({ path: directory, env: {} }),
			/Cannot read/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
