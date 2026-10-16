//! Vault search with Obsidian's query language.
//!
//! Plain words and `"exact phrases"` (all must match, case-insensitively), `-negation`, `OR`, `( grouping )`,
//! `/regular expressions/`, and the operators `file:` `path:` `content:` `tag:` `property:` (or `[key:value]`),
//! `line:` `block:` `section:` `task:` `task-todo:` `task-done:` and `match-case:` / `ignore-case:`.
//! An operator takes a word, a quoted phrase, a regex or a parenthesised group; for `line:` / `block:` /
//! `section:` / `task:` the whole group has to match inside one line / paragraph / heading section / task.

use crate::metadata::{all_tags, MetadataCache};
use crate::vault::Vault;
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    /// (line number, line text) matches inside the file; empty for name/path-only matches.
    pub lines: Vec<(usize, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    /// A plain term: file name, path or content.
    Any,
    File,
    Path,
    Content,
    Tag,
    Line,
    Block,
    Section,
    Task,
    TaskTodo,
    TaskDone,
}

#[derive(Debug, Clone)]
enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    /// A word, phrase or regex, optionally case sensitive.
    Text {
        pat: Pat,
        case: bool,
    },
    /// An operator applied to a sub-expression (`line:(a b)`, `tag:#x`, `file:name`, ...).
    Scoped {
        scope: Scope,
        inner: Box<Node>,
    },
    /// `[key]` or `[key:value]`.
    Property {
        key: String,
        value: Option<String>,
    },
}

#[derive(Debug, Clone)]
enum Pat {
    Lit(String),
    Re(Regex),
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

fn scope_of(op: &str) -> Option<Scope> {
    Some(match op {
        "file" => Scope::File,
        "path" => Scope::Path,
        "content" => Scope::Content,
        "tag" => Scope::Tag,
        "line" => Scope::Line,
        "block" => Scope::Block,
        "section" => Scope::Section,
        "task" => Scope::Task,
        "task-todo" => Scope::TaskTodo,
        "task-done" => Scope::TaskDone,
        _ => return None,
    })
}

impl Parser<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }
    fn skip_ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.i += 1;
        }
    }
    /// `a b OR c d` -> Or([And([a, b]), And([c, d])]); stops at an unmatched `)`.
    fn expr(&mut self, depth: usize) -> Node {
        let mut groups: Vec<Vec<Node>> = vec![vec![]];
        loop {
            self.skip_ws();
            match self.peek() {
                None => break,
                Some(')') if depth > 0 => break,
                Some(')') => {
                    self.i += 1; // a stray ")" at the top level is ignored
                }
                _ => {
                    if self.word_is("OR") {
                        self.i += 2;
                        groups.push(vec![]);
                    } else if let Some(n) = self.item(depth) {
                        groups.last_mut().unwrap().push(n);
                    }
                }
            }
        }
        let mut alts: Vec<Node> =
            groups.into_iter().filter(|g| !g.is_empty()).map(|mut g| if g.len() == 1 { g.pop().unwrap() } else { Node::And(g) }).collect();
        match alts.len() {
            0 => Node::And(vec![]),
            1 => alts.pop().unwrap(),
            _ => Node::Or(alts),
        }
    }
    /// True when the upcoming characters are exactly the keyword `w` followed by whitespace, `(` or the end.
    fn word_is(&self, w: &str) -> bool {
        let end = self.i + w.chars().count();
        self.s.get(self.i..end).is_some_and(|x| x.iter().copied().eq(w.chars())) && self.s.get(end).is_none_or(|c| c.is_whitespace() || *c == '(')
    }
    fn item(&mut self, depth: usize) -> Option<Node> {
        let neg = self.peek() == Some('-') && self.s.get(self.i + 1).is_some_and(|c| !c.is_whitespace());
        if neg {
            self.i += 1;
        }
        let node = self.atom(depth)?;
        Some(if neg { Node::Not(Box::new(node)) } else { node })
    }
    fn atom(&mut self, depth: usize) -> Option<Node> {
        match self.peek()? {
            '(' => {
                self.i += 1;
                let n = self.expr(depth + 1);
                if self.peek() == Some(')') {
                    self.i += 1;
                }
                Some(n)
            }
            '[' => self.property(),
            _ => {
                if let Some((op, len)) = self.operator() {
                    self.i += len;
                    return self.operator_arg(&op, depth);
                }
                self.term(false)
            }
        }
    }
    /// A known `name:` prefix at the cursor (unknown prefixes are ordinary text, as in "note: hello").
    fn operator(&self) -> Option<(String, usize)> {
        let mut j = self.i;
        while self.s.get(j).is_some_and(|c| c.is_ascii_alphabetic() || *c == '-') {
            j += 1;
        }
        if j == self.i || self.s.get(j) != Some(&':') {
            return None;
        }
        let name: String = self.s[self.i..j].iter().collect::<String>().to_lowercase();
        let known = scope_of(&name).is_some() || matches!(name.as_str(), "match-case" | "ignore-case" | "property");
        known.then_some((name, j + 1 - self.i))
    }
    fn operator_arg(&mut self, op: &str, depth: usize) -> Option<Node> {
        match op {
            "property" => {
                if self.peek() == Some('[') {
                    self.property()
                } else {
                    None
                }
            }
            "match-case" | "ignore-case" => {
                let mut n = self.arg(depth)?;
                set_case(&mut n, op == "match-case");
                Some(n)
            }
            _ => {
                let scope = scope_of(op)?;
                let inner = self.arg(depth)?;
                Some(Node::Scoped { scope, inner: Box::new(inner) })
            }
        }
    }
    /// What follows an operator: a group, a quoted phrase, a regex or a bare word.
    fn arg(&mut self, depth: usize) -> Option<Node> {
        if self.peek() == Some('(') {
            return self.atom(depth);
        }
        self.term(true)
    }
    fn term(&mut self, after_op: bool) -> Option<Node> {
        match self.peek()? {
            '"' => {
                self.i += 1;
                let start = self.i;
                while self.peek().is_some_and(|c| c != '"') {
                    self.i += 1;
                }
                let t: String = self.s[start..self.i].iter().collect();
                if self.peek() == Some('"') {
                    self.i += 1;
                }
                Some(Node::Text { pat: Pat::Lit(t), case: false })
            }
            '/' => {
                // /regex/ with a closing slash followed by a delimiter; otherwise a plain word starting with "/".
                let mut j = self.i + 1;
                while self.s.get(j).is_some_and(|c| *c != '/') {
                    j += if self.s[j] == '\\' { 2 } else { 1 };
                }
                if self.s.get(j) == Some(&'/') && self.s.get(j + 1).is_none_or(|c| c.is_whitespace() || *c == ')') {
                    let src: String = self.s[self.i + 1..j].iter().collect();
                    if let Ok(re) = RegexBuilder::new(&src).case_insensitive(true).build() {
                        self.i = j + 1;
                        return Some(Node::Text { pat: Pat::Re(re), case: false });
                    }
                }
                self.bare(after_op)
            }
            _ => self.bare(after_op),
        }
    }
    fn bare(&mut self, _after_op: bool) -> Option<Node> {
        let start = self.i;
        while self.peek().is_some_and(|c| !c.is_whitespace() && c != ')') {
            self.i += 1;
        }
        if self.i == start {
            self.i += 1;
            return None;
        }
        Some(Node::Text { pat: Pat::Lit(self.s[start..self.i].iter().collect()), case: false })
    }
    fn property(&mut self) -> Option<Node> {
        self.i += 1; // [
        let start = self.i;
        let mut quoted = false;
        while let Some(c) = self.peek() {
            match c {
                '"' => quoted = !quoted,
                ']' if !quoted => break,
                _ => {}
            }
            self.i += 1;
        }
        let inner: String = self.s[start..self.i].iter().collect();
        if self.peek() == Some(']') {
            self.i += 1;
        }
        let (key, value) = match inner.split_once(':') {
            Some((k, v)) => (k.trim(), Some(v.trim().trim_matches('"').to_string())),
            None => (inner.trim(), None),
        };
        (!key.is_empty()).then(|| Node::Property { key: key.to_lowercase(), value })
    }
}

fn set_case(n: &mut Node, case: bool) {
    match n {
        Node::And(v) | Node::Or(v) => v.iter_mut().for_each(|c| set_case(c, case)),
        Node::Not(b) => set_case(b, case),
        Node::Scoped { inner, .. } => set_case(inner, case),
        Node::Text { case: c, pat } => {
            *c = case;
            if let Pat::Re(re) = pat {
                if let Ok(r) = RegexBuilder::new(re.as_str()).case_insensitive(!case).build() {
                    *re = r;
                }
            }
        }
        Node::Property { .. } => {}
    }
}

fn matches_text(pat: &Pat, case: bool, hay: &str) -> bool {
    match pat {
        Pat::Lit(s) => {
            if case {
                hay.contains(s.as_str())
            } else {
                hay.to_lowercase().contains(&s.to_lowercase())
            }
        }
        Pat::Re(re) => re.is_match(hay),
    }
}

struct Ctx<'a> {
    name: &'a str,
    path: &'a str,
    body: &'a str,
    lines: Vec<&'a str>,
    tags: Vec<String>,
    fm: Option<&'a serde_json::Map<String, Value>>,
}

/// Does the expression hold for one text scope (a line, paragraph, section or task)? Operators other than the
/// text terms themselves cannot be evaluated inside a scope and count as true.
fn holds_in(node: &Node, hay: &str) -> bool {
    match node {
        Node::And(v) => v.iter().all(|c| holds_in(c, hay)),
        Node::Or(v) => v.iter().any(|c| holds_in(c, hay)),
        Node::Not(b) => !holds_in(b, hay),
        Node::Text { pat, case } => matches_text(pat, *case, hay),
        Node::Scoped { inner, .. } => holds_in(inner, hay),
        Node::Property { .. } => true,
    }
}

fn task_text(line: &str) -> Option<(char, &str)> {
    let t = line.trim_start();
    let t = t.strip_prefix(['-', '*', '+'])?.trim_start();
    let rest = t.strip_prefix('[')?;
    let mut it = rest.char_indices();
    let (_, status) = it.next()?;
    let (close, c) = it.next()?;
    (c == ']').then(|| (status, rest[close + 1..].trim_start()))
}

fn value_to_strings(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) => a.iter().flat_map(value_to_strings).collect(),
        Value::String(s) => vec![s.clone()],
        Value::Null => vec![],
        other => vec![other.to_string()],
    }
}

fn eval(node: &Node, cx: &Ctx, lines_hit: &mut Vec<usize>, record: bool) -> bool {
    match node {
        Node::And(v) => v.iter().all(|c| eval(c, cx, lines_hit, record)),
        Node::Or(v) => {
            let mut any = false;
            for c in v {
                any |= eval(c, cx, lines_hit, record); // no short circuit: every alternative may add match lines
            }
            any
        }
        Node::Not(b) => !eval(b, cx, lines_hit, false),
        Node::Text { .. } => eval_scope(Scope::Any, node, cx, lines_hit, record),
        Node::Scoped { scope, inner } => eval_scope(*scope, inner, cx, lines_hit, record),
        Node::Property { key, value } => {
            let Some(fm) = cx.fm else { return false };
            let Some((_, v)) = fm.iter().find(|(k, _)| k.to_lowercase() == *key) else { return false };
            match value {
                None => !v.is_null(),
                Some(want) => value_to_strings(v).iter().any(|s| s.to_lowercase().contains(&want.to_lowercase())) || (want == "null" && v.is_null()),
            }
        }
    }
}

fn eval_scope(scope: Scope, inner: &Node, cx: &Ctx, lines_hit: &mut Vec<usize>, record: bool) -> bool {
    // A boolean combination under an operator (`file:(a OR b)`, `tag:(x y)`) applies that operator to each leaf.
    match inner {
        Node::And(v) if !matches!(scope, Scope::Any | Scope::Line | Scope::Block | Scope::Section | Scope::Task | Scope::TaskTodo | Scope::TaskDone) => {
            return v.iter().all(|c| eval_scope(scope, c, cx, lines_hit, record));
        }
        Node::Or(v) if !matches!(scope, Scope::Any | Scope::Line | Scope::Block | Scope::Section | Scope::Task | Scope::TaskTodo | Scope::TaskDone) => {
            let mut any = false;
            for c in v {
                any |= eval_scope(scope, c, cx, lines_hit, record);
            }
            return any;
        }
        Node::Not(b) if !matches!(scope, Scope::Any) => return !eval_scope(scope, b, cx, lines_hit, false),
        _ => {}
    }
    let (pat, case) = match inner {
        Node::Text { pat, case } => (Some(pat), *case),
        _ => (None, false),
    };
    let text = |hay: &str| match pat {
        Some(p) => matches_text(p, case, hay),
        None => holds_in(inner, hay),
    };
    // Match lines are reported for the words a content-like operator found.
    let note = |hit: &mut Vec<usize>, idxs: Vec<usize>| {
        if record {
            for i in idxs {
                if !hit.contains(&i) {
                    hit.push(i);
                }
            }
        }
    };
    match scope {
        Scope::Any => {
            let in_name = text(cx.name) || text(cx.path);
            let idxs: Vec<usize> = cx.lines.iter().enumerate().filter(|(_, l)| text(l)).map(|(i, _)| i).collect();
            let ok = in_name || !idxs.is_empty() || (pat.is_some() && text(cx.body));
            if ok {
                note(lines_hit, idxs);
            }
            ok
        }
        Scope::File => text(cx.name),
        Scope::Path => text(cx.path),
        Scope::Content => {
            let ok = text(cx.body);
            if ok {
                note(lines_hit, cx.lines.iter().enumerate().filter(|(_, l)| text(l)).map(|(i, _)| i).collect());
            }
            ok
        }
        Scope::Tag => match pat {
            Some(Pat::Lit(s)) => {
                let want = s.trim_start_matches('#').to_lowercase();
                cx.tags.iter().any(|t| {
                    let t = t.trim_start_matches('#').to_lowercase();
                    t == want || t.starts_with(&format!("{want}/"))
                })
            }
            Some(Pat::Re(re)) => cx.tags.iter().any(|t| re.is_match(t.trim_start_matches('#'))),
            None => false,
        },
        Scope::Line => {
            let idxs: Vec<usize> = cx.lines.iter().enumerate().filter(|(_, l)| text(l)).map(|(i, _)| i).collect();
            let ok = !idxs.is_empty();
            if ok {
                note(lines_hit, idxs);
            }
            ok
        }
        Scope::Block => {
            let mut hit = vec![];
            let mut start = 0;
            for (i, l) in cx.lines.iter().chain(std::iter::once(&"")).enumerate() {
                if l.trim().is_empty() {
                    if i > start && text(&cx.lines[start..i].join("\n")) {
                        hit.push(start);
                    }
                    start = i + 1;
                }
            }
            let ok = !hit.is_empty();
            note(lines_hit, hit);
            ok
        }
        Scope::Section => {
            let heading = |l: &str| {
                l.trim_start().starts_with('#')
                    && l.trim_start().trim_start_matches('#').starts_with(' ')
                    && l.trim_start().len() - l.trim_start().trim_start_matches('#').len() <= 6
            };
            let mut hit = vec![];
            let mut start = 0;
            for i in 1..=cx.lines.len() {
                if i == cx.lines.len() || heading(cx.lines[i]) {
                    if text(&cx.lines[start..i].join("\n")) {
                        hit.push(start);
                    }
                    start = i;
                }
            }
            let ok = !hit.is_empty();
            note(lines_hit, hit);
            ok
        }
        Scope::Task | Scope::TaskTodo | Scope::TaskDone => {
            let idxs: Vec<usize> = cx
                .lines
                .iter()
                .enumerate()
                .filter(|(_, l)| {
                    task_text(l).is_some_and(|(status, rest)| match scope {
                        Scope::TaskTodo => status == ' ',
                        Scope::TaskDone => status != ' ',
                        _ => true,
                    } && text(rest))
                })
                .map(|(i, _)| i)
                .collect();
            let ok = !idxs.is_empty();
            note(lines_hit, idxs);
            ok
        }
    }
}

pub fn search(vault: &Vault, meta: &MetadataCache, query: &str) -> Vec<SearchHit> {
    let chars: Vec<char> = query.chars().collect();
    let root = Parser { s: &chars, i: 0 }.expr(0);
    if matches!(&root, Node::And(v) if v.is_empty()) {
        return vec![];
    }
    let mut hits = vec![];
    for f in vault.files() {
        let body = if f.is_markdown() { vault.read(&f.path).unwrap_or_default() } else { String::new() };
        let m = meta.get(&f.path);
        let cx = Ctx {
            name: &f.name,
            path: &f.path,
            body: &body,
            lines: body.lines().collect(),
            tags: m.map(all_tags).unwrap_or_default(),
            fm: m.and_then(|m| m.frontmatter.as_ref()),
        };
        let mut idxs = vec![];
        if eval(&root, &cx, &mut idxs, true) {
            idxs.sort_unstable();
            hits.push(SearchHit { path: f.path.clone(), lines: idxs.into_iter().map(|i| (i, cx.lines[i].to_string())).collect() });
        }
    }
    hits
}
