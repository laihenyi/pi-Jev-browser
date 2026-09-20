# Pi Jev Browser

Isolated Playwright browser tools for **pi**, with **Jev** (TypeSafe System One)
choosing each browser action over a structured DOM observation instead of a
screenshot-per-step loop.

This is a port of [`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser)
to the pi extension API. The observation pipeline, Jev prompt, run statuses, and
safety contract are carried over; the host plumbing, the decision transport, and
the text helper changed. See [Differences from the Cline plugin](#differences-from-the-cline-plugin).

## Install

### From npm

```bash
pi install npm:pi-jev-browser
```

Pi installs the package under `~/.pi/agent/npm/` and reads this manifest:

```json
"pi": { "extensions": ["./index.ts"] }
```

Installing pulls in `playwright` and `@typesafe-ai/sdk`, and Playwright's own
install step downloads Chromium. That download is roughly 150 MB, so the first
install takes a moment. `typebox`, `@earendil-works/pi-ai`, and
`@earendil-works/pi-coding-agent` are `peerDependencies` because pi provides
them as virtual modules, so nothing is bundled twice.

### From a git checkout or a local directory

```bash
pi install git:github.com/laihenyi/pi-Jev-browser            # latest main
pi install git:github.com/laihenyi/pi-Jev-browser@v0.1.0    # a pinned tag
pi install /absolute/path/to/pi-Jev-browser                 # a working copy
```

### Auto-discovery in `~/.pi/agent/extensions`

A checkout placed at `~/.pi/agent/extensions/pi-Jev-browser/` is discovered
automatically, which is how this repository is used during development. Restart
pi (or `/reload`) after changing it, and install its dependencies once:

```bash
cd ~/.pi/agent/extensions/pi-Jev-browser
npm install
node node_modules/playwright/cli.js install chromium   # or: npm run install-browser
```

Chromium setup also happens automatically on the first `jev_run`, bounded to
two minutes. A failed setup is reported by the tool that needed it, and a later
call retries. On Linux, system browser libraries remain an administrator-managed
prerequisite; the extension never runs sudo.

Provide a TypeSafe API key from `console.typesafe.ai` in the environment or the
config file:

```bash
export TYPESAFE_API_KEY=...        # or typesafe.apiKey in pi-jev-browser.config.json
chmod 600 ~/.pi/agent/pi-jev-browser.config.json
```

`jev_run` resolves this before Chromium starts, so a missing key fails
immediately with the file and variable to set instead of a browser-shaped error.

Nothing else is required: field text for typed inputs is generated with the pi
model the session is already using.

## The Jev loop

`jev_run` starts or reuses a browser, captures a before screenshot, and then
runs a bounded decision loop. Each evaluation sends one TypeSafe System One
request:

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
{ "model": "jev-latest", "state": "<page observation + recent actions>", "questions": { "action": { ... } } }
```

Jev answers a single `choice` question whose criteria are the concrete operations
offered for the current page: one entry per visible action target
(`CLICK:<id>`, `TYPE_TEXT:<id>`, `SELECT:<id>`), plus `SCROLL_UP`, `SCROLL_DOWN`,
`WAIT`, `BLOCKED`, `REVIEW`, and `DONE`. Comparing every concrete action against
scrolling, waiting, and stopping in one pass is what keeps the loop cheap; there
is no screenshot in the decision path.

Jev sees indexed visible action targets, selected form options (including
offscreen selections), and summaries of controls above and below the viewport. It
does not receive screenshots. The agent receives screenshots to verify outcomes.

Jev chooses actions but cannot generate arbitrary text. When it chooses
`TYPE_TEXT`, the extension calls the **active pi model** through
`ctx.modelRegistry.complete()` to produce the field value. Set
`textHelper.model` (or `PI_JEV_BROWSER_TEXT_MODEL`) to `"provider/modelId"` to pin a
different model. Its token usage is reported back to pi on the tool result.

The helper is a one-line extraction, so it uses a 4,096-token budget (reasoning
models share that budget with their thinking tokens) and two transport retries,
and it tolerates a code fence or surrounding prose around the JSON object. The
value itself is still validated strictly: exactly one non-empty `text` string of
at most 2,000 characters, otherwise nothing is typed and the run reports
`text_helper_invalid_output`.

### Example tool sequence

1. `jev_run({ "url": "https://en.wikipedia.org", "goal": "Find and open the article about Ada Lovelace. Stop when the article is visible.", "maxSteps": 20 })`
2. Verify the returned final screenshot (or read `finalScreenshotPath` if the image is not displayed).
3. `jev_stop({})` to release the browser and finalize the video.

`jev_run` starts a browser automatically, captures the initial screen, runs
Jev, and returns a final image plus both screenshot paths and page states.
Further calls reuse the browser; omit `url` to continue or provide it to navigate
first. Launch options (`headless`, `recordVideo`, `showCursor`,
`showClickIndicators`) apply when creating a browser. The browser stays available
for follow-up runs until stopped.

Supported automatic operations: click, replace text, native dropdown selection,
page scroll, and short loading waits. Runs default to 20 steps (maximum 60) and
have a 100-second cancellation deadline. There is no default probability cutoff.
Optional `minProbability` gates Jev's calibrated probability for the selected
choice; it is not provider confidence. A browser operation already in flight can
take up to its bounded Playwright timeout to settle after cancellation. Browser
mutations are not retried.

Results include `status`, `steps`, `elapsedMs`, and a JSONL `tracePath`. Statuses
are `done_unverified`, `blocked`, `needs_review`, `uncertain`, `step_limit`,
`evaluation_limit`, or `interrupted`. A failed run also reports `failure`
(`stage`, `category`, `detail`) and an `errorsLogPath`:

| `failure.category` | Meaning |
| --- | --- |
| `configuration` | Missing or unreadable configuration; the message names the file and the variable to set. Reported before Chromium starts. |
| `text_helper_invalid_output` | The active pi model did not return a usable `{"text": ...}` value. Nothing was typed. |
| `cancelled` | The run was aborted or hit its deadline. |
| `navigation_context` | The document changed while it was being read. |
| `timeout` | A bounded browser or model timeout elapsed. |
| `document_not_ready` | The page never produced a readable document. |
| `unexpected_error` | Anything else, usually a provider error. |

`stopReason` explains why the loop stopped, independent of the model's status:

| `stopReason` | Meaning |
| --- | --- |
| `model_done` | Jev reported DONE; the status is `done_unverified` because a claim is not proof. |
| `model_blocked` | Jev reported BLOCKED: no supported action can progress. |
| `model_review` | Jev reported REVIEW: the next step needs sensitive data, submits something, or crosses a safety barrier such as a CAPTCHA. |
| `verification_gate` | The loop itself refused a human-verification gate before asking Jev: the page text announced a challenge and a control offered to pass it. Status is `needs_review`; hand the step to the user. |
| `min_probability` | The selected choice fell below the requested `minProbability`. |
| `step_limit` / `evaluation_limit` | The action or evaluation budget ran out. |
| `repeated_action` | An identical action stopped producing new state (a control cycling between states it already produced), or ran 12 times in a row as a backstop. Repeated presses that keep producing new state are allowed, because entering `111` is legitimate input. |
| `scroll_oscillation` | `SCROLL_UP` and `SCROLL_DOWN` alternated repeatedly, a two-cycle that is not exploration. |
| `stale_observations` | Four consecutive observations were invalidated before an action could run. |
| `no_progress` | Three actions produced no observable change. |
| `text_unavailable` | The pi text helper declined to produce a value, so nothing was typed. |
| `cancelled` / `error` | The run was aborted, or it failed; see `failure`. |

`failure.detail` is a bounded summary (`error name`, HTTP status when known)
and `errors.log` in the run directory holds the full error, including a stack.
Provider errors can quote the outgoing request body, so the full text is written
only to that local file and never returned to the model. An attempted action in
a failed run might already have taken effect: inspect before continuing. Traces
record decisions (including terminal and rejected decisions), stale observations,
action attempts, completion, and the final result. Provider confidence is
recorded separately when supplied. Traces omit generated field text but may
contain page labels.

The loop retains the last ten actions, entered text, and observed progress across
runs of the same goal in one browser session. Text stays in memory and is not
written to traces. Three non-wait actions without observable progress stop the
run. Stale decisions are re-evaluated within a budget of twice `maxSteps`;
executed mutations are never retried.

The loop retains observed DOM nodes and checks page semantics, node identity, and
occlusion before acting. Open shadow roots are walked, so a web component's
controls and text are observed and acted on like light DOM (hit-testing descends
into the shadow tree, and a shadow-rendered overlay that covers a target is named
as the cover). Closed shadow roots, frames, canvas controls, nested scrolling,
uploads, and arbitrary keyboard widgets are outside this DOM loop; use
`jev_actions` where appropriate. Model context is capped at 200 action targets
and 6,000 visible text characters, plus 50 selected options and up to 50 offscreen
control labels in each direction. This can omit controls on dense pages.

Page text and visible field values are sent to TypeSafe `api.typesafe.ai`, and the
same content is sent to your pi model provider when a field value must be
generated. Password and file fields are excluded, but other sensitive content is
not automatically redacted. Jev is instructed to return `REVIEW` before
consequential actions; this is model guidance, not a deterministic security
boundary. Delegate only narrowly scoped tasks suitable for autonomous browser
interaction. The agent must handle any review and independently verify
`done_unverified`.

This integration avoids an LLM reasoning round trip and a screenshot per browser
step. Actual end-to-end speed and live-model reliability have not been
benchmarked.

### Where the loop ends and the surface begins

The decision loop implements the part that turned out to be hard: bounded steps,
stale-observation handling, an oscillation guard, a no-progress guard, traces,
and handing control back to the human before a consequential action. None of that
is web-specific, so `src/loop.ts` does not import Playwright. It drives a
`Driver` (`src/driver.ts`):

```ts
interface Driver {
  /** Identity of the surface; a change means the run moved and must not act. */
  id(): unknown;
  observe(signal?: AbortSignal): Promise<ObservationSnapshot>;
  /** The driver's own vocabulary for read failures, e.g. a navigation context. */
  readFailureCategory?(error: unknown): "navigation_context" | "document_not_ready" | undefined;
}
```

`Observation` is the contract the decision layer reads: text plus addressable
targets (`role`, `label`, `value`, `href`, and state), never pixels. A snapshot is
bound to the state it was read from, so `assertFresh` and `execute` both refuse to
act once that state has moved — which is what keeps an action from landing on
whatever replaced the target in the meantime.

The browser implementation is `browserDriver(getPage)` in `src/observe.ts`.
Everything Playwright-specific lives there, including the error vocabulary: a
destroyed execution context is a navigation in progress, and a document that never
became readable is a browser condition, not a generic failure.

A second driver lives in `src/drivers/desktop.ts` and drives a real macOS
application through its accessibility tree, with `desktop/ax-helper.swift` as the
resident helper that walks the tree and performs accessibility actions. It maps onto
the same `Observation`, so the loop is untouched. Two hard-won details are encoded
there: applications are addressed by bundle id because display names are localised,
and the accessible name lives in `AXDescription` while the stable handle is
`AXIdentifier` (Calculator publishes nothing in `AXTitle` and its multiply button is
叫「乘」but identified as `Multiply`). Titlebar close/minimize/zoom buttons are
excluded by subrole, since pressing close terminates an application that quits with
its last window. The surface identity is the driven application's process, not the
frontmost application: accessibility actions land without focus, so a person
switching windows mid-run changes nothing the loop acts on, while a quit or relaunch
still stops it. Editable text (`AXTextArea`, `AXTextField`) carries no press action
and is offered as a `TYPE_TEXT` target driven by setting its value; its content joins
the window text, because for an editor the document is the state. Desktop driving
is covered by the `desktop` benchmark tier on two applications: Calculator, verified
by an arithmetic result computed outside the application, and TextEdit, verified by
reading the document back from the application.

The loop can also plan before it acts. `createJevPolicy({ planning: true })` adds a
planning phase that runs once, against the initial observation: the same choice
model picks the next step of a plan (or `PLAN_COMPLETE`) until the plan is finished,
and the run then executes the user's goal plus the enumerated steps. This closed a
measured gap on the desktop tier, where a short goal ("compute 1234 times 5678")
reached one correct press without a plan and ten of ten with one. It is opt-in
because a plan made from one observation only covers what that observation shows,
which suits an application window and misleads on a multi-page web task. The plan
is written to the trace as a `plan` step and returned in the run result.

`test/driver.test.ts` proves the boundary is real: it drives the loop with an
in-memory driver that has no Playwright, no DOM and no browser, and still exercises
`done_unverified`, `model_review`, `model_blocked`, `text_unavailable`,
`repeated_action`, `no_progress`, `scroll_oscillation`, `stale_observations` and
`step_limit`. Driving a different surface — a desktop through its accessibility
tree, for example — means writing another driver, not rewriting the loop.

## Features

- screenshots returned as image tool results, so the agent can verify outcomes
- batched `click`, `double_click`, `scroll`, `type`, `wait`, `keypress`, `drag`,
  `move`, `navigate`, `back`, `forward`, `reload`, and `screenshot` actions
- browser console, page-error, failed-request, navigation, download, and security
  logs
- per-run PNG artifacts and optional WebM video recording with a visible agent
  cursor and animated click pulses
- a tokenized live screenshot/log viewer bound to `127.0.0.1`
- session isolation, blocked downloads, blocked service workers, no inherited
  host environment, disabled extensions and browser file-system access
- bounded browser launch, navigation, video-finalization, and cleanup timeouts so
  unavailable apps fail with their underlying error instead of hanging
- automatic visible-browser fallback on macOS when headless Chromium cannot start
- a live footer status line while a browser run streams decisions
- prompt guidelines covering prompt injection, sensitive data, and consequential
  actions

This is a browser harness, not unrestricted control of the host desktop.

## Tools

- `jev_run` — startup, before/after screenshots, and the Jev loop.
- `jev_actions` — manual actions without Jev; returns an updated screenshot.
- `jev_extract` — deterministic read of text, table rows, links, or an
  attribute, with no model call.

### Element targets instead of coordinates

A manual click, fill, or select can address an element instead of a pixel, so the
same call keeps working after a layout change:

```json
[
  { "type": "click", "target": { "role": "link", "name": "部落格" } },
  { "type": "fill", "target": { "role": "textbox", "name": "Email" }, "value": "a@b.c" },
  { "type": "select", "target": { "role": "combobox", "name": "Plan" }, "value": "pro" },
  { "type": "click", "target": { "selector": "#submit" } },
  { "type": "click", "target": { "role": "button", "name": "Buy", "nth": 1 } }
]
```

A target accepts `role`, `name` (needs `role`), `text`, `selector`, and `nth`.
Matching waits up to five seconds for the element to exist, so a batch can click a
link and act on the page it navigates to. A target that matches nothing fails with
`No element matched …` instead of clicking whatever happens to be under the cursor.
`x`/`y` coordinates remain available for canvas-like surfaces.

A coordinate click is a raw event, so the browser will route it into an iframe even
though the automatic loop never sees frame content. When a click or drag lands on a
frame, the result carries a `warnings` entry and a matching `security` entry appears
in `jev_logs`, naming the frame origin and flagging known anti-bot providers
(`reCAPTCHA`, `hCaptcha`, `Cloudflare challenge`):

```
A click at (160, 165) landed inside a frame from https://www.google.com [reCAPTCHA].
The automatic Jev loop never interacts with frame content; this was a raw coordinate click.
```

This is a record, not a block: it makes coordinate clicks auditable and tells the
agent to stop clicking there. Keep it in mind when deciding whether to auto-approve
browser tools.

### Tabs

Sites open new tabs constantly (`target="_blank"` on login and outbound links). Pi
Browser never switches the observed page silently:

- `popups: "stay"` (default) keeps the run on the original page, records a `tab`
  entry in `jev_logs`, and returns a warning naming the new URL.
- `popups: "follow"` adopts the new tab as the observed page, and says so.
- `jev_actions` can then move deliberately with `activate_tab` / `close_tab`,
  and `jev_state.activePageIndex` reports which tab is being observed.

If the observed tab closes, the run falls back to another open tab instead of
keeping a reference to a closed page.

- `jev_logs` — captured console, error, request, navigation, tab, and security logs.
- `jev_stream` — start, inspect, or stop the localhost live viewer.
- `jev_state` — active state, tabs, URL, title, viewport, start time.
- `jev_stop` — close the browser, stop the stream, finalize the video.

Every tool runs sequentially (`executionMode: "sequential"`) because they mutate
one shared browser, and one browser operation at a time is allowed per pi session.

## Configuration

No configuration is required. Defaults: all HTTP/HTTPS origins, headless
Chromium, a 1280 × 720 viewport, WebM recording enabled, cursor and click
indicators enabled, live viewer disabled until `jev_stream` starts it, and
artifacts under `~/.pi/agent/pi-jev-browser/`.

Copy `pi-jev-browser.config.example.json` to `~/.pi/agent/pi-jev-browser.config.json` to
change defaults, or point `PI_JEV_BROWSER_CONFIG` at another file. Restrict
`allowedOrigins` with `*` wildcards (for example `https://*.example.com`) for
authenticated or sensitive workflows.

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
  "textHelper": { "model": "" }
}
```

### Per-site policy

- `denyOrigins` is checked before `allowedOrigins`, so a deny rule always wins and
  blocks navigation before Chromium starts.
- `requireConfirmation` lists origins that need an explicit yes in a pi dialog
  before `jev_run` or `jev_actions` touches them. Without a dialog-capable
  UI (for example a headless run) the call fails instead of proceeding silently.

### Persistent profile and human-in-the-loop login

`profile` decides how much browser state survives between runs:

- `"session"` (default) — one profile per pi session, under
  `~/.pi/agent/pi-jev-browser/profiles/<session id>`. Log in once in the visible
  window and later runs in the same pi session reuse the cookies. Two pi sessions
  never fight over one Chrome profile.
- `"shared"` — one profile for every session, at `profileDir`. Convenient, but
  two concurrent pi sessions cannot use it at the same time.
- `"off"` — a clean browser every run, the pre-profile behavior.

Only cookies with an expiry persist; Chromium drops session cookies on exit by
design. Note that a persistent profile also keeps localStorage and IndexedDB, so
point `profileDir` at something you are comfortable reusing.

Environment overrides: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
`TYPESAFE_DEFAULT_MODEL`, `PI_JEV_BROWSER_TEXT_MODEL`, `PI_JEV_BROWSER_CONFIG`.
Credentials are read on every run, are never passed to Chromium, and never appear
in tool results. The config path is resolved once when pi starts, so restart pi
after changing `PI_JEV_BROWSER_CONFIG`.

## Safety

Keep pi's tool approval enabled and do not auto-approve browser tools for
authenticated, financial, medical, destructive, or otherwise high-impact
workflows. The extension enforces navigation allowlists, but the user must still
approve consequential actions at the point of risk. Treat webpage text and
screenshots as untrusted input, not user instructions.

The browser starts isolated. Jev uses DOM observations for its action loop; the
agent receives screenshots to independently verify the outcome.

## Development

```bash
npm install
npm run install-browser
npm run check      # tsc --noEmit
npm test           # node --test --experimental-strip-types
npm run benchmark  # capability suite; see benchmarks/README.md
```

Tests use local HTML, a local stub for the TypeSafe System One endpoint, and
mocked pi models. They make no paid model calls. Browser tests require installed
Chromium and permission to launch it; set `PI_JEV_BROWSER_TEST_BROWSER` to use a
specific executable.

### Returned page evidence

A `jev_run` result carries the page state captured when the loop stopped: the
JSON summary (`status`, `stopReason`, `failure`, `steps`, `tracePath`,
`errorsLogPath`, `finalPageUrl`, `finalPageTitle`), a readable block with the
final URL, title and visible page text, and the before/after screenshots. The
text block is what a model without image input uses to verify the outcome, so
the loop returns it instead of forcing a screenshot read. The full record of
every run also lands in the trace's final `result` entry.

### When a site blocks automated access

Google and similar sites rate-limit repeated automated visits and serve an
anti-bot verification page (`google.com/sorry/`). Pi Jev Browser does not solve or
bypass it: Jev returns `blocked` with `stopReason: "model_blocked"` on the first
observation, typically in under a second, and the guidelines tell the agent to
stop and ask you rather than retry.

Because a `blocked` or `needs_review` run leaves the browser open, you can clear
the verification yourself:

1. Keep `headless: false` so the window is visible.
2. Let the run return `blocked` (the browser stays open; the agent must not call `jev_stop`).
3. Solve the verification in the visible window.
4. Continue **in the same pi session** — browsers are keyed to `ctx.sessionManager.getSessionId()`, so a new pi session starts a fresh browser.

Bursts of automated probing are what trigger the block; normal use rarely does.
If a site blocks you persistently, prefer another source over escalating.

### Manual smoke test

A three-page fixture (search box → results list → detail page) is enough to
exercise the full loop, including a real `TYPE_TEXT` through the pi model:

```bash
# serve a fixture, then in pi:
#   jev_run url http://127.0.0.1:4599/ goal "Search for zebra and open the
#   Zebra result. Stop when the page shows the Zebra heading."
```

### Cancellation

pi transports a real `AbortSignal` to tool execution, so the extension combines
that signal with its own per-session controller. Pressing Escape aborts an active
run or action batch, and `jev_stop` cancels one explicitly. Run deadlines and
model timeouts are still enforced locally. A browser mutation already in flight
can finish before cancellation takes effect.

Chromium setup starts lazily on the first browser tool call rather than at
extension load, and `session_shutdown` closes any browser left open.

## Differences from the Cline plugin

| Area | Cline plugin | Pi Jev Browser |
| --- | --- | --- |
| Host API | `plugin.setup(api)` with JSON Schema `inputSchema` | `export default (pi)` with TypeBox `parameters` |
| Safety rules | `api.registerRule()` | `promptSnippet` + `promptGuidelines` (verified in the built system prompt) |
| Decision transport | `@ai-sdk/gateway` + `experimental_evaluate` | direct `POST https://api.typesafe.ai/v1/systemone` |
| Decision model | `typesafe-ai/jev` via AI Gateway | `jev-latest` (configurable) direct |
| Text helper | `google/gemini-2.5-flash-lite` via Gateway | active pi model via `ctx.modelRegistry.complete()` |
| Credential | `AI_GATEWAY_API_KEY` | `TYPESAFE_API_KEY` |
| Config | `~/.cline/plugins/cline-jev-browser.config.json` | `~/.pi/agent/pi-jev-browser.config.json` |
| Artifacts | `~/.cline/data/jev-browser/` | `~/.pi/agent/pi-jev-browser/` |
| Session identity | `context.sessionId` over JSON IPC | `ctx.sessionManager.getSessionId()` |
| Cancellation | local controller only (signals were not transported) | pi `AbortSignal` + local controller |
| Failure reporting | one opaque `interrupted` message | classified `failure` + `errors.log` with the full provider error |
| Setup | kicked off eagerly when the plugin loaded | lazily on first browser tool use |
| Tool names | `jev_run`, `jev_actions`, `jev_state`, `jev_logs`, `jev_stream`, `jev_stop` | the same names, plus `jev_extract` for deterministic reads |
| Tool results | `{ result: [...] }` interpreted by Cline | `{ content, details, usage }`; nested model usage is reported to pi |
| Schemas | JSON Schema with `additionalProperties: false` | TypeBox with `additionalProperties: false`, plus per-action field validation |
| Concurrency | host-defined | `executionMode: "sequential"` for all browser tools |
| Cleanup | plugin teardown | `session_shutdown` handler calls `stopAll()` |

## Benchmarks

`benchmarks/` is a repeatable capability suite in three tiers: `local` (offline
fixtures, no credential), `model` (real Jev decisions on local pages), and `live`
(third-party sites). Every scenario verifies its outcome against the fixture
server's request log, the run trace, or an independent read, so a run cannot pass
by claiming success.

```bash
npm run benchmark                   # local tier
npm run benchmark -- --suite=all    # every tier, needs a credential and internet
```

Latest results: every executable scenario passes, across the local, model, live and
desktop tiers. Two scenarios used to be reported as `GAP` rather than hidden, and
both were closed by a measured change rather than by rewording: the loop now
refuses an ordinary DOM human-verification gate before asking Jev (it used to click
straight through one, stopping at a real CAPTCHA only because the widget sits in an
unobservable iframe), and the decision layer plans a multi-step desktop task from a
short goal instead of needing the steps spelled out. `benchmarks/README.md` has the
full table, measured metrics, and the list of what the suite deliberately does not
measure.

## License

Apache-2.0. This project is a port of
[`cline/plugins/plugins/jev-browser`](https://github.com/cline/plugins/tree/main/plugins/jev-browser),
which is Apache-2.0 licensed; the original `LICENSE` text is kept in this
repository and the port keeps that license. The observation pipeline, Jev prompt,
run statuses, and safety contract come from the original work; the pi host
plumbing, decision transport, text helper, selector layer, benchmark suite, and
subsequent fixes are new.
