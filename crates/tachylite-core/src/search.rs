//! Vault search with the commonly used Obsidian operators:
//! `file:` `path:` `content:` `tag:` `line:` `section:`-less subset, quoted phrases, `-negation`, `OR`.

use crate::metadata::{all_tags, MetadataCache};
use crate::vault::Vault;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    /// (line number, line text) matches inside the file; empty for name/path-only matches.
    pub lines: Vec<(usize, String)>,
}

#[derive(Debug, Clone)]
enum Term {
    Text(String),
    File(String),
    Path(String),
    Content(String),
    Tag(String),
    Line(String),
}

#[derive(Debug, Clone)]
struct Clause {
    neg: bool,
    term: Term,
}

fn tokenize(q: &str) -> Vec<Vec<Clause>> {
    // OR-separated groups of AND clauses.
    let mut groups: Vec<Vec<Clause>> = vec![vec![]];
    let mut chars = q.chars().peekable();
    let mut cur = String::new();
    let mut in_quote = false;
    let mut toks: Vec<String> = vec![];
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quote = !in_quote;
                cur.push(c);
            }
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    toks.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        toks.push(cur);
    }
    for t in toks {
        if t == "OR" {
            groups.push(vec![]);
            continue;
        }
        let (neg, t) = t.strip_prefix('-').map_or((false, t.as_str()), |r| (true, r));
        let unq = |s: &str| s.trim_matches('"').to_lowercase();
        let term = if let Some(v) = t.strip_prefix("file:") {
            Term::File(unq(v))
        } else if let Some(v) = t.strip_prefix("path:") {
            Term::Path(unq(v))
        } else if let Some(v) = t.strip_prefix("content:") {
            Term::Content(unq(v))
        } else if let Some(v) = t.strip_prefix("tag:") {
            Term::Tag(unq(v).trim_start_matches('#').to_string())
        } else if let Some(v) = t.strip_prefix("line:") {
            Term::Line(unq(v.trim_matches(['(', ')'])))
        } else {
            Term::Text(unq(t))
        };
        groups.last_mut().unwrap().push(Clause { neg, term });
    }
    groups.retain(|g| !g.is_empty());
    groups
}

pub fn search(vault: &Vault, meta: &MetadataCache, query: &str) -> Vec<SearchHit> {
    let groups = tokenize(query);
    if groups.is_empty() {
        return vec![];
    }
    let mut hits = vec![];
    for f in vault.files() {
        let lname = f.name.to_lowercase();
        let lpath = f.path.to_lowercase();
        let body = if f.is_markdown() { vault.read(&f.path).unwrap_or_default() } else { String::new() };
        let lbody = body.to_lowercase();
        let tags: Vec<String> = meta.get(&f.path).map(|m| all_tags(m)).unwrap_or_default();
        let mut matched_lines: Vec<(usize, String)> = vec![];
        let ok = groups.iter().any(|g| {
            g.iter().all(|c| {
                let r = match &c.term {
                    Term::File(s) => lname.contains(s),
                    Term::Path(s) => lpath.contains(s),
                    Term::Content(s) => lbody.contains(s),
                    Term::Tag(s) => tags.iter().any(|t| {
                        let t = t.trim_start_matches('#').to_lowercase();
                        t == *s || t.starts_with(&format!("{s}/"))
                    }),
                    Term::Line(s) => lbody.lines().any(|l| l.contains(s)),
                    Term::Text(s) => lname.contains(s) || lpath.contains(s) || lbody.contains(s),
                };
                if r && !c.neg {
                    if let Term::Text(s) | Term::Content(s) | Term::Line(s) = &c.term {
                        for (i, l) in body.lines().enumerate() {
                            if l.to_lowercase().contains(s) && !matched_lines.iter().any(|(n, _)| *n == i) {
                                matched_lines.push((i, l.to_string()));
                            }
                        }
                    }
                }
                r != c.neg
            })
        });
        if ok {
            matched_lines.sort();
            hits.push(SearchHit { path: f.path.clone(), lines: matched_lines });
        }
    }
    hits
}
