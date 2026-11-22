//! The Runners view model the mod draws, built from `ci-runners status --json --offline`: the tiles, one row per server
//! and the line Home shows. It only turns the service's fields into words and minutes; durations are the service's own,
//! counted at its `generated_at`.

use std::path::Path;

use chrono::{DateTime, Utc};
use serde_json::{Value, json};

/// The `status --json` shape this model reads; any other `v` reads as a newer service.
pub const JSON_V: u64 = 1;

/// Where the status came from, or why there is none.
pub enum Source {
    /// No ci-runners on this machine: the space and Home's line hide.
    Absent,
    /// ci-runners is installed but too old for cockpit, and what to do.
    Outdated(String),
    /// ci-runners is installed but does not answer, and why.
    Down(String),
    /// The status, as `ci-runners status --json --offline` gives it.
    Live(Value),
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn time(v: &Value) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v.as_str()?).ok().map(|t| t.with_timezone(&Utc))
}

fn since(at: &Value, now: DateTime<Utc>) -> Option<f64> {
    time(at).map(|t| (now - t).num_seconds().max(0) as f64)
}

/// A length of time to the minute: "<1m", "7m", "1h 05m", "2d 3h".
pub fn span(secs: f64) -> String {
    let m = (secs / 60.0).floor() as i64;
    match m {
        ..1 => "<1m".into(),
        1..60 => format!("{m}m"),
        60..1440 => format!("{}h {:02}m", m / 60, m % 60),
        _ => format!("{}d {}h", m / 1440, (m % 1440) / 60),
    }
}

fn rubles(v: f64) -> String {
    format!("≈ {v:.0} ₽")
}

/// The model of a service cockpit cannot read: a card with why, a warning line and a "!" badge.
fn unusable(state: &str, error: String, line: &str) -> Value {
    json!({"state": state, "error": error, "line": {"text": line, "tone": "warning"}, "badge": {"count": "!", "tone": "warning"}})
}

fn secs(v: &Value) -> Option<f64> {
    v.as_f64().map(|s| s.max(0.0))
}

/// What the server is doing: `unowned` is a server of ours the tick leaves alone, `unknown` a runner whose GitHub
/// runners were not listed.
fn phase(server: &Value, runners_known: bool) -> &'static str {
    let runner = &server["runner"];
    if server["role"].is_null() {
        "unowned"
    } else if server["drain"] == true {
        "draining"
    } else if text(&server["role"]) == "image-builder" {
        "building"
    } else if runner.is_null() && !runners_known {
        "unknown"
    } else if runner["busy"] == true {
        "busy"
    } else if runner["online"] == true {
        "idle"
    } else if text(&server["status"]) == "ACTIVE" {
        "booting"
    } else {
        "other"
    }
}

fn size(server: &Value) -> Value {
    match (server["vcpus"].as_u64(), server["ram_mb"].as_u64(), server["disk_gb"].as_u64()) {
        (Some(c), Some(r), Some(d)) => json!(format!("{c} vCPU · {} GiB · {d} GB", r / 1024)),
        _ => Value::Null,
    }
}

/// The tick's next step for a server in words. `in_s` below zero is a deadline already passed, a minute or more of it
/// reads as overdue; `job_lost` is the service's word that the step would cut a running job.
fn next(next: &Value, generated: DateTime<Utc>) -> Value {
    let Some(at) = time(&next["at"]) else { return Value::Null };
    let in_s = next["in_s"].as_f64().unwrap_or_else(|| (at - generated).num_seconds() as f64);
    let (action, reason) = (text(&next["action"]), text(&next["reason"]));
    let overdue = in_s <= -60.0;
    let when = if overdue {
        format!("overdue {}", span(-in_s))
    } else if in_s <= 0.0 {
        "now".to_string()
    } else {
        format!("in {}", span(in_s))
    };
    let mut words = format!("{action} {when} · {reason}");
    if next["job_lost"] == true {
        words.push_str(" · job lost");
    }
    json!({"text": words, "at": next["at"], "overdue": overdue, "job_lost": next["job_lost"]})
}

fn server(s: &Value, warned: bool, runners_known: bool, generated: DateTime<Utc>) -> Value {
    let runner = &s["runner"];
    let runner_row = if runner.is_null() {
        Value::Null
    } else {
        let idle = if runner["busy"] == true { None } else { secs(&runner["idle_s"]).map(span) };
        json!({"name": runner["name"], "online": runner["online"] == true, "busy": runner["busy"] == true, "idle": idle})
    };
    json!({
        "id": s["id"], "name": s["name"], "role": s["role"], "status": s["status"], "drain": s["drain"] == true,
        "phase": phase(s, runners_known),
        "age": secs(&s["age_s"]).map(span),
        "flavor": s["flavor"], "size": size(s), "image": s["image"], "trial_label": s["trial_label"],
        "runner": runner_row,
        "next": next(&s["next"], generated),
        "cost": s["cost_estimate_rub"].as_f64().map(rubles),
        "warned": warned,
    })
}

fn build(source: Source, watched: &Path, now: DateTime<Utc>) -> Value {
    let status = match source {
        Source::Absent => return json!({"state": "absent", "error": null, "line": null, "badge": null}),
        Source::Outdated(why) => return unusable("outdated", why, "update ci-runners"),
        Source::Down(why) => return unusable("down", why, "ci-runners does not answer"),
        Source::Live(status) => status,
    };
    if status["v"].as_u64() != Some(JSON_V) {
        return unusable("newer", "ci-runners answers in a newer format than this cockpit reads".into(), "update cockpit");
    }
    for field in ["servers", "tick"] {
        let fits = if field == "servers" { status[field].is_array() } else { status[field].is_object() };
        if !fits {
            let why = format!("ci-runners status lacks {field}; cockpit and ci-runners disagree on the format");
            return unusable("down", why, "ci-runners status is not understood");
        }
    }
    // Every time counts from the moment the service built its answer, as its own durations do.
    let generated = time(&status["generated_at"]).unwrap_or(now);

    let mut warnings = status["warnings"].as_array().cloned().unwrap_or_default();
    for w in &mut warnings {
        if text(&w["text"]).is_empty() {
            w["text"] = json!(text(&w["kind"]));
        }
    }
    let state_dir = text(&status["state_dir"]);
    if !state_dir.is_empty() && Path::new(state_dir) != watched {
        let watched = watched.to_string_lossy();
        let why = format!("ci-runners keeps its state in {state_dir}; cockpit watches {watched}, so it updates every 20 s");
        warnings.push(json!({"kind": "state-dir", "text": why, "object": null}));
    }

    let tick = &status["tick"];
    let never_ran = time(&tick["last_at"]).is_none();
    let stale = warnings.iter().any(|w| text(&w["kind"]) == "tick-stale");
    let tick_row = json!({
        "ago": since(&tick["last_at"], generated).map(span), "ok": tick["ok"] == true, "errors": tick["errors"].as_u64().unwrap_or(0), "stale": stale,
        "error_text": tick["error_text"].as_str().filter(|t| !t.is_empty()),
    });

    let raw = status["servers"].as_array().cloned().unwrap_or_default();
    let warned = |id: &Value| warnings.iter().any(|w| !w["object"].is_null() && w["object"] == *id);
    let runners_known = status["sources"]["runners"]["ok"] != false;
    let servers: Vec<Value> = raw.iter().map(|s| server(s, warned(&s["id"]), runners_known, generated)).collect();

    let busy = servers.iter().filter(|s| s["runner"]["busy"] == true).count();
    let runners = raw.iter().filter(|s| text(&s["role"]) == "runner").count();
    let queue = &status["queue"];
    let queued = queue["queued_runs"].as_u64();
    let cost = status["cost_total_rub"].as_f64().map(rubles);
    let queue_stale = queued.is_some() && queue["stale"] == true;
    let tiles = json!({
        "servers": servers.len(), "runners": runners, "busy": busy, "queued": queued,
        "queue_ago": queued.and_then(|_| since(&queue["at"], generated)).map(span), "queue_stale": queue_stale, "cost": cost,
    });

    let mut line = match servers.len() {
        0 => "no servers".to_string(),
        1 => format!("1 server · {busy} busy"),
        n => format!("{n} servers · {busy} busy"),
    };
    if let Some(q) = queued {
        line.push_str(&format!(" · {q} queued"));
    }
    let (state, line, badge) = if never_ran {
        ("no-tick", json!({"text": "tick has not run", "tone": "warning"}), json!({"count": "!", "tone": "warning"}))
    } else {
        let tone = if warnings.is_empty() { Value::Null } else { json!("warning") };
        let badge = if warnings.is_empty() { Value::Null } else { json!({"count": warnings.len(), "tone": "warning"}) };
        ("live", json!({"text": line, "tone": tone}), badge)
    };
    json!({
        "state": state, "error": null, "line": line, "badge": badge, "tick": tick_row,
        "warnings": warnings, "tiles": tiles, "servers": servers,
    })
}

/// The model for whatever the source gave: `{state: "absent"}`, a card for an old or silent service, or the whole status.
pub fn model(source: Source, watched: &Path, now: DateTime<Utc>) -> Value {
    build(source, watched, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const WATCHED: &str = "/home/me/.local/state/ci-runners";

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn now() -> DateTime<Utc> {
        at("2026-11-22T19:01:53Z")
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/status-live.json")).unwrap()
    }

    fn live(status: Value) -> Value {
        model(Source::Live(status), Path::new(WATCHED), now())
    }

    fn small(drain: bool, role: &str, status: &str, runner: Value) -> Value {
        json!({"id": "x", "name": "s", "role": role, "status": status, "drain": drain, "runner": runner})
    }

    #[test]
    fn the_live_status_becomes_tiles_rows_and_a_line() {
        insta::assert_snapshot!(serde_json::to_string_pretty(&live(fixture())).unwrap());
    }

    #[test]
    fn phase_follows_drain_role_and_runner() {
        let r = |online: bool, busy: bool| json!({"name": "r", "online": online, "busy": busy});
        let mut status = fixture();
        status["servers"] = json!([
            small(true, "runner", "ACTIVE", r(true, true)),
            small(false, "image-builder", "ACTIVE", Value::Null),
            small(false, "runner", "ACTIVE", r(true, true)),
            small(false, "runner", "ACTIVE", r(true, false)),
            small(false, "runner", "ACTIVE", Value::Null),
        ]);
        let m = live(status);
        let phases: Vec<&str> = m["servers"].as_array().unwrap().iter().map(|s| s["phase"].as_str().unwrap()).collect();
        assert_eq!(phases, ["draining", "building", "busy", "idle", "booting"]);
    }

    #[test]
    fn a_server_without_a_role_is_not_the_tick_s_and_unlisted_runners_are_unknown() {
        let mut status = fixture();
        status["servers"] = json!([
            {"id": "x", "name": "acme-scratch", "role": null, "status": "ACTIVE", "drain": false, "runner": null},
            small(false, "runner", "ACTIVE", Value::Null),
        ]);
        let phases = |m: Value| m["servers"].as_array().unwrap().iter().map(|s| s["phase"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(phases(live(status.clone())), ["unowned", "booting"]);
        status["sources"]["runners"]["ok"] = json!(false);
        assert_eq!(phases(live(status)), ["unowned", "unknown"]);
    }

    #[test]
    fn the_next_step_reads_ahead_now_or_overdue() {
        let words = |in_s: i64, job_lost: Value| {
            let mut status = fixture();
            status["servers"][1]["next"] = json!({"action": "delete", "reason": "idle", "at": "2026-11-22T19:00:00Z", "in_s": in_s, "job_lost": job_lost});
            let next = live(status)["servers"][1]["next"].clone();
            (next["text"].as_str().unwrap().to_string(), next["overdue"] == true)
        };
        assert_eq!(words(600, json!(false)), ("delete in 10m · idle".into(), false));
        assert_eq!(words(0, json!(false)), ("delete now · idle".into(), false));
        assert_eq!(words(-59, Value::Null), ("delete now · idle".into(), false));
        assert_eq!(words(-240, json!(false)), ("delete overdue 4m · idle".into(), true));
        assert_eq!(words(81500, json!(true)), ("delete in 22h 38m · idle · job lost".into(), false));
    }

    #[test]
    fn a_failed_tick_carries_its_error_text() {
        let mut status = fixture();
        status["tick"]["ok"] = json!(false);
        status["tick"]["errors"] = json!(1);
        status["tick"]["error_text"] = json!("volumes not listed: storage answered 503");
        let tick = live(status)["tick"].clone();
        assert_eq!((tick["ok"].clone(), tick["errors"].clone()), (json!(false), json!(1)));
        assert_eq!(tick["error_text"], "volumes not listed: storage answered 503");
        assert_eq!(live(fixture())["tick"]["error_text"], Value::Null);
    }

    #[test]
    fn absent_hides_and_the_rest_warn() {
        let absent = model(Source::Absent, Path::new(WATCHED), now());
        assert_eq!((&absent["line"], &absent["badge"]), (&Value::Null, &Value::Null));
        let old = model(Source::Outdated("update ci-runners".into()), Path::new(WATCHED), now());
        let down = model(Source::Down("timed out".into()), Path::new(WATCHED), now());
        assert_eq!((old["state"].as_str(), old["badge"]["count"].as_str()), (Some("outdated"), Some("!")));
        assert_eq!((down["state"].as_str(), down["error"].as_str(), down["badge"]["count"].as_str()), (Some("down"), Some("timed out"), Some("!")));
    }

    #[test]
    fn an_unknown_v_reads_newer() {
        let mut status = fixture();
        status["v"] = json!(2);
        let m = live(status);
        assert_eq!(m["state"], "newer");
        assert!(m.get("servers").is_none());
    }

    #[test]
    fn no_tick_only_before_the_first_tick() {
        let mut status = fixture();
        status["tick"]["last_at"] = Value::Null;
        assert_eq!(live(status)["state"], "no-tick");
        let mut status = fixture();
        status["tick"].as_object_mut().unwrap().remove("last_at");
        assert_eq!(live(status)["state"], "no-tick");
    }

    #[test]
    fn an_uninstalled_tick_that_ran_stays_live() {
        let mut status = fixture();
        status["tick"]["installed"] = json!(false);
        status["warnings"] = json!([{"kind": "tick-stale", "text": "no successful tick for > 5 min", "object": null}]);
        let m = live(status);
        assert_eq!(m["state"], "live");
        assert_eq!(m["servers"].as_array().unwrap().len(), 3);
        assert_eq!(m["warnings"].as_array().unwrap().len(), 1);
        assert!(m["tick"]["ago"].is_string());
    }

    #[test]
    fn a_reply_without_servers_or_tick_reads_down() {
        for field in ["servers", "tick"] {
            let mut status = fixture();
            status[field] = json!("nope");
            let m = live(status);
            assert_eq!(m["state"], "down");
            assert_eq!(m["line"], json!({"text": "ci-runners status is not understood", "tone": "warning"}));
            assert_eq!(m["badge"]["count"], "!");
            assert_eq!(m["error"], format!("ci-runners status lacks {field}; cockpit and ci-runners disagree on the format"));
            let mut status = fixture();
            status.as_object_mut().unwrap().remove(field);
            assert_eq!(live(status)["state"], "down");
        }
    }

    #[test]
    fn a_trailing_slash_on_the_state_dir_is_the_same_folder() {
        let m = model(Source::Live(fixture()), Path::new(&format!("{WATCHED}/")), now());
        assert!(m["warnings"].as_array().unwrap().iter().all(|w| w["kind"] != "state-dir"));
    }

    #[test]
    fn a_queue_is_stale_only_when_the_service_says_so() {
        let mut status = fixture();
        assert_eq!(live(status.clone())["tiles"]["queue_stale"], false);
        status["queue"]["stale"] = json!(true);
        assert_eq!(live(status.clone())["tiles"]["queue_stale"], true);
        status["queue"]["stale"] = json!(false);
        assert_eq!(live(status.clone())["tiles"]["queue_stale"], false);
        status["queue"] = Value::Null;
        assert_eq!(live(status)["tiles"]["queue_stale"], false);
    }

    #[test]
    fn a_warning_without_text_reads_as_its_kind() {
        let mut status = fixture();
        status["warnings"] = json!([{"kind": "a-new-kind", "object": null}]);
        assert_eq!(live(status)["warnings"][0]["text"], "a-new-kind");
    }

    #[test]
    fn tick_stale_is_the_service_s_word() {
        let mut status = fixture();
        status["warnings"] = json!([{"kind": "tick-stale", "text": "no successful tick for > 5 min", "object": null}]);
        let m = live(status);
        assert_eq!(m["tick"]["stale"], true);
        assert_eq!(m["servers"].as_array().unwrap().len(), 3);
        let mut status = fixture();
        status["tick"]["last_at"] = json!("2026-11-22T18:01:13Z");
        status["warnings"] = json!([]);
        assert_eq!(live(status)["tick"]["stale"], false);
    }

    #[test]
    fn queue_off_hides_the_tile() {
        let mut status = fixture();
        status["queue"] = Value::Null;
        let m = live(status);
        assert_eq!(m["tiles"]["queued"], Value::Null);
        assert!(!m["line"]["text"].as_str().unwrap().contains("queued"));
    }

    #[test]
    fn the_cost_tile_is_the_service_s_total() {
        assert_eq!(live(fixture())["tiles"]["cost"], "≈ 53 ₽");
        let mut status = fixture();
        status["cost_total_rub"] = json!(60.4);
        assert_eq!(live(status.clone())["tiles"]["cost"], "≈ 60 ₽");
        status["cost_total_rub"] = Value::Null;
        assert_eq!(live(status)["tiles"]["cost"], Value::Null);
    }

    #[test]
    fn times_count_from_the_service_s_answer_not_cockpit_s_clock() {
        let a = model(Source::Live(fixture()), Path::new(WATCHED), at("2026-11-22T19:01:05Z"));
        let b = model(Source::Live(fixture()), Path::new(WATCHED), at("2026-11-23T09:00:00Z"));
        assert_eq!(a, b);
        let mut status = fixture();
        status["generated_at"] = Value::Null;
        assert_eq!(model(Source::Live(status), Path::new(WATCHED), at("2026-11-22T19:05:13Z"))["tick"]["ago"], "4m");
    }

    #[test]
    fn a_different_state_dir_warns() {
        let m = model(Source::Live(fixture()), Path::new("/elsewhere"), now());
        let kinds: Vec<&str> = m["warnings"].as_array().unwrap().iter().map(|w| w["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["reap-overdue", "state-dir"]);
        assert_eq!(m["badge"]["count"], 2);
    }
}
