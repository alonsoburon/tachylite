//! Compares the metadata parser with `metadataCache` output recorded from a real Obsidian
//! (`tools/obsidian-dump`, see its README). Skipped when `compat/obsidian-reference.json` is absent.
//! Prints every difference and writes `compat/reference-report-cache.txt`; set `TACHYLITE_STRICT_REFERENCE=1`
//! to fail when there are any. The UI half (commands, menus, config) is `ui/test/compat.reference.test.ts`.
use serde_json::Value;
use std::path::PathBuf;
use tachylite_core::parse::parse;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Differences between what Obsidian recorded (`want`) and what Tachylite produced (`got`), one line each.
pub fn diff_json(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Object(w), Value::Object(g)) => {
            for (k, wv) in w {
                match g.get(k) {
                    Some(gv) => diff_json(&format!("{path}.{k}"), wv, gv, out),
                    None => out.push(format!("{path}.{k}: Obsidian has {}, Tachylite has nothing", short(wv))),
                }
            }
            for (k, gv) in g {
                if !w.contains_key(k) {
                    out.push(format!("{path}.{k}: only Tachylite has {}", short(gv)));
                }
            }
        }
        (Value::Array(w), Value::Array(g)) => {
            if w.len() != g.len() {
                out.push(format!("{path}: Obsidian has {} entries, Tachylite {} (Obsidian {}, Tachylite {})", w.len(), g.len(), short(want), short(got)));
                return;
            }
            for (i, (wv, gv)) in w.iter().zip(g).enumerate() {
                diff_json(&format!("{path}[{i}]"), wv, gv, out);
            }
        }
        _ if want == got => {}
        _ => out.push(format!("{path}: Obsidian {}, Tachylite {}", short(want), short(got))),
    }
}

fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 110 {
        format!("{}…", s.chars().take(110).collect::<String>())
    } else {
        s
    }
}

/// Every note of the dump compared with what the parser makes of the same text.
pub fn compare(reference: &Value) -> Vec<(String, Vec<String>)> {
    let mut sections = vec![];
    let Some(cache) = reference.get("cache").and_then(Value::as_object) else { return sections };
    for (name, entry) in cache {
        let (Some(text), Some(want)) = (entry.get("text").and_then(Value::as_str), entry.get("cache")) else {
            sections.push((name.clone(), vec!["no cache recorded in Obsidian for this note".into()]));
            continue;
        };
        let got = serde_json::to_value(parse(text)).unwrap();
        let mut diffs = vec![];
        diff_json(name, want, &got, &mut diffs);
        sections.push((name.clone(), diffs));
    }
    sections
}

fn report(sections: &[(String, Vec<String>)]) -> (String, usize) {
    let mut lines = vec![];
    let mut total = 0;
    for (name, diffs) in sections {
        total += diffs.len();
        lines.push(format!(
            "## {name}: {}",
            if diffs.is_empty() { "no differences".to_string() } else { format!("{} difference{}", diffs.len(), if diffs.len() == 1 { "" } else { "s" }) }
        ));
        lines.extend(diffs.iter().map(|d| format!("  - {d}")));
    }
    lines.push(String::new());
    lines.push(format!("{total} difference{} in total", if total == 1 { "" } else { "s" }));
    (lines.join("\n"), total)
}

#[test]
fn metadata_cache_matches_the_obsidian_reference() {
    let file = root().join("compat/obsidian-reference.json");
    let Ok(raw) = std::fs::read_to_string(&file) else {
        eprintln!("skipped: compat/obsidian-reference.json not found (see tools/obsidian-dump/README.md)");
        return;
    };
    let reference: Value = serde_json::from_str(&raw).expect("compat/obsidian-reference.json is not valid JSON");
    let sections = compare(&reference);
    if sections.is_empty() {
        eprintln!("the dump has no `cache` section (was tachylite-corpus copied into the vault?)");
        return;
    }
    let (text, total) = report(&sections);
    println!("{text}");
    let _ = std::fs::write(root().join("compat/reference-report-cache.txt"), format!("{text}\n"));
    if std::env::var("TACHYLITE_STRICT_REFERENCE").as_deref() == Ok("1") {
        assert_eq!(total, 0, "metadata cache differs from the Obsidian reference; see compat/reference-report-cache.txt");
    }
}

#[test]
fn the_comparison_reports_differences_and_agreement() {
    // A hand-made reference (not Obsidian data) to prove the comparison itself works.
    let text = "See [[Target]] and #tag\n";
    let good = serde_json::to_value(parse(text)).unwrap();
    let reference = serde_json::json!({ "cache": { "ok.md": { "text": text, "cache": good }, "no-cache.md": { "text": text, "cache": null } } });
    let sections = compare(&reference);
    assert_eq!(sections.iter().find(|(n, _)| n == "ok.md").unwrap().1, Vec::<String>::new());

    let mut wrong = serde_json::to_value(parse(text)).unwrap();
    wrong["links"][0]["link"] = "Other".into();
    wrong["tags"][0]["position"]["start"]["offset"] = 99.into();
    wrong["extra"] = serde_json::json!([1]);
    let reference = serde_json::json!({ "cache": { "bad.md": { "text": text, "cache": wrong } } });
    let diffs = &compare(&reference)[0].1;
    assert!(diffs.contains(&"bad.md.links[0].link: Obsidian \"Other\", Tachylite \"Target\"".to_string()), "{diffs:?}");
    assert!(diffs.iter().any(|d| d.starts_with("bad.md.tags[0].position.start.offset: Obsidian 99, Tachylite ")), "{diffs:?}");
    assert!(diffs.contains(&"bad.md.extra: Obsidian has [1], Tachylite has nothing".to_string()), "{diffs:?}");
}
