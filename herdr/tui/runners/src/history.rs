//! History tiles, chart rows and notes from the service's offline stats.

use chrono::{NaiveDate, TimeZone};
use serde_json::{Value, json};

use crate::model::{rubles, time};

const WINDOWS: [&str; 2] = ["24h", "7d"];
const STARTED: [&str; 4] = ["auto", "manual", "builder", "unknown"];
const DAY_SERIES: [(&str, &str); 7] = [
    ("busy", "Busy"),
    ("idle", "Idle"),
    ("booting", "Booting"),
    ("stopped", "Stopped"),
    ("expired", "Expired"),
    ("builder", "Builder"),
    ("unknown", "Unknown"),
];

fn words(parts: Vec<String>) -> Option<String> {
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn positive(value: &Value) -> Option<u64> {
    value.as_u64().filter(|&n| n > 0)
}

fn note(text: impl Into<String>, warn: bool) -> Value {
    json!({"text": text.into(), "tone": warn.then_some("warning")})
}

fn tile(id: &str, label: &str, value: Value, hint: Option<String>, warn: bool) -> Value {
    let value = if value.is_null() { json!("—") } else { value };
    json!({"id": id, "label": label, "value": value, "hint": hint, "tone": warn.then_some("warning")})
}

fn launched(servers: &Value) -> Value {
    let started = &servers["started"];
    // The service's breakdown omits categories without events.
    let counts = STARTED.map(|kind| started.get(kind).map_or(Some(0), Value::as_u64));
    let total = started.as_object().and_then(|_| counts.iter().try_fold(0_u64, |sum, &n| sum.checked_add(n?)));
    let mut parts = Vec::new();
    if started.is_object() {
        for (i, (kind, count)) in STARTED.into_iter().zip(counts).enumerate() {
            if let Some(n) = count.filter(|&n| i < 2 || n != 0) {
                parts.push(format!("{n} {kind}"));
            }
        }
    }
    if let Some(n) = positive(&servers["pending"]) {
        parts.push(format!("{n} still running"));
    }
    tile("launched", "Launched", json!(total), words(parts), false)
}

fn wasted(servers: &Value) -> Value {
    let idle = servers["online_no_jobs"].as_u64();
    let never = servers["never_online"].as_u64();
    let total = idle.zip(never).and_then(|(a, b)| a.checked_add(b));
    let mut parts = Vec::new();
    if let Some(n) = idle {
        parts.push(format!("{n} idle without a job"));
    }
    if let Some(n) = never {
        parts.push(format!("{n} never online"));
    }
    if let Some(n) = positive(&servers["unclear"]) {
        parts.push(format!("{n} unclear"));
    }
    tile("wasted", "Wasted", json!(total), words(parts), total.is_some_and(|n| n > 0))
}

fn estimate(value: &Value, priced: bool) -> Option<String> {
    priced.then(|| value.as_f64().map(rubles)).flatten()
}

fn spent(cost: &Value, priced: bool) -> Value {
    let value = estimate(&cost["estimate_rub"], priced);
    let hint = if value.is_none() {
        Some("no price in config".into())
    } else {
        let mut parts = Vec::new();
        if let Some(n) = cost["billed_hours"].as_f64() {
            parts.push(format!("{n} server-hours"));
        }
        if let Some(n) = cost["by_state_rub"]["idle"].as_f64() {
            parts.push(format!("{n:.0} ₽ idle"));
        }
        words(parts)
    };
    tile("spent", "Spent", json!(value), hint, false)
}

fn duration(value: &Value) -> Option<String> {
    let secs = value.as_f64()?.round() as u64;
    Some(if secs < 60 { format!("{secs}s") } else { format!("{}m{:02}s", secs / 60, secs % 60) })
}

fn online(servers: &Value) -> Value {
    let timings = &servers["time_to_online_s"];
    let value = duration(&timings["p50"]);
    let hint = value.as_ref().and_then(|_| duration(&timings["max"])).map(|max| format!("worst {max}"));
    tile("online", "To online", json!(value), hint, false)
}

fn autoscale(a: &Value) -> Value {
    let mut parts = Vec::new();
    if let (Some(met), Some(passes)) = (a["threshold_met"].as_u64(), a["passes_with_demand"].as_u64()) {
        parts.push(format!("threshold met {met} of {passes} passes with demand"));
    }
    let blocked = a["blocked_minutes"].as_object();
    for (kind, minutes) in blocked.into_iter().flatten() {
        if let Some(n) = minutes.as_f64().filter(|&n| n > 0.0) {
            parts.push(format!("blocked {kind} {n}m"));
        }
    }
    let errors = &a["errors"];
    let error_parts: Vec<_> = [("passes", "passes"), ("episodes", "episodes")]
        .into_iter()
        .filter_map(|(key, label)| positive(&errors[key]).map(|n| format!("{n} {label}")))
        .collect();
    let warn = blocked.is_some_and(|b| !b.is_empty()) || !error_parts.is_empty();
    if let Some(errors) = words(error_parts) {
        parts.push(format!("errors {errors}"));
    }
    for (key, label) in [("paused_minutes", "paused"), ("disabled_minutes", "off")] {
        if let Some(n) = a[key].as_f64().filter(|&n| n > 0.0) {
            parts.push(format!("{label} {n}m"));
        }
    }
    tile("autoscale", "Autoscale", json!(a["created"].as_u64()), words(parts), warn)
}

fn partial(coverage: &Value) -> Option<String> {
    coverage.as_f64().filter(|&c| c < 1.0).map(|c| format!("{:.0}%", c * 100.0))
}

fn window(w: &Value, priced: bool) -> Value {
    let servers = &w["servers"];
    let cost = &w["cost"];
    let tiles = [
        launched(servers),
        tile("took", "Took jobs", json!(servers["with_jobs"].as_u64()), None, false),
        wasted(servers),
        spent(cost, priced),
        online(servers),
        autoscale(&w["autoscale"]),
    ];
    let mut notes = Vec::new();
    if let Some(coverage) = partial(&w["coverage"]) {
        notes.push(note(format!("data covers {coverage} of the period"), false));
    }
    if w["approx"] == true {
        notes.push(note("partly estimated from snapshots", false));
    }
    if cost["bounded"] == true {
        notes.push(note("some server lifetimes are bounded", false));
    }
    json!({"tiles": tiles, "notes": notes})
}

fn series(key: &str, name: &str, values: Vec<Option<f64>>, line: bool) -> Value {
    json!({"key": key, "name": name, "values": values, "line": line})
}

fn chart(labels: Vec<String>, notes: Vec<Option<String>>, series: Vec<Value>) -> Value {
    json!({"kind": "bar", "stacked": true, "labels": labels, "notes": notes, "series": series})
}

fn rows(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

fn covered(row: &Value) -> bool {
    row["coverage"].as_f64().is_some_and(|c| c > 0.0)
}

fn has_activity(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields.values().any(has_activity),
        _ => value.as_f64().is_some_and(|n| n > 0.0),
    }
}

fn window_has_data(window: &Value) -> bool {
    covered(window) || ["servers", "hours", "autoscale", "cost"].into_iter().any(|key| has_activity(&window[key]))
}

fn hour_note(row: &Value) -> Option<String> {
    if !covered(row) {
        return Some("no data".into());
    }
    let mut parts: Vec<_> = partial(&row["coverage"]).map(|c| format!("covered {c}")).into_iter().collect();
    let created = ["auto", "manual"].into_iter().filter_map(|kind| positive(&row[format!("created_{kind}")]).map(|n| format!("{n} {kind}"))).collect();
    if let Some(created) = words(created) {
        parts.push(format!("created {created}"));
    }
    words(parts)
}

fn hours<Tz: TimeZone>(rows: &[Value], tz: &Tz) -> Value
where
    Tz::Offset: std::fmt::Display,
{
    let labels = rows.iter().map(|r| time(&r["start"]).map_or_else(|| "—".into(), |t| t.with_timezone(tz).format("%H:%M").to_string())).collect();
    let notes = rows.iter().map(hour_note).collect();
    let series =
        [("busy", "Busy", "cloud_busy"), ("idle", "Idle", "cloud_idle"), ("booting", "Booting", "cloud_booting"), ("waiting", "Waiting jobs", "waiting_max")]
            .into_iter()
            .map(|(key, name, field)| {
                let values = rows.iter().map(|r| r[field].as_f64().filter(|_| covered(r))).collect();
                series(key, name, values, key == "waiting")
            })
            .collect();
    chart(labels, notes, series)
}

fn day_covered(row: &Value) -> bool {
    covered(row) && row["hours"].is_object()
}

fn day_note(row: &Value, priced: bool) -> Option<String> {
    if !day_covered(row) {
        return Some("no data".into());
    }
    let mut parts: Vec<_> = estimate(&row["estimate_rub"], priced).into_iter().collect();
    if let Some(coverage) = partial(&row["coverage"]) {
        parts.push(format!("covered {coverage}"));
    }
    words(parts)
}

fn days(rows: &[Value], today: Option<NaiveDate>, priced: bool) -> Value {
    let labels = rows
        .iter()
        .map(|r| {
            let date = r["date"].as_str().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
            match date {
                Some(d) if Some(d) == today => "today".into(),
                Some(d) => d.format("%a %d").to_string(),
                None => "—".into(),
            }
        })
        .collect();
    let notes = rows.iter().map(|row| day_note(row, priced)).collect();
    let mut all_series = Vec::new();
    for (i, (key, name)) in DAY_SERIES.into_iter().enumerate() {
        let values: Vec<_> = rows.iter().map(|r| r["hours"][key].as_f64().filter(|_| day_covered(r))).collect();
        if i < 3 || values.iter().flatten().any(|&n| n != 0.0) {
            all_series.push(series(key, name, values, false));
        }
    }
    chart(labels, notes, all_series)
}

/// The two history windows, chart models and service notes.
pub fn history<Tz: TimeZone>(stats: Result<&Value, &str>, tz: &Tz) -> Value
where
    Tz::Offset: std::fmt::Display,
{
    let stats = match stats {
        Ok(stats) => stats,
        Err(error) => return json!({"error": error}),
    };
    if !stats.is_object()
        || ["series", "days", "warnings"].into_iter().any(|key| !stats[key].is_null() && !stats[key].is_array())
        || (!stats["windows"].is_null() && !stats["windows"].is_object())
        || WINDOWS.into_iter().any(|key| !stats["windows"][key].is_null() && !stats["windows"][key].is_object())
    {
        return json!({"error": "ci-runners stats is not understood"});
    }

    let warnings = rows(&stats["warnings"]);
    let mut notes: Vec<_> = warnings
        .iter()
        .filter_map(|w| {
            let text = w["text"].as_str().filter(|t| !t.is_empty()).or_else(|| w["kind"].as_str()).or_else(|| w.as_str())?;
            Some(note(text, true))
        })
        .collect();
    let raw_windows = &stats["windows"];
    let has_windows = WINDOWS.into_iter().any(|key| raw_windows[key].is_object());
    let has_rows = ["series", "days"].into_iter().any(|key| rows(&stats[key]).iter().any(covered));
    let has_data = has_rows || WINDOWS.into_iter().any(|key| window_has_data(&raw_windows[key]));
    if !has_windows || !has_data || warnings.iter().any(|w| w["kind"] == "no-journal" || w == "no-journal") {
        return json!({"empty": true, "notes": notes});
    }

    let price = stats["price_per_hour_rub"].as_f64();
    let priced = price.is_some();
    notes
        .insert(0, note(price.map_or_else(|| "no price in config: rubles are not estimated".into(), |p| format!("≈ at {p} ₽ per started server-hour")), false));
    let windows: serde_json::Map<_, _> =
        WINDOWS.into_iter().filter_map(|key| raw_windows[key].as_object().map(|_| (key.into(), window(&raw_windows[key], priced)))).collect();
    let today = time(&stats["generated_at"]).map(|t| t.with_timezone(tz).date_naive());
    json!({
        "empty": false,
        "windows": windows,
        "charts": {"24h": hours(rows(&stats["series"]), tz), "7d": days(rows(&stats["days"]), today, priced)},
        "notes": notes
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;
    use serde_json::json;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/stats-live.json")).unwrap()
    }

    fn tz() -> FixedOffset {
        FixedOffset::east_opt(3 * 3600).unwrap()
    }

    #[test]
    fn windows_become_tiles() {
        let stats = fixture();
        let h = history(Ok(&stats), &tz());
        assert_eq!(
            h["windows"]["24h"]["tiles"],
            json!([
                {"id": "launched", "label": "Launched", "value": 4, "hint": "3 auto · 1 manual · 1 still running", "tone": null},
                {"id": "took", "label": "Took jobs", "value": 2, "hint": null, "tone": null},
                {"id": "wasted", "label": "Wasted", "value": 2, "hint": "2 idle without a job · 0 never online · 1 unclear", "tone": "warning"},
                {"id": "spent", "label": "Spent", "value": "≈ 56 ₽", "hint": "13 server-hours · 30 ₽ idle", "tone": null},
                {"id": "online", "label": "To online", "value": "2m50s", "hint": "worst 3m47s", "tone": null},
                {"id": "autoscale", "label": "Autoscale", "value": 3,
                 "hint": "threshold met 1 of 14 passes with demand · blocked isolation 6m · errors 2 passes · 2 episodes · paused 30m · off 15m",
                 "tone": "warning"}
            ])
        );
        assert_eq!(
            h["windows"]["24h"]["notes"],
            json!([
                {"text": "data covers 73% of the period", "tone": null},
                {"text": "partly estimated from snapshots", "tone": null},
                {"text": "some server lifetimes are bounded", "tone": null}
            ])
        );
        assert_eq!(h["notes"], json!([{"text": "≈ at 4.34 ₽ per started server-hour", "tone": null}]));
    }

    #[test]
    fn unknown_is_a_gap_not_zero() {
        let stats = fixture();
        let h = history(Ok(&stats), &tz());
        let hours = &h["charts"]["24h"];
        let days = &h["charts"]["7d"];
        for s in hours["series"].as_array().unwrap() {
            assert_eq!(s["values"][0], Value::Null);
            assert_eq!(s["values"][1].is_null(), s["key"] == "waiting");
        }
        assert_eq!(hours["series"][3]["line"], true);
        assert_eq!(hours["notes"][0], "no data");
        assert_eq!(hours["notes"][2], "covered 73% · created 2 auto · 1 manual");
        for s in days["series"].as_array().unwrap() {
            assert_eq!(s["values"][0], Value::Null);
        }
        assert_eq!(days["series"].as_array().unwrap().len(), 4);
        assert_eq!(days["series"][3]["key"], "stopped");
        assert_eq!(days["notes"][0], "no data");
        assert_eq!(days["notes"][1], "≈ 26 ₽ · covered 73%");
    }

    #[test]
    fn labels_are_local_time() {
        let stats = fixture();
        let h = history(Ok(&stats), &tz());
        assert_eq!(h["charts"]["24h"]["labels"].as_array().unwrap().len(), 24);
        assert_eq!(h["charts"]["24h"]["labels"][0], "22:00");
        assert_eq!(h["charts"]["7d"]["labels"][0], "Mon 16");
        assert_eq!(h["charts"]["7d"]["labels"][6], "today");
    }

    #[test]
    fn no_price_says_so() {
        let mut stats = fixture();
        stats["price_per_hour_rub"] = Value::Null;
        stats["windows"]["24h"]["cost"]["estimate_rub"] = Value::Null;
        stats["days"][1]["estimate_rub"] = Value::Null;
        let h = history(Ok(&stats), &tz());
        let spent = &h["windows"]["24h"]["tiles"][3];
        assert_eq!(spent["value"], "—");
        assert_eq!(spent["hint"], "no price in config");
        assert_eq!(h["charts"]["7d"]["notes"][1], "covered 73%");
        assert_eq!(h["notes"][0]["text"], "no price in config: rubles are not estimated");
    }

    #[test]
    fn no_journal_is_empty() {
        let stats = json!({"series": [], "windows": {}, "days": [], "warnings": [{"kind": "no-journal"}, {"kind": "gap", "text": "journal gap"}]});
        assert_eq!(
            history(Ok(&stats), &tz()),
            json!({
                "empty": true, "notes": [{"text": "no-journal", "tone": "warning"}, {"text": "journal gap", "tone": "warning"}]
            })
        );
    }

    #[test]
    fn windows_without_observations_are_empty() {
        let empty = json!({
            "coverage": 0, "servers": {"started": {}, "deletes": {}, "with_jobs": null},
            "hours": null, "autoscale": null, "cost": {"estimate": true, "estimate_rub": null},
            "tick": {"error_passes": 0, "gap_minutes": 0, "journal_lost": 0}
        });
        let mut stats = json!({
            "windows": {"24h": empty, "7d": empty}, "series": [{"coverage": 0}],
            "days": [{"coverage": 0, "hours": null}],
            "warnings": [{"kind": "acme-gap", "text": "journal reports a gap"}]
        });
        assert_eq!(
            history(Ok(&stats), &tz()),
            json!({
                "empty": true, "notes": [{"text": "journal reports a gap", "tone": "warning"}]
            })
        );
        stats["windows"]["7d"]["servers"]["started"]["manual"] = json!(1);
        assert_eq!(history(Ok(&stats), &tz())["empty"], false);
    }

    #[test]
    fn an_error_is_carried() {
        assert_eq!(history(Err("boom"), &tz()), json!({"error": "boom"}));
    }

    #[test]
    fn the_fixture_keeps_the_service_shape() {
        fn keys(value: &Value) -> Vec<&str> {
            let mut keys: Vec<_> = value.as_object().unwrap().keys().map(String::as_str).collect();
            keys.sort_unstable();
            keys
        }
        let stats = fixture();
        assert_eq!(
            keys(&stats),
            ["bucket", "covered_until", "days", "generated_at", "journal", "price_per_hour_rub", "series", "sources", "v", "warnings", "windows"]
        );
        assert_eq!(keys(&stats["windows"]["24h"]), ["approx", "autoscale", "cost", "coverage", "from", "hours", "servers", "tick", "to"]);
    }

    #[test]
    fn missing_measurements_stay_unknown() {
        let mut stats = fixture();
        stats["series"][2].as_object_mut().unwrap().remove("coverage");
        stats["days"][1]["hours"] = Value::Null;
        stats["windows"]["24h"]["servers"]["with_jobs"] = Value::Null;
        stats["windows"]["24h"]["servers"].as_object_mut().unwrap().remove("never_online");
        let h = history(Ok(&stats), &tz());
        assert_eq!(h["charts"]["24h"]["series"][0]["values"][2], Value::Null);
        assert_eq!(h["charts"]["7d"]["notes"][1], "no data");
        assert_eq!(h["windows"]["24h"]["tiles"][1]["value"], "—");
        assert_eq!(h["windows"]["24h"]["tiles"][2]["value"], "—");
    }

    #[test]
    fn an_unrecognized_reply_has_an_error() {
        assert!(history(Ok(&json!({"v": 1, "windows": "oops"})), &tz())["error"].is_string());
    }
}
