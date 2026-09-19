use std::path::{Path, PathBuf};
use std::process::Command;

pub fn safe_name_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

pub fn find_first(roots: &[PathBuf], name: &str) -> Option<PathBuf> {
    find_named(roots, name, None, true).into_iter().next()
}

pub fn find_dir(roots: &[PathBuf], name: &str) -> Option<PathBuf> {
    find_named(roots, name, Some('d'), true).into_iter().next()
}

pub fn find_all(roots: &[PathBuf], name: &str) -> Vec<PathBuf> {
    find_named(roots, name, Some('f'), false)
}

fn find_named(roots: &[PathBuf], name: &str, kind: Option<char>, quit: bool) -> Vec<PathBuf> {
    let roots: Vec<_> = roots.iter().filter(|path| path.exists()).cloned().collect();
    if roots.is_empty() || name.is_empty() {
        return Vec::new();
    }
    if let Some(found) = unix_find(&roots, name, kind, quit) {
        return found;
    }
    walk_named(&roots, name, kind, quit)
}

fn unix_find(
    roots: &[PathBuf],
    name: &str,
    kind: Option<char>,
    quit: bool,
) -> Option<Vec<PathBuf>> {
    if !cfg!(unix) {
        return None;
    }
    let mut command = Command::new("find");
    command.args(roots);
    let kind_flag = kind.map(|value| value.to_string());
    if let Some(kind) = &kind_flag {
        command.args(["-type", kind]);
    }
    command.args(["-name", name, "-print"]);
    if quit {
        command.arg("-quit");
    }
    let output = command.output().ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let paths = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    Some(paths)
}

fn walk_named(roots: &[PathBuf], name: &str, kind: Option<char>, quit: bool) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for root in roots {
        walk(root, name, kind, quit, &mut found);
        if quit && !found.is_empty() {
            break;
        }
    }
    found
}

fn walk(dir: &Path, name: &str, kind: Option<char>, quit: bool, found: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if quit && !found.is_empty() {
            return;
        }
        let path = entry.path();
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let kind_ok = match kind {
            Some('d') => path.is_dir(),
            Some('f') => path.is_file(),
            _ => true,
        };
        if kind_ok && name_matches(file_name, name) {
            found.push(path.clone());
            if quit {
                return;
            }
        }
        if path.is_dir() {
            walk(&path, name, kind, quit, found);
        }
    }
}

fn name_matches(file_name: &str, pattern: &str) -> bool {
    if let Some(inner) = pattern
        .strip_prefix('*')
        .and_then(|rest| rest.strip_suffix('*'))
    {
        return file_name.contains(inner);
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return file_name.ends_with(suffix);
    }
    file_name == pattern
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_stops_on_name() {
        let root = std::env::temp_dir().join(format!("que-find-{}", std::process::id()));
        let nested = root.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        let target = nested.join("rollout-019fb25e-7179-7a41-b520-abde1d5e68fb.jsonl");
        std::fs::write(&target, "").unwrap();
        std::fs::write(nested.join("other.jsonl"), "").unwrap();
        let found = find_first(
            &[root.clone()],
            "*019fb25e-7179-7a41-b520-abde1d5e68fb.jsonl",
        );
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found.as_deref(), Some(target.as_path()));
    }
}
