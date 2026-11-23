# Runners: load history and a readable autoscale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Runners space shows a coloured Autoscale card with a big max-servers stepper, and a History card
(24 h / 7 d chart, window tiles, notes) drawn from `ci-runners stats --json --offline`.

**Architecture:** The hub (`herdr/tui/runners`) calls `stats` next to `status`, in parallel, and turns its JSON into a
`history` block (tiles in words, chart models with local-time labels, notes) beside the existing model; the autoscale
block gains a `state` and `waiting`. `plot.js` learns a line series over stacked bars, per-series colours and per-row
notes. The mod replaces the Autoscale strip with a card and adds the History card.

**Tech Stack:** Rust (serde_json, chrono, insta), the Herdr app mod in JS (gpui-kit), node:test.

**Spec:** `docs/superpowers/specs/2026-11-23-runners-history-design.md`. Service contract: README section
«JSON для cockpit» in `~/projects/temporal-CI-CD/README.md` (around line 470) — read only.

## Global Constraints

- Cockpit computes nothing of the history: it formats units (seconds → `2m50s`, UTC → local hour), joins words, and
  only one sum: Wasted = `online_no_jobs + never_online`.
- Unknown is never zero: `coverage: 0`, a missing field or `null` reads as no data (`—`, a gap, “no data”).
- Money always carries `≈` and the price note `≈ at <price> ₽ per started server-hour`.
- A failing or missing `stats` never changes the view's `state`; it only hides the History card or shows its error.
- Fixtures, snapshots and examples: acme demo world only. Never copy values from the real `~/.local/bin/ci-runners`
  output. Never run the real `ci-runners autoscale …`.
- Doc comments: one or two plain present-tense sentences; no history, no issue numbers.
- Rust about 160 columns, single-line let-else, `cargo fmt` with `herdr/tui/rustfmt.toml`.
- Rust tests: `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE HC_BIN=/nonexistent/hc cargo test -p cockpit-runners`
  (from `herdr/tui`). Heavy workspace runs go through aq (`--memory 5G --cpus 4`).
- Node: `node --test app/tests/runners.test.mjs` (and any new test file); `node --input-type=module --check` on changed mod files.
- Shell: `shellcheck -S warning scripts/fake-ci-runners.sh`.
- Temp files only in `/tmp` (tmpfs).

## Review Focus

1. `stats` answers `no-journal` with empty `series`, `windows`, `days`: History shows “No history yet” and the
   service's warning; nothing panics or divides by zero.
2. `stats` hangs: the status part of the screen still builds; History shows “ci-runners stats did not answer within 5s”.
3. An older ci-runners without `stats-offline`: no `stats` call, `history: null`, no History card, no `w` key hint.
4. `price_per_hour_rub: null`: Spent shows `—` with “no price in config”, day tooltips show no rubles, the price note says so.
5. `queue.waiting_heavy` present but `null` versus absent: the first shows `—` (“not read”), the second hides the
   figure and falls back to `queued_runs` for the tile.

---

### Task 1: Autoscale state, waiting jobs and the queue tile (hub)

**Files:**
- Modify: `herdr/tui/runners/src/model.rs` (`autoscale()`, `build()` tiles and line, tests)
- Modify: `herdr/tui/runners/tests/fixtures/status-live.json`, `status-stale.json` (add `"waiting_heavy"` to `queue`)

**Interfaces:**
- Produces: `autoscale.state: "on"|"blocked"|"error"|"paused"|"off"`; `autoscale.waiting: null | {"count": u64|null}`
  (`null` when `queue` has no `waiting_heavy` key); `tiles.queued` from `waiting_heavy` when the key exists, else
  `queued_runs`; `tiles.queue_label: "Waiting"|"Queued"`.

- [ ] **Step 1: Failing tests** in `model.rs` tests:
  - `autoscale_state_follows_limits`: from `fixture()` with `limits` edited — `autoscale: false` → `"off"`;
    `paused: true` plus `last_decision.error: "x"` → `"paused"`; `last_decision.error: "quota"` and `blocked: "isolation"` → `"error"`;
    `blocked: "isolation"` → `"blocked"`; the fixture as is → `"on"`.
  - `waiting_heavy_feeds_the_figure_and_the_tile`: `queue.waiting_heavy: 2` → `autoscale.waiting == {"count": 2}`,
    `tiles.queued == 2`, `tiles.queue_label == "Waiting"`, line contains `· 2 waiting`; `waiting_heavy: null` →
    `{"count": null}` and `tiles.queued == null`; key removed → `autoscale.waiting == null`, `tiles.queued` is
    `queued_runs`, `queue_label == "Queued"`, line says `queued`.
- [ ] **Step 2:** Run them; expect FAIL (missing fields).
- [ ] **Step 3:** Implement in `autoscale()` (it gets `&status["queue"]` as a new parameter) and `build()`.
- [ ] **Step 4:** Run the crate tests; accept the snapshot change with `cargo insta review` only after reading it
  (`INSTA_UPDATE=always` then inspect the `.snap` diff): only the new fields may change.
- [ ] **Step 5:** Commit `runners: autoscale state and waiting heavy jobs from the service`.

### Task 2: The history block from `stats` (hub)

**Files:**
- Create: `herdr/tui/runners/src/history.rs` (and `pub mod history;` in `lib.rs`)
- Create: `herdr/tui/runners/tests/fixtures/stats-live.json` (acme shape: 24 hourly `series`, `windows` `24h` and `7d`,
  7 `days`, `price_per_hour_rub: 4.34`, `warnings: []`; include one hour with `coverage: 0` and all values `null`,
  one hour with `waiting_max: null` but servers, one day with `coverage: 0` and `hours: null`, one day with
  `hours.stopped > 0`, a `24h` window with `pending: 1`, `blocked_minutes: {"isolation": 6}`, `errors.episodes: 2`)
- Modify: `herdr/tui/runners/src/model.rs` (signature, `history` key, snapshot test)

**Interfaces:**
- Consumes: Task 1's model.
- Produces:
  - `pub fn history<Tz: TimeZone>(stats: Result<&Value, &str>, tz: &Tz) -> Value where Tz::Offset: std::fmt::Display`
  - `pub fn model<Tz: TimeZone>(source: Source, stats: Option<Result<Value, String>>, watched: &Path, now: DateTime<Utc>, tz: &Tz) -> Value`
    (same bound); the model gains `"history"`: `null` when `stats` is `None`, else `history(...)`.
  - The `history` value:
    ```
    {"error": "<text>"}                                   // when stats is Err
    {"empty": true,  "notes": [...]}                      // no-journal warning or no windows
    {"empty": false,
     "windows": {"24h": {"tiles": [Tile], "notes": [Note]}, "7d": {...}},
     "charts":  {"24h": Chart, "7d": Chart},
     "notes":   [Note]}                                   // response-wide: price, service warnings
    Tile  = {"id", "label", "value", "hint": str|null, "tone": "warning"|null}
    Note  = {"text", "tone": "warning"|null}
    Chart = {"kind": "bar", "stacked": true, "labels": [str], "notes": [str|null],
             "series": [{"key", "name", "values": [f64|null], "line": bool}]}
    ```
- Exact words (from the spec's tables):
  - Tile ids and labels: `launched` “Launched”, `took` “Took jobs”, `wasted` “Wasted”, `spent` “Spent”,
    `online` “To online”, `autoscale` “Autoscale”.
  - Launched hint `3 auto · 1 manual` (builder/unknown appended when non-zero), then `· 1 still running` when `pending`.
  - Wasted hint `2 idle without a job · 0 never online` (`· 1 unclear` when non-zero); tone warning when the sum > 0.
  - Spent value `≈ 56 ₽` (rounded to whole rubles), hint `13 server-hours · 30 ₽ idle` (`by_state_rub.idle`);
    `estimate_rub: null` → value `—`, hint `no price in config`.
  - To online value `2m50s`, hint `worst 3m47s`; `null` → `—`, no hint.
  - Autoscale value `created`, hint `threshold met 1 of 14 passes with demand`, then non-zero only:
    `blocked isolation 6m` per kind, `errors 2 passes · 10 episodes` (non-zero parts), `paused 30m`, `off 15m`; tone
    warning when `blocked_minutes` is non-empty or any error count > 0.
  - Window notes: `data covers 73% of the period` when `coverage < 1`; `partly estimated from snapshots` when `approx`;
    `some server lifetimes are bounded` when `cost.bounded`.
  - Response notes: `≈ at 4.34 ₽ per started server-hour` or `no price in config: rubles are not estimated`; each
    entry of `warnings[]` as its `text` (or `kind`) with tone warning.
  - Chart 24h: labels `%H:%M` of each `start` in `tz`; series `busy` “Busy” (`cloud_busy`), `idle` “Idle”,
    `booting` “Booting”, `waiting` “Waiting jobs” (`waiting_max`, `line: true`); `coverage == 0` → all four `null`;
    notes per hour joined by ` · `: `no data` | `covered 73%` (when < 1), `created 2 auto · 1 manual` (non-zero parts).
  - Chart 7d: labels `%a %d` of `days[].date`, the date equal to `generated_at` in `tz` → `today`; series
    `busy`/`idle`/`booting` from `hours`, plus `stopped`, `expired`, `builder`, `unknown` each only when non-zero on
    some day; `coverage == 0` or `hours: null` → `null`; notes `no data` | `≈ 26 ₽` (no rubles when `null`) and
    `covered 73%` when < 1.

- [ ] **Step 1: Failing tests** in `history.rs` with `FixedOffset::east_opt(3 * 3600)`:
  - `windows_become_tiles` (24h tile values and hints exactly as above for the fixture);
  - `unknown_is_a_gap_not_zero` (the `coverage: 0` hour has `null` in all series and note `no data`; the
    `waiting_max: null` hour has `null` only in `waiting`; the empty day is `null`);
  - `labels_are_local_time` (first label equals the fixture's first `start` + 3 h as `%H:%M`; last day label `today`);
  - `no_price_says_so`, `no_journal_is_empty` (`warnings: [{"kind":"no-journal",…}]`, empty arrays/objects),
    `an_error_is_carried` (`history(Err("boom"), …) == {"error": "boom"}`);
  - `the_fixture_keeps_the_service_shape`: the fixture's top-level keys and one window's keys equal the README table's
    sets (`v, generated_at, sources, journal, covered_until, price_per_hour_rub, bucket, series, windows, days, warnings`;
    window `from, to, coverage, approx, servers, hours, autoscale, cost, tick`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement `history.rs`; change `model()` to the new signature; tests' `live()` passes
  `Some(Ok(stats fixture))` and the +3 h offset; `gui.rs` `view()` passes `None` and `&chrono::Local` for now (Task 3 wires it).
- [ ] **Step 4:** Run the crate tests; read and accept the snapshot diff (only `history` added).
- [ ] **Step 5:** Commit `runners: the history block from ci-runners stats`.

### Task 3: Calling `stats` and the sandbox fake (hub)

**Files:**
- Modify: `herdr/tui/runners/src/gui.rs` (`view()`, new `stats()`, tests with `Fake`)
- Modify: `herdr/tui/runners/tests/fixtures/version.json` (add `"stats-offline"`)
- Modify: `scripts/fake-ci-runners.sh`

**Interfaces:**
- Consumes: Task 2's `model(source, stats, watched, now, tz)`.
- Produces: `fn stats(bin: &Path, limit: Duration) -> Option<Result<Value, String>>` — `None` when `features(bin)`
  fails or lacks `stats-offline`; else runs `stats --json --offline`. Errors: the `call()` texts (`ci-runners stats
  did not answer within 5s`), non-zero exit → first stderr line or `ci-runners stats exited N`, bad JSON →
  `ci-runners stats printed no JSON: <e>`, `v != 1` → `ci-runners stats answers in a newer format than this cockpit reads`.
  `view()` runs `source()` and `stats()` at the same time (`std::thread::scope`), then `model(…, &chrono::Local)`.

- [ ] **Step 1: Failing tests** with the existing `Fake` (extend `Fake::build` with a `stats` snippet):
  `stats_is_not_asked_without_the_feature` (no `stats` in `calls`), `stats_errors_are_words` (exit 3 with stderr
  `journal unreadable` → `Err("journal unreadable")`; `v: 2` → the newer-format text), `a_hung_stats_does_not_hold_the_status`
  (stats sleeps 30 s, limit 1 s → `Err` naming the limit, total time under 2 s, and `source()` still `Live`).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement. Fake: `stats --json --offline` → `cat "$fixtures/stats-live.json"`;
  `CI_RUNNERS_FAKE=nostats` prints `version.json` with `"stats-offline"` removed (sed) and refuses `stats` with exit 2;
  update the header comment.
- [ ] **Step 4:** Run crate tests and `shellcheck -S warning scripts/fake-ci-runners.sh`; run
  `CI_RUNNERS_FAKE=nostats sh scripts/fake-ci-runners.sh version --json` and check `stats-offline` is gone.
- [ ] **Step 5:** Commit `runners: ask ci-runners for stats beside the status`.

### Task 4: A line over stacked bars, series colours and row notes (`plot.js`)

**Files:**
- Modify: `app/mods/cockpit/plot.js`
- Create: `app/tests/plot.test.mjs` (load the module the way `runners.test.mjs` does)

**Interfaces:**
- Produces, on the `Chart` model: series `line: true` (bar charts: drawn as a 2px polyline through bar centres, not in
  the stack, not in `totals`, counted in the value scale, `null` breaks it, a lone point is a dot; legend chip a
  10×2 bar; listed in the tip); series `color` (used instead of `SERIES[i]` when given); `model.notes[i]` (a muted
  line under the tip's values when a string). `export function prepared(model, win, hidden)` for tests.
- Show view charts keep their look (they never send `line`, `color` or `notes`).

- [ ] **Step 1: Failing tests:** `prepared` on a stacked bar model with series A, B and `W` (`line: true`): `W` has no
  `base`, `totals` equal A + B, A/B bases as before; a series with `color: "#123456"` keeps it, others get `SERIES[i]`.
- [ ] **Step 2:** Run `node --test app/tests/plot.test.mjs`; expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new test, `node --test app/tests/*.test.mjs` and `node --input-type=module --check < app/mods/cockpit/plot.js`.
- [ ] **Step 5:** Commit `plot: a line over stacked bars, series colours and row notes`.

### Task 5: The Autoscale card and the History card (mod, docs)

**Files:**
- Modify: `app/mods/cockpit/runners.js`
- Modify: `app/tests/runners.test.mjs`
- Modify: `docs/app.md` (section “View `runners`”)

**Interfaces:**
- Consumes: Task 1 (`autoscale.state`, `autoscale.waiting`, `tiles.queue_label`), Task 2 (`history`), Task 4
  (`Chart` with `line`, `color`, `notes`).
- Produces (exported, pure, tested):
  - `autoscaleBadge(model)` → `{label, variant}`: on “On” success, blocked “On · blocked” warning, error “On · error”
    destructive, paused “Paused” warning, off “Off in config” secondary; `null` without autoscale.
  - `maxCaption(model)` → `from config · cap 6` | `set here · cap 6`.
  - `waitingFigure(model)` → `null` (no `waiting`) | `{value: "2"}` | `{value: "—", hint: "not read"}`.
  - `historyView(model, win)` → `null` | `{error}` | `{empty: true, notes}` | `{chart, tiles, notes}` where `notes` =
    window notes then response notes, `win` is `"24h"|"7d"`.
- Remove `autoscaleParts`/`autoscaleLine` only if nothing else imports them (the card still shows trigger, pause
  words and the last decision in small text); remove `STATS_NOTE`.

- [ ] **Step 1: Failing tests** in `runners.test.mjs` against the snapshot model: badge for each state (edit
  `autoscale.state` on a copy), `maxCaption` both sources, `waitingFigure` three cases, `historyView(m, "24h")` has six
  tiles with Launched first and a chart whose `waiting` series has `line: true`, `historyView(m, "7d")` labels end with
  `today`, `historyView` with `{history: {error: "boom"}}` and `{history: null}`; the `w` key toggles the window
  (through the class, as the existing key tests do) and is ignored without history.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3:** Implement the drawing per the spec's “Вид”: the Autoscale card (badge with dot; max figure at
  `Metric` value size with `Button` − and + on either side, caption and `Reset` link-button under it; Waiting heavy
  jobs figure; Pause/Resume button right; small trigger · pause words · last decision, warning-toned as now); then the
  History card (`Tabs` `24 h | 7 d`, `Chart` height 140 and width from `this.width`, hover and hidden-series state
  on the class, series colours: busy `k.success`, idle `k.warning`, booting `SERIES[0]`, waiting `k.foreground`,
  others `k.mutedFg`/`SERIES[4..]`; `Tiles` of `Metric` with warning hint tone; notes in `TEXT.xs`, warning ones in
  `k.warning`); then the now-tiles (label from `queue_label`) and the list. KeyHints gain `["w", "24 h / 7 d"]` when
  history has windows. Update the file's header comment and `docs/app.md` (model fields, the cards, `stats` call,
  the fake's `nostats`).
- [ ] **Step 4:** Run `node --test app/tests/*.test.mjs`, `node --input-type=module --check < app/mods/cockpit/runners.js`,
  and the crate tests (the snapshot is unchanged by this task).
- [ ] **Step 5:** Commit `runners: the Autoscale card and the History card`.

### Final gate (controller)

`cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` and the workspace tests through
aq (two known host failures only: `hub_env::tests::a_login_shell_is_read_on_the_account_s_names_alone`,
`act::start::tests::cancel_ends_a_driven_setup_before_its_worktree_goes`), node tests, shellcheck. The look in both
themes and the `+`/`w` keys are checked by the user on the Mac.
