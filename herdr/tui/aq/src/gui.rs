//! The aq views the hub serves: `aq`, the queue as the space and Home draw it, and `aq-log`, one item's output or result;
//! with the actions aq offers on an item (cancel, extend, release). The dashboard comes from the snapshot aq's daemon
//! rewrites in its runtime folder, else from `aq dashboard --json`.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::mpsc::channel;
use std::time::Duration;

use chrono::Utc;
use cockpit_core::files;
use serde_json::{Value, json};

use crate::model::{self, Source};

/// The folder aq keeps `dashboard.json` in: `AQ_RUNTIME_DIR`, else `$XDG_RUNTIME_DIR/agent-queue`, else the user's
/// `/run/user/<uid>/agent-queue`.
pub fn runtime_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("AQ_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()).map(PathBuf::from);
    // SAFETY: getuid has no preconditions and cannot fail.
    base.unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() }))).join("agent-queue")
}

/// The view rebuilds whenever aq rewrites its snapshot.
pub fn dirs() -> Vec<PathBuf> {
    vec![runtime_dir()]
}

/// The aq binary: `AQ_BIN`, else `aq` on the PATH, else `~/.local/bin/aq` (a hub started outside a login shell may lack
/// it on its PATH).
fn aq_bin() -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |p: &PathBuf| p.is_file() && p.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
    if let Some(bin) = std::env::var_os("AQ_BIN").filter(|b| !b.is_empty()) {
        return Some(PathBuf::from(bin)).filter(runnable);
    }
    let on_path = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join("aq")).find(runnable));
    on_path.or_else(|| Some(files::home().join(".local/bin/aq")).filter(runnable))
}

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Runs aq with these arguments to its end, `timeout` at most; a failure to start or a timeout reads as code 1.
fn aq(bin: &PathBuf, args: &[&str], timeout: Duration) -> Out {
    let child = Command::new(bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    let child = match child {
        Ok(child) => child,
        Err(e) => return Out { code: 1, stdout: String::new(), stderr: e.to_string() },
    };
    let pid = child.id();
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Out {
            code: out.status.code().unwrap_or(1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Ok(Err(e)) => Out { code: 1, stdout: String::new(), stderr: e.to_string() },
        Err(_) => {
            // SAFETY: kill only signals the child this function started and still owns.
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            Out { code: 1, stdout: String::new(), stderr: format!("aq {} did not answer within {}s", args.join(" "), timeout.as_secs()) }
        }
    }
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches("aq: ").to_string()
}

/// The dashboard as aq gives it now, or why there is none.
fn source() -> Source {
    let bin = aq_bin();
    if let Some(snap) = files::load(&runtime_dir().join("dashboard.json")) {
        return Source::Live(snap);
    }
    let Some(bin) = bin else { return Source::Absent };
    let out = aq(&bin, &["dashboard", "--json"], Duration::from_secs(5));
    match out.code {
        0 => serde_json::from_str(&out.stdout).map(Source::Live).unwrap_or_else(|e| Source::Down(format!("aq dashboard printed no JSON: {e}"))),
        69 => Source::Down("the aq daemon is not running".into()),
        _ => Source::Down(Some(first_line(&out.stderr)).filter(|l| !l.is_empty()).unwrap_or_else(|| format!("aq dashboard exited {}", out.code))),
    }
}

pub fn view(_args: &Value, _doc: &dyn Fn(&str) -> Value) -> Value {
    model::model(source(), Utc::now())
}

/// An item id as aq prints it: hex digits and dashes, so it can never read as a flag.
fn item_id(args: &[Value]) -> Result<&str, String> {
    let id = args.first().and_then(Value::as_str).unwrap_or("");
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || id.starts_with('-') {
        return Err(format!("not an aq item id: {id:?}"));
    }
    Ok(id)
}

/// `cancel [id]`, `extend [id, ttl]` (30m by default) and `release [id]`, run as the aq commands of the same name.
pub fn act(action: &str, args: &[Value]) -> Option<Result<String, String>> {
    if !["cancel", "extend", "release"].contains(&action) {
        return None;
    }
    Some(run_act(action, args))
}

fn run_act(action: &str, args: &[Value]) -> Result<String, String> {
    let id = item_id(args)?;
    let bin = aq_bin().ok_or("aq is not installed on this machine")?;
    let ttl = args.get(1).and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("30m");
    if !ttl.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("not a duration: {ttl:?}"));
    }
    let argv: Vec<&str> = match action {
        "cancel" => vec!["cancel", "--reason", "cancelled from cockpit", id],
        "extend" => vec!["extend", "--ttl", ttl, id],
        _ => vec!["release", id],
    };
    let out = aq(&bin, &argv, Duration::from_secs(15));
    let short: String = id.chars().take(8).collect();
    if out.code == 0 {
        let done = match action {
            "cancel" => format!("Cancelled {short}"),
            "extend" => format!("Extended {short} by {ttl}"),
            _ => format!("Released {short}"),
        };
        Ok(done)
    } else {
        let why = first_line(&out.stderr);
        Err(if why.is_empty() { format!("aq {action} exited {}", out.code) } else { why })
    }
}

/// `aq-log {id, stream, tail}`: an item's stdout or stderr (its last `tail` lines, 200 by default) or, with stream
/// `result`, how it ended, as `{id, stream, text, error}`.
pub fn log_view(args: &Value, _doc: &dyn Fn(&str) -> Value) -> Value {
    let stream = args["stream"].as_str().filter(|s| ["stdout", "stderr", "result"].contains(s)).unwrap_or("stdout");
    let id = match item_id(std::slice::from_ref(&args["id"])) {
        Ok(id) => id,
        Err(e) => return json!({"id": args["id"], "stream": stream, "text": "", "error": e}),
    };
    let Some(bin) = aq_bin() else {
        return json!({"id": id, "stream": stream, "text": "", "error": "aq is not installed on this machine"});
    };
    let tail = args["tail"].as_u64().unwrap_or(200).min(5000).to_string();
    let argv: Vec<&str> = if stream == "result" { vec!["result", id] } else { vec!["logs", "--stream", stream, "--tail", &tail, id] };
    let out = aq(&bin, &argv, Duration::from_secs(10));
    let error = (out.code != 0).then(|| Some(first_line(&out.stderr)).filter(|l| !l.is_empty()).unwrap_or_else(|| format!("aq exited {}", out.code)));
    json!({"id": id, "stream": stream, "text": out.stdout, "error": error})
}

/// Rebuilds both views every 20 seconds while something shows them, so a snapshot left behind by a daemon that died
/// reads as down and a running item's log keeps up.
pub fn start(touch: fn()) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(20));
            touch();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_that_could_read_as_flags_are_refused() {
        assert!(item_id(&[json!("--all")]).is_err());
        assert!(item_id(&[json!("")]).is_err());
        assert!(item_id(&[json!("9c4a7e21-3b5d")]).is_ok());
    }

    #[test]
    fn unknown_actions_are_not_aq_actions() {
        assert!(act("merge", &[]).is_none());
        assert!(act("extend", &[json!("9c4a7e21"), json!("1h; rm")]).is_some_and(|r| r.is_err()));
    }
}
