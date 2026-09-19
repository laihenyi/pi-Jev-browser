import assert from "node:assert/strict";
import test from "node:test";
import { observe } from "../src/observe.ts";
import { launchTestBrowser } from "./helpers.ts";

test("post-action navigation read is recovered without repeating the click", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent(
			"<button onclick=\"this.textContent='Opened'\">Open</button>",
		);
		const originalRead = page.evaluateHandle.bind(page);
		let invalidateNextRead = false;
		let failures = 0;
		page.evaluateHandle = (async (
			...args: Parameters<typeof page.evaluateHandle>
		) => {
			if (invalidateNextRead) {
				invalidateNextRead = false;
				failures++;
				throw new Error(
					"Execution context was destroyed, most likely because of a navigation",
				);
			}
			return originalRead(...args);
		}) as typeof page.evaluateHandle;
		const snapshot = await observe(page);
		try {
			const target = snapshot.data.targets[0];
			await snapshot.execute(
				"CLICK",
				target,
				undefined,
				new AbortController().signal,
			);
			assert.equal(await page.locator("button").textContent(), "Opened");
			invalidateNextRead = true;
			const after = await observe(page);
			try {
				assert.equal(after.data.targets[0]?.label, "Opened");
			} finally {
				await after.dispose();
			}
		} finally {
			await snapshot.dispose();
		}
		assert.equal(failures, 1);

		page.evaluateHandle = originalRead;
		await page.evaluate(() => {
			document.body.remove();
			setTimeout(() => {
				const body = document.createElement("body");
				body.innerHTML = "<h1>New document ready</h1>";
				document.documentElement.append(body);
			}, 150);
		});
		const settled = await observe(page);
		assert.match(settled.data.text, /New document ready/);
		await settled.dispose();

		let reads = 0;
		page.evaluateHandle = async () => {
			reads++;
			throw new Error("Execution context was destroyed");
		};
		await assert.rejects(observe(page), /Execution context/);
		assert.equal(reads, 5);
		reads = 0;
		page.evaluateHandle = async () => {
			reads++;
			throw new Error("Unexpected page bug");
		};
		await assert.rejects(observe(page), /Unexpected page bug/);
		assert.equal(reads, 1);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(observe(page, controller.signal), /abort/i);
		assert.equal(reads, 1);
	} finally {
		await browser.close();
	}
});

test("observation surfaces ARIA controls, options, and freshness", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent(
			'<div role="combobox" aria-label="Trip type">Round trip</div><div role="menuitemradio" aria-checked="false">One way</div><div role="gridcell">September 20</div><input aria-label="Origin"><select aria-label="Cabin"><option>Economy</option><option>Business</option></select>',
		);
		const snapshot = await observe(page);
		try {
			for (const role of ["combobox", "menuitemradio", "gridcell"])
				assert.ok(snapshot.data.targets.some((t) => t.role === role));
			assert.equal(
				snapshot.data.targets.find((t) => t.role === "combobox")?.value,
				"Round trip",
			);
			const origin = snapshot.data.targets.filter((t) => t.label === "Origin");
			assert.equal(origin.length, 2);
			assert.equal(origin[0].id, origin[1].id);
			const option = snapshot.data.targets.find((t) => t.operation === "SELECT");
			assert.ok(option);
			await snapshot.execute(
				"SELECT",
				option,
				undefined,
				new AbortController().signal,
			);
			assert.equal(await page.locator("select").inputValue(), "Business");
		} finally {
			await snapshot.dispose();
		}

		await page.setContent('<a href="#one">Buy</a><p id="ticker">1</p>');
		const stable = await observe(page);
		try {
			await page.locator("#ticker").evaluate((e) => (e.textContent = "2"));
			await stable.execute(
				"CLICK",
				stable.data.targets[0],
				undefined,
				new AbortController().signal,
			);
			assert.ok(page.url().endsWith("#one"));
		} finally {
			await stable.dispose();
		}
		const changed = await observe(page);
		try {
			await page.locator("a").evaluate((e) => e.setAttribute("href", "#other"));
			await assert.rejects(
				changed.execute(
					"CLICK",
					changed.data.targets[0],
					undefined,
					new AbortController().signal,
				),
				/changed/,
			);
		} finally {
			await changed.dispose();
		}
	} finally {
		await browser.close();
	}
});

test("observation exposes hidden radio options, covers, and offscreen choices", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent(
			'<input style="display:none" id="size" type="radio" name="size" value="small"><label for="size">Small $10</label><input style="display:none" id="disabled" type="radio" disabled><label for="disabled">Unavailable</label>',
		);
		const snapshot = await observe(page);
		try {
			const target = snapshot.data.targets.find((t) => t.label === "Small $10");
			assert.ok(target);
			assert.equal(target.role, "radio");
			assert.equal(target.checked, "false");
			assert.ok(!snapshot.data.targets.some((t) => t.label === "Unavailable"));
			await snapshot.execute(
				"CLICK",
				target,
				undefined,
				new AbortController().signal,
			);
			assert.equal(await page.locator("#size").isChecked(), true);
		} finally {
			await snapshot.dispose();
		}
		const updated = await observe(page);
		try {
			assert.equal(
				updated.data.targets.find((t) => t.label === "Small $10")?.checked,
				"true",
			);
		} finally {
			await updated.dispose();
		}

		await page.setContent(
			'<div style="position:relative;width:180px;height:60px"><input id="option" type="radio" style="position:absolute;inset:0;width:100%;height:100%;opacity:0.01;z-index:2"><label for="option" style="display:block;width:100%;height:100%">No extras</label></div>',
		);
		const covered = await observe(page);
		try {
			const target = covered.data.targets.find(
				(t) => t.label === "No extras" && t.role === "radio",
			);
			assert.ok(target);
			await covered.execute(
				"CLICK",
				target,
				undefined,
				new AbortController().signal,
			);
			assert.ok(await page.locator("#option").isChecked());
		} finally {
			await covered.dispose();
		}

		await page.setContent(
			'<input id="chosen" type="radio" name="size" value="small" checked><label for="chosen">Small</label><div style="height:2000px"></div><input id="later" type="radio" name="carrier" value="later"><label for="later">Connect later</label><button disabled>Unavailable</button>',
		);
		const scrolledPast = await observe(page);
		try {
			assert.ok(
				scrolledPast.data.offscreenControls?.below.includes("Connect later"),
			);
			assert.ok(
				!scrolledPast.data.targets.some((t) => t.label === "Connect later"),
			);
			assert.ok(
				!scrolledPast.data.offscreenControls?.below.includes("Unavailable"),
			);
			assert.deepEqual(scrolledPast.data.selectedOptions, [
				{ group: "size", label: "Small", value: "small" },
			]);
		} finally {
			await scrolledPast.dispose();
		}
		await page.locator("#later").scrollIntoViewIfNeeded();
		const scrolled = await observe(page);
		try {
			assert.equal(scrolled.data.selectedOptions?.[0].value, "small");
			assert.ok(scrolled.data.targets.some((t) => t.label === "Connect later"));
		} finally {
			await scrolled.dispose();
		}

		await page.setContent("<button>Search</button>");
		const overlayed = await observe(page);
		try {
			await page.evaluate(() => {
				const cover = document.createElement("div");
				cover.style.cssText = "position:fixed;inset:0;z-index:999";
				document.body.append(cover);
			});
			await assert.rejects(
				overlayed.execute(
					"CLICK",
					overlayed.data.targets.find((e) => e.label === "Search"),
					undefined,
					new AbortController().signal,
				),
				/covered/,
			);
		} finally {
			await overlayed.dispose();
		}

		await page.setContent("<button>Search</button>");
		const replaced = await observe(page);
		try {
			const target = replaced.data.targets.find((e) => e.label === "Search");
			assert.ok(target);
			await page
				.locator("button")
				.evaluate((e) => e.replaceWith(e.cloneNode(true)));
			await assert.rejects(
				replaced.execute(
					"CLICK",
					target,
					undefined,
					new AbortController().signal,
				),
				/disappeared/,
			);
		} finally {
			await replaced.dispose();
		}
	} finally {
		await browser.close();
	}
});
