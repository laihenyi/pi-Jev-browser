import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isUrlAllowed, readConfig } from "../src/config.ts";

test("matches configured origins and blocks unsupported schemes", () => {
	const patterns = ["https://*.example.com", "http://localhost:*"];
	assert.equal(isUrlAllowed("https://app.example.com/path", patterns), true);
	assert.equal(isUrlAllowed("http://localhost:4173", patterns), true);
	assert.equal(isUrlAllowed("https://example.net", patterns), false);
	assert.equal(isUrlAllowed("file:///etc/passwd", ["*"]), false);
});

test("loads bounded config values", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-config-"));
	const path = join(directory, "config.json");
	try {
		writeFileSync(
			path,
			JSON.stringify({
				allowedOrigins: ["https://example.com"],
				viewport: { width: 99, height: 9999 },
				stream: { enabled: true, intervalMs: 10 },
			}),
		);
		const config = readConfig(path);
		assert.deepEqual(config.allowedOrigins, ["https://example.com"]);
		assert.deepEqual(config.viewport, { width: 640, height: 1600 });
		assert.deepEqual(config.stream, { enabled: true, intervalMs: 250 });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("uses complete defaults when configuration is omitted", () => {
	const config = readConfig(
		join(tmpdir(), "missing-pi-jev-browser.config.json"),
	);
	assert.deepEqual(config.allowedOrigins, ["http://*", "https://*"]);
	assert.equal(config.headless, true);
	assert.equal(config.recordVideo, true);
	assert.equal(config.showCursor, true);
	assert.equal(config.showClickIndicators, true);
	assert.deepEqual(config.viewport, { width: 1280, height: 720 });
	assert.deepEqual(config.stream, { enabled: false, intervalMs: 1000 });
	// A new tab must never hijack a run, so "stay" is the default policy.
	assert.equal(config.popups, "stay");
	assert.equal(config.profile, "session");
	assert.deepEqual(config.denyOrigins, []);
	assert.deepEqual(config.requireConfirmation, []);
	assert.equal(isUrlAllowed("https://openai.com", config.allowedOrigins), true);
	assert.equal(
		isUrlAllowed("http://example.test:8080", config.allowedOrigins),
		true,
	);
	assert.equal(
		isUrlAllowed("file:///etc/passwd", config.allowedOrigins),
		false,
	);
});

test("reports unreadable or malformed configuration instead of silently defaulting", () => {
	assert.throws(() => readConfig(tmpdir()), /Cannot read/);
	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-config-bad-"));
	const path = join(directory, "config.json");
	try {
		writeFileSync(path, "{invalid");
		assert.throws(() => readConfig(path), /is not valid JSON/);
		writeFileSync(path, JSON.stringify([1, 2, 3]));
		assert.throws(() => readConfig(path), /must contain a JSON object/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("the desktop tool asks before every run by default and has no allow list", () => {
	const defaults = readConfig(join(tmpdir(), "missing-pi-jev-browser.config.json"));
	assert.deepEqual(defaults.desktop, { requireConfirmation: true });

	const directory = mkdtempSync(join(tmpdir(), "pi-jev-browser-config-"));
	const path = join(directory, "config.json");
	try {
		// A leftover allowedBundleIds from an older config is ignored, not enforced.
		writeFileSync(
			path,
			JSON.stringify({ desktop: { allowedBundleIds: ["com.apple.calculator"], requireConfirmation: false } }),
		);
		const config = readConfig(path);
		assert.deepEqual(config.desktop, { requireConfirmation: false });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
