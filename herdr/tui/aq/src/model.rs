//! The aq view model the mod draws, built from aq's dashboard snapshot: the pool and the host, what runs, what waits and
//! why, the reservations with their nested tasks, what ended lately, and the line Home shows. Memory reads in tenths of a
//! GiB and times in minutes, so the model only moves when something you would see moves.

use chrono::{DateTime, Utc};
use serde_json::{Value, json};

/// Where the dashboard came from, or why there is none.
pub enum Source {
    /// No aq on this machine: the space and Home's line hide.
    Absent,
    /// aq is installed but its daemon does not answer, and why.
    Down(String),
    /// The dashboard, as `dashboard.json` or `aq dashboard --json` gives it.
    Live(Value),
}

/// A snapshot older than this means the daemon died without removing it.
pub const STALE_SECS: i64 = 60;
/// A queued item waiting longer than this turns Home's line yellow.
const LATE_SECS: f64 = 300.0;
/// A failure that ended within this turns Home's line red.
const FRESH_FAILURE_SECS: i64 = 3600;
const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

const ACTIVE: [&str; 4] = ["STARTING", "RUNNING", "CLEANING", "RECOVERING"];
const HELD: [&str; 4] = ["GRANTED", "EXPIRING", "TEARING_DOWN", "HELD"];

fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
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

const MIB: f64 = 1024.0 * 1024.0;

/// Bytes as GiB to one decimal ("12.3 GiB"), or below a GiB as MiB, to the ten past 100 ("4 MiB", "510 MiB").
pub fn gib(bytes: f64) -> String {
    match bytes {
        b if b >= GIB => format!("{:.1} GiB", b / GIB),
        b if b >= 100.0 * MIB => format!("{:.0} MiB", (b / MIB / 10.0).round() * 10.0),
        b => format!("{:.0} MiB", b / MIB),
    }
}

/// Used against a total: "3.1 / 8.0 GiB" when both read in GiB, each in its own unit otherwise ("4 MiB / 64 MiB").
fn gib_pair(used: f64, of: f64) -> String {
    match of {
        of if of <= 0.0 => gib(used),
        of if used >= GIB && of >= GIB => format!("{:.1} / {:.1} GiB", used / GIB, of / GIB),
        of => format!("{} / {}", gib(used), gib(of)),
    }
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

/// A share in hundredths, capped at 1.
fn ratio(part: f64, whole: f64) -> f64 {
    if whole <= 0.0 { 0.0 } else { ((part / whole).clamp(0.0, 1.0) * 100.0).round() / 100.0 }
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

/// What a queued item waits on, in words: aq's `blocked_by`.
fn blocker(by: &str) -> String {
    match by {
        "pool_memory" => "pool memory".into(),
        "pool_cpu" => "pool CPU".into(),
        "live_memory" => "free memory".into(),
        "pressure" => "memory pressure".into(),
        "tmp" => "tmp space".into(),
        "disk" => "disk space".into(),
        "recovering" => "aq recovering".into(),
        "queue" => "its turn".into(),
        other => other.replace('_', " "),
    }
}

/// How a finished item ended: (outcome, words, tone).
fn outcome(item: &Value) -> (&'static str, String, &'static str) {
    let reason = text(&item["reason"]);
    match text(&item["state"]) {
        "SUCCEEDED" => ("ok", "Succeeded".into(), "success"),
        "FAILED" if reason.starts_with("OOM") => ("oom", if reason == "OOM_HOST_GUARD" { "OOM (host guard)".into() } else { "OOM".into() }, "destructive"),
        "FAILED" if reason == "TIMEOUT" => ("timeout", "Timed out".into(), "destructive"),
        "FAILED" => match item["exit_code"].as_i64() {
            Some(code) if reason == "COMMAND_FAILED" || reason.is_empty() => ("failed", format!("Failed · exit {code}"), "destructive"),
            _ if !reason.is_empty() => ("failed", format!("Failed · {}", reason.to_lowercase().replace('_', " ")), "destructive"),
            _ => ("failed", "Failed".into(), "destructive"),
        },
        "CANCELLED" => ("cancelled", "Cancelled".into(), "muted"),
        "REJECTED" => ("rejected", "Rejected".into(), "warning"),
        "RELEASED" | "TORN_DOWN" => ("released", "Released".into(), "muted"),
        other => ("other", other.to_lowercase().replace('_', " "), "muted"),
    }
}

fn is_failure(item: &Value) -> bool {
    matches!(outcome(item).0, "failed" | "oom" | "timeout")
}

/// What every row carries: who queued it, where, and the item's own words.
fn base(item: &Value) -> Value {
    let id = text(&item["id"]);
    json!({
        "id": id,
        "short": id.chars().take(8).collect::<String>(),
        "name": item["name"].as_str().filter(|n| !n.is_empty()).unwrap_or("unnamed"),
        "kind": text(&item["kind"]),
        "state": text(&item["state"]),
        "project": basename(text(&item["project"])),
        "path": text(&item["project"]),
        "agent": text(&item["client_type"]),
        "session": text(&item["session_id"]),
        "within": item["within"].as_str(),
        "cpus": num(&item["cpus"]),
    })
}

/// A task as its row draws it, by phase: running with its memory now against its limit, queued with its place and
/// why it waits, or finished with how it ended.
fn task(item: &Value, now: DateTime<Utc>) -> Value {
    let mut row = base(item);
    let state = text(&item["state"]);
    let limit = num(&item["memory_limit"]);
    let r = row.as_object_mut().expect("an object");
    if ACTIVE.contains(&state) {
        let current = item.get("memory_current").map_or(num(&item["memory_expected"]), num);
        r.insert("phase".into(), json!("running"));
        r.insert("mem".into(), json!({"text": gib_pair(current, limit), "ratio": ratio(current, limit), "high": limit > 0.0 && current / limit >= 0.85}));
        r.insert("time".into(), json!(since(&item["started_at"], now).map(span)));
        r.insert("timeout".into(), json!(item["timeout_seconds"].as_f64().map(span)));
        r.insert("acts".into(), json!(["logs", "cancel"]));
    } else if state == "QUEUED" {
        let waited = since(&item["created_at"], now).unwrap_or(0.0);
        let blocked = match (text(&item["blocked_by"]), text(&item["blocked_detail"])) {
            ("", _) => String::new(),
            (by, "") => blocker(by),
            (by, detail) => format!("{}: {detail}", blocker(by)),
        };
        let expected = time(&item["expected_start"]).map(|t| {
            let secs = (t - now).num_seconds();
            if secs < 60 { "any moment".to_string() } else { format!("in {}", span(secs as f64)) }
        });
        r.insert("phase".into(), json!("queued"));
        r.insert("position".into(), item["position"].clone());
        r.insert("blocked".into(), json!(blocked));
        r.insert("expected".into(), json!(expected));
        r.insert("waited".into(), json!(span(waited)));
        r.insert("late".into(), json!(waited > LATE_SECS));
        let need = Some(num(&item["memory_expected"])).filter(|e| *e > 0.0).unwrap_or(limit);
        r.insert("mem".into(), json!({"text": format!("needs {}", gib(need)), "ratio": 0.0, "high": false}));
        r.insert("acts".into(), json!(["cancel"]));
    } else {
        let (word, words, tone) = outcome(item);
        let peak = num(&item["memory_peak"]);
        r.insert("phase".into(), json!("done"));
        r.insert("outcome".into(), json!(word));
        r.insert("words".into(), json!(words));
        r.insert("tone".into(), json!(tone));
        r.insert("exit_code".into(), item["exit_code"].clone());
        r.insert("diagnostic".into(), json!(text(&item["diagnostic"])));
        r.insert("took".into(), json!(item["run_seconds"].as_f64().map(span)));
        r.insert("ended".into(), json!(since(&item["ended_at"], now).map(|s| format!("{} ago", span(s)))));
        r.insert("peak".into(), json!(if peak > 0.0 { Some(gib_pair(peak, limit)) } else { None }));
        r.insert("acts".into(), json!(if text(&item["kind"]) == "task" { vec!["logs", "result"] } else { vec!["result"] }));
    }
    row
}

/// A reservation as its row draws it: its time left, the budget its tasks share, the stand's memory and those tasks.
fn reservation(item: &Value, nested: Vec<Value>, now: DateTime<Utc>) -> Value {
    let mut row = base(item);
    let left = time(&item["expires_at"]).map(|t| (t - now).num_seconds() as f64);
    let limit = num(&item["memory_limit"]);
    let current = item.get("memory_current").map_or(0.0, num);
    let budget = match (num(&item["task_memory"]), num(&item["task_cpus"])) {
        (m, _) if m <= 0.0 => String::new(),
        (m, c) if c > 0.0 => format!("tasks {} · {c} CPU", gib(m)),
        (m, _) => format!("tasks {}", gib(m)),
    };
    let r = row.as_object_mut().expect("an object");
    r.insert("phase".into(), json!("held"));
    r.insert("ttl".into(), json!(left.map(|s| if s <= 0.0 { "expired".to_string() } else { format!("{} left", span(s)) })));
    r.insert("expiring".into(), json!(text(&item["state"]) == "EXPIRING" || left.is_some_and(|s| s < 300.0)));
    r.insert("budget".into(), json!(budget));
    r.insert("mem".into(), json!({"text": gib_pair(current, limit), "ratio": ratio(current, limit), "high": limit > 0.0 && current / limit >= 0.85}));
    r.insert("docker".into(), json!(text(&item["docker_project"])));
    r.insert("time".into(), json!(since(&item["started_at"], now).map(span)));
    r.insert("tasks".into(), json!(nested));
    r.insert("acts".into(), json!(["extend", "release"]));
    row
}

/// The sidebar's bubble, only when the space wants a look: the tasks that failed in the last hour in red, else the items
/// waiting over five minutes in yellow, else a yellow "!" while aq holds the queue back; null when all is well.
fn badge(failed: usize, late: usize, held_back: bool) -> Value {
    match (failed, late, held_back) {
        (f, _, _) if f > 0 => json!({"count": f, "tone": "destructive"}),
        (_, l, _) if l > 0 => json!({"count": l, "tone": "warning"}),
        (_, _, true) => json!({"count": "!", "tone": "warning"}),
        _ => Value::Null,
    }
}

/// The model for whatever the source gave: `{state: "absent"}`, `{state: "down", error}`, or the whole dashboard.
pub fn model(source: Source, now: DateTime<Utc>) -> Value {
    let snap = match source {
        Source::Absent => return json!({"state": "absent", "line": null, "badge": null}),
        Source::Down(why) => {
            return json!({"state": "down", "error": why, "line": {"text": "aq is down", "tone": "warning"}, "badge": null});
        }
        Source::Live(snap) => snap,
    };
    if let Some(age) = since(&snap["at"], now).filter(|a| *a > STALE_SECS as f64) {
        let why = format!("the aq daemon stopped updating its dashboard {} ago", span(age));
        return json!({"state": "down", "error": why, "line": {"text": "aq is down", "tone": "warning"}, "badge": null});
    }
    let items = snap["items"].as_array().cloned().unwrap_or_default();
    let in_res = |res: &str| -> Vec<Value> { items.iter().filter(|i| text(&i["within"]) == res).map(|i| task(i, now)).collect() };
    let top = |i: &&Value| i["within"].as_str().is_none_or(str::is_empty);
    let running: Vec<Value> =
        items.iter().filter(top).filter(|i| text(&i["kind"]) != "reservation" && ACTIVE.contains(&text(&i["state"]))).map(|i| task(i, now)).collect();
    let mut queued: Vec<Value> = items.iter().filter(|i| text(&i["state"]) == "QUEUED").map(|i| task(i, now)).collect();
    queued.sort_by_key(|q| q["position"].as_i64().unwrap_or(i64::MAX));
    let reservations: Vec<Value> = items
        .iter()
        .filter(|i| text(&i["kind"]) == "reservation" && HELD.contains(&text(&i["state"])))
        .map(|i| reservation(i, in_res(text(&i["id"])), now))
        .collect();
    let recent_items = snap["recent"].as_array().cloned().unwrap_or_default();
    let recent: Vec<Value> = recent_items.iter().map(|i| task(i, now)).collect();

    let host = &snap["host"];
    let pool = &snap["pool"];
    let (total, available) = (num(&host["mem_total"]), num(&host["mem_available"]));
    let (committed, pool_mem) = (num(&pool["memory"]), num(&pool["pool_memory"]));
    let (cpus, pool_cpus) = (num(&pool["cpus"]), num(&pool["pool_cpus"]));
    let pressure = host["pressure_closed"].as_bool().unwrap_or(false);
    let guard = host["guard_active"].as_bool().unwrap_or(false);

    let active = items.iter().filter(|i| text(&i["kind"]) != "reservation" && ACTIVE.contains(&text(&i["state"]))).count();
    let late = queued.iter().filter(|q| q["late"] == true).count();
    let failed = recent_items.iter().filter(|i| is_failure(i) && since(&i["ended_at"], now).is_some_and(|s| s <= FRESH_FAILURE_SECS as f64)).count();
    let day = &snap["day"];
    let finished = day["finished"].as_u64().unwrap_or(0);
    let succeeded = day["succeeded"].as_u64().unwrap_or(0);
    let memory = format!("{:.0}/{:.0} GiB", committed / GIB, pool_mem / GIB);
    let line_text = if active == 0 && queued.is_empty() && reservations.is_empty() {
        format!("idle · {finished} today")
    } else {
        let mut parts = vec![format!("{active} running")];
        if !queued.is_empty() {
            parts.push(format!("{} queued", queued.len()));
        }
        if !reservations.is_empty() {
            parts.push(format!("{} held", reservations.len()));
        }
        parts.push(memory);
        parts.join(" · ")
    };
    let tone = if failed > 0 {
        Some("destructive")
    } else if pressure || guard || late > 0 {
        Some("warning")
    } else {
        None
    };
    let queue = &snap["queue"];
    let head = match (text(&queue["blocked_by"]), text(&queue["blocked_detail"])) {
        ("", _) => String::new(),
        (by, "") => format!("the queue waits on {}", blocker(by)),
        (by, detail) => format!("the queue waits on {}: {detail}", blocker(by)),
    };
    json!({
        "state": "live",
        "daemon": text(&snap["daemon"]["version"]),
        "line": {"text": line_text, "tone": tone},
        "badge": badge(failed, late, pressure || guard),
        "host": {
            "text": gib_pair(total - available, total),
            "ratio": ratio(total - available, total),
            "pressure_closed": pressure,
            "guard_active": guard,
        },
        "pool": {
            "text": gib_pair(committed, pool_mem),
            "ratio": ratio(committed, pool_mem),
            "cpus_text": format!("{cpus} / {pool_cpus} CPU"),
            "cpus_ratio": ratio(cpus, pool_cpus),
        },
        "head": head,
        "counts": {"running": active, "queued": queued.len(), "reservations": reservations.len(), "recent": recent.len()},
        "running": running,
        "queued": queued,
        "reservations": reservations,
        "recent": recent,
        "day": {
            "text": if finished > 0 { format!("{succeeded}/{finished} ok") } else { "nothing yet".into() },
            "finished": finished,
            "succeeded": succeeded,
            "failed": day["failed"].as_u64().unwrap_or(0),
            "cancelled": day["cancelled"].as_u64().unwrap_or(0),
            "oom": day["oom"].as_u64().unwrap_or(0),
            "timeout": day["timeout"].as_u64().unwrap_or(0),
            "wait_median": day["wait_median_seconds"].as_f64().map(|s| if s < 60.0 { format!("{s:.0}s") } else { span(s) }),
            "wait_max": day["wait_max_seconds"].as_f64().map(|s| if s < 60.0 { format!("{s:.0}s") } else { span(s) }),
            "run_total": day["run_seconds"].as_f64().map(span),
            "reservations": day["reservations"].as_u64().unwrap_or(0),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-11T09:30:00Z").unwrap().with_timezone(&Utc)
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/dashboard.json")).unwrap()
    }

    #[test]
    fn memory_reads_in_gib_or_below_it_in_mib() {
        assert_eq!([gib(4.0 * MIB), gib(512.0 * MIB), gib(3.4 * GIB)], ["4 MiB", "510 MiB", "3.4 GiB"]);
        assert_eq!(
            [gib_pair(4.0 * MIB, 64.0 * MIB), gib_pair(1.2 * GIB, 4.0 * GIB), gib_pair(300.0 * MIB, 4.0 * GIB)],
            ["4 MiB / 64 MiB", "1.2 / 4.0 GiB", "300 MiB / 4.0 GiB"]
        );
    }

    #[test]
    fn spans_read_to_the_minute() {
        assert_eq!([span(5.0), span(61.0), span(3_900.0), span(200_000.0)], ["<1m", "1m", "1h 05m", "2d 7h"]);
    }

    #[test]
    fn absent_and_down_hide_or_warn() {
        assert_eq!(model(Source::Absent, now())["line"], Value::Null);
        let down = model(Source::Down("not running".into()), now());
        assert_eq!((down["state"].as_str(), down["line"]["tone"].as_str()), (Some("down"), Some("warning")));
    }

    #[test]
    fn a_stale_snapshot_reads_as_down() {
        let mut snap = fixture();
        snap["at"] = json!("2026-11-11T09:25:00Z");
        let m = model(Source::Live(snap), now());
        assert_eq!(m["state"], "down");
        assert!(m["error"].as_str().unwrap().contains("5m ago"));
    }

    #[test]
    fn the_dashboard_splits_into_running_queued_held_and_recent() {
        insta::assert_snapshot!(serde_json::to_string_pretty(&model(Source::Live(fixture()), now())).unwrap());
    }

    #[test]
    fn a_recent_failure_turns_the_line_red_and_an_old_one_does_not() {
        let mut snap = fixture();
        assert_eq!(model(Source::Live(snap.clone()), now())["line"]["tone"], "destructive");
        for item in snap["recent"].as_array_mut().unwrap() {
            item["ended_at"] = json!("2026-11-11T07:00:00Z");
        }
        assert_eq!(model(Source::Live(snap), now())["line"]["tone"], "warning");
    }

    #[test]
    fn the_badge_counts_what_wants_a_look_not_what_runs() {
        assert_eq!(badge(2, 1, true), json!({"count": 2, "tone": "destructive"}));
        assert_eq!(badge(0, 1, true), json!({"count": 1, "tone": "warning"}));
        assert_eq!(badge(0, 0, true), json!({"count": "!", "tone": "warning"}));
        assert_eq!(badge(0, 0, false), Value::Null);
        let mut snap = fixture();
        snap["recent"] = json!([]);
        snap["items"].as_array_mut().unwrap().retain(|i| i["state"] != "QUEUED");
        let m = model(Source::Live(snap), now());
        assert_eq!((m["badge"].clone(), m["line"]["text"].as_str()), (Value::Null, Some("3 running · 1 held · 17/27 GiB")));
    }

    #[test]
    fn an_empty_queue_reads_idle_with_the_day() {
        let mut snap = fixture();
        snap["items"] = json!([]);
        snap["recent"] = json!([]);
        let m = model(Source::Live(snap), now());
        assert_eq!((m["line"]["text"].as_str(), &m["badge"]), (Some("idle · 31 today"), &Value::Null));
    }
}
