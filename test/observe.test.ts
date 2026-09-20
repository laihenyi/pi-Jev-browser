import assert from "node:assert/strict";
import test from "node:test";
import { observe, StaleObservationError } from "../src/observe.ts";
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

test("a target covered after the observation names what intercepted the pointer", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		// Targets that cannot receive the pointer are already excluded when the page is
		// observed, so this covers the remaining window: the overlay appears after the
		// observation, which is how a cookie banner loading late behaves. Detecting it
		// needs no pixels, and naming it turns an unactionable stale into a next step.
		await page.setContent('<button id="buy">Buy</button>');
		const snapshot = await observe(page);
		try {
			const buy = snapshot.data.targets.find((target) => target.label === "Buy");
			assert.ok(buy, "the button is observed while nothing covers it");
			await page.evaluate(() => {
				const dialog = document.createElement("div");
				dialog.setAttribute("role", "dialog");
				dialog.setAttribute("aria-label", "We use cookies");
				dialog.style.cssText = "position:fixed;inset:0;z-index:10";
				const accept = document.createElement("button");
				accept.id = "accept";
				accept.textContent = "Accept cookies";
				// Kept away from the observed button so the hit test lands on the overlay.
				accept.style.cssText = "position:absolute;bottom:8px;right:8px";
				dialog.appendChild(accept);
				document.body.appendChild(dialog);
			});
			await assert.rejects(
				snapshot.execute("CLICK", buy, undefined, new AbortController().signal),
				(error: unknown) => {
					assert.ok(error instanceof StaleObservationError);
					// Still classified as target_unavailable by the loop, but now actionable.
					assert.match(error.message, /Observed target is covered by/);
					assert.match(error.message, /dialog/);
					assert.match(error.message, /We use cookies/);
					return true;
				},
			);
		} finally {
			await snapshot.dispose();
		}
	} finally {
		await browser.close();
	}
});

test("controls and text inside open shadow roots are observed and acted on", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent(
			'<p>Light text</p><div id="host"></div><div id="nested"></div><div id="closed"></div><button>Light button</button>',
		);
		await page.evaluate(() => {
			const host = document.querySelector("#host")!.attachShadow({ mode: "open" });
			host.innerHTML =
				'<p>Shadow text</p><button onclick="this.textContent=\'Shadow clicked\'">Shadow button</button>' +
				'<span id="lbl">Shadow field</span><input aria-labelledby="lbl">';
			// A shadow root inside a shadow root, as component libraries produce.
			const outer = document.querySelector("#nested")!.attachShadow({ mode: "open" });
			outer.innerHTML = "<x-inner></x-inner>";
			const inner = outer.querySelector("x-inner")!.attachShadow({ mode: "open" });
			inner.innerHTML = '<button onclick="window.__deep=true">Deep button</button>';
			// A closed root is not reachable from outside; its control must not be offered.
			const closed = document.querySelector("#closed")!.attachShadow({ mode: "closed" });
			closed.innerHTML = "<button>Closed button</button><p>Closed text</p>";
		});
		const snapshot = await observe(page);
		try {
			const labels = snapshot.data.targets.map((target) => `${target.operation}:${target.label}`);
			assert.ok(labels.includes("CLICK:Light button"), labels.join());
			assert.ok(labels.includes("CLICK:Shadow button"), labels.join());
			assert.ok(labels.includes("CLICK:Deep button"), labels.join());
			// aria-labelledby resolves inside the shadow tree the input lives in.
			assert.ok(labels.includes("TYPE_TEXT:Shadow field"), labels.join());
			assert.equal(labels.some((label) => label.includes("Closed button")), false, labels.join());
			assert.match(snapshot.data.text, /Light text/);
			assert.match(snapshot.data.text, /Shadow text/);
			assert.doesNotMatch(snapshot.data.text, /Closed text/);

			const signal = new AbortController().signal;
			const shadowButton = snapshot.data.targets.find((target) => target.label === "Shadow button")!;
			await snapshot.execute("CLICK", shadowButton, undefined, signal);
			assert.equal(
				await page.evaluate(() => document.querySelector("#host")!.shadowRoot!.querySelector("button")!.textContent),
				"Shadow clicked",
			);
		} finally {
			await snapshot.dispose();
		}
		// A fresh observation is needed after the click changed the label; type and click deep.
		const again = await observe(page);
		try {
			const signal = new AbortController().signal;
			const field = again.data.targets.find((target) => target.operation === "TYPE_TEXT" && target.label === "Shadow field")!;
			await again.execute("TYPE_TEXT", field, "typed into shadow", signal);
			assert.equal(
				await page.evaluate(() => document.querySelector("#host")!.shadowRoot!.querySelector("input")!.value),
				"typed into shadow",
			);
		} finally {
			await again.dispose();
		}
		const third = await observe(page);
		try {
			const deep = third.data.targets.find((target) => target.label === "Deep button")!;
			// The typed value is now part of the observed state, as it is for light DOM.
			assert.equal(third.data.targets.find((target) => target.label === "Shadow field")?.value, "typed into shadow");
			await third.execute("CLICK", deep, undefined, new AbortController().signal);
			assert.equal(await page.evaluate(() => (window as unknown as { __deep?: boolean }).__deep), true);
		} finally {
			await third.dispose();
		}
	} finally {
		await browser.close();
	}
});

test("a shadow-DOM overlay covering a light-DOM target is named as the cover", async () => {
	const browser = await launchTestBrowser();
	try {
		const page = await browser.newPage();
		await page.setContent('<button id="buy">Buy</button><div id="banner"></div>');
		const snapshot = await observe(page);
		try {
			const buy = snapshot.data.targets.find((target) => target.label === "Buy")!;
			// The banner appears after the observation, inside a shadow root.
			await page.evaluate(() => {
				const root = document.querySelector("#banner")!.attachShadow({ mode: "open" });
				root.innerHTML =
					'<div role="dialog" aria-label="We use cookies" style="position:fixed;inset:0;background:#fff8"></div>';
			});
			await assert.rejects(
				snapshot.execute("CLICK", buy, undefined, new AbortController().signal),
				(error: unknown) =>
					error instanceof StaleObservationError && /covered by dialog labelled "We use cookies"/.test(error.message),
			);
		} finally {
			await snapshot.dispose();
		}
	} finally {
		await browser.close();
	}
});
