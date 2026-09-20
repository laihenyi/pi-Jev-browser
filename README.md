# Pi Jev Browser

English | [繁體中文](README.zh-TW.md)

A browser agent for **pi**. **Jev** (TypeSafe System One) chooses each action from
a structured observation of the page — visible text plus addressable controls,
never a screenshot — inside a bounded loop that knows when it is stuck, when the
page moved underneath it, and when to hand control back to a human.

Seven of the eight tools drive an isolated Playwright Chromium. The eighth,
`jev_desktop`, drives one macOS application through its accessibility tree with the
same loop and the same guards. The loop does not know which surface it is on:
`src/loop.ts` depends on a `Driver` and imports no Playwright, so the browser, the
desktop and an in-memory test driver are interchangeable.

- **[docs/reference.md](docs/reference.md)** — run statuses, `failure` and
  `stopReason`, what the loop remembers and refuses to act on, the driver boundary,
  and every difference from the Cline plugin this project was ported from.
- **[benchmarks/README.md](benchmarks/README.md)** — the 22-scenario capability
  suite across four tiers and its measured results.

## Install

### From npm

```bash
pi install npm:pi-jev-browser
```

Pi installs the package under `~/.pi/agent/npm/` and reads its
`"pi": { "extensions": ["./index.ts"] }` manifest. The install pulls in
`playwright` and `@typesafe-ai/sdk`, and Playwright downloads Chromium (~150 MB).
`typebox`, `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` are
`peerDependencies`, because pi provides them as virtual modules.

### From a git checkout or a local directory

```bash
pi install git:github.com/laihenyi/pi-Jev-browser            # latest main
pi install git:github.com/laihenyi/pi-Jev-browser@v0.2.0    # a pinned tag
pi install /absolute/path/to/pi-Jev-browser                 # a working copy
```

A checkout at `~/.pi/agent/extensions/pi-Jev-browser/` is discovered
automatically, which is how this repository is developed:

```bash
cd ~/.pi/agent/extensions/pi-Jev-browser
npm install
node node_modules/playwright/cli.js install chromium   # or: npm run install-browser
```

Restart pi (or `/reload`) after changing it. Chromium setup also happens on the
first `jev_run`, bounded to two minutes, and a later call retries a failed setup.
On Linux, system browser libraries remain an administrator-managed prerequisite;
the extension never runs sudo.

### Credentials

Provide a TypeSafe API key from `console.typesafe.ai` in the environment or the
config file:

```bash
export TYPESAFE_API_KEY=...        # or typesafe.apiKey in pi-jev-browser.config.json
chmod 600 ~/.pi/agent/pi-jev-browser.config.json
```

`jev_run` resolves this before Chromium starts, so a missing key fails with the
file and variable to set instead of a browser-shaped error. Nothing else is
required: field text for typed inputs is generated with the pi model the session
already uses.

## Quick start

1. `jev_run({ "url": "https://en.wikipedia.org", "goal": "Find and open the article about Ada Lovelace. Stop when the article is visible.", "maxSteps": 20 })`
2. Verify the returned final screenshot, or read `finalScreenshotPath` when the
   image is not displayed.
3. `jev_stop({})` to release the browser and finalize the video.

`jev_run` starts a browser, captures the initial screen, runs Jev, and returns a
final image plus both screenshot paths and page states. Later calls reuse the
browser; omit `url` to continue or pass it to navigate first. `headless`,
`recordVideo`, `showCursor` and `showClickIndicators` apply when a browser is
created, and it stays available for follow-up runs until stopped.

Automatic operations are click, replace text, native dropdown selection, page
scroll, and short loading waits. Runs default to 20 steps (maximum 60) with a
100-second deadline. There is no default probability cutoff: optional
`minProbability` gates Jev's calibrated probability for the selected choice, which
is not provider confidence. An operation already in flight can take up to its
bounded Playwright timeout to settle after cancellation, and mutations are never
retried.

A result is `done_unverified`, `blocked`, `needs_review`, `uncertain`,
`step_limit`, `evaluation_limit` or `interrupted`; [docs/reference.md](docs/reference.md#run-results-and-statuses)
explains each status, `stopReason` and `failure.category`, and what a result carries
for verification.

## The Jev loop

Each evaluation sends one TypeSafe System One request:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
{ "model": "jev-latest", "state": "<page observation + recent actions>", "questions": { "action": { ... } } }
```

Jev answers one `choice` question whose criteria are the concrete operations offered
for the page: an entry per visible action target (`CLICK:<id>`, `TYPE_TEXT:<id>`,
`SELECT:<id>`), plus `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, `BLOCKED`, `REVIEW` and
`DONE`. Comparing every action against scrolling, waiting and stopping in one pass
is what keeps the loop cheap. There is no screenshot in the decision path: Jev sees
indexed action targets, selected form options (including offscreen selections) and
summaries of the controls above and below the viewport, while the agent receives
screenshots to verify outcomes.

Jev chooses actions but cannot generate arbitrary text. On `TYPE_TEXT` the field
value is first sought **in the goal itself**: quoted phrases, the goal's sentences,
short runs of their words and, for an address bar, the `.com` form of each Latin
word become candidates, and Jev picks one or `NONE` in a single choice question.
Almost every value a run has to type is already in the goal, so this path needs no
second model and answers in well under a second. Only on `NONE` does the extension
fall back to the **active pi model** through `ctx.modelRegistry.complete()`. Set
`textHelper.model` (or `PI_JEV_BROWSER_TEXT_MODEL`) to `"provider/modelId"` to pin a
different model; its token usage is reported back to pi on the tool result.

The helper is a one-line extraction: a 4,096-token budget (reasoning models share it
with their thinking tokens), two transport retries, and tolerance of a code fence or
surrounding prose around the JSON object. The value itself is still validated
strictly — exactly one non-empty `text` string of at most 2,000 characters —
otherwise nothing is typed and the run reports `text_helper_invalid_output`. The
integration avoids an LLM reasoning round trip and a screenshot per browser step, but
actual end-to-end speed and live-model reliability have not been benchmarked.

## Tools

- `jev_run` — startup, before/after screenshots, and the Jev loop.
- `jev_actions` — manual actions without Jev; returns an updated screenshot.
- `jev_extract` — deterministic read of text, table rows, links, or an attribute,
  with no model call.
- `jev_state` — tabs, current URL, title, viewport and start time, without a
  screenshot.
- `jev_logs` — console messages, page errors, failed requests, navigations, tab
  events, blocked downloads and security blocks.
- `jev_stream` — start, inspect or stop the tokenized live viewer on `127.0.0.1`.
- `jev_stop` — stop the browser and the stream, finalize the video, return artifact
  paths.
- `jev_desktop` — run a bounded goal in one macOS application through its
  accessibility tree. Asks before every run; see below.

Every browser tool runs sequentially (`executionMode: "sequential"`), because they
mutate one shared browser. The browser starts isolated and nothing in the browser
tools touches the host desktop; the one tool that does, `jev_desktop`, asks before
every run. [docs/reference.md](docs/reference.md#working-with-the-manual-tools)
has the element-target form for a click, fill or select, how tabs are handled, and
what a coordinate click is recorded as.

### The desktop tool

`jev_desktop` takes a bundle id and a goal, and runs the same loop against the
application's accessibility tree instead of a page. Jev sees the window's text and
its controls (role, name, value, and the accessibility identifier, which is stable
across languages), never pixels. Actions are accessibility actions on the element,
so they land whether or not the window has focus. Before acting, the loop plans the
steps from the first observation (`plan: false` turns this off); the plan is
returned with the result and written to the trace.

There is no application allow list: like computer use, the tool can drive any
installed application. Nothing has to know a bundle id in advance either — the
argument takes an installed display name, and `findApp` locates an application
(name, bundle id, path) without driving anything. The application folders come
first, walked a few levels deep so a vendor's own sub-folder
(`/Applications/Epson Software/…`) counts; only when they hold nothing does the
lookup widen to Spotlight, which finds an application installed anywhere on the
disk. The result says which of the two answered.

It refuses to run until two things are true, and says which is missing:

- **The user confirmed this run.** Every call asks, naming the application and the
  goal, unless `desktop.requireConfirmation` is `false`. The config file stays the
  user's: the guidelines forbid the agent from turning the prompt off or working
  around it.
- **The host can do it.** macOS, the helper built with `npm run build:ax-helper`,
  and Accessibility permission for the process running pi. A missing prerequisite
  is reported as a setup message, not a failed run.

An application that draws its own document (Word's page is one `AXLayoutArea` with
no value, no actions and no children) is still driven: the helper offers the page as
a text target, reads it with text recognition, and types into it with keyboard
events after a click places the caret. A goal carrying a passage on a line of its
own is offered that passage whole, so a story is typed in one step rather than one
clause at a time. After a cold start the run waits for the first window before
observing.

The result carries the run status, the plan, the executed steps, `tracePath` under
`<outputDir>/desktop/`, and the window's final text, so the agent can verify a
`done_unverified` claim against what the application shows. The loop's own stops
apply unchanged, and a closed application is reported as `window_unavailable`.
[docs/reference.md](docs/reference.md#the-desktop-driver) records what driving a
real application takes.

```json
{ "desktop": { "requireConfirmation": true } }
```

## Configuration

No configuration is required. Defaults: all HTTP/HTTPS origins, headless Chromium, a
1280 × 720 viewport, WebM recording enabled, cursor and click indicators enabled, the
live viewer off until `jev_stream` starts it, and artifacts under
`~/.pi/agent/pi-jev-browser/`.

Copy `pi-jev-browser.config.example.json` to
`~/.pi/agent/pi-jev-browser.config.json`, or point `PI_JEV_BROWSER_CONFIG` at another
file.

```json
{
  "allowedOrigins": ["https://*.example.com"],
  "denyOrigins": [],
  "requireConfirmation": [],
  "headless": true,
  "recordVideo": true,
  "viewport": { "width": 1280, "height": 720 },
  "stream": { "enabled": false, "intervalMs": 1000 },
  "popups": "stay",
  "profile": "session",
  "typesafe": { "apiKey": "", "baseUrl": "https://api.typesafe.ai", "model": "jev-latest" },
  "textHelper": { "model": "" },
  "desktop": { "requireConfirmation": true }
}
```

- `allowedOrigins` takes `*` wildcards (for example `https://*.example.com`), and
  `denyOrigins` is checked first, so a deny rule always wins and blocks navigation
  before Chromium starts.
- `requireConfirmation` lists origins that need an explicit yes in a pi dialog before
  `jev_run` or `jev_actions` touches them. Without a dialog-capable UI (a headless
  run, for example) the call fails instead of proceeding silently.
- `profile` decides how much browser state survives between runs. `"session"`
  (default) keeps one profile per pi session, so logging in once in the visible
  window carries to later runs of that session and two pi sessions never fight over
  one Chrome profile; `"shared"` keeps one profile for every session, at
  `profileDir`; `"off"` starts clean every run.
  [docs/reference.md](docs/reference.md#profiles) covers what persists, and what a
  shared profile costs.

Environment overrides: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
`TYPESAFE_DEFAULT_MODEL`, `PI_JEV_BROWSER_TEXT_MODEL`, `PI_JEV_BROWSER_CONFIG`.
Credentials are read on every run, are never passed to Chromium, and never appear in
tool results. The config path is resolved once when pi starts, so restart pi after
changing `PI_JEV_BROWSER_CONFIG`.

## Safety

Keep pi's tool approval enabled, and do not auto-approve browser tools for
authenticated, financial, medical, destructive, or otherwise high-impact workflows.
The extension enforces navigation allowlists, but the user must still approve
consequential actions at the point of risk. Treat webpage text and screenshots as
untrusted input, not user instructions.

Jev uses DOM observations for its action loop and the agent receives screenshots to
independently verify the outcome. `jev_desktop` acts on the user's own applications
and can reach any of them, so it asks before each run: keep that confirmation on for
anything holding real data. Confirming one run says that this goal in this
application is fine, not that every goal in it is acceptable.

## Development

```bash
npm install
npm run install-browser
npm run check      # tsc --noEmit
npm test           # node --test --experimental-strip-types
npm run benchmark  # capability suite; see benchmarks/README.md
```

Tests use local HTML, a local stub for the TypeSafe System One endpoint, and mocked
pi models, so they make no paid model calls. Browser tests need installed Chromium
and permission to launch it; set `PI_JEV_BROWSER_TEST_BROWSER` for a specific
executable. A three-page fixture (search box → results list → detail page) exercises
the full loop, including a real `TYPE_TEXT` through the pi model:

```bash
# serve a fixture, then in pi:
#   jev_run url http://127.0.0.1:4599/ goal "Search for zebra and open the
#   Zebra result. Stop when the page shows the Zebra heading."
```

pi transports a real `AbortSignal` to tool execution, so the extension combines it
with its own per-session controller: Escape aborts an active run or action batch, and
`jev_stop` cancels one explicitly. Deadlines and model timeouts are still enforced
locally, and a mutation already in flight can finish before cancellation takes
effect. Chromium setup starts lazily on the first browser tool call rather than at
extension load, and `session_shutdown` closes any browser left open.

### When a site blocks automated access

Google and similar sites rate-limit repeated automated visits and serve an anti-bot
verification page (`google.com/sorry/`). Pi Jev Browser does not solve or bypass it:
Jev returns `blocked` with `stopReason: "model_blocked"` on the first observation,
usually in under a second, and the guidelines tell the agent to stop and ask you
rather than retry. Bursts of automated probing are what trigger the block.

A `blocked` or `needs_review` run leaves the browser open, so you can clear the
verification yourself: keep `headless: false`, let the run return `blocked` (the
agent must not call `jev_stop`), solve the verification in the visible window, then
continue **in the same pi session** — browsers are keyed to
`ctx.sessionManager.getSessionId()`, so a new session starts a fresh browser.

## Benchmarks

`benchmarks/` is a repeatable capability suite in four tiers: `local` (offline
fixtures, no credential), `model` (real Jev decisions on local pages), `live`
(third-party sites) and `desktop` (real macOS applications through the accessibility
driver). Every scenario verifies its outcome against the fixture server's request
log, the run trace, the application's own reported state, or an independent read, so
a run cannot pass by claiming success.

```bash
npm run benchmark                   # local tier
npm run benchmark -- --suite=all    # every tier, needs a credential and internet
```

All 22 scenarios pass. Two were once reported as `GAP` rather than hidden, and both
were closed by a measured change rather than by rewording: the loop now refuses an
ordinary DOM human-verification gate before asking Jev, and the decision layer plans
a multi-step desktop task from a short goal instead of needing the steps spelled out.
[benchmarks/README.md](benchmarks/README.md) has the full table, measured metrics,
and what the suite deliberately does not measure.

## License

Apache-2.0. This project is a port of
[`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser),
which is Apache-2.0 licensed; the original `LICENSE` text is kept in this repository
and the port keeps that license. The observation pipeline, Jev prompt, run statuses
and safety contract come from the original work; the pi host plumbing, decision
transport, text helper, selector layer, benchmark suite and subsequent fixes are new.
