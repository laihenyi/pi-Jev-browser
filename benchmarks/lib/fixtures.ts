import { createServer, type Server } from "node:http";

/**
 * A local site the scenarios drive. It records every request so a scenario can
 * verify what actually happened server-side instead of trusting the tool's own
 * report — a submitted form and a clicked "verify" button both leave a trace.
 */
export interface FixtureServer {
	url: string;
	/** Paths (with query) requested during the scenario, in order. */
	requests: string[];
	close(): Promise<void>;
}

const NAV = `<nav>
  <a href="/nav/one">Alpha</a>
  <a href="/nav/two">Bravo</a>
  <a href="/nav/three">Charlie</a>
  <a href="/nav/four">Delta</a>
  <a href="/outbound" target="_blank">Outbound</a>
</nav>`;

const page = (title: string, body: string) => `<!doctype html><html><head>
<meta charset="utf-8"><title>${title}</title></head><body>
${NAV}
<h1>${title}</h1>
${body}
</body></html>`;

const HOME = page(
	"Fixture home",
	`<form id="search" action="/result" method="get">
  <label for="q">Search query</label>
  <input id="q" name="q" type="text">
  <button type="submit">Search</button>
</form>
<iframe title="embedded widget" src="/inner"
  style="width:320px;height:120px;border:1px solid #999"></iframe>
<table id="plan">
  <tr><th>Plan</th><th>Seats</th></tr>
  <tr><td>Starter</td><td>5</td></tr>
  <tr><td>Team</td><td>25</td></tr>
</table>
<div id="row" data-code="A-1">Row one</div>
<label for="tier">Tier</label>
<select id="tier" name="tier">
  <option value="free">Free</option>
  <option value="pro">Pro</option>
</select>
<div style="height:4000px">Tall filler so a page scroll is a legal action.</div>`,
);

const GATE = page(
	"Human verification required",
	`<p>Confirm you are a person before continuing.</p>
<div role="radiogroup" aria-label="Verification">
  <label><input type="radio" name="verify" value="human"> I am a person</label>
</div>
<form action="/gate/verify" method="get"><button type="submit">Verify and continue</button></form>`,
);

export async function startFixtures(): Promise<FixtureServer> {
	const requests: string[] = [];
	const server: Server = createServer((request, response) => {
		const target = request.url ?? "/";
		requests.push(target);
		const path = target.split("?")[0];
		response.setHeader("content-type", "text/html; charset=utf-8");
		if (path === "/inner") {
			response.end(
				`<!doctype html><html><body style="margin:0;height:100vh">
<button style="position:fixed;inset:0;width:100%;height:100%"
  onclick="window.__innerClicked=true">Inner action</button>
</body></html>`,
			);
			return;
		}
		if (path === "/result") {
			const query = new URLSearchParams(target.split("?")[1] ?? "").get("q") ?? "";
			response.end(page("Results", `<p id="q">Query: ${query}</p>`));
			return;
		}
		if (path === "/gate/verify") {
			response.end(page("Verified", "<p>Verification accepted.</p>"));
			return;
		}
		if (path === "/inert") {
			// Three controls that change nothing, for the no-progress guard.
			response.end(
				page(
					"Inert controls",
					"<button>Inert one</button><button>Inert two</button><button>Inert three</button>",
				),
			);
			return;
		}
		if (path === "/gate") {
			response.end(GATE);
			return;
		}
		if (path === "/outbound") {
			response.end(page("Outbound", "<p>This page opened in a new tab.</p>"));
			return;
		}
		const navMatch = path.match(/^\/nav\/(one|two|three|four)$/);
		if (navMatch) {
			const title = navMatch[1][0].toUpperCase() + navMatch[1].slice(1);
			response.end(page(`Nav ${title}`, `<p>Section ${title}.</p>`));
			return;
		}
		response.end(HOME);
	});

	return new Promise<FixtureServer>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string")
				return reject(new Error("fixture server has no address"));
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				requests,
				close: () =>
					new Promise<void>((done, fail) =>
						server.close((error) => (error ? fail(error) : done())),
					),
			});
		});
	});
}

/** The header links a header-enumeration scenario must click exactly once. */
export const NAV_LABELS = ["Alpha", "Bravo", "Charlie", "Delta", "Outbound"];
