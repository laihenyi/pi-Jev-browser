import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { runJev } from "../../src/loop.ts";
import { defaultHelperPath, desktopDriver, DESKTOP_RULES, type DesktopDriver } from "../../src/drivers/desktop.ts";
import { check, stepRecorder, type Scenario } from "../lib/harness.ts";

/**
 * A second desktop application, so the desktop recipe is shown to hold beyond
 * Calculator. TextEdit exercises the other half of the driver: Calculator is all
 * buttons (AXPress), an editor is a text area driven by setting its value. Before
 * this tier the accessibility walk only offered elements with a press action, so a
 * TextEdit document was invisible to the loop.
 *
 * Verification reads the document back from the application's own accessibility
 * value and compares it with the sentence requested here, so nothing is taken on
 * trust from the agent or its summary.
 */

const execFileAsync = promisify(execFile);
const BUNDLE = "com.apple.TextEdit";
const TEXTEDIT_APP = "/System/Applications/TextEdit.app";
const SENTENCE = "The quick brown fox jumps over the lazy dog";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const osascript = (...lines: string[]) =>
	execFileAsync("osascript", lines.flatMap((line) => ["-e", line])).catch(() => undefined);

/** A fresh, empty, untitled document, and nothing else open that could be observed first. */
async function freshDocument(driver: DesktopDriver) {
	await osascript(
		'tell application "TextEdit" to activate',
		'tell application "TextEdit" to close every document saving no',
		'tell application "TextEdit" to make new document',
	);
	for (let attempt = 0; attempt < 16; attempt++) {
		await sleep(250);
		try {
			const snapshot = await driver.observe();
			const area = snapshot.data.targets.find((target) => target.role === "AXTextArea");
			if (area && area.value === "") return;
		} catch {
			/* the window can lag the AppleScript reply */
		}
	}
	throw new Error("TextEdit did not present an empty document");
}

async function closeDocuments() {
	await osascript('tell application "TextEdit" to close every document saving no');
}

/** The document text as the application reports it, read until it stops changing. */
async function documentText(driver: DesktopDriver, budgetMs = 3000): Promise<string> {
	const started = Date.now();
	let previous: string | undefined;
	while (Date.now() - started < budgetMs) {
		const snapshot = await driver.observe();
		const current = snapshot.data.targets.find((target) => target.role === "AXTextArea")?.value ?? "";
		if (current === previous) return current;
		previous = current;
		await sleep(250);
	}
	return previous ?? "";
}

function hostSkipReason(): string | undefined {
	if (process.platform !== "darwin")
		return "the desktop tier drives macOS applications through the accessibility tree";
	if (!existsSync(defaultHelperPath()))
		return "the accessibility helper is not built (npm run build:ax-helper)";
	if (!existsSync(TEXTEDIT_APP)) return "TextEdit is not installed";
	return undefined;
}

export const texteditScenarios: Scenario[] = [
	{
		id: "desktop-textedit-deterministic",
		tier: "desktop",
		category: "capability",
		needsCredentials: false,
		title: "The accessibility driver writes into a real document and reads it back",
		notes:
			"No model is involved. This measures the driver on a second application and a second kind of control: the editor's text area has no press action and is driven by setting its accessibility value. The written sentence is read back from the application, and the document text must also appear in the window text the decision layer sees, because for an editor the document is the state.",
		skip: hostSkipReason,
		async run(context) {
			void context;
			const driver = desktopDriver({ bundleId: BUNDLE });
			try {
				await freshDocument(driver);
				const snapshot = await driver.observe();
				const area = snapshot.data.targets.find(
					(target) => target.role === "AXTextArea" && target.operation === "TYPE_TEXT",
				);
				if (!area) throw new Error("no text area target was offered");
				await snapshot.execute("TYPE_TEXT", area, SENTENCE, AbortSignal.timeout(5000));
				const text = await documentText(driver);
				const window = (await driver.observe()).data.text;
				return {
					checks: [
						check("the text area is offered as a TYPE_TEXT target", area.operation === "TYPE_TEXT", area.label),
						check("the document holds exactly the written sentence", text === SENTENCE, text),
						check("the window text the decision layer reads includes the document", window.includes(SENTENCE), window),
					],
					metrics: { text, targets: snapshot.data.targets.length },
				};
			} finally {
				await closeDocuments();
				await driver.close();
			}
		},
	},
	{
		id: "desktop-textedit-entry",
		tier: "desktop",
		category: "capability",
		needsCredentials: true,
		title: "Jev types a requested sentence into a second desktop application",
		notes:
			"The decision layer, with the desktop rules calibrated on Calculator, drives an editor instead: it has to choose the text area over sixteen formatting controls, let the text helper supply the sentence, and stop once the document shows it. The text helper is scripted, so this measures the decision loop on a new application, not sentence generation. The document must hold the sentence exactly once: a run that typed it twice, or appended to it, fails.",
		skip: hostSkipReason,
		async run(context) {
			const driver = desktopDriver({ bundleId: BUNDLE });
			try {
				await freshDocument(driver);
				const recorder = stepRecorder(context.outputDir, "desktop-textedit-entry");
				const result = await runJev(
					{
						goal: `Type the sentence "${SENTENCE}" into the document of this text editor, then stop when the document shows it.`,
						maxSteps: 6,
					},
					{ driver, policy: context.jev(() => SENTENCE, DESKTOP_RULES), onStep: recorder.onStep },
				);
				const text = await documentText(driver);
				const executed = result.steps.filter((step) => step.status === "executed");
				return {
					checks: [
						check("the document holds exactly the requested sentence", text === SENTENCE, text),
						check("Jev reported DONE", result.stopReason === "model_done", result.stopReason),
						check(
							"the sentence was typed once",
							executed.filter((step) => step.operation === "TYPE_TEXT").length === 1,
							JSON.stringify(executed.map((step) => `${step.operation}:${step.target}`)),
						),
					],
					metrics: {
						executedSteps: executed.length,
						executed: recorder.executed().join(" "),
						stopReason: result.stopReason,
						loopElapsedMs: result.elapsedMs,
						text,
						tracePath: recorder.tracePath,
					},
				};
			} finally {
				await closeDocuments();
				await driver.close();
			}
		},
	},
];
