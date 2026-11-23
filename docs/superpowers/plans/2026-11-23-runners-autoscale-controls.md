# Runners Autoscale Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An "Autoscale" strip on the Runners screen that shows ci-runners' autoscale limits and last decision and lets the person pause/resume it and change or reset its server cap.

**Architecture:** The hub's `runners` view model gains an `autoscale` block built from the service's `limits` and the `features` of `version --json`; the view's `act` runs `ci-runners autoscale … --actor cockpit`; the mod draws the strip and sends acts the way the aq screen does. Cockpit computes nothing the service already decides.

**Tech Stack:** Rust (`herdr/tui/runners`, serde_json, chrono, insta), the Herdr app mod (plain ES modules on gpui-kit), POSIX sh.

**Spec:** `docs/superpowers/specs/2026-11-23-runners-autoscale-controls-design.md` (and, for v1 of the screen, `docs/superpowers/specs/2026-11-22-runners-space-design.md`). Service contract: `~/projects/temporal-CI-CD/docs/superpowers/specs/2026-11-23-autoscale-design.md` §5.

## Global Constraints

- Cockpit only shows the service's fields and runs the service's commands; it adds no thresholds or decisions of its own.
- A control exists only when `version --json` `features` declares it: `pause` → Pause/Resume, `set-max` → max −/+ and Reset.
- `limits.autoscale: false` → the strip is one line `autoscale off in config`, no controls.
- Every command carries `--actor cockpit`. No confirmation dialogs. No pause reason prompt.
- Commands: `ci-runners autoscale pause --actor cockpit`, `ci-runners autoscale resume --actor cockpit`, `ci-runners autoscale set-max <N> --actor cockpit`, `ci-runners autoscale set-max --reset --actor cockpit`; a 20 s limit (the service itself waits up to 15 s for its lock).
- Fixtures, snapshots and examples use the acme demo world only (see `AGENTS.md`); never copy real data from the live ci-runners.
- Rust tests: from `herdr/tui`, `env -u HC_TERMINAL_ID -u HC_TERMINAL_SOCKET -u HC_SCOPE HC_BIN=/nonexistent/hc cargo test -p cockpit-runners` (add `INSTA_UPDATE=always` to accept a changed snapshot; cargo-insta is not installed). Mod tests: from the repo root, `node --experimental-vm-modules --test app/tests/*.test.mjs`.
- House rules from `AGENTS.md`: doc comments one or two plain present-tense sentences; ~160 columns; `cargo fmt` with `herdr/tui/rustfmt.toml`.
- Never touch the person's live Herdr window, hub or `~/.cache/cockpit`/`~/.config/cockpit`; never run the real `~/.local/bin/ci-runners autoscale …` (it changes the person's live service). Tests use fake binaries only.

## Review Focus

1. A service without `limits` (older ci-runners) or without `pause`/`set-max` in `features`: no strip, or no such controls — never a button that fails on click. (Task 1, Task 2 tests.)
2. A failing command (lock timeout, bad N): the act returns the service's first stderr line as the error, and the mod shows it as an error toast. (Task 2, Task 3 tests.)
3. Max at its bounds: − disabled at 0, + disabled at `max_vms`; a key press on a hidden or disabled control does nothing. (Task 3 tests.)
4. `last_decision` with `error` or `blocked` reads in the warning tone; `null` reads `no decisions yet`. (Task 1 tests.)
5. A hung `ci-runners autoscale` is killed at 20 s and reads as an error, not a hung hub thread. (Task 2 test with a sleeping fake.)

---

### Model contract (Task 1 produces, Tasks 3–4 consume)

The view model (see `docs/app.md`, "Runners") gains one top-level key, present in every `live` and `no-tick` model:

```jsonc
"autoscale": null | {                    // null when the status has no `limits` object
  "on": true,                            // limits.autoscale
  "paused": false, "paused_by": "cockpit" | null, "paused_ago": "5m" | null, "pause_reason": "…" | null,
  "max": 3, "max_source": "config" | "set-max", "max_vms": 6,
  "trigger": "≥3 waiting or 10m",        // from min_queued and max_wait_minutes
  "last": {"text": "5 waiting → created 2", "ago": "2m" | null, "tone": "warning" | null},
  "can_pause": true, "can_set_max": true // from version --json features
}
```

`last.text`: `last_decision` null → `no decisions yet`; `error` set → `error: <error>` (warning); `blocked` set → `blocked: <blocked>` plus `, N waiting` when waiting > 0 (warning); `created` > 0 → `N waiting → created K`; else `N waiting`, and `queue empty` when waiting is 0. Ages (`paused_ago`, `last.ago`) count from the status's `generated_at`, like the tick's age. The Home `line.text` gains ` · autoscale paused` when `on && paused`.

---

### Task 1: Model: the autoscale block

**Files:**
- Modify: `herdr/tui/runners/src/model.rs`, `herdr/tui/runners/src/gui.rs` (only the `Source::Live` call site and test call sites)
- Modify: `herdr/tui/runners/tests/fixtures/status-live.json`, `status-stale.json`, `version.json`
- Modify: the insta snapshot under `herdr/tui/runners/src/snapshots/`

**Interfaces:**
- Produces: `Source::Live(Value, Vec<String>)` — the status and the declared features; `model(source, watched, now)` keeps its signature. The `autoscale` block above.

- [ ] **Step 1:** Add `limits` to both status fixtures, shaped exactly as the service's §5 example: `{"autoscale": true, "paused": false, "paused_by": null, "paused_at": null, "pause_reason": null, "max_servers": 3, "max_servers_source": "config", "max_vms": 6, "min_queued": 3, "max_wait_minutes": 10, "last_decision": {"at": "2026-11-22T18:59:40Z", "waiting": 5, "oldest_s": 740, "free": 0, "booting": 1, "created": 2, "blocked": null, "error": null}}`. Add `"pause", "set-max"` to `version.json` `features`. Keep one key per line in the status fixtures (Task 4's fake edits them with `sed`).
- [ ] **Step 2: Failing tests** in `model.rs`:
  - `autoscale_reads_the_service_s_limits`: fixture → `autoscale` equals `{"on": true, "paused": false, "paused_by": null, "paused_ago": null, "pause_reason": null, "max": 3, "max_source": "config", "max_vms": 6, "trigger": "≥3 waiting or 10m", "last": {"text": "5 waiting → created 2", "ago": "2m", "tone": null}, "can_pause": true, "can_set_max": true}`.
  - `no_limits_no_autoscale`: `limits` removed → `autoscale` is null; `limits` present but features `[]` → `can_pause` and `can_set_max` false.
  - `last_decision_words`: null → `no decisions yet`; `error: "create failed: quota"` → `error: create failed: quota`, tone warning; `blocked: "isolation", waiting: 4` → `blocked: isolation, 4 waiting`, tone warning; waiting 0, created 0 → `queue empty`.
  - `a_pause_shows_on_home`: `paused: true, paused_by: "cockpit", paused_at: "2026-11-22T18:56:40Z"` → `paused_ago` `5m`, line text ends with ` · autoscale paused`; with `autoscale: false` and `paused: true` the line has no such suffix.
- [ ] **Step 3:** Run them; expect failures (missing key / wrong `Source::Live` arity).
- [ ] **Step 4:** Implement: `Source::Live(Value, Vec<String>)` (update `gui.rs`'s `source()` to pass the features it already read, and every test call site); `fn autoscale(limits: &Value, features: &[String], generated: DateTime<Utc>) -> Value` in `model.rs`; add the key to the live/no-tick model and the line suffix.
- [ ] **Step 5:** Run all `cockpit-runners` tests with `INSTA_UPDATE=always`; inspect the snapshot diff (only the new `autoscale` key and nothing else changes); then `cargo clippy -p cockpit-runners --all-targets --locked -- -D warnings` and `cargo fmt --check`.
- [ ] **Step 6:** Commit `runners: the autoscale block from the service's limits`.

### Task 2: Hub act: run the autoscale commands

**Files:**
- Modify: `herdr/tui/runners/src/gui.rs`, `herdr/tui/cli/src/gui.rs` (the `runners` registration: `act: cockpit_runners::gui::act`)

**Interfaces:**
- Consumes: `features(bin)`, `bin()`, `call()` in `gui.rs`.
- Produces: `pub fn act(action: &str, args: &[Value]) -> Option<Result<String, String>>` — `None` for an action it does not know; actions `pause`, `resume`, `set-max` (args `[N]`, a non-negative integer as JSON number), `reset-max`.

- [ ] **Step 1: Failing tests** in `gui.rs`, using the existing `Fake` helper (it records calls):
  - `pause_runs_the_service_s_command`: fake with features `["status-offline","pause","set-max"]`; `act("pause", &[])` → `Ok("Autoscale paused")`, the fake saw `autoscale pause --actor cockpit`. Same for `resume` → `Ok("Autoscale resumed")`, `set-max [4]` → `autoscale set-max 4 --actor cockpit`, `Ok("Max servers set to 4")`, `reset-max` → `autoscale set-max --reset --actor cockpit`, `Ok("Max servers back to the config's")`.
  - `an_undeclared_control_is_refused_without_a_call`: features without `pause` → `act("pause")` is `Err("this ci-runners cannot pause autoscale; update it")` and the fake saw no `autoscale` call; without `set-max` → `Err("this ci-runners cannot change the server cap; update it")`.
  - `a_bad_max_is_refused`: `set-max` with `[]`, `["4"]`, `[-1]`, `[1.5]` → `Err` starting `not a server count`, no call.
  - `a_failing_command_gives_its_stderr`: fake exits 1 with stderr `control.lock busy` → `Err("control.lock busy")`; no stderr → `Err("ci-runners autoscale pause exited 1")`.
  - `unknown_actions_are_not_ours`: `act("drain", &[])` is `None`.
  - `a_hung_command_stops_at_the_limit`: fake sleeps 30 s on `autoscale` → `Err` naming the limit, within ~21 s (mark it like the existing hanging-status test).
  - No binary (`CI_RUNNERS_BIN` unset paths are hard to fake): test the inner function that takes `Option<PathBuf>` → `Err("ci-runners is not installed on this machine")`.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement `act` as a thin wrapper over a `run_act(bin: Option<PathBuf>, action, args)` (the testable inner); give `call()` a limit parameter (5 s for version/status, 20 s for autoscale). Register `act` in `cli/src/gui.rs`. The hub rebuilds the view after any `act`, so no `touch` is needed.
- [ ] **Step 4:** Run the crate's tests, clippy for `cockpit-runners` and `cockpit` (the cli crate), fmt.
- [ ] **Step 5:** Commit `runners: pause, resume and the server cap from the hub`.

### Task 3: Mod: the Autoscale strip

**Files:**
- Modify: `app/mods/cockpit/runners.js`, `app/tests/runners.test.mjs`

**Interfaces:**
- Consumes: the model's `autoscale` block (contract above); `hub.act("runners", action, args)` returning `{note, error}`.
- Produces: exported `autoscaleControls(model)` → the visible controls `[{id, label, key, disabled}]` (ids `pause`|`resume`, `less`, `more`, `reset`), and `autoscaleLine(model)` → the strip's words or null.

- [ ] **Step 1: Failing tests** in `runners.test.mjs` (the snapshot model now carries `autoscale`):
  - `autoscaleLine`: snapshot model → `on · max 3 (config, cap 6) · trigger ≥3 waiting or 10m · last 2m ago: 5 waiting → created 2`; `on: false` → `autoscale off in config`; paused → starts `paused by cockpit 5m ago`; `autoscale: null` → null.
  - `autoscaleControls`: snapshot → ids `["pause", "less", "more"]` (no `reset`, source is config); `max_source: "set-max"` → adds `reset`; paused → `resume` instead of `pause`; `max: 0` → `less` disabled; `max: 6` → `more` disabled; `can_pause: false` → no pause/resume; `can_set_max: false` → no less/more/reset; `on: false` → `[]`.
  - Keys: on a view with the snapshot model and a stubbed `send`, `p` sends `["pause", []]`, `+` and `=` send `["set-max", [4]]`, `-` sends `["set-max", [2]]`, `0` does nothing (no reset visible); with `max: 0`, `-` does nothing; while a send is in flight, keys do nothing.
- [ ] **Step 2:** Run; expect failures.
- [ ] **Step 3:** Implement: the strip between the warnings and the tiles (`Autoscale` label, `autoscaleLine` in muted text, the paused/last-decision parts in the warning colour when their tone says so, buttons via `Button` from `ui.js` like aq); a `Toaster` for results exactly like `aq.js` `send()`; a `busy` flag that disables buttons and keys while an act runs; add the keys to `KeyHints` when their control is visible. Check how other mods in `app/mods/cockpit/` match `+`/`=` keystrokes before choosing names.
- [ ] **Step 4:** `node --input-type=module --check < app/mods/cockpit/runners.js`; run the mod tests.
- [ ] **Step 5:** Commit `runners: the Autoscale strip and its keys`.

### Task 4: Sandbox fake and docs

**Files:**
- Modify: `scripts/fake-ci-runners.sh`, `docs/app.md` (the Runners section), `app/RECIPE.md` only if it lists the runners keys

- [ ] **Step 1:** The fake answers `autoscale pause --actor cockpit`, `autoscale resume --actor cockpit`, `autoscale set-max N --actor cockpit`, `autoscale set-max --reset --actor cockpit` by writing `paused` and `max` to a state file (`${TMPDIR:-/tmp}/fake-ci-runners.$(id -u)`), and `status --json --offline` rewrites `"paused":`, `"paused_by":`, `"max_servers":` and `"max_servers_source":` lines of the fixture from that file with `sed`. `CI_RUNNERS_FAKE=fail` makes every `autoscale` command print `control.lock busy` to stderr and exit 1.
- [ ] **Step 2:** Check: `shellcheck -S warning scripts/fake-ci-runners.sh`; run `sh scripts/fake-ci-runners.sh autoscale pause --actor cockpit && sh scripts/fake-ci-runners.sh status --json --offline | grep '"paused"'` → `true`; resume → `false`; `set-max 5` → `"max_servers": 5` and `"set-max"`; `set-max --reset` → back to `3`/`config`.
- [ ] **Step 3:** `docs/app.md`: add the `autoscale` block to the model listing, describe the strip, the controls, the keys (`p`, `+`/`=`, `-`, `0`), the acts and their notes and errors, and the fake's `autoscale` and `CI_RUNNERS_FAKE=fail`.
- [ ] **Step 4:** Commit `runners: autoscale in the sandbox fake and the docs`.
