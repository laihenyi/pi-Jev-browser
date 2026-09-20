import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { configurationError } from "./errors.ts";

/**
 * Application lookup.
 *
 * A bundle id is the only stable identifier macOS offers, and a display name is
 * localised, so neither can be something a goal has to spell out: on the next
 * machine the caller has never seen the installed set. The installed set is
 * therefore read from disk and matched against whatever the caller did say,
 * which is the reverse-DNS id, the display name, or a fragment of either.
 *
 * The application folders come first and are walked a few levels deep, because
 * a vendor often puts its tools in a folder of their own (`/Applications/Epson
 * Software/…`). Only when they hold no match does the lookup widen to
 * Spotlight, which knows about an application installed anywhere on the disk.
 */

const execFileAsync = promisify(execFile);

export interface InstalledApp {
	name: string;
	bundleId: string;
	path: string;
}

/** The reverse-DNS shape `assertDesktopPrerequisites` also enforces. */
export const BUNDLE_ID_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/;

export function appSearchDirs(
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): string[] {
	if (platform !== "darwin") return [];
	return [
		"/Applications",
		"/Applications/Utilities",
		"/System/Applications",
		"/System/Applications/Utilities",
		join(home, "Applications"),
	];
}

/**
 * `plutil` reads both the XML and the binary form of `Info.plist`, which is what
 * an application chooses at build time, so nothing here parses a plist by hand.
 */
async function readBundleId(appPath: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("/usr/bin/plutil", [
			"-extract",
			"CFBundleIdentifier",
			"raw",
			"-o",
			"-",
			join(appPath, "Contents", "Info.plist"),
		]);
		const bundleId = stdout.trim();
		return BUNDLE_ID_PATTERN.test(bundleId) ? bundleId : undefined;
	} catch {
		// A directory named `.app` is not necessarily an application, and a
		// damaged one is not a reason to fail the whole listing.
		return undefined;
	}
}

/** Applications can be numerous, so the reads are batched rather than unbounded. */
async function mapLimited<T, R>(
	items: T[],
	limit: number,
	run: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (let index = next++; index < items.length; index = next++) {
			results[index] = await run(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

/** How far below an application folder a vendor sub-folder is followed. */
export const APP_FOLDER_DEPTH = 3;

export interface ListAppsOptions {
	/** Overridable for tests; the real lookup walks the standard app folders. */
	dirs?: string[];
	readId?: (appPath: string) => Promise<string | undefined>;
	/**
	 * The disk-wide fallback, overridable for tests; the real one asks Spotlight.
	 * It returns `.app` paths whose name matches the query, anywhere on disk.
	 */
	spotlight?: (query: string) => Promise<string[]>;
}

/**
 * The `.app` bundles in a folder and its sub-folders, to a bounded depth. A
 * bundle is not entered, and neither is a hidden folder.
 */
async function findBundles(
	dir: string,
	depth: number,
): Promise<{ name: string; path: string }[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const bundles: { name: string; path: string }[] = [];
	const folders: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.name.endsWith(".app")) bundles.push({ name: entry.name, path });
		else if (depth > 1) folders.push(path);
	}
	for (const folder of folders)
		bundles.push(...(await findBundles(folder, depth - 1)));
	return bundles;
}

async function readApps(
	bundles: { name: string; path: string }[],
	readId: (appPath: string) => Promise<string | undefined>,
	seen: InstalledApp[],
): Promise<InstalledApp[]> {
	const bundleIds = await mapLimited(bundles, 16, (bundle) => readId(bundle.path));
	const apps: InstalledApp[] = [];
	bundles.forEach((bundle, index) => {
		const bundleId = bundleIds[index]?.trim();
		// Whatever produced the id, only an id the runtime would accept belongs
		// in the list.
		if (!bundleId || !BUNDLE_ID_PATTERN.test(bundleId)) return;
		if ([...seen, ...apps].some((app) => app.bundleId === bundleId)) return;
		apps.push({
			name: bundle.name.replace(/\.app$/i, ""),
			bundleId,
			path: bundle.path,
		});
	});
	return apps;
}

export async function listInstalledApps(
	options: ListAppsOptions = {},
): Promise<InstalledApp[]> {
	const dirs = options.dirs ?? appSearchDirs();
	const readId = options.readId ?? readBundleId;
	const apps: InstalledApp[] = [];
	for (const dir of dirs) {
		// Manually installed copies live in `~/Applications` and can shadow the
		// same id in `/Applications`; the first directory that has one wins, and
		// a folder's own top level wins over its sub-folders.
		const bundles = await findBundles(dir, APP_FOLDER_DEPTH);
		apps.push(...(await readApps(bundles, readId, apps)));
	}
	return apps;
}

/**
 * Spotlight indexes every application bundle on the disk, so an application
 * that lives outside the application folders (a developer build, a tool inside
 * another package, a copy on an external volume) is still found by name.
 */
async function spotlightApps(query: string): Promise<string[]> {
	if (process.platform !== "darwin") return [];
	const escaped = query.replace(/[\\"']/g, "");
	if (!escaped.trim()) return [];
	try {
		const { stdout } = await execFileAsync("/usr/bin/mdfind", [
			`kMDItemContentType == 'com.apple.application-bundle' && (kMDItemDisplayName == '*${escaped}*'c || kMDItemCFBundleIdentifier == '*${escaped}*'c)`,
		]);
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.endsWith(".app"));
	} catch {
		// No Spotlight index, or mdfind unavailable: the folder walk stands.
		return [];
	}
}

/**
 * Applications matching a query: the application folders first, and Spotlight
 * only when they hold nothing, so a well-known application never pays for a
 * disk-wide search and a little-known one is still located.
 */
export async function findApps(
	query: string,
	options: ListAppsOptions = {},
): Promise<{ apps: InstalledApp[]; source: "folders" | "spotlight" }> {
	const installed = await listInstalledApps(options);
	const fromFolders = searchApps(query, installed);
	if (fromFolders.length > 0 || !query.trim())
		return { apps: fromFolders, source: "folders" };
	const spotlight = options.spotlight ?? spotlightApps;
	const paths = await spotlight(query);
	const bundles = paths.map((path) => ({
		name: path.slice(path.lastIndexOf("/") + 1),
		path,
	}));
	const found = await readApps(bundles, options.readId ?? readBundleId, installed);
	return { apps: searchApps(query, found), source: "spotlight" };
}

export type AppMatch =
	| { status: "resolved"; app: InstalledApp }
	| { status: "ambiguous"; query: string; candidates: InstalledApp[] }
	| { status: "not-found"; query: string; apps: InstalledApp[] };

function comparable(value: string): string {
	return value.trim().replace(/\.app$/i, "").toLowerCase();
}

/** `word` reaches `com.microsoft.Word`, and `microsoft word` reaches `Microsoft Word`. */
function looseKey(value: string): string {
	return comparable(value).replace(/\s+/g, "");
}

export function matchApp(query: string, apps: InstalledApp[]): AppMatch {
	const wanted = comparable(query);
	if (!wanted) return { status: "not-found", query, apps };
	const exact = apps.filter(
		(app) =>
			comparable(app.bundleId) === wanted || comparable(app.name) === wanted,
	);
	if (exact.length === 1) return { status: "resolved", app: exact[0] };
	if (exact.length > 1) return { status: "ambiguous", query, candidates: exact };
	const looseWanted = looseKey(query);
	const loose = apps.filter(
		(app) =>
			comparable(app.bundleId).endsWith(`.${looseWanted}`) ||
			looseKey(app.name).includes(looseWanted),
	);
	if (loose.length === 1) return { status: "resolved", app: loose[0] };
	if (loose.length > 1) return { status: "ambiguous", query, candidates: loose };
	return { status: "not-found", query, apps };
}

function appScore(app: InstalledApp, wanted: string, looseWanted: string): number {
	const name = comparable(app.name);
	const bundleId = comparable(app.bundleId);
	if (name === wanted || bundleId === wanted) return 4;
	// A whole word beats a substring: `word` means Microsoft Word, not Passwords.
	if (name.split(/[\s._-]+/).includes(looseWanted)) return 3;
	if (looseKey(app.name) === looseWanted) return 3;
	if (bundleId.endsWith(`.${looseWanted}`)) return 3;
	if (looseKey(app.name).includes(looseWanted) || bundleId.includes(looseWanted))
		return 1;
	return 0;
}

/**
 * A caller that has never seen this machine can ask what is installed instead of
 * guessing a name, so a near miss still answers with the closest applications.
 */
export function searchApps(
	query: string,
	apps: InstalledApp[],
	limit = 20,
): InstalledApp[] {
	const wanted = comparable(query);
	const looseWanted = looseKey(query);
	if (!wanted)
		return [...apps].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
	return apps
		.map((app) => ({ app, score: appScore(app, wanted, looseWanted) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name))
		.slice(0, limit)
		.map((entry) => entry.app);
}

function renderApp(app: InstalledApp): string {
	return `${app.name} (${app.bundleId})`;
}

function renderList(apps: InstalledApp[], limit = 12): string {
	const shown = apps.slice(0, limit).map(renderApp);
	if (apps.length > shown.length)
		shown.push(`… ${apps.length - shown.length} more`);
	return shown.join(", ");
}

/**
 * The name a caller gave resolves to exactly one application, or the failure says
 * what is installed. A value that is already a bundle id is taken as given so the
 * common case never pays for a directory walk.
 */
export async function resolveBundleId(
	query: string,
	options: ListAppsOptions = {},
): Promise<{ bundleId: string; app?: InstalledApp }> {
	const trimmed = query.trim();
	// The common case, and the only one that must never scan a directory.
	if (BUNDLE_ID_PATTERN.test(trimmed) && !/\.app$/i.test(trimmed))
		return { bundleId: trimmed };
	const apps = await listInstalledApps(options);
	if (BUNDLE_ID_PATTERN.test(trimmed)) {
		// `Something.app` is id-shaped but usually a file name, so it is taken
		// literally only when that id is really installed.
		const installed = apps.find(
			(app) => app.bundleId.toLowerCase() === trimmed.toLowerCase(),
		);
		if (installed) return { bundleId: installed.bundleId, app: installed };
	}
	let match = matchApp(trimmed, apps);
	if (match.status === "not-found") {
		// The application folders hold nothing like it: widen to the whole disk.
		const wider = await findApps(trimmed, options);
		if (wider.source === "spotlight" && wider.apps.length > 0)
			match = matchApp(trimmed, wider.apps);
	}
	if (match.status === "resolved")
		return { bundleId: match.app.bundleId, app: match.app };
	if (match.status === "ambiguous")
		throw configurationError(
			`"${trimmed}" matches more than one installed application: ${renderList(match.candidates)}. Pass the bundle id to choose one.`,
		);
	if (match.apps.length === 0)
		throw configurationError(
			`No installed application matches "${trimmed}", and no applications were found in ${(options.dirs ?? appSearchDirs()).join(", ")} or by Spotlight. Pass a bundle id.`,
		);
	throw configurationError(
		`No installed application matches "${trimmed}" in the application folders or by Spotlight. Installed: ${renderList(match.apps)}. Pass a bundle id, or a name that appears in this list.`,
	);
}
