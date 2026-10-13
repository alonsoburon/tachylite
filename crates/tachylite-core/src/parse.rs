//! Markdown metadata extraction (links, embeds, tags, headings, sections, list items,
//! blocks, frontmatter). Output mirrors the public `CachedMetadata` shape from the
//! Obsidian plugin API so plugins and tools can consume it unchanged.
//!
//! Positions use UTF-16 code units for `col` and `offset`, matching what JavaScript
//! plugins observe.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Loc {
    pub line: usize,
    pub col: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Pos {
    pub start: Loc,
    pub end: Loc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkCache {
    pub link: String,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    pub position: Pos,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagCache {
    pub tag: String,
    pub position: Pos,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingCache {
    pub heading: String,
    pub level: u8,
    pub position: Pos,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SectionCache {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub position: Pos,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListItemCache {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub position: Pos,
    pub parent: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BlockCache {
    pub id: String,
    pub position: Pos,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterLinkCache {
    pub key: String,
    pub link: String,
    pub original: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedMetadata {
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub links: Vec<LinkCache>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub embeds: Vec<LinkCache>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub tags: Vec<TagCache>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub headings: Vec<HeadingCache>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub sections: Vec<SectionCache>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub list_items: Vec<ListItemCache>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty", default)]
    pub blocks: BTreeMap<String, BlockCache>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontmatter: Option<Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub frontmatter_position: Option<Pos>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub frontmatter_links: Vec<FrontmatterLinkCache>,
}

/// Maps byte offsets of the source text to (line, utf16 col, utf16 offset).
struct Index<'a> {
    text: &'a str,
    line_starts: Vec<usize>,
    ascii: bool,
}

impl<'a> Index<'a> {
    fn new(text: &'a str) -> Self {
        let mut line_starts = vec![0];
        for (i, b) in text.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        Index { text, line_starts, ascii: text.is_ascii() }
    }

    fn u16(&self, from: usize, to: usize) -> usize {
        if self.ascii {
            to - from
        } else {
            self.text[from..to].encode_utf16().count()
        }
    }

    fn loc(&self, byte: usize) -> Loc {
        let line = match self.line_starts.binary_search(&byte) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        Loc { line, col: self.u16(self.line_starts[line], byte), offset: self.u16(0, byte) }
    }

    fn pos(&self, start: usize, end: usize) -> Pos {
        Pos { start: self.loc(start), end: self.loc(end) }
    }
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("static regex"))
}

fn re_list() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(?:\[(.)\][ \t]+)?")
}
fn re_atx() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
}
fn re_fence() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^ {0,3}(`{3,}|~{3,})")
}
fn re_block_id() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$")
}
fn re_setext() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^ {0,3}(=+|-+)[ \t]*$")
}
fn re_hr() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$")
}

/// Extract the YAML frontmatter block. Returns (end byte offset, yaml text) when present.
fn split_frontmatter(text: &str) -> Option<(usize, usize, &str)> {
    let rest = text.strip_prefix("---")?;
    let nl = rest.find('\n')?;
    if !rest[..nl].trim().is_empty() {
        return None;
    }
    let body_start = 3 + nl + 1;
    let mut cursor = body_start;
    for line in text[body_start..].split_inclusive('\n') {
        let t = line.trim_end_matches(['\n', '\r']);
        if t.trim_end() == "---" || t.trim_end() == "..." {
            return Some((cursor + t.len(), body_start, &text[body_start..cursor]));
        }
        cursor += line.len();
    }
    None
}

pub fn parse(text: &str) -> CachedMetadata {
    let idx = Index::new(text);
    let mut meta = CachedMetadata::default();

    let mut body_from = 0usize;
    if let Some((end, ystart, yaml)) = split_frontmatter(text) {
        meta.frontmatter_position = Some(idx.pos(0, end));
        meta.sections.push(SectionCache { id: None, kind: "yaml".into(), position: idx.pos(0, end) });
        if let Ok(Value::Object(m)) = serde_yaml::from_str::<Value>(yaml) {
            collect_frontmatter_links(&m, &mut meta.frontmatter_links);
            meta.frontmatter = Some(m);
        } else if yaml.trim().is_empty() {
            meta.frontmatter = Some(Map::new());
        }
        let _ = ystart;
        body_from = end;
    }

    // Walk lines of the body, tracking fenced code and math blocks.
    struct Line<'a> {
        start: usize,
        text: &'a str,
    }
    let mut lines: Vec<Line> = Vec::new();
    let mut off = body_from;
    for raw in text[body_from..].split_inclusive('\n') {
        let t = raw.trim_end_matches(['\n', '\r']);
        lines.push(Line { start: off, text: t });
        off += raw.len();
    }
    // The first "line" after frontmatter is the remainder of the closing fence line.
    if body_from > 0 && !lines.is_empty() && lines[0].text.is_empty() {
        lines.remove(0);
    }

    #[derive(PartialEq)]
    enum Mode {
        Normal,
        Fence(char, usize),
        Math,
    }
    let mut mode = Mode::Normal;

    // Section assembly state.
    struct Sec {
        kind: &'static str,
        start: usize,
        end: usize,
        id: Option<String>,
    }
    let mut cur: Option<Sec> = None;
    let mut sections: Vec<Sec> = Vec::new();
    let flush = |cur: &mut Option<Sec>, sections: &mut Vec<Sec>| {
        if let Some(s) = cur.take() {
            sections.push(s);
        }
    };

    // List tracking: stack of (indent, line number).
    let mut list_stack: Vec<(usize, usize)> = Vec::new();
    let mut list_first_line: usize = 0;
    let mut prev_blank = true;

    for (n, ln) in lines.iter().enumerate() {
        let line_no = idx.loc(ln.start).line;
        let t = ln.text;
        let end = ln.start + t.len();
        let blank = t.trim().is_empty();

        match mode {
            Mode::Fence(ch, len) => {
                if let Some(c) = re_fence().captures(t) {
                    let f = &c[1];
                    if f.starts_with(ch) && f.len() >= len && t.trim_start().trim_start_matches(ch).trim().is_empty() {
                        mode = Mode::Normal;
                    }
                }
                if let Some(s) = cur.as_mut() {
                    s.end = end;
                }
                continue;
            }
            Mode::Math => {
                if t.contains("$$") {
                    mode = Mode::Normal;
                }
                if let Some(s) = cur.as_mut() {
                    s.end = end;
                }
                continue;
            }
            Mode::Normal => {}
        }

        if blank {
            flush(&mut cur, &mut sections);
            prev_blank = true;
            continue;
        }

        // Fence open.
        if let Some(c) = re_fence().captures(t) {
            let f = &c[1];
            let ch = f.chars().next().unwrap();
            if !(ch == '`' && t[c.get(0).unwrap().end()..].contains('`')) {
                flush(&mut cur, &mut sections);
                cur = Some(Sec { kind: "code", start: ln.start, end, id: None });
                mode = Mode::Fence(ch, f.len());
                prev_blank = false;
                continue;
            }
        }
        // Math block open: line starting with $$ and not closed on the same line.
        if t.trim_start().starts_with("$$") && t.matches("$$").count() == 1 {
            flush(&mut cur, &mut sections);
            cur = Some(Sec { kind: "math", start: ln.start, end, id: None });
            mode = Mode::Math;
            prev_blank = false;
            continue;
        }

        // Headings (ATX).
        if let Some(c) = re_atx().captures(t) {
            flush(&mut cur, &mut sections);
            let level = c[1].len() as u8;
            let heading = c.get(2).map_or("", |m| m.as_str()).trim().to_string();
            meta.headings.push(HeadingCache { heading, level, position: idx.pos(ln.start, end) });
            sections.push(Sec { kind: "heading", start: ln.start, end, id: None });
            scan_inline(&idx, t, ln.start, &mut meta, false);
            prev_blank = false;
            list_stack.clear();
            continue;
        }
        // Setext underline converts the paragraph above into a heading.
        if let (Some(c), Some(s)) = (re_setext().captures(t), cur.as_ref()) {
            if s.kind == "paragraph" && (!t.trim_start().starts_with('-') || !re_list().is_match(t)) {
                let level = if c[1].starts_with('=') { 1 } else { 2 };
                let s = cur.take().unwrap();
                let heading = text[s.start..s.end].lines().last().unwrap_or("").trim().to_string();
                meta.headings.push(HeadingCache { heading, level, position: idx.pos(s.start, end) });
                sections.push(Sec { kind: "heading", start: s.start, end, id: None });
                continue;
            }
        }
        if re_hr().is_match(t) {
            flush(&mut cur, &mut sections);
            sections.push(Sec { kind: "thematic-break", start: ln.start, end, id: None });
            prev_blank = false;
            continue;
        }

        // List items.
        if let Some(c) = re_list().captures(t) {
            let indent = c[1].replace('\t', "    ").len();
            let task = c.get(3).map(|m| m.as_str().to_string());
            let in_list = cur.as_ref().is_some_and(|s| s.kind == "list");
            if !in_list {
                flush(&mut cur, &mut sections);
                list_stack.clear();
                list_first_line = line_no;
                cur = Some(Sec { kind: "list", start: ln.start, end, id: None });
            }
            while list_stack.last().is_some_and(|(i, _)| *i >= indent) {
                list_stack.pop();
            }
            let parent = list_stack.last().map_or(-(list_first_line as i64), |(_, l)| *l as i64);
            list_stack.push((indent, line_no));
            let id = re_block_id().captures(t).map(|b| b[1].to_string());
            let marker_start = ln.start + c[1].len();
            meta.list_items.push(ListItemCache { id: id.clone(), position: idx.pos(marker_start, end), parent, task });
            if let (Some(id), Some(s)) = (id, cur.as_mut()) {
                s.id = Some(id);
            }
            if let Some(s) = cur.as_mut() {
                s.end = end;
            }
            scan_inline(&idx, t, ln.start, &mut meta, false);
            prev_blank = false;
            continue;
        }

        // Continuation or new block.
        let kind = if t.trim_start().starts_with('>') {
            if t.trim_start().trim_start_matches('>').trim_start().starts_with("[!") {
                "callout"
            } else {
                "blockquote"
            }
        } else if t.trim_start().starts_with('|') {
            "table"
        } else if t.trim_start().starts_with('<') {
            "html"
        } else {
            "paragraph"
        };
        let continues = cur.as_ref().is_some_and(|s| s.kind == kind || (s.kind == "list" && !prev_blank) || (s.kind == "blockquote" && kind == "paragraph"))
            && !(prev_blank && cur.as_ref().is_some_and(|s| s.kind != "list"));
        if continues {
            let s = cur.as_mut().unwrap();
            s.end = end;
        } else {
            flush(&mut cur, &mut sections);
            list_stack.clear();
            cur = Some(Sec { kind, start: ln.start, end, id: None });
        }
        if let Some(s) = cur.as_mut() {
            if let Some(b) = re_block_id().captures(t) {
                s.id = Some(b[1].to_string());
            }
        }
        scan_inline(&idx, t, ln.start, &mut meta, kind == "table");
        prev_blank = false;
        let _ = n;
    }
    flush(&mut cur, &mut sections);

    for s in sections {
        let position = idx.pos(s.start, s.end);
        if let Some(id) = &s.id {
            meta.blocks.insert(id.clone(), BlockCache { id: id.clone(), position });
        }
        meta.sections.push(SectionCache { id: s.id, kind: s.kind.into(), position });
    }
    meta.sections.sort_by_key(|s| s.position.start.offset);
    meta
}

fn collect_frontmatter_links(m: &Map<String, Value>, out: &mut Vec<FrontmatterLinkCache>) {
    fn walk(key: &str, v: &Value, out: &mut Vec<FrontmatterLinkCache>) {
        match v {
            Value::String(s) => {
                static R: OnceLock<Regex> = OnceLock::new();
                let r = re(&R, r"\[\[([^\[\]|]+?)(?:\|([^\[\]]*?))?\]\]");
                for c in r.captures_iter(s) {
                    out.push(FrontmatterLinkCache {
                        key: key.to_string(),
                        link: c[1].trim().to_string(),
                        original: c[0].to_string(),
                        display_text: c.get(2).map(|d| d.as_str().to_string()),
                    });
                }
            }
            Value::Array(a) => a.iter().enumerate().for_each(|(i, x)| walk(&format!("{key}.{i}"), x, out)),
            Value::Object(o) => o.iter().for_each(|(k, x)| walk(&format!("{key}.{k}"), x, out)),
            _ => {}
        }
    }
    for (k, v) in m {
        walk(k, v, out);
    }
}

/// Byte ranges of inline code spans in a line (backtick runs must match in length).
fn code_spans(line: &str) -> Vec<(usize, usize)> {
    let b = line.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        if b[i] == b'`' {
            let s = i;
            while i < b.len() && b[i] == b'`' {
                i += 1;
            }
            let n = i - s;
            let mut j = i;
            let mut found = None;
            while j < b.len() {
                if b[j] == b'`' {
                    let c = j;
                    while j < b.len() && b[j] == b'`' {
                        j += 1;
                    }
                    if j - c == n {
                        found = Some(j);
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            if let Some(e) = found {
                spans.push((s, e));
                i = e;
            }
        } else {
            i += 1;
        }
    }
    spans
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

fn has_scheme(s: &str) -> bool {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^[A-Za-z][A-Za-z0-9+.\-]*:").is_match(s)
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// Find links, embeds and tags in one line of body text.
fn scan_inline(idx: &Index, line: &str, line_start: usize, meta: &mut CachedMetadata, in_table: bool) {
    let spans = code_spans(line);
    let in_code = |i: usize| spans.iter().any(|(s, e)| i >= *s && i < *e);
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if in_code(i) {
            i += 1;
            continue;
        }
        // Escaped characters are literal.
        if b[i] == b'\\' {
            i += 2;
            continue;
        }
        let embed = b[i] == b'!' && i + 1 < b.len() && (b[i + 1] == b'[');
        let open = if embed { i + 1 } else { i };
        if open < b.len() && b[open] == b'[' {
            // Wikilink.
            if line[open..].starts_with("[[") {
                if let Some(rel) = line[open + 2..].find("]]") {
                    let inner = &line[open + 2..open + 2 + rel];
                    if !inner.is_empty() && !inner.contains("[[") {
                        let end = open + 2 + rel + 2;
                        let sep = if in_table { split_unescaped_pipe(inner) } else { inner.split_once('|') };
                        let (target, alias) = match sep {
                            Some((a, b)) => (a, Some(b)),
                            None => (inner, None),
                        };
                        let target = target.trim();
                        let target = target.trim_end_matches('\\');
                        let link = LinkCache {
                            link: target.to_string(),
                            original: line[i..end].to_string(),
                            display_text: Some(alias.map_or(target, str::trim).to_string()),
                            position: idx.pos(line_start + i, line_start + end),
                        };
                        if embed {
                            meta.embeds.push(link)
                        } else {
                            meta.links.push(link)
                        }
                        i = end;
                        continue;
                    }
                }
            }
            // Markdown link [text](dest).
            if let Some(close) = find_matching_bracket(line, open) {
                if line[close + 1..].starts_with('(') {
                    if let Some((dest, end)) = parse_dest(line, close + 2) {
                        if !has_scheme(&dest) && !dest.starts_with('#') || (dest.starts_with('#') && dest.len() > 1) {
                            let text = &line[open + 1..close];
                            let link = LinkCache {
                                link: percent_decode(&dest),
                                original: line[i..end].to_string(),
                                display_text: Some(text.to_string()),
                                position: idx.pos(line_start + i, line_start + end),
                            };
                            if embed {
                                meta.embeds.push(link)
                            } else {
                                meta.links.push(link)
                            }
                        }
                        i = end;
                        continue;
                    }
                }
            }
        }
        if b[i] == b'#' {
            let prev_ok = i == 0 || {
                let p = line[..i].chars().next_back().unwrap();
                !is_tag_char(p) && p != '#' && p != '&'
            };
            if prev_ok {
                let rest = &line[i + 1..];
                let len: usize = rest.chars().take_while(|c| is_tag_char(*c)).map(char::len_utf8).sum();
                let name = &rest[..len];
                if !name.is_empty() && name.chars().any(|c| !c.is_ascii_digit()) {
                    let name = name.trim_end_matches('/');
                    if !name.is_empty() && !name.contains("//") {
                        let end = i + 1 + name.len();
                        meta.tags.push(TagCache { tag: format!("#{name}"), position: idx.pos(line_start + i, line_start + end) });
                        i = end;
                        continue;
                    }
                }
            }
        }
        i += line[i..].chars().next().map_or(1, char::len_utf8);
    }
}

fn split_unescaped_pipe(s: &str) -> Option<(&str, &str)> {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() && b[i + 1] == b'|' {
            return Some((&s[..i], &s[i + 2..]));
        }
        if b[i] == b'|' {
            return Some((&s[..i], &s[i + 1..]));
        }
        i += 1;
    }
    None
}

fn find_matching_bracket(line: &str, open: usize) -> Option<usize> {
    let b = line.as_bytes();
    let mut depth = 0;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 1,
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Parse a link destination starting after `(`; returns (dest, index after `)`).
fn parse_dest(line: &str, start: usize) -> Option<(String, usize)> {
    let rest = &line[start..];
    if let Some(r) = rest.strip_prefix('<') {
        let e = r.find('>')?;
        let after = &r[e + 1..];
        let close = after.find(')')?;
        return Some((r[..e].to_string(), start + 1 + e + 1 + close + 1));
    }
    let mut depth = 0;
    for (i, c) in rest.char_indices() {
        match c {
            '(' => depth += 1,
            ')' if depth == 0 => {
                let dest = rest[..i].split_whitespace().next().unwrap_or("").to_string();
                return Some((dest, start + i + 1));
            }
            ')' => depth -= 1,
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wikilinks_embeds_tags() {
        let m = parse("# Title\n\nSee [[Note A#Sec|alias]] and ![[img.png]] #todo/now `[[no]]` #123\n");
        assert_eq!(m.links.len(), 1);
        assert_eq!(m.links[0].link, "Note A#Sec");
        assert_eq!(m.links[0].display_text.as_deref(), Some("alias"));
        assert_eq!(m.embeds[0].link, "img.png");
        assert_eq!(m.tags.iter().map(|t| t.tag.as_str()).collect::<Vec<_>>(), ["#todo/now"]);
        assert_eq!(m.headings[0].heading, "Title");
    }

    #[test]
    fn frontmatter_and_positions() {
        let m = parse("---\ntitle: x\ntags: [a, b]\nup: \"[[Parent]]\"\n---\nbody [[Z]]\n");
        assert_eq!(m.frontmatter.as_ref().unwrap()["title"], "x");
        assert_eq!(m.frontmatter_links[0].link, "Parent");
        assert_eq!(m.links[0].position.start.line, 5);
        assert_eq!(m.links[0].position.start.col, 5);
    }

    #[test]
    fn utf16_columns() {
        let m = parse("😀 [[a]]");
        assert_eq!(m.links[0].position.start.col, 3);
    }

    #[test]
    fn markdown_links_and_code_blocks() {
        let m = parse("[x](Folder/My%20Note.md) [e](https://a.b)\n```\n[[skip]] #skip\n```\n");
        assert_eq!(m.links.len(), 1);
        assert_eq!(m.links[0].link, "Folder/My Note.md");
        assert!(m.tags.is_empty());
        assert!(m.sections.iter().any(|s| s.kind == "code"));
    }

    #[test]
    fn lists_tasks_blocks() {
        let m = parse("- [ ] a\n  - [x] b ^blk\n- c\n\npara ^p1\n");
        assert_eq!(m.list_items.len(), 3);
        assert_eq!(m.list_items[0].task.as_deref(), Some(" "));
        assert_eq!(m.list_items[1].parent, 0);
        assert_eq!(m.list_items[2].parent, 0);
        assert!(m.blocks.contains_key("blk") && m.blocks.contains_key("p1"));
    }

    #[test]
    fn table_escaped_pipe() {
        let m = parse("| a |\n|---|\n| [[X\\|y]] |\n");
        assert_eq!(m.links[0].link, "X");
        assert_eq!(m.links[0].display_text.as_deref(), Some("y"));
    }
}
