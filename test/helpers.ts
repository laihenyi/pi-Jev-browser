import { chromium, type Browser } from "playwright";

/** Launch the Playwright build installed for this extension. */
export function launchTestBrowser(): Promise<Browser> {
	const executablePath = process.env.PI_JEV_BROWSER_TEST_BROWSER;
	return chromium.launch({
		headless: true,
		...(executablePath ? { executablePath } : {}),
	});
}
