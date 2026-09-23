# Reference

Detail that is useful when something needs explaining, kept out of the
[README](../README.md) so the README stays readable: run statuses and error
classification, the boundary between the decision loop and the surface it drives,
and what changed from the Cline plugin this project was ported from.

- [What the browser side provides](#what-the-browser-side-provides)
- [Run results and statuses](#run-results-and-statuses)
- [What the loop remembers, and what it refuses to act on](#what-the-loop-remembers-and-what-it-refuses-to-act-on)
- [Working with the manual tools](#working-with-the-manual-tools)
- [Profiles](#profiles)
- [Where the loop ends and the surface begins](#where-the-loop-ends-and-the-surface-begins)
- [Differences from the Cline plugin](#differences-from-the-cline-plugin)

## What the browser side provides

Beyond the decision loop, the browser tools come with:

- screenshots returned as image tool results, so the agent can verify outcomes
- batched `click`, `double_click`, `scroll`, `type`, `wait`, `keypress`, `drag`,
  `move`, `navigate`, `back`, `forward`, `reload` and `screenshot` actions
- browser console, page-error, failed-request, navigation, download and security logs
- per-run PNG artifacts and optional WebM video recording with a visible agent
  cursor and animated click pulses
- a tokenized live screenshot/log viewer bound to `127.0.0.1`
- session isolation, blocked downloads, blocked service workers, no inherited host
  environment, disabled extensions and browser file-system access
- bounded browser launch, navigation, video-finalization and cleanup timeouts, so an
  unavailable app fails with its underlying error instead of hanging
- automatic visible-browser fallback on macOS when headless Chromium cannot start
- a live footer status line while a browser run streams decisions
- prompt guidelines covering prompt injection, sensitive data and consequential
  actions

## Run results and statuses

A `jev_run` result carries `status`, `steps`, `elapsedMs` and a JSONL `tracePath`.
Statuses are `done_unverified`, `blocked`, `needs_review`, `uncertain`,
`step_limit`, `evaluation_limit` or `interrupted`. A failed run also reports
`failure` (`stage`, `category`, `detail`) and an `errorsLogPath`.

`failure.detail` is a bounded summary (`error name`, HTTP status when known), and
`errors.log` in the run directory holds the full error including a stack. Provider
errors can quote the outgoing request body, so the full text is written only to
that local file and never returned to the model. An attempted action in a failed
run might already have taken effect: inspect before continuing.

### `failure.category`

| `failure.category` | Meaning |
| --- | --- |
| `configuration` | Missing or unreadable configuration; the message names the file and the variable to set. Reported before Chromium starts. |
| `text_helper_invalid_output` | The active pi model did not return a usable `{"text": ...}` value. Nothing was typed. |
| `cancelled` | The run was aborted or hit its deadline. |
| `navigation_context` | The document changed while it was being read. |
| `timeout` | A bounded browser or model timeout elapsed. |
| `document_not_ready` | The page never produced a readable document. |
| `unexpected_error` | Anything else, usually a provider error. |

### `stopReason`

`stopReason` explains why the loop stopped, independent of the model's status.

| `stopReason` | Meaning |
| --- | --- |
| `model_done` | Jev reported DONE; the status is `done_unverified` because a claim is not proof. |
| `model_blocked` | Jev reported BLOCKED: no supported action can progress. |
| `model_review` | Jev reported REVIEW: the next step needs sensitive data, submits something, or crosses a safety barrier such as a CAPTCHA. |
| `submit_review` | The loop itself refused to press Return in a field that has no confirm control of its own (a chat composer, a command line): that sends or executes what was typed. Status is `needs_review`; the user sends. |
| `verification_gate` | The loop itself refused a human-verification gate before asking Jev: the page text announced a challenge and a control offered to pass it. Status is `needs_review`; hand the step to the user. |
| `min_probability` | The selected choice fell below the requested `minProbability`. |
| `step_limit` / `evaluation_limit` | The action or evaluation budget ran out. |
| `repeated_action` | An identical action stopped producing new state (a control cycling between states it already produced), or ran 12 times in a row as a backstop. Repeated presses that keep producing new state are allowed, because entering `111` is legitimate input. |
| `scroll_oscillation` | `SCROLL_UP` and `SCROLL_DOWN` alternated repeatedly, a two-cycle that is not exploration. |
| `stale_observations` | Four consecutive observations were invalidated before an action could run. |
| `no_progress` | Three actions produced no observable change. A control pressed twice without any change, or whose press led twice to a state already produced (a bubble that highlights, a tab that reopens), is withdrawn from the next question first, so the count starts again when the question changes; the run only stops when Jev keeps choosing fresh controls that change nothing. Whitespace and punctuation differences between reads do not count as change. |
| `text_unavailable` | Neither the goal nor the pi text helper supplied a value for the field, so nothing was typed. |
| `cancelled` / `error` | The run was aborted, or it failed; see `failure`. |

### Returned page evidence

A `jev_run` result carries the page state captured when the loop stopped: the JSON
summary (`status`, `stopReason`, `failure`, `steps`, `tracePath`, `errorsLogPath`,
`finalPageUrl`, `finalPageTitle`), a readable block with the final URL, title and
visible page text, and the before/after screenshots. The text block is what a
model without image input uses to verify the outcome, so the loop returns it
instead of forcing a screenshot read. The full record of every run also lands in
the trace's final `result` entry.

Traces record decisions (including terminal and rejected decisions), stale
observations, action attempts, completion and the final result. Provider
confidence is recorded separately when supplied. Traces omit generated field text
but may contain page labels.

## What the loop remembers, and what it refuses to act on

The loop retains the last ten actions, entered text, and observed progress across
runs of the same goal in one browser session. Text stays in memory and is not
written to traces. Stale decisions are re-evaluated within a budget of twice
`maxSteps`; executed mutations are never retried.

It retains observed DOM nodes and checks page semantics, node identity and
occlusion before acting. Open shadow roots are walked, so a web component's
controls and text are observed and acted on like light DOM: hit-testing descends
into the shadow tree, and a shadow-rendered overlay that covers a target is named
as the cover. Closed shadow roots, frames, canvas controls, nested scrolling,
uploads and arbitrary keyboard widgets are outside this DOM loop; use
`jev_actions` where appropriate.

Model context is capped at 200 action targets and 6,000 visible text characters,
plus 50 selected options and up to 50 offscreen control labels in each direction.
This can omit controls on dense pages.

Page text and visible field values are sent to TypeSafe `api.typesafe.ai`, and the
same content is sent to your pi model provider when a field value has to be
generated because the goal does not contain it. Password and file fields are
excluded, but other sensitive content is not automatically redacted. Jev is
instructed to return `REVIEW` before consequential actions; that is model
guidance, not a deterministic security boundary.

## Working with the manual tools

### Element targets instead of coordinates

A manual click, fill or select can address an element instead of a pixel, so the same
call keeps working after a layout change:

```json
[
  { "type": "click", "target": { "role": "link", "name": "部落格" } },
  { "type": "fill", "target": { "role": "textbox", "name": "Email" }, "value": "a@b.c" },
  { "type": "select", "target": { "role": "combobox", "name": "Plan" }, "value": "pro" },
  { "type": "click", "target": { "selector": "#submit" } },
  { "type": "click", "target": { "role": "button", "name": "Buy", "nth": 1 } }
]
```

A target accepts `role`, `name` (needs `role`), `text`, `selector` and `nth`.
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
Jev Browser never switches the observed page silently:

- `popups: "stay"` (default) keeps the run on the original page, records a `tab`
  entry in `jev_logs`, and returns a warning naming the new URL.
- `popups: "follow"` adopts the new tab as the observed page, and says so.
- `jev_actions` can then move deliberately with `activate_tab` / `close_tab`, and
  `jev_state.activePageIndex` reports which tab is being observed.

If the observed tab closes, the run falls back to another open tab instead of
keeping a reference to a closed page.

## Profiles

`profile` decides how much browser state survives between runs:

- `"session"` (default) — one profile per pi session, under
  `~/.pi/agent/pi-jev-browser/profiles/<session id>`. Log in once in the visible
  window and later runs in the same pi session reuse the cookies. Two pi sessions
  never fight over one Chrome profile.
- `"shared"` — one profile for every session, at `profileDir`. Convenient, but two
  concurrent pi sessions cannot use it at the same time.
- `"off"` — a clean browser every run, the pre-profile behavior.

Only cookies with an expiry persist; Chromium drops session cookies on exit by
design. A persistent profile also keeps localStorage and IndexedDB, so point
`profileDir` at something you are comfortable reusing.

## Where the loop ends and the surface begins

The decision loop implements the part that turned out to be hard: bounded steps,
stale-observation handling, an oscillation guard, a no-progress guard, traces, and
handing control back to the human before a consequential action. None of that is
web-specific, so `src/loop.ts` does not import Playwright. It drives a `Driver`
(`src/driver.ts`):

```ts
interface Driver {
  /** Identity of the surface; a change means the run moved and must not act. */
  id(): unknown;
  observe(signal?: AbortSignal): Promise<ObservationSnapshot>;
  /** The driver's own vocabulary for read failures: a navigation context, a closed window. */
  readFailureCategory?(
    error: unknown,
  ): "navigation_context" | "document_not_ready" | "window_unavailable" | undefined;
}
```

`Observation` is the contract the decision layer reads: text plus addressable
targets (`role`, `label`, `value`, `href`, and state), never pixels. A snapshot is
bound to the state it was read from, so `assertFresh` and `execute` both refuse to
act once that state has moved — which is what keeps an action from landing on
whatever replaced the target in the meantime.

`test/driver.test.ts` proves the boundary is real: it drives the loop with an
in-memory driver that has no Playwright, no DOM and no browser, and still
exercises `done_unverified`, `model_review`, `model_blocked`, `text_unavailable`,
`repeated_action`, `no_progress`, `scroll_oscillation`, `stale_observations` and
`step_limit`. Driving a different surface means writing another driver, not
rewriting the loop.

### The browser driver

`browserDriver(getPage)` in `src/observe.ts` — everything Playwright-specific
lives there, including the error vocabulary: a destroyed execution context is a
navigation in progress, and a document that never became readable is a browser
condition, not a generic failure.

### The desktop driver

`src/drivers/desktop.ts` drives a real macOS application through its accessibility
tree, with `desktop/ax-helper.swift` as the resident helper that walks the tree and
performs accessibility actions. It maps onto the same `Observation`, so the loop is
untouched. Hard-won details are encoded there:

- Applications are addressed by bundle id because display names are localised, and
  the accessible name lives in `AXDescription` while the stable handle is
  `AXIdentifier`. Calculator publishes nothing in `AXTitle`, and its multiply
  button is labelled in the system language but identified as `Multiply`.
- Titlebar close/minimize/zoom buttons are excluded by subrole, since pressing
  close terminates an application that quits with its last window.
- The surface identity is the driven application's process, not the frontmost
  application: accessibility actions land without focus, so a person switching
  windows mid-run changes nothing the loop acts on, while a quit or relaunch still
  stops it.
- Editable text (`AXTextArea`, `AXTextField`) carries no press action and is
  offered as a `TYPE_TEXT` target driven by setting its value; its content joins
  the window text, because for an editor the document is the state.
- An application that draws its own document (Word's page is one `AXLayoutArea`
  with no value, no actions and no children) is offered as a text target, read
  with text recognition, and typed into with keyboard events after a click places
  the caret.
- Text recognition reads only what changed. The window capture is compared with
  the previous one at 1/8 scale in 128-point tiles; unchanged tiles keep the lines
  they produced last time, and only the rectangles around changed tiles are
  recognised again (grown past any line they would cut, at most four). A window
  that has not moved a pixel costs one capture and no recognition, which is what
  makes the settle re-read and the pre-press re-walk cheap. The helper reports
  `timing` (walk, capture, ocr, ocrRead as a percentage) on every observation.
- A synthetic mouse click (the only way to choose a list row that exposes no
  action) is refused unless the point hit-tests to the driven application: the
  window may be on another Space, minimised, or covered, and the click would land
  in whatever is there instead. The refusal reads as "covered", so the loop
  re-observes rather than clicking elsewhere. Accessibility actions need no such
  check.
- The observation taken after an action is carried into the next decision
  instead of being read again, so a step costs one read, not two.
- Recognised lines of one or two characters with low confidence (an icon, a
  badge, a cursor read as "口" or "-6") are dropped: they flicker between reads
  and would make every observation a new state.
- AXError `-25204` (cannot complete) and `-25205` (invalid element) are the
  application not answering in time and the control dying as a result of the
  press, not a refusal, when the window has changed since the observation.

Desktop driving is covered by the `desktop` benchmark tier on two applications:
Calculator, verified by an arithmetic result computed outside the application, and
TextEdit, verified by reading the document back from the application.

### Planning

`createJevPolicy({ planning: true })` adds a planning phase that runs once,
against the initial observation: the same choice model picks the next step of a
plan (or `PLAN_COMPLETE`) until the plan is finished, and the run then executes the
user's goal plus the enumerated steps. This closed a measured gap on the desktop
tier, where a short goal ("compute 1234 times 5678") reached one correct press
without a plan and ten of ten with one. It is opt-in because a plan made from one
observation only covers what that observation shows, which suits an application
window and misleads on a multi-page web task. The plan is written to the trace as
a `plan` step and returned in the run result.

## Differences from the Cline plugin

The observation pipeline, the Jev prompt, the run statuses and the safety contract
were carried over from the Cline plugin; the host plumbing, the decision transport
and the text helper changed, and everything from the `Driver` interface onward (the
desktop driver, the planning phase, the verification gate, shadow DOM, the
benchmark suite) was added here.

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
