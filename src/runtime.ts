import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { executeActions } from "./actions.ts";
import { ensureChromium } from "./browser-setup.ts";
import { isUrlAllowed, readConfig } from "./config.ts";
import { diagnosticRecord } from "./errors.ts";
import { extractFromPage, type ExtractInput } from "./extract.ts";
import { type RunMemory, type RunStep, runJev } from "./loop.ts";
import { waitForDocument } from "./observe.ts";
import type { JevPolicy } from "./policy.ts";
import { installRecordingOverlay } from "./recording-overlay.ts";
import { startStream } from "./stream.ts";
import type {
	ActiveBrowserSession,
	BrowserAction,
	BrowserLogEntry,
	BrowserState,
	PiBrowserConfig,
	ToolContent,
	ToolHost,
} from "./types.ts";

interface BrowserRunInput {
	url?: string;
	headless?: boolean;
	recordVideo?: boolean;
	showCursor?: boolean;
	showClickIndicators?: boolean;
	goal: string;
	maxSteps?: number;
	minProbability?: number;
}

type ManagedSession = ActiveBrowserSession & {
	emit: (type: string, payload: unknown) => void;
	/** Reports tabs that appeared since the last drain and returns pending notices. */
	drainNotices?: () => string[];
};

export class PiBrowserManager {
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly jevMemory = new WeakMap<ActiveBrowserSession, RunMemory>();
	private readonly running = new Map<string, AbortController>();

	private async startBrowser(
		input: {
			url?: string;
			headless?: boolean;
			recordVideo?: boolean;
			showCursor?: boolean;
			showClickIndicators?: boolean;
		},
		host: ToolHost,
	) {
		const key = sessionKey(host);
		await this.stopByKey(key).catch(() => undefined);
		const config = readConfig();
		const url = input.url?.trim() || "about:blank";
		assertUrlAllowed(url, config);
		const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
		const outputDir = join(config.outputDir, safePathPart(key), id);
		await mkdir(join(outputDir, "screenshots"), { recursive: true });
		if (input.recordVideo ?? config.recordVideo)
			await mkdir(join(outputDir, "videos"), { recursive: true });

		await ensureChromium();
		// Playwright is imported lazily so loading the extension never depends on it.
		const { chromium } = await import("playwright");

		const requestedHeadless = input.headless ?? config.headless;
		const launchOptions = {
			// On macOS this keeps the full Chromium build, which supports both
			// headless and a visible window if the host process forbids headless.
			...(process.platform === "darwin"
				? { channel: "chromium" as const }
				: { chromiumSandbox: true }),
			timeout: 20_000,
			env: {},
			args: [
				"--disable-extensions",
				"--disable-file-system",
				`--window-size=${config.viewport.width},${config.viewport.height}`,
			],
		};
		const contextOptions = {
			viewport: config.viewport,
			acceptDownloads: false as const,
			serviceWorkers: "block" as const,
			...((input.recordVideo ?? config.recordVideo)
				? {
						recordVideo: {
							dir: join(outputDir, "videos"),
							size: config.viewport,
						},
					}
				: {}),
		};
		const profileDir = resolveProfileDir(config, key);
		let actualHeadless = requestedHeadless;
		let launchWarning: string | undefined;
		let browser: Browser | undefined;
		let browserContext: BrowserContext;
		const start = async (headless: boolean) => {
			if (profileDir) {
				// A persistent profile keeps cookies and local storage between runs, so a
				// human can complete a login once instead of on every run.
				const context = await chromium.launchPersistentContext(profileDir, {
					...launchOptions,
					...contextOptions,
					headless,
				});
				return { context, browser: undefined };
			}
			const launched = await chromium.launch({ ...launchOptions, headless });
			return {
				context: await launched.newContext(contextOptions),
				browser: launched,
			};
		};
		try {
			({ context: browserContext, browser } = await start(requestedHeadless));
		} catch (error) {
			if (process.platform !== "darwin" || !requestedHeadless) throw error;
			// Headless Chromium may be rejected by the host process even though a
			// normal browser window is allowed. Fall back instead of consuming the
			// entire tool call timeout.
			({ context: browserContext, browser } = await start(false));
			actualHeadless = false;
			launchWarning =
				"Headless Chromium was unavailable in this process, so Pi Jev Browser started a visible browser window.";
		}
		await installRecordingOverlay(browserContext, {
			showCursor: input.showCursor ?? config.showCursor,
			showClickIndicators:
				input.showClickIndicators ?? config.showClickIndicators,
		});
		const page = browserContext.pages()[0] ?? (await browserContext.newPage());
		const session: ManagedSession = {
			browser,
			context: browserContext,
			page,
			video: page.video() ?? undefined,
			id,
			outputDir,
			startedAt: new Date().toISOString(),
			logs: [],
			nextLogId: 1,
			notices: [],
			emit: (type, payload) => host.onEvent?.(type, payload),
		};
		this.sessions.set(key, session);
		this.attachObservability(session, config);

		try {
			if (url !== "about:blank")
				await page.goto(url, {
					waitUntil: "domcontentloaded",
					timeout: 20_000,
				});
			if (config.stream.enabled)
				await this.startStreamForSession(session, config.stream.intervalMs);
		} catch (error) {
			await this.stopByKey(key).catch(() => undefined);
			throw error;
		}

		const state = await this.stateForSession(session, config);
		session.emit("started", {
			state,
			outputDir,
			streamUrl: session.stream?.url,
			actualHeadless,
			launchWarning,
		});
		return {
			...state,
			outputDir,
			streamUrl: session.stream?.url,
			actualHeadless,
			launchWarning,
			message: "Browser started.",
		};
	}

	/** Current URL when a browser is active, for policy checks before a call. */
	currentUrl(host: ToolHost) {
		return this.sessions.get(sessionKey(host))?.page.url();
	}

	async screenshot(input: { label?: string }, host: ToolHost) {
		const session = this.requireSession(host);
		const config = readConfig();
		const label = sanitizeLabel(input.label ?? "screenshot");
		const path = join(
			session.outputDir,
			"screenshots",
			`${Date.now()}-${label}.png`,
		);
		await waitForDocument(session.page);
		const image = await session.page.screenshot({
			path,
			type: "png",
			timeout: 5000,
		});
		const state = await this.stateForSession(session, config);
		session.emit("screenshot", { state, path });
		return screenshotResult(state, path, image);
	}

	async actions(
		input: { actions: BrowserAction[]; includeScreenshot?: boolean },
		host: ToolHost,
	) {
		this.assertNotRunning(host);
		const session = this.requireSession(host);
		const config = readConfig();
		const key = sessionKey(host);
		const controller = new AbortController();
		this.running.set(key, controller);
		const warnings: string[] = [];
		// Only interactions can open a new tab, so the bounded tab settle is skipped
		// for pure reads like scroll, wait, and navigate.
		const canOpenTab = input.actions.some((action) =>
			["click", "double_click", "drag", "keypress"].includes(action.type),
		);
		try {
			await executeActions(session.page, input.actions, {
				assertUrlAllowed: (url) => assertUrlAllowed(url, config),
				signal: combineSignals([
					controller.signal,
					host.signal,
					AbortSignal.timeout(115_000),
				]),
				// Raw coordinate clicks can cross frame boundaries even though the
				// automatic loop cannot. Record where they land instead of staying silent.
				onFrameHit: ({ warning }) => {
					warnings.push(warning);
					this.addLog(session, {
						type: "security",
						level: "warning",
						text: warning,
						url: session.page.url(),
					});
				},
				// activate_tab/close_tab move the run, so the manager follows the choice.
				onActivePageChange: (page) => {
					session.page = page;
				},
			});
			if (canOpenTab) await this.settleTabs(session);
			const state = await this.stateForSession(session, config);
			const tabNotices = session.drainNotices?.() ?? session.notices.splice(0);
			if (tabNotices.length > 0) warnings.push(...tabNotices);
			session.emit("actions", {
				actionTypes: input.actions.map((action) => action.type),
				state,
			});
			if (input.includeScreenshot === false) {
				return {
					state,
					executed: input.actions.map((action) => action.type),
					warnings: warnings.length > 0 ? warnings : undefined,
				};
			}
			const shot = await this.screenshot({ label: "after-actions" }, host);
			return {
				...shot,
				warnings: warnings.length > 0 ? warnings : undefined,
			};
		} finally {
			this.running.delete(key);
		}
	}

	async extract(input: ExtractInput, host: ToolHost) {
		this.assertNotRunning(host);
		const session = this.requireSession(host);
		const result = await extractFromPage(session.page, input);
		session.emit("extract", {
			kind: result.kind,
			selector: result.selector,
			count: result.count,
		});
		return {
			...result,
			url: session.page.url(),
			title: await session.page.title().catch(() => ""),
		};
	}

	async run(input: BrowserRunInput, host: ToolHost, policy: JevPolicy) {
		this.assertNotRunning(host);
		const key = sessionKey(host);
		const controller = new AbortController();
		this.running.set(key, controller);
		try {
			if (!this.sessions.has(key)) await this.startBrowser(input, host);
			else if (input.url) {
				assertUrlAllowed(input.url, readConfig());
				await this.requireSession(host).page.goto(input.url, {
					waitUntil: "domcontentloaded",
					timeout: 20_000,
				});
			}
			const signal = combineSignals([controller.signal, host.signal]);
			signal.throwIfAborted();
			const session = this.requireSession(host);
			const tracePath = join(session.outputDir, `jev-${randomUUID()}.jsonl`);
			const errorsLogPath = join(session.outputDir, "errors.log");
			const initial = await this.screenshot({ label: "jev-initial" }, host);
			const memory = this.jevMemory.get(session) ?? {
				goal: input.goal,
				actions: [],
			};
			this.jevMemory.set(session, memory);
			const result = await runJev(input, {
				memory,
				policy,
				page: () => session.page,
				signal,
				onStep: async (step: RunStep) => {
					await appendFile(tracePath, `${JSON.stringify(step)}\n`);
					session.emit("jev-step", step);
				},
				// Full provider errors stay local: they can quote the request body.
				onFailure: async (error, stage) => {
					await appendFile(
						errorsLogPath,
						`${diagnosticRecord(error, { stage })}\n`,
					);
				},
			});
			// A tab switch changes which origin the run is observing, so the agent has to
			// see it even when the run itself succeeded.
			const tabNotices = session.drainNotices?.() ?? session.notices.splice(0);
			if (tabNotices.length > 0)
				result.warnings = [...(result.warnings ?? []), ...tabNotices];
			await appendFile(
				tracePath,
				`${JSON.stringify({ type: "result", ...result })}\n`,
			);
			let final:
				| Awaited<ReturnType<PiBrowserManager["screenshot"]>>
				| undefined;
			try {
				final = await this.screenshot({ label: "jev-final" }, host);
			} catch {
				/* Browser may have been stopped during cancellation. */
			}
			return {
				...result,
				tracePath,
				errorsLogPath: result.failure ? errorsLogPath : undefined,
				initialScreenshot: {
					artifactPath: initial.artifactPath,
					state: initial.state,
				},
				finalScreenshot: final
					? { artifactPath: final.artifactPath, state: final.state }
					: null,
				screenshotWarning: final
					? undefined
					: "Final screenshot unavailable; the browser may have closed. Outcome is unverified.",
				result: final?.result,
			};
		} finally {
			this.running.delete(key);
		}
	}

	/**
	 * A click that opens a new tab returns before the browser reports the tab: the
	 * page event can arrive a few milliseconds after the click call resolves and the
	 * tab shows up in pages() later still. Without this bounded wait the popup notice
	 * would miss the very call that caused it and surface one call later.
	 */
	private async settleTabs(session: ManagedSession) {
		const before = session.context.pages().length;
		for (let attempt = 0; attempt < 12; attempt++) {
			await sleep(60);
			if (session.context.pages().length !== before) {
				await sleep(120);
				return;
			}
		}
	}

	private assertNotRunning(host: ToolHost) {
		if (this.running.has(sessionKey(host)))
			throw new Error(
				"A browser operation is active for this session. Wait or cancel it before issuing another browser mutation.",
			);
	}

	async state(host: ToolHost) {
		const session = this.sessions.get(sessionKey(host));
		return session
			? this.stateForSession(session, readConfig())
			: ({
					active: false,
					pages: [],
					viewport: readConfig().viewport,
				} satisfies BrowserState);
	}

	logs(input: { afterId?: number; limit?: number }, host: ToolHost) {
		const session = this.requireSession(host);
		const afterId = Number.isFinite(input.afterId) ? Number(input.afterId) : 0;
		const limit = Math.min(1000, Math.max(1, Number(input.limit) || 200));
		const logs = session.logs
			.filter((entry) => entry.id > afterId)
			.slice(-limit);
		return {
			logs,
			lastId: logs.at(-1)?.id ?? afterId,
			total: session.logs.length,
		};
	}

	async stream(
		input: { action: "start" | "status" | "stop"; intervalMs?: number },
		host: ToolHost,
	) {
		const session = this.requireSession(host);
		if (input.action === "stop") {
			await session.stream?.stop();
			session.stream = undefined;
			return { active: false };
		}
		if (input.action === "start" && !session.stream) {
			await this.startStreamForSession(
				session,
				Math.min(
					10_000,
					Math.max(250, input.intervalMs ?? readConfig().stream.intervalMs),
				),
			);
		}
		return { active: Boolean(session.stream), url: session.stream?.url };
	}

	async stop(host: ToolHost) {
		this.running.get(sessionKey(host))?.abort();
		return this.stopByKey(sessionKey(host));
	}

	/** Close a session's browser without a tool call, e.g. on session_shutdown. */
	async stopSession(sessionId: string) {
		this.running.get(sessionId)?.abort();
		return this.stopByKey(sessionId);
	}

	async stopAll() {
		const keys = [...this.sessions.keys()];
		await Promise.all(keys.map((key) => this.stopSession(key)));
	}

	private async stopByKey(key: string) {
		const session = this.sessions.get(key);
		if (!session)
			return {
				active: false,
				message: "No browser is active for this pi session.",
			};
		this.sessions.delete(key);
		await settleWithin(session.stream?.stop(), 3_000);
		await settleWithin(session.context.close(), 8_000);
		let videoPath: string | undefined;
		try {
			videoPath = await withTimeout(
				session.video?.path(),
				8_000,
				"Video finalization",
			);
		} catch {
			videoPath = undefined;
		}
		if (session.browser) await settleWithin(session.browser.close(), 3_000);
		session.emit("stopped", { outputDir: session.outputDir, videoPath });
		return { active: false, outputDir: session.outputDir, videoPath };
	}

	private requireSession(host: ToolHost) {
		const key = sessionKey(host);
		const session = this.sessions.get(key);
		if (!session)
			throw new Error(
				"No browser is active. Call jev_run with a goal and initial URL first.",
			);
		// Rebind on every call: a session outlives the call that created it, and
		// progress events must reach the current caller, not the first one.
		session.emit = (type, payload) => host.onEvent?.(type, payload);
		return session;
	}

	private async stateForSession(
		session: ActiveBrowserSession,
		config: PiBrowserConfig,
	): Promise<BrowserState> {
		const pages = await Promise.all(
			session.context.pages().map(async (page, index) => ({
				index,
				title: await page.title().catch(() => ""),
				url: page.url(),
			})),
		);
		return {
			active: true,
			currentUrl: session.page.url(),
			pageTitle: await session.page.title().catch(() => ""),
			pages,
			activePageIndex: session.context.pages().indexOf(session.page),
			startedAt: session.startedAt,
			viewport: config.viewport,
		};
	}

	private attachObservability(
		session: ManagedSession,
		config: PiBrowserConfig,
	) {
		void session.context.route("**/*", async (route) => {
			const request = route.request();
			if (
				request.isNavigationRequest() &&
				!isUrlAllowed(request.url(), config.allowedOrigins)
			) {
				this.addLog(session, {
					type: "security",
					level: "blocked",
					text: "Blocked navigation outside allowedOrigins.",
					url: request.url(),
				});
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});

		const attachPage = (page: Page) => {
			page.on("console", (message) =>
				this.addLog(session, {
					type: "console",
					level: message.type(),
					text: message.text(),
					url: page.url(),
				}),
			);
			page.on("pageerror", (error) =>
				this.addLog(session, {
					type: "pageerror",
					level: "error",
					text: error.message,
					url: page.url(),
				}),
			);
			page.on("requestfailed", (request) =>
				this.addLog(session, {
					type: "requestfailed",
					level: "error",
					text: request.failure()?.errorText ?? "Request failed",
					url: request.url(),
				}),
			);
			page.on("download", (download) =>
				this.addLog(session, {
					type: "download",
					level: "blocked",
					text: `Download blocked: ${download.suggestedFilename()}`,
					url: page.url(),
				}),
			);
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame())
					this.addLog(session, {
						type: "navigation",
						level: "info",
						text: frame.url(),
						url: frame.url(),
					});
			});
		};
		attachPage(session.page);
		// The initial page is not a new tab.
		const reported = new WeakSet<Page>();
		reported.add(session.page);
		const reportTab = (page: Page) => {
			if (reported.has(page)) return;
			reported.add(page);
			// Silently adopting a new tab used to move the whole run to another origin
			// without telling anyone. Now the policy decides, and either way the switch
			// is logged and reported to the agent.
			const follow = config.popups === "follow";
			if (follow) session.page = page;
			const notice = follow
				? `A new tab opened at ${page.url()} and is now the observed page.`
				: `A new tab opened at ${page.url()}. Pi Jev Browser kept observing ${session.page.url()}; use jev_actions activate_tab or close_tab to switch tabs.`;
			session.notices.push(notice);
			this.addLog(session, {
				type: "tab",
				level: "info",
				text: notice,
				url: page.url(),
			});
			page.on("close", () => {
				// Never keep observing a closed page after a site closes its own tab.
				if (session.page !== page) return;
				const fallback = session.context
					.pages()
					.find((candidate) => !candidate.isClosed());
				if (!fallback) return;
				session.page = fallback;
				const message = `The observed tab closed, so Pi Jev Browser switched to ${fallback.url()}.`;
				session.notices.push(message);
				this.addLog(session, {
					type: "tab",
					level: "warning",
					text: message,
					url: fallback.url(),
				});
			});
		};
		// The page event can arrive after the click that caused it has already returned,
		// so notices are collected by comparing open pages rather than by event timing.
		session.drainNotices = () => {
			for (const page of session.context.pages()) reportTab(page);
			return session.notices.splice(0);
		};
		session.context.on("page", (page) => {
			attachPage(page);
			reportTab(page);
		});
	}

	private addLog(
		session: ManagedSession,
		input: Omit<BrowserLogEntry, "id" | "timestamp">,
	) {
		const entry: BrowserLogEntry = {
			id: session.nextLogId++,
			timestamp: new Date().toISOString(),
			...input,
		};
		session.logs.push(entry);
		if (session.logs.length > 5000)
			session.logs.splice(0, session.logs.length - 5000);
		session.emit("log", entry);
	}

	private async startStreamForSession(
		session: ManagedSession,
		intervalMs: number,
	) {
		session.stream = await startStream(session, { intervalMs });
		session.emit("stream", { url: session.stream.url });
	}
}

function screenshotResult(
	state: BrowserState,
	artifactPath: string,
	image: Buffer,
): { state: BrowserState; artifactPath: string; result: ToolContent[] } {
	return {
		state,
		artifactPath,
		result: [
			{
				type: "text",
				text: `Screenshot captured at ${artifactPath}. Current URL: ${state.currentUrl ?? "unknown"}`,
			},
			{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
		],
	};
}

function assertUrlAllowed(url: string, config: PiBrowserConfig) {
	if (isUrlAllowed(url, config.denyOrigins)) {
		throw new Error(
			`Navigation blocked by denyOrigins in pi-jev-browser.config.json: ${url}`,
		);
	}
	if (!isUrlAllowed(url, config.allowedOrigins)) {
		throw new Error(`Navigation blocked by pi-jev-browser.config.json: ${url}`);
	}
}

/**
 * "session" keeps one profile per pi session, so a login survives later runs in
 * the same conversation without two conversations fighting over one profile.
 */
function resolveProfileDir(config: PiBrowserConfig, key: string) {
	if (config.profile === "off") return undefined;
	if (config.profile === "shared") return config.profileDir;
	return join(config.outputDir, "profiles", safePathPart(key));
}

export function sessionKey(host: { sessionId: string }) {
	return host.sessionId || "default";
}

function safePathPart(value: string) {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 180) || "default";
}

function sanitizeLabel(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64) || "screenshot"
	);
}

function combineSignals(signals: Array<AbortSignal | undefined>) {
	const present = signals.filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	return present.length === 1 ? present[0] : AbortSignal.any(present);
}

async function settleWithin(
	promise: Promise<unknown> | undefined,
	timeoutMs: number,
) {
	if (!promise) return;
	await withTimeout(promise, timeoutMs, "Browser cleanup").catch(
		() => undefined,
	);
}

async function withTimeout<T>(
	promise: Promise<T> | undefined,
	timeoutMs: number,
	label: string,
): Promise<T | undefined> {
	if (!promise) return undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
