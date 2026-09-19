#!/usr/bin/env node
// A fake accessibility helper for tests: same line protocol as desktop/ax-helper.swift,
// no macOS, no accessibility permission. Configuration comes from the environment so a
// test can script the tree and observe what the driver asked for.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_AX_LOG;
const nodes = JSON.parse(process.env.FAKE_AX_NODES ?? "[]");
let signature = process.env.FAKE_AX_SIGNATURE ?? "sig-1";
const frontBundle = process.env.FAKE_AX_FRONT ?? "com.test.app";

const respond = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
const record = (entry) => {
	if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (!line.trim()) return;
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		respond({ ok: false, error: "request was not a JSON object" });
		return;
	}
	record({ request });
	switch (request.cmd) {
		case "ping":
			respond({ ok: true, trusted: process.env.FAKE_AX_UNTRUSTED !== "1", version: 1 });
			return;
		case "front":
			respond({ ok: true, bundleId: frontBundle });
			return;
		case "activate":
			respond({ ok: true });
			return;
		case "observe":
			respond({
				ok: true,
				bundleId: request.bundleId,
				app: "Fake app",
				window: "Fake window",
				signature,
				text: process.env.FAKE_AX_TEXT ?? "0",
				nodes,
			});
			return;
		case "press":
		case "setvalue":
			if (request.signature !== signature) {
				respond({ ok: false, error: "surface changed since the observation" });
				return;
			}
			if (process.env.FAKE_AX_NEXT_SIGNATURE) signature = process.env.FAKE_AX_NEXT_SIGNATURE;
			respond({ ok: true });
			return;
		case "setsignature":
			// Lets a test simulate the application changing state between an observation
			// and the action that observation was bound to.
			signature = String(request.value);
			respond({ ok: true });
			return;
		case "quit":
			respond({ ok: true });
			process.exit(0);
			return;
		default:
			respond({ ok: false, error: `unknown command ${request.cmd}` });
	}
});
