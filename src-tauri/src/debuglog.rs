//! Rotating file log at `~/.que/logs/que.log`.
//!
//! Default level is Info (release-safe). Settings "debug logging" raises it to
//! Debug. `QUE_LOG=trace|debug|info|warn|error|0` overrides the setting.
//! `QUE_LOG_STDERR=1` also mirrors lines to stderr.

use crate::error::AppError;
use crate::paths::logs_dir;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const BACKUPS: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[repr(u8)]
pub enum Level {
    Error = 1,
    Warn = 2,
    Info = 3,
    Debug = 4,
    Trace = 5,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "ERROR",
            Self::Warn => "WARN",
            Self::Info => "INFO",
            Self::Debug => "DEBUG",
            Self::Trace => "TRACE",
        }
    }

    fn from_env(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "0" | "off" | "silent" => None,
            "error" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" => Some(Self::Debug),
            "trace" => Some(Self::Trace),
            _ => Some(Self::Info),
        }
    }
}

static MIN: AtomicU8 = AtomicU8::new(Level::Info as u8);
static ENV_LOCKED: AtomicBool = AtomicBool::new(false);
static STDERR: AtomicBool = AtomicBool::new(false);
static FILE: Mutex<()> = Mutex::new(());
fn terms() -> parking_lot::MutexGuard<'static, std::collections::HashMap<String, String>> {
    static TERMS: std::sync::OnceLock<
        parking_lot::Mutex<std::collections::HashMap<String, String>>,
    > = std::sync::OnceLock::new();
    TERMS
        .get_or_init(|| parking_lot::Mutex::new(std::collections::HashMap::new()))
        .lock()
}

pub fn init() {
    STDERR.store(
        std::env::var("QUE_LOG_STDERR").is_ok_and(|v| v != "0"),
        Ordering::Relaxed,
    );
    if let Ok(value) = std::env::var("QUE_LOG") {
        ENV_LOCKED.store(true, Ordering::Relaxed);
        match Level::from_env(&value) {
            Some(level) => MIN.store(level as u8, Ordering::Relaxed),
            None => MIN.store(0, Ordering::Relaxed),
        }
        return;
    }
    if std::env::var("QUE_DEBUG").is_ok_and(|v| v == "0") {
        ENV_LOCKED.store(true, Ordering::Relaxed);
        MIN.store(0, Ordering::Relaxed);
    }
}

pub fn set_verbose(on: bool) {
    if ENV_LOCKED.load(Ordering::Relaxed) {
        return;
    }
    MIN.store(
        if on {
            Level::Debug as u8
        } else {
            Level::Info as u8
        },
        Ordering::Relaxed,
    );
}

pub fn verbose() -> bool {
    MIN.load(Ordering::Relaxed) >= Level::Debug as u8
}

pub fn min_level() -> Option<Level> {
    match MIN.load(Ordering::Relaxed) {
        1 => Some(Level::Error),
        2 => Some(Level::Warn),
        3 => Some(Level::Info),
        4 => Some(Level::Debug),
        5 => Some(Level::Trace),
        _ => None,
    }
}

pub fn enabled(level: Level) -> bool {
    MIN.load(Ordering::Relaxed) >= level as u8
}

pub fn logs_path() -> std::path::PathBuf {
    logs_dir().join("que.log")
}

pub fn log_path() -> std::path::PathBuf {
    logs_path()
}

pub fn bind_term(term: &str, card: &str) {
    if term.is_empty() || card.is_empty() {
        return;
    }
    terms().insert(term.to_string(), card.to_string());
}

pub fn unbind_term(term: &str) {
    terms().remove(term);
}

pub fn card_for(term: &str) -> Option<String> {
    terms().get(term).cloned()
}

/// Leftover call sites are Debug so default Info stays quiet.
pub fn log(msg: &str) {
    debug("dbg", msg);
}

pub fn write(level: Level, sys: &str, card: Option<&str>, term: Option<&str>, msg: &str) {
    if !enabled(level) {
        return;
    }
    let card = card.map(str::to_string).or_else(|| term.and_then(card_for));
    let line = format_line(level, sys, card.as_deref(), term, msg);
    if STDERR.load(Ordering::Relaxed) {
        eprintln!("{line}");
    }
    let _guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let path = logs_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    rotate_if_needed(&path);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
}

pub fn error(sys: &str, msg: &str) {
    write(Level::Error, sys, None, None, msg);
}
pub fn warn(sys: &str, msg: &str) {
    write(Level::Warn, sys, None, None, msg);
}
pub fn info(sys: &str, msg: &str) {
    write(Level::Info, sys, None, None, msg);
}
pub fn debug(sys: &str, msg: &str) {
    write(Level::Debug, sys, None, None, msg);
}
pub fn trace(sys: &str, msg: &str) {
    write(Level::Trace, sys, None, None, msg);
}

pub fn error_term(sys: &str, term: &str, msg: &str) {
    write(Level::Error, sys, None, Some(term), msg);
}
pub fn warn_term(sys: &str, term: &str, msg: &str) {
    write(Level::Warn, sys, None, Some(term), msg);
}
pub fn info_term(sys: &str, term: &str, msg: &str) {
    write(Level::Info, sys, None, Some(term), msg);
}
pub fn debug_term(sys: &str, term: &str, msg: &str) {
    write(Level::Debug, sys, None, Some(term), msg);
}
pub fn trace_term(sys: &str, term: &str, msg: &str) {
    write(Level::Trace, sys, None, Some(term), msg);
}

pub fn info_card(sys: &str, card: &str, term: Option<&str>, msg: &str) {
    write(Level::Info, sys, Some(card), term, msg);
}
pub fn debug_card(sys: &str, card: &str, term: Option<&str>, msg: &str) {
    write(Level::Debug, sys, Some(card), term, msg);
}
pub fn warn_card(sys: &str, card: &str, term: Option<&str>, msg: &str) {
    write(Level::Warn, sys, Some(card), term, msg);
}

pub fn log_error(context: &str, err: &AppError) {
    match err {
        AppError::Machine {
            code,
            prompt,
            detail,
        } => match (prompt, detail) {
            (Some(p), Some(d)) => error(
                "error",
                &format!("{context} Machine code={code} prompt={p:?} detail={d:?}"),
            ),
            (Some(p), None) => error(
                "error",
                &format!("{context} Machine code={code} prompt={p:?}"),
            ),
            (None, Some(d)) => error(
                "error",
                &format!("{context} Machine code={code} detail={d:?}"),
            ),
            (None, None) => error("error", &format!("{context} Machine code={code}")),
        },
        AppError::Message(m) => error("error", &format!("{context}: {m}")),
    }
}

pub fn clip(value: &str, max: usize) -> String {
    if value.len() <= max {
        value.to_string()
    } else {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…(len={})", &value[..end], value.len())
    }
}

pub fn read_tail(max_bytes: usize) -> String {
    let path = logs_path();
    let Ok(meta) = std::fs::metadata(&path) else {
        return String::new();
    };
    let Ok(mut file) = std::fs::File::open(&path) else {
        return String::new();
    };
    use std::io::{Read, Seek, SeekFrom};
    let skip = meta.len().saturating_sub(max_bytes as u64);
    if skip > 0 {
        let _ = file.seek(SeekFrom::Start(skip));
    }
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);
    if skip > 0 {
        if let Some(cut) = buf.find('\n') {
            buf = buf[cut + 1..].to_string();
        }
    }
    buf
}

pub fn filter_text(text: &str, card: Option<&str>, term: Option<&str>) -> String {
    text.lines()
        .filter(|line| {
            let card_ok = card.is_none_or(|id| {
                line.contains(&format!("card={id}"))
                    || line.contains(&format!(" {id} "))
                    || line.ends_with(id)
            });
            let term_ok =
                term.is_none_or(|id| line.contains(&format!("term={id}")) || line.contains(id));
            card_ok || term_ok
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_line(
    level: Level,
    sys: &str,
    card: Option<&str>,
    term: Option<&str>,
    msg: &str,
) -> String {
    let mut line = format!("[{}] {} {sys}", timestamp(), level.as_str());
    if let Some(card) = card.filter(|s| !s.is_empty()) {
        line.push_str(" card=");
        line.push_str(card);
    }
    if let Some(term) = term.filter(|s| !s.is_empty()) {
        line.push_str(" term=");
        line.push_str(term);
    }
    line.push(' ');
    line.push_str(msg);
    line
}

fn rotate_if_needed(path: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_FILE_BYTES {
        return;
    }
    let dir = path.parent().unwrap_or(path);
    let stem = "que";
    let oldest = dir.join(format!("{stem}.{BACKUPS}.log"));
    let _ = std::fs::remove_file(&oldest);
    for index in (1..BACKUPS).rev() {
        let from = dir.join(format!("{stem}.{index}.log"));
        let to = dir.join(format!("{stem}.{}.log", index + 1));
        let _ = std::fs::rename(&from, &to);
    }
    let _ = std::fs::rename(path, dir.join(format!("{stem}.1.log")));
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_preserves_utf8_boundaries() {
        assert_eq!(clip("中文", 1), "…(len=6)");
        assert_eq!(clip("中文", 4), "中…(len=6)");
        assert_eq!(clip("a😀b", 3), "a…(len=6)");
        assert_eq!(clip("中文", 6), "中文");
    }

    #[test]
    fn formats_card_and_term() {
        let line = format_line(
            Level::Info,
            "remote",
            Some("c1"),
            Some("t1"),
            "connected 12ms",
        );
        assert!(line.contains("INFO remote card=c1 term=t1 connected 12ms"));
    }

    #[test]
    fn filter_keeps_matching_ids() {
        let text = "[t] INFO queue card=aa create\n[t] INFO pty term=zz bytes\n[t] INFO app boot\n";
        let filtered = filter_text(text, Some("aa"), Some("zz"));
        assert!(filtered.contains("card=aa"));
        assert!(filtered.contains("term=zz"));
        assert!(!filtered.contains("app boot"));
    }
}
