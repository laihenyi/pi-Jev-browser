import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function installChromium(): Promise<void> {
	// Resolve the extension's own Playwright CLI so browser revisions match its
	// dependency. Playwright is imported lazily everywhere else; the CLI is the
	// only runtime reference we need at setup time.
	const cli = resolvePlaywrightCli();
	try {
		await execFileAsync(process.execPath, [cli, "install", "chromium"], {
			timeout: 120_000,
			maxBuffer: 2 * 1024 * 1024,
			windowsHide: true,
		});
	} catch {
		// Installer output can contain proxy credentials; do not expose it to tools.
		throw new Error(
			"Automatic Chromium setup failed or timed out. Check network/proxy access and browser-cache permissions, then retry browser_run. On Linux, required system libraries must also be installed by the system administrator.",
		);
	}
}

/**
 * Prefer the extension directory, then walk upward so a hoisted or
 * workspace-level Playwright install still resolves.
 */
export function resolvePlaywrightCli(): string {
	const candidates: string[] = [];
	const here = extensionDir();
	if (here) {
		let dir = here;
		for (let depth = 0; depth < 8; depth++) {
			candidates.push(join(dir, "node_modules", "playwright", "cli.js"));
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
	}
	const found = candidates.find((candidate) => existsSync(candidate));
	if (!found)
		throw new Error(
			"Playwright is not installed next to the pi-browser extension. Run `npm install` in the extension directory.",
		);
	return found;
}

function extensionDir(): string | undefined {
	try {
		return dirname(new URL(import.meta.url).pathname);
	} catch {
		return undefined;
	}
}

export function createBrowserSetup(install: () => Promise<void>) {
	let pending: Promise<void> | undefined;
	return () => {
		if (!pending) {
			pending = Promise.resolve()
				.then(install)
				.catch((error) => {
					pending = undefined;
					throw error;
				});
		}
		return pending;
	};
}

// The CLI checks its cache and downloads only missing browser artifacts.
export const ensureChromium = createBrowserSetup(installChromium);
