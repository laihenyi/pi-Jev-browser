# Capability benchmark

A repeatable suite that measures what this browser agent actually does, instead of
trusting a single successful demo. Every scenario **verifies** its outcome — a
submitted form is confirmed in the server's request log, a clicked header link is
confirmed against the run trace, a price is cross-checked with an independent
read — so a run cannot pass by claiming success.

```bash
npm run benchmark                  # local tier: no credential, no internet
npm run benchmark -- --suite=model # + real Jev decisions on local pages
npm run benchmark -- --suite=live  # + third-party sites (needs internet)
npm run benchmark -- --suite=all --strict
npm run benchmark -- --list        # every scenario with its tier
npm run benchmark -- --only=jev-header-enumeration,manual-popup-stay
npm run benchmark -- --repeat=3    # a scenario passes only if every repetition passes
```

Results are written to `benchmarks/results/<timestamp>.json`, appended to
`benchmarks/results/history.jsonl`, and printed as a table. The exit code is
non-zero when a `local` or `model` scenario fails; `live` failures are reported
but only affect the exit code with `--strict`, because a third-party site can
block the runner through no fault of the code.

## Tiers

| Tier | Needs | What it can prove |
| --- | --- | --- |
| `local` | nothing (offline) | The execution layer and the loop guards, on a fixture site served from `127.0.0.1`. No model calls at all. |
| `model` | a TypeSafe credential | Real Jev decisions, but against local pages only, so the results are reproducible and no third party is touched. |
| `live` | credential + internet | Real sites. These are the numbers that matter, and also the ones that can break for reasons outside the code. |
| `desktop` | macOS + accessibility permission | Real applications driven through their accessibility tree instead of the DOM, using the same loop. Verified by arithmetic, not by looking at the screen. |

The `model` tier reads the credential from `~/.pi/agent/pi-jev-browser.config.json` or
`TYPESAFE_API_KEY`, the same way the extension does. The benchmark overrides only
browser policy, and fails loudly if the runtime is still reading a different
config file.

## Scenarios

### `local` — execution layer and loop guards

| Scenario | Category | Asserts |
| --- | --- | --- |
| `manual-selectors` | regression | `fill` / `select` / `click` by role and accessible name, with the form submission confirmed by the fixture server. |
| `manual-extract` | capability | `jev_extract` returns exact text, table rows, links and attributes. |
| `manual-frame-audit` | regression | A coordinate click that lands in an iframe is reported **and** really reaches the frame; a click elsewhere is not reported. |
| `manual-popup-stay` | regression | A `target="_blank"` link is reported, never becomes the observed page, and `activate_tab` moves tabs on request. |
| `manual-deny-origin` | regression | `denyOrigins` refuses navigation before Chromium starts. |
| `session-profile` | regression | A cookie with an expiry survives a browser restart in the same session. |
| `loop-scroll-oscillation` | regression | Alternating `SCROLL_UP`/`SCROLL_DOWN` stops the loop after five scrolls instead of burning the step budget. |
| `loop-no-progress` | regression | Three different inert actions stop the loop as `no_progress`. |

### `model` — real Jev decisions

| Scenario | Category | Asserts |
| --- | --- | --- |
| `jev-header-enumeration` | regression | Jev clicks five distinct header links, one of which opens a new tab, and ends with `model_done`. Local reproduction of the failure that motivated the popup fix. |
| `jev-form-fill` | capability | Jev fills a search field and submits; the fixture server confirms the query it received. |
| `jev-verification-gate` | limitation | The REVIEW rule generalising to a plain-HTML human-verification gate. **Currently a documented gap** — see below. |

### `desktop` — real macOS applications

The desktop tier drives an application through its accessibility tree with the
same `runJev` loop the browser tier uses. Nothing in the loop knows the
difference; only the driver does.

| Scenario | Category | Asserts |
| --- | --- | --- |
| `desktop-calculator-deterministic` | capability | The driver addresses buttons by accessibility identifier, the actions land, and the application's own display matches `1234 × 5678` computed here. No model is involved. |
| `desktop-repeat-guard` | regression | Six presses of one digit produce six different displays and are not stopped as a repeat. Regression for the guard that counted identical actions and killed a run that was making progress. |
| `desktop-calculator-entry` | capability | Jev completing a ten-step entry, using the recipe the calibration tool found: an enumerated goal plus mechanical rules. |
| `desktop-goal-needs-a-plan` | capability | The same task from a short goal. Jev plans the key sequence first (asserted step by step), then executes it. Formerly a documented gap — see below. |

Two things the tier learned about driving a desktop, both now fixed in the driver:

- **Titlebar buttons were offered as targets.** Close, minimize and zoom are
  `AXButton`s with an `AXPress` action and no accessible name, so they appeared in
  the observation. Pressing close terminates an application that quits with its
  last window, which is how Calculator died mid-run and left every later scenario
  reporting `no window`. They are now excluded by subrole.
- **A running application can have no window.** Closing the last window leaves the
  process alive, and `open` on a running application does not create a new one. The
  tier detects that state and relaunches before it starts.

### `live` — third-party sites

| Scenario | Category | Asserts |
| --- | --- | --- |
| `live-flight-month-sweep` | capability | Lowest TPE→LON fare for each of the next three months, read deterministically until the price is stable. |
| `live-flight-nonstop-filter` | capability | Two-step filter dialog: open `Stops`, select `Nonstop` by `role=radio`, and confirm the applied filter changed the result set. |
| `live-pilotrun-header` | capability | Jev clicks every header link on a real marketing site whose login link opens a tab and whose blog route hydrates its header late. |

## Measured results

Latest full run on 2026-09-19, macOS, Chromium 1243, `jev-1.13.0`.

```
scenario                     tier   category    result  time
manual-selectors             local  regression  PASS    2.7s
manual-extract               local  capability  PASS    0.8s
manual-frame-audit           local  regression  PASS    2.3s
manual-popup-stay            local  regression  PASS    1.1s
manual-deny-origin           local  regression  PASS    0.0s
session-profile              local  regression  PASS    1.7s
loop-scroll-oscillation      local  regression  PASS    1.8s
loop-no-progress             local  regression  PASS    1.9s
jev-header-enumeration       model  regression  PASS    5.3s
jev-form-fill                model  capability  PASS    2.2s
jev-verification-gate        model  limitation  GAP     2.6s
live-flight-month-sweep      live   capability  PASS    8.9s
live-flight-nonstop-filter   live   capability  PASS    16.2s
live-pilotrun-header         live   capability  PASS    9.1s
```

Selected metrics from that run:

| Metric | Value |
| --- | --- |
| Lowest TPE→LON fare, 2026-10 / 2026-11 / 2026-12 | `$1,026` / `$1,115` / **`$928`** |
| Cheapest December itinerary | Etihad, 25 hr 25 min, TPE–LHR, 1 stop AUH |
| Nonstop-filtered fare, same search | `$1,124` (two-step selector click: 3,461 ms) |
| `live-pilotrun-header` | 10 executed steps, **10 distinct targets**, 0 stale observations, loop 8,122 ms |
| `jev-header-enumeration` decision latency | median 270 ms |
| `live-pilotrun-header` decision latency | median 266 ms |

The month sweep was cross-checked against an earlier TWD measurement of the same
routes (NT$32,604 / NT$35,408 / NT$29,482), which matches at the prevailing rate.
The nonstop fare was confirmed three independent ways: Jev's own final page text
(`All filters (1)`, `Nonstop`, `1 result returned`), a deterministic extract of
the result URL Jev produced, and the deterministic two-step selector flow.

## Planning: a gap that was measured, then closed

`desktop-goal-needs-a-plan` used to be reported as **GAP**. The decision layer held a
plan it was given but did not invent one: with the calibrated rules, an enumerated
goal completed ten of ten presses and a short goal reached a correct prefix of one.

That was a measured boundary rather than an opinion, because the desktop rules were
calibrated with an instrument instead of by rewriting prose until something passed:

```bash
node benchmarks/desktop-calibration.ts --runs=2            # all variants
node benchmarks/desktop-calibration.ts --runs=2 --variants=D   # one variant
```

It reports the longest correct prefix of the expected press sequence, so a change
that improves the plan shows up even when a run still does not finish. Measured
against macOS Calculator's "1234 x 5678", two runs per variant:

| Variant | Correct prefix (of 10) | Outcome |
| --- | --- | --- |
| Browser rules + enumerated goal | 2, 2 | repeats one digit, then `repeated_action` |
| Earlier desktop rules + enumerated goal | 2, 2 | presses Clear mid-entry, then `step_limit` |
| Calibrated desktop rules + enumerated goal | **10, 10** | completes, `model_done`, display `7,006,652` |
| Calibrated desktop rules + short goal | 1, 1 | presses Clear mid-entry, then `step_limit` |
| Calibrated desktop rules + short goal + **planning** | **10, 10** | plans all ten presses first, completes, `model_done` |

Three conclusions came out of that table, and all are load-bearing:

- **Make the next step mechanical, do not describe it.** The earlier rules said to
  "track what the window text says you have entered" and measured at zero
  improvement. The calibrated rules say to compare the requested number with the
  digits the display shows and press the first missing one, with a worked example.
- **The goal has to carry the plan.** The rules alone are not enough: the same rules
  with a short goal reach a prefix of one. A ten-step task is ten fresh decisions,
  and the plan is what keeps them consistent.
- **The decision layer can make that plan itself, with the tool it already has.**
  The provider only answers choice questions, so the planning phase asks one: given
  the unchanged initial observation and the plan so far, which target is the next
  step, or is the plan complete? It repeats that until `PLAN_COMPLETE` (bounded), and
  the loop then runs against the user's goal plus the enumerated plan. Four measured
  runs planned the full sequence and executed 10 of 10; the plan is written to the
  trace as a `plan` step. Planning is opt-in (`createJevPolicy({ planning: true })`)
  because a plan made from one observation only covers the targets visible in it,
  which suits a single application window and would mislead on a multi-page web task.

One measurement trap surfaced along the way: **Calculator restores its last
expression across a relaunch**, and after a completed calculation the first press
of the clear key only clears the entry. A run that started on top of the previous
answer would pass on numbers it never entered, so both the scenarios and the
calibration tool now clear until the display reads 0 and fail if it will not.

## Known gaps, asserted on purpose

Other things the suite does **not** measure:

- **Date pickers and multi-step form entry.** The live flight scenarios use the URL
  shortcut, which skips the form.
- **iframe content.** No scenario expects the automatic loop to read frame content;
  `manual-frame-audit` only measures what a coordinate click does.
- **Purchase paths.** No scenario clicks a booking, checkout, or payment control.
- **Vision.** The suite never asserts on screenshots; outcomes come from page text,
  the DOM, the trace, and server-side request logs.

## Design notes

- **Server-side truth.** The fixture records every request, so a form submission, a
  verification call, or a missing navigation is observable independently of what
  the tool reports.
- **One browser per scenario.** Each scenario gets its own manager and session
  profile, so a leaked cookie or tab cannot influence the next scenario.
- **Bounded settles instead of sleeps.** Prices are read until stable, tabs are
  waited for with a deadline, and every wait is capped, so a slow site produces a
  recorded failure rather than a hung suite.
- **Scripted policies for loop guards.** The scroll and no-progress scenarios drive
  `runJev` with a scripted policy, so the guard is measured without model variance.

## Adding a scenario

```ts
// benchmarks/scenarios/local.ts
{
  id: "my-scenario",
  tier: "local",
  category: "regression",
  title: "One line describing the behaviour",
  notes: "What a failure means, and what this deliberately does not test.",
  async run(context) {
    const manager = context.manager();
    const host = { sessionId: "bench-mine" };
    await manager.run({ url: context.fixtures.url, goal: "…" }, host, idlePolicy);
    const { page } = sessionOf(manager, host);
    return { checks: [check("name", condition, "detail seen")] };
  },
}
```

Register it in `benchmarks/scenarios/index.ts`-equivalent (the arrays exported from
`local.ts`, `model.ts`, `live.ts`). Prefer an assertion that can fail: compare an
exact value, read the server log, or check the trace rather than the returned
status alone.
