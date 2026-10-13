//! Black-box compatibility suite: every folder in `compat/` at the repository root is a fixture vault
//! (`<fixture>/vault/`) plus the behaviour Obsidian is expected to show on it (`<fixture>/expected.json`).
//! See compat/README.md for the file format, what each fixture asserts, and how sure we are of each expectation.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tachylite_core::metadata::{all_tags, resolve_subpath};
use tachylite_core::Workspace;

fn compat_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../compat").canonicalize().expect("compat/ directory")
}

fn copy_dir(from: &Path, to: &Path) {
    for e in walkdir::WalkDir::new(from).min_depth(1) {
        let e = e.unwrap();
        let dest = to.join(e.path().strip_prefix(from).unwrap());
        if e.file_type().is_dir() {
            fs::create_dir_all(&dest).unwrap();
        } else {
            fs::create_dir_all(dest.parent().unwrap()).unwrap();
            fs::copy(e.path(), &dest).unwrap();
        }
    }
}

/// `expected` matches `actual` when every key of an expected object matches (extra keys in `actual` are ignored),
/// arrays have the same length and match element-wise, and scalars are equal. `null` expects the key to be absent.
fn subset(expected: &Value, actual: &Value, at: &str, errs: &mut Vec<String>) {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            for (k, ev) in e {
                if k.starts_with("//") {
                    continue; // comment keys
                }
                let path = format!("{at}.{k}");
                match (ev, a.get(k)) {
                    (Value::Null, None | Some(Value::Null)) => {}
                    (Value::Null, Some(av)) => errs.push(format!("{path}: expected absent, got {av}")),
                    (_, None) => errs.push(format!("{path}: missing (expected {ev})")),
                    (_, Some(av)) => subset(ev, av, &path, errs),
                }
            }
        }
        (Value::Array(e), Value::Array(a)) => {
            if e.len() != a.len() {
                errs.push(format!("{at}: expected {} items, got {}: {}", e.len(), a.len(), Value::Array(a.clone())));
                return;
            }
            for (i, (ev, av)) in e.iter().zip(a).enumerate() {
                subset(ev, av, &format!("{at}[{i}]"), errs);
            }
        }
        _ if expected == actual => {}
        _ => errs.push(format!("{at}: expected {expected}, got {actual}")),
    }
}

fn open(vault: &Path) -> (tempfile::TempDir, Workspace) {
    let d = tempfile::tempdir().unwrap();
    copy_dir(vault, d.path());
    let ws = Workspace::open(d.path()).unwrap();
    (d, ws)
}

fn read_tree(root: &Path) -> Value {
    let mut out = serde_json::Map::new();
    for e in walkdir::WalkDir::new(root).min_depth(1).sort_by_file_name() {
        let e = e.unwrap();
        let rel = e.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if e.file_type().is_file() && !rel.starts_with(".obsidian") {
            out.insert(rel, Value::String(fs::read_to_string(e.path()).unwrap_or_default()));
        }
    }
    Value::Object(out)
}

/// Runs one fixture and returns its mismatches (each prefixed with the assertion that failed).
fn run_fixture(dir: &Path) -> Vec<String> {
    let exp: Value =
        serde_json::from_str(&fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap_or_else(|e| panic!("{}: bad expected.json: {e}", dir.display()));
    let vault = dir.join("vault");
    let mut errs = vec![];
    let (_d, ws) = open(&vault);

    for (i, case) in exp.get("resolve").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let link = case["link"].as_str().unwrap();
        let from = case["from"].as_str().unwrap();
        let (lp, _) = tachylite_core::metadata::split_subpath(link);
        let got = ws.meta.first_linkpath_dest(lp, from).map_or(Value::Null, Value::String);
        if got != case["to"] {
            errs.push(format!("resolve[{i}] [[{link}]] from {from}: expected {}, got {got}", case["to"]));
        }
    }
    if let Some(Value::Object(files)) = exp.get("metadata") {
        for (path, e) in files {
            let actual = serde_json::to_value(ws.meta.get(path)).unwrap();
            subset(e, &actual, &format!("metadata[{path}]"), &mut errs);
        }
    }
    for key in ["resolvedLinks", "unresolvedLinks"] {
        if let Some(Value::Object(files)) = exp.get(key) {
            let all = if key == "resolvedLinks" { &ws.meta.resolved_links } else { &ws.meta.unresolved_links };
            for (path, e) in files {
                let actual = all.get(path).map_or(json!({}), |m| json!(m));
                if *e != actual {
                    errs.push(format!("{key}[{path}]: expected {e}, got {actual}"));
                }
            }
        }
    }
    if let Some(Value::Object(e)) = exp.get("fileTags") {
        for (path, tags) in e {
            let actual = ws.meta.get(path).map_or(json!([]), |m| json!(all_tags(m)));
            if *tags != actual {
                errs.push(format!("fileTags[{path}]: expected {tags}, got {actual}"));
            }
        }
    }
    if let Some(e) = exp.get("vaultTags") {
        let actual = json!(ws.meta.tags());
        if *e != actual {
            errs.push(format!("vaultTags: expected {e}, got {actual}"));
        }
    }
    for (i, case) in exp.get("subpath").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let file = case["file"].as_str().unwrap();
        let sub = case["subpath"].as_str().unwrap();
        let got = ws.meta.get(file).and_then(|m| resolve_subpath(m, sub)).map_or(Value::Null, |r| json!(r));
        let mut e2 = vec![];
        match (&case["expect"], &got) {
            (Value::Null, Value::Null) => {}
            (Value::Null, g) => e2.push(format!("expected no match, got {g}")),
            (e, Value::Null) => e2.push(format!("expected {e}, got no match")),
            (e, g) => subset(e, g, "", &mut e2),
        }
        errs.extend(e2.into_iter().map(|m| format!("subpath[{i}] {file}{sub}: {m}")));
    }
    for (i, case) in exp.get("linktext").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let (d, mut ws) = open(&vault);
        if let Some(Value::Object(cfg)) = case.get("config") {
            for (k, v) in cfg {
                ws.vault.config.file.set(k, v.clone());
            }
        }
        let (target, source) = (case["target"].as_str().unwrap(), case["source"].as_str().unwrap());
        let got = ws.meta.file_to_linktext(&ws.vault, target, source, true);
        if got != case["expected"].as_str().unwrap() {
            errs.push(format!("linktext[{i}] {target} from {source}: expected {}, got {got:?}", case["expected"]));
        }
        drop(d);
    }
    for (i, case) in exp.get("rename").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let (d, mut ws) = open(&vault);
        if let Some(Value::Object(cfg)) = case.get("config") {
            for (k, v) in cfg {
                ws.vault.config.file.set(k, v.clone());
            }
        }
        for step in case["steps"].as_array().unwrap() {
            let (from, to) = (step[0].as_str().unwrap(), step[1].as_str().unwrap());
            if let Err(e) = ws.rename(from, to, true) {
                errs.push(format!("rename[{i}] {from} -> {to}: {e}"));
            }
        }
        let tree = read_tree(d.path());
        subset(&case["files"], &tree, &format!("rename[{i}].files"), &mut errs);
        for (j, r) in case.get("resolve").and_then(Value::as_array).into_iter().flatten().enumerate() {
            let got = ws.meta.first_linkpath_dest(r["link"].as_str().unwrap(), r["from"].as_str().unwrap()).map_or(Value::Null, Value::String);
            if got != r["to"] {
                errs.push(format!("rename[{i}].resolve[{j}] [[{}]] from {}: expected {}, got {got}", r["link"], r["from"], r["to"]));
            }
        }
        if let Some(Value::Object(e)) = case.get("unresolvedLinks") {
            for (path, ev) in e {
                let actual = ws.meta.unresolved_links.get(path).map_or(json!({}), |m| json!(m));
                if *ev != actual {
                    errs.push(format!("rename[{i}].unresolvedLinks[{path}]: expected {ev}, got {actual}"));
                }
            }
        }
    }
    errs
}

#[test]
fn compat_fixtures() {
    let root = compat_dir();
    let mut dirs: Vec<PathBuf> = fs::read_dir(&root).unwrap().map(|e| e.unwrap().path()).filter(|p| p.join("expected.json").is_file()).collect();
    dirs.sort();
    assert!(!dirs.is_empty(), "no fixtures in {}", root.display());
    let only = std::env::var("COMPAT_FIXTURE").ok();
    let mut failures = vec![];
    for dir in dirs {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        if only.as_deref().is_some_and(|o| o != name) {
            continue;
        }
        for e in run_fixture(&dir) {
            failures.push(format!("[{name}] {e}"));
        }
    }
    assert!(failures.is_empty(), "{} compat mismatch(es):\n{}", failures.len(), failures.join("\n"));
}
