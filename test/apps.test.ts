import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BUNDLE_ID_PATTERN,
	appSearchDirs,
	findApps,
	listInstalledApps,
	matchApp,
	resolveBundleId,
	searchApps,
	type InstalledApp,
} from "../src/apps.ts";

const safari: InstalledApp = {
	name: "Safari",
	bundleId: "com.apple.Safari",
	path: "/Applications/Safari.app",
};
const word: InstalledApp = {
	name: "Microsoft Word",
	bundleId: "com.microsoft.Word",
	path: "/Applications/Microsoft Word.app",
};
const pages: InstalledApp = {
	name: "Pages",
	bundleId: "com.apple.Pages",
	path: "/Applications/Pages.app",
};

test("a bundle id is recognised by shape, so the fast path costs nothing", () => {
	assert.equal(BUNDLE_ID_PATTERN.test("com.apple.calculator"), true);
	assert.equal(BUNDLE_ID_PATTERN.test("com.microsoft.Word"), true);
	assert.equal(BUNDLE_ID_PATTERN.test("Microsoft Word"), false);
	assert.equal(BUNDLE_ID_PATTERN.test("Safari"), false);
	// `TextEdit.app` is id-shaped, so it is only trusted when that id is installed.
	assert.equal(BUNDLE_ID_PATTERN.test("TextEdit.app"), true);
});

test("the application folders are the standard ones on macOS only", () => {
	assert.deepEqual(appSearchDirs("/Users/someone", "linux"), []);
	const dirs = appSearchDirs("/Users/someone", "darwin");
	assert.ok(dirs.includes("/Applications"));
	assert.ok(dirs.includes("/System/Applications"));
	assert.ok(dirs.includes("/Users/someone/Applications"));
});

test("display names, bundle ids, and fragments all resolve", () => {
	assert.deepEqual(matchApp("Safari", [safari, word]), {
		status: "resolved",
		app: safari,
	});
	assert.deepEqual(matchApp("com.microsoft.Word", [safari, word]), {
		status: "resolved",
		app: word,
	});
	// A localised display name is what a caller is most likely to have.
	assert.deepEqual(matchApp("Microsoft Word", [safari, word]), {
		status: "resolved",
		app: word,
	});
	// `.app` and case are noise, and so is the fragment `word`.
	assert.deepEqual(matchApp("word.app", [safari, word]), {
		status: "resolved",
		app: word,
	});
});

test("an ambiguous or missing name says what it found instead of guessing", () => {
	const notes: InstalledApp = {
		name: "Notes",
		bundleId: "com.apple.Notes",
		path: "/System/Applications/Notes.app",
	};
	const ambiguous = matchApp("app", [safari, pages, notes]);
	assert.equal(ambiguous.status, "not-found");
	const byId = matchApp("com.apple", [
		safari,
		{ ...pages, bundleId: "com.apple.Pages" },
		{ ...notes, bundleId: "com.apple.Notes" },
	]);
	assert.equal(byId.status, "not-found");
	assert.equal(searchApps("com.apple", [safari, pages, notes]).length, 3);
	assert.equal(searchApps("nothing-like-this", [safari, word]).length, 0);
	// A search with no query lists what is installed rather than nothing.
	assert.equal(searchApps("", [safari, word]).length, 2);
});

test("the installed set is read from disk, not assumed", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jev-browser-apps-"));
	try {
		mkdirSync(join(root, "Microsoft Word.app"));
		mkdirSync(join(root, "Spaces.app"));
		mkdirSync(join(root, "Safari.app"));
		mkdirSync(join(root, "Notes.txt"));
		const apps = await listInstalledApps({
			dirs: [root, join(root, "does-not-exist")],
			readId: async (appPath) => {
				if (appPath.includes("Spaces")) return "not a bundle id";
				if (appPath.endsWith("Notes.txt")) throw new Error("not a bundle");
				return appPath.includes("Word") ? "com.microsoft.Word" : "com.apple.Safari";
			},
		});
		assert.deepEqual(
			apps.map((app) => app.name).sort(),
			["Microsoft Word", "Safari"],
		);
		// An application whose id is unusable is skipped, not fatal.
		assert.equal(apps.length, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("vendor sub-folders inside an application folder are searched too", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jev-browser-apps-"));
	try {
		mkdirSync(join(root, "Safari.app"));
		mkdirSync(join(root, "Epson Software", "Epson Utilities"), { recursive: true });
		mkdirSync(join(root, "Epson Software", "Epson Scan 2.app"));
		mkdirSync(join(root, "Epson Software", "Epson Utilities", "Epson Data Collection Agent.app"));
		// Too deep to be followed, and inside a bundle, and hidden: all skipped.
		mkdirSync(join(root, "a", "b", "c", "Deep.app"), { recursive: true });
		mkdirSync(join(root, "Safari.app", "Contents", "Inner.app"), { recursive: true });
		mkdirSync(join(root, ".hidden", "Hidden.app"), { recursive: true });
		const apps = await listInstalledApps({
			dirs: [root],
			readId: async (appPath) =>
				`com.test.${appPath.slice(appPath.lastIndexOf("/") + 1).replace(/\.app$/, "").replace(/\W/g, "")}`,
		});
		assert.deepEqual(
			apps.map((app) => app.name).sort(),
			["Epson Data Collection Agent", "Epson Scan 2", "Safari"],
		);
		assert.equal(apps.find((app) => app.name === "Epson Scan 2")?.path, join(root, "Epson Software", "Epson Scan 2.app"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the application folders come first and Spotlight is only asked when they hold nothing", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jev-browser-apps-"));
	try {
		mkdirSync(join(root, "Microsoft Word.app"));
		const asked: string[] = [];
		const options = {
			dirs: [root],
			readId: async (appPath: string) =>
				appPath.includes("Obscure") ? "com.example.Obscure" : "com.microsoft.Word",
			spotlight: async (query: string) => {
				asked.push(query);
				return ["/Users/someone/Developer/build/Obscure Tool.app"];
			},
		};
		const known = await findApps("word", options);
		assert.equal(known.source, "folders");
		assert.deepEqual(known.apps.map((app) => app.bundleId), ["com.microsoft.Word"]);
		assert.deepEqual(asked, []);

		const obscure = await findApps("obscure", options);
		assert.equal(obscure.source, "spotlight");
		assert.deepEqual(obscure.apps, [
			{ name: "Obscure Tool", bundleId: "com.example.Obscure", path: "/Users/someone/Developer/build/Obscure Tool.app" },
		]);
		assert.deepEqual(asked, ["obscure"]);

		// resolveBundleId widens the same way, so a goal can name the tool.
		const resolved = await resolveBundleId("Obscure Tool", options);
		assert.equal(resolved.bundleId, "com.example.Obscure");
		// Nothing anywhere: the failure says both places were searched.
		await assert.rejects(
			() => resolveBundleId("Photoshop", { ...options, spotlight: async () => [] }),
			/No installed application matches "Photoshop" in the application folders or by Spotlight/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resolveBundleId takes an id as given and looks a name up", async () => {
	const given = await resolveBundleId("com.apple.calculator", { dirs: [] });
	assert.deepEqual(given, { bundleId: "com.apple.calculator" });

	const root = mkdtempSync(join(tmpdir(), "pi-jev-browser-apps-"));
	try {
		mkdirSync(join(root, "Microsoft Word.app"));
		const byName = await resolveBundleId("Word", {
			dirs: [root],
			readId: async () => "com.microsoft.Word",
		});
		assert.equal(byName.bundleId, "com.microsoft.Word");
		assert.equal(byName.app?.name, "Microsoft Word");
		// `Something.app` resolves as a name when no such id is installed.
		const byFileName = await resolveBundleId("Microsoft Word.app", {
			dirs: [root],
			readId: async () => "com.microsoft.Word",
		});
		assert.equal(byFileName.bundleId, "com.microsoft.Word");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unknown name fails with the installed set in the message", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-jev-browser-apps-"));
	try {
		mkdirSync(join(root, "Microsoft Word.app"));
		await assert.rejects(
			() =>
				resolveBundleId("Photoshop", {
					dirs: [root],
					readId: async () => "com.microsoft.Word",
					spotlight: async () => [],
				}),
			/No installed application matches "Photoshop"[\s\S]*com\.microsoft\.Word/,
		);
		await assert.rejects(
			() => resolveBundleId("Photoshop", { dirs: [root], readId: async () => undefined, spotlight: async () => [] }),
			/no applications were found/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
