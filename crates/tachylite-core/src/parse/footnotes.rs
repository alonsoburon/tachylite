//! Footnotes for `CachedMetadata`, as Obsidian reports them (typings since 1.6.6 / 1.8.7):
//! `footnotes` holds definitions (`[^id]: text`, position = the whole definition incl. continuation lines) and inline
//! footnotes (`^[text]`, position = the text inside the brackets, id = ""), sorted by position; `footnoteRefs` holds
//! `[^id]` references that have a matching definition. Ids are normalised like CommonMark labels (case-folded,
//! inner whitespace collapsed). Fenced code and inline code are skipped. Positions are UTF-16 like the rest.
use super::{code_spans, re, re_fence, CachedMetadata, Index, Pos};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FootnoteCache {
    pub id: String,
    pub position: Pos,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FootnoteRefCache {
    pub id: String,
    pub position: Pos,
}

fn re_def() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^( {0,3})\[\^([^\]\s]+)\]:")
}

/// Does this line start a footnote definition (`[^id]:`)?
pub(super) fn is_definition(line: &str) -> bool {
    re_def().is_match(line)
}

fn normalize(label: &str) -> String {
    label.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn indented(t: &str) -> bool {
    t.starts_with('\t') || t.starts_with("    ")
}

/// A line that starts another block, so it can't lazily continue a definition's paragraph.
fn starts_block(t: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^ {0,3}(?:#{1,6}(?:\s|$)|>|\||[-*+][ \t]|\d{1,9}[.)][ \t]|`{3,}|~{3,}|\$\$)").is_match(t)
}

/// Fill `meta.footnotes` and `meta.footnote_refs` from the body (text after the frontmatter at `body_from`).
pub(super) fn collect(text: &str, body_from: usize, idx: &Index, meta: &mut CachedMetadata) {
    let mut lines: Vec<(usize, &str, bool)> = Vec::new(); // (byte start, text, inside fenced code)
    let mut off = body_from;
    let mut fence: Option<(char, usize)> = None;
    for raw in text[body_from..].split_inclusive('\n') {
        let t = raw.trim_end_matches(['\n', '\r']);
        let fence_line = re_fence().captures(t).map(|c| c[1].to_string());
        match (&fence, fence_line) {
            (Some((ch, len)), Some(f)) if f.starts_with(*ch) && f.len() >= *len && t.trim().trim_start_matches(*ch).is_empty() => {
                lines.push((off, t, true));
                fence = None;
            }
            (Some(_), _) => lines.push((off, t, true)),
            (None, Some(f)) if !(f.starts_with('`') && t.trim_start()[f.len()..].contains('`')) => {
                fence = Some((f.chars().next().unwrap_or('`'), f.len()));
                lines.push((off, t, true));
            }
            (None, _) => lines.push((off, t, false)),
        }
        off += raw.len();
    }

    // Definitions (and the `[^id]:` labels, which are not references).
    let mut defs: HashSet<String> = HashSet::new();
    let mut labels: HashSet<usize> = HashSet::new();
    let mut i = 0;
    while i < lines.len() {
        let (start, t, code) = lines[i];
        let Some(c) = re_def().captures(t).filter(|_| !code) else {
            i += 1;
            continue;
        };
        let from = start + c[1].len();
        labels.insert(from);
        let mut end = start + t.len();
        let mut j = i + 1;
        let mut prev_blank = false;
        while j < lines.len() && !lines[j].2 {
            let (s, lt, _) = lines[j];
            if lt.trim().is_empty() {
                prev_blank = true;
                j += 1;
                continue;
            }
            let lazy = !prev_blank && !is_definition(lt) && !starts_block(lt);
            if !(indented(lt) || lazy) {
                break;
            }
            end = s + lt.len();
            prev_blank = false;
            j += 1;
        }
        defs.insert(normalize(&c[2]));
        meta.footnotes.push(FootnoteCache { id: normalize(&c[2]), position: idx.pos(from, end) });
        i = j.max(i + 1);
        // continuation lines are scanned for references below like any other line
    }

    // References `[^id]` and inline footnotes `^[text]`.
    for &(start, t, code) in &lines {
        if code {
            continue;
        }
        let spans = code_spans(t);
        let in_code = |k: usize| spans.iter().any(|(s, e)| k >= *s && k < *e);
        let b = t.as_bytes();
        let mut k = 0;
        while k < b.len() {
            if in_code(k) {
                k += 1;
                continue;
            }
            if b[k] == b'\\' {
                k += 2;
                continue;
            }
            if b[k] == b'[' && b.get(k + 1) == Some(&b'^') {
                let close = t[k + 2..].find(']').map(|r| k + 2 + r);
                if let Some(e) = close {
                    let label = &t[k + 2..e];
                    if !label.is_empty() && !label.chars().any(char::is_whitespace) {
                        let id = normalize(label);
                        if !labels.contains(&(start + k)) && defs.contains(&id) {
                            meta.footnote_refs.push(FootnoteRefCache { id, position: idx.pos(start + k, start + e + 1) });
                        }
                        k = e + 1;
                        continue;
                    }
                }
            }
            if b[k] == b'^' && b.get(k + 1) == Some(&b'[') {
                let mut depth = 0usize;
                let mut e = None;
                let mut m = k + 1;
                while m < b.len() {
                    match b[m] {
                        b'\\' => m += 1,
                        b'[' => depth += 1,
                        b']' => {
                            depth -= 1;
                            if depth == 0 {
                                e = Some(m);
                                break;
                            }
                        }
                        _ => {}
                    }
                    m += 1;
                }
                if let Some(e) = e.filter(|e| *e > k + 2) {
                    meta.footnotes.push(FootnoteCache { id: String::new(), position: idx.pos(start + k + 2, start + e) });
                    k = e + 1;
                    continue;
                }
            }
            k += 1;
        }
    }
    meta.footnotes.sort_by_key(|f| f.position.start.offset);
}

#[cfg(test)]
mod tests {
    use super::super::parse;

    #[test]
    fn definitions_refs_and_inline() {
        let m = parse("Text[^1] and [^Qux] and [^none] and ^[inline [[L]] note].\n\n[^1]: bar\n    more\n\n[^qux]: quux\n`[^1]` ^[]\n");
        let ids: Vec<_> = m.footnotes.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["", "1", "qux"]);
        let inline = &m.footnotes[0];
        assert_eq!((inline.position.start.col, inline.position.end.col), (38, 55));
        assert_eq!(m.footnotes[1].position.start.line, 2);
        assert_eq!(m.footnotes[1].position.end.line, 3); // indented continuation belongs to the definition
        let refs: Vec<_> = m.footnote_refs.iter().map(|r| (r.id.as_str(), r.position.start.col, r.position.end.col)).collect();
        assert_eq!(refs, [("1", 4, 8), ("qux", 13, 19)]); // undefined [^none], labels, code and empty ^[] are skipped
        assert!(m.sections.iter().any(|s| s.kind == "footnoteDefinition" && s.position.start.line == 2 && s.position.end.line == 3));
        let defs = parse("[^a]: one\n[^b]: two\n");
        assert_eq!(defs.sections.iter().filter(|s| s.kind == "footnoteDefinition").count(), 2);
    }

    #[test]
    fn fenced_code_and_utf16() {
        let m = parse("```\n[^a] ^[x]\n```\n😀[^a]\n\n[^a]: é\n");
        assert_eq!(m.footnote_refs.len(), 1);
        assert_eq!(m.footnote_refs[0].position.start.col, 2);
        assert_eq!(m.footnote_refs[0].position.start.line, 3);
        assert_eq!(m.footnotes.len(), 1);
        let j = serde_json::to_value(&m).unwrap();
        assert!(j.get("footnoteRefs").is_some() && j.get("footnotes").is_some());
        assert!(serde_json::to_value(parse("plain")).unwrap().get("footnotes").is_none());
    }
}
