//! The Runners view the hub serves, read from `ci-runners status --json --offline`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use chrono::Utc;
use cockpit_core::{files, run};
use serde_json::Value;

use crate::model::{self, Source};

const LIMIT: Duration = Duration::from_secs(5);
const CAP: usize = 1 << 20;

/// The folder ci-runners keeps its state in, where its tick writes.
pub fn state_dir() -> PathBuf {
    files::home().join(".local/state/ci-runners")
}

/// The folders the view rebuilds on: ci-runners' state folder, only on a machine that has ci-runners, because the hub
/// creates what it watches.
pub fn dirs() -> Vec<PathBuf> {
    dirs_for(bin())
}

fn dirs_for(bin: Option<PathBuf>) -> Vec<PathBuf> {
    if bin.is_some() { vec![state_dir()] } else { Vec::new() }
}

/// The ci-runners binary: `CI_RUNNERS_BIN`, else `ci-runners` on the PATH, else `~/.local/bin/ci-runners` (a hub started
/// outside a login shell may lack it on its PATH).
fn bin() -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let runnable = |p: &PathBuf| p.is_file() && p.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
    if let Some(bin) = std::env::var_os("CI_RUNNERS_BIN").filter(|b| !b.is_empty()) {
        return Some(PathBuf::from(bin)).filter(runnable);
    }
    let on_path = std::env::var_os("PATH").and_then(|path| std::env::split_paths(&path).map(|d| d.join("ci-runners")).find(runnable));
    on_path.or_else(|| Some(files::home().join(".local/bin/ci-runners")).filter(runnable))
}

/// Runs the binary with these arguments; a timeout or a failure to start is an error naming `what`.
fn call(bin: &Path, args: &[&str], what: &str) -> Result<std::process::Output, String> {
    run::output(Command::new(bin).args(args), LIMIT, CAP, &Default::default()).map_err(|e| match e.as_str() {
        "it took too long" => format!("{what} did not answer within {}s", LIMIT.as_secs()),
        _ => format!("{what} could not run: {e}"),
    })
}

/// The features this ci-runners declares in `version --json`, read again only when the binary changes; an old one that
/// has no such command or prints no JSON declares none.
fn features(bin: &Path) -> Result<Vec<String>, String> {
    type Known = Mutex<HashMap<(PathBuf, SystemTime), Vec<String>>>;
    static CACHE: OnceLock<Known> = OnceLock::new();
    let key = bin.metadata().and_then(|m| m.modified()).ok().map(|at| (bin.to_path_buf(), at));
    let cache = CACHE.get_or_init(Default::default);
    if let Some(known) = key.as_ref().and_then(|k| cache.lock().ok()?.get(k).cloned()) {
        return Ok(known);
    }
    let out = call(bin, &["version", "--json"], "ci-runners version")?;
    let found: Vec<String> = Some(out)
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok())
        .map(|v| v["features"].as_array().into_iter().flatten().filter_map(|f| f.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if let (Some(key), Ok(mut held)) = (key, cache.lock()) {
        held.insert(key, found.clone());
    }
    Ok(found)
}

fn first_line(text: &str) -> String {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string()
}

/// The status as ci-runners gives it now, or why there is none; an old ci-runners is never asked for it.
fn source(bin: Option<PathBuf>) -> Source {
    let Some(bin) = bin else { return Source::Absent };
    match features(&bin) {
        Err(e) => return Source::Down(e),
        Ok(features) if !features.iter().any(|f| f == "status-offline") => {
            return Source::Outdated("ci-runners on this machine has no status --json --offline; update it".into());
        }
        Ok(_) => {}
    }
    let out = match call(&bin, &["status", "--json", "--offline"], "ci-runners status") {
        Ok(out) => out,
        Err(e) => return Source::Down(e),
    };
    if !out.status.success() {
        let why = first_line(&String::from_utf8_lossy(&out.stderr));
        return Source::Down(if why.is_empty() { format!("ci-runners status exited {}", out.status.code().unwrap_or(1)) } else { why });
    }
    serde_json::from_slice(&out.stdout).map(Source::Live).unwrap_or_else(|e| Source::Down(format!("ci-runners status printed no JSON: {e}")))
}

pub fn view(_args: &Value, _doc: &dyn Fn(&str) -> Value) -> Value {
    model::model(source(bin()), &state_dir(), Utc::now())
}

/// Rebuilds the view every 20 seconds while something shows it, so a stalled tick reads as stale.
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
    use crate::model::{Source, model};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant, SystemTime};

    #[test]
    fn no_ci_runners_watches_nothing() {
        assert!(dirs_for(None).is_empty());
        assert_eq!(dirs_for(Some(PathBuf::from("/x/ci-runners"))), vec![state_dir()]);
    }

    const VERSION: &str = include_str!("../tests/fixtures/version.json");
    const STATUS: &str = include_str!("../tests/fixtures/status-live.json");

    /// A fake ci-runners in a temp folder: `version` and `status` are shell snippets; every call lands in `calls`.
    struct Fake {
        dir: tempfile::TempDir,
        bin: PathBuf,
    }

    impl Fake {
        fn new(version: &str, status: &str) -> Fake {
            let dir = tempfile::tempdir().unwrap();
            let bin = dir.path().join("ci-runners");
            let script = format!("#!/bin/sh\necho \"$*\" >> \"$(dirname \"$0\")/calls\"\ncase \"$1\" in\nversion) {version} ;;\nstatus) {status} ;;\nesac\n");
            fs::write(&bin, script).unwrap();
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
            Fake { dir, bin }
        }

        fn live() -> Fake {
            let fake = Fake::new("cat \"$(dirname \"$0\")/version.json\"", "cat \"$(dirname \"$0\")/status.json\"");
            fs::write(fake.dir.path().join("version.json"), VERSION).unwrap();
            fs::write(fake.dir.path().join("status.json"), STATUS).unwrap();
            fake
        }

        fn calls(&self, first: &str) -> usize {
            fs::read_to_string(self.dir.path().join("calls")).unwrap_or_default().lines().filter(|l| l.starts_with(first)).count()
        }
    }

    fn version_ok() -> String {
        format!("echo '{}'", VERSION.trim())
    }

    #[test]
    fn no_binary_is_absent() {
        assert!(matches!(source(None), Source::Absent));
    }

    #[test]
    fn an_old_binary_is_outdated_and_status_is_never_called() {
        let fake = Fake::new("echo oops >&2; exit 1", "echo '{}'");
        assert!(matches!(source(Some(fake.bin.clone())), Source::Outdated(_)));
        assert_eq!(fake.calls("status"), 0);
        assert_eq!(fake.calls("version"), 1);
    }

    #[test]
    fn a_binary_without_status_offline_is_outdated() {
        let fake = Fake::new("echo '{\"version\":\"0\",\"json_v\":1,\"features\":[]}'", "echo '{}'");
        match source(Some(fake.bin.clone())) {
            Source::Outdated(why) => assert_eq!(why, "ci-runners on this machine has no status --json --offline; update it"),
            _ => panic!("not outdated"),
        }
        assert_eq!(fake.calls("status"), 0);
    }

    #[test]
    fn a_live_binary_gives_its_status() {
        let fake = Fake::live();
        let src = source(Some(fake.bin.clone()));
        assert!(matches!(src, Source::Live(_)));
        let view = model(src, Path::new("/home/me/.local/state/ci-runners"), chrono::Utc::now());
        assert_eq!(view["state"], "live");
        assert_eq!(fake.calls("status --json --offline"), 1);
    }

    #[test]
    fn a_failing_status_is_down_with_its_stderr() {
        let fake = Fake::new(&version_ok(), "echo boom >&2; exit 3");
        match source(Some(fake.bin.clone())) {
            Source::Down(why) => assert_eq!(why, "boom"),
            _ => panic!("not down"),
        }
    }

    #[test]
    fn a_failing_status_without_stderr_says_its_code() {
        let fake = Fake::new(&version_ok(), "exit 4");
        match source(Some(fake.bin.clone())) {
            Source::Down(why) => assert_eq!(why, "ci-runners status exited 4"),
            _ => panic!("not down"),
        }
    }

    #[test]
    fn garbage_is_down() {
        let fake = Fake::new(&version_ok(), "echo not json");
        match source(Some(fake.bin.clone())) {
            Source::Down(why) => assert!(why.starts_with("ci-runners status printed no JSON"), "{why}"),
            _ => panic!("not down"),
        }
    }

    #[test]
    fn a_hanging_status_is_down_within_the_limit() {
        let fake = Fake::new(&version_ok(), "sleep 30");
        let started = Instant::now();
        let src = source(Some(fake.bin.clone()));
        assert!(started.elapsed() < Duration::from_secs(7));
        match src {
            Source::Down(why) => assert!(why.contains("did not answer"), "{why}"),
            _ => panic!("not down"),
        }
    }

    #[test]
    fn features_are_read_once_per_binary_version() {
        let fake = Fake::new(&version_ok(), "echo '{\"v\":1}'");
        source(Some(fake.bin.clone()));
        source(Some(fake.bin.clone()));
        assert_eq!(fake.calls("version"), 1);
        let file = fs::File::options().write(true).open(&fake.bin).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(60)).unwrap();
        drop(file);
        source(Some(fake.bin.clone()));
        assert_eq!(fake.calls("version"), 2);
    }
}
