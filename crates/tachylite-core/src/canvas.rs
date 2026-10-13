//! JSON Canvas (`.canvas`, <https://jsoncanvas.org/spec/1.0/>) references for the link graph.
//! Obsidian counts the files a canvas shows in `resolvedLinks`: file nodes (an exact vault path,
//! optionally with a `#subpath`) and the links/embeds written in text nodes' markdown.

use crate::parse;
use serde_json::Value;

/// Link paths referenced by a canvas file, in node order. File nodes yield their vault path,
/// text nodes every `[[link]]` / `![[embed]]` / markdown link they contain. Invalid JSON yields none.
pub fn canvas_links(text: &str) -> Vec<String> {
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(text) else { return vec![] };
    let Some(Value::Array(nodes)) = root.get("nodes") else { return vec![] };
    let mut out = vec![];
    for n in nodes {
        match n.get("type").and_then(Value::as_str) {
            Some("file") => {
                if let Some(f) = n.get("file").and_then(Value::as_str).filter(|f| !f.is_empty()) {
                    out.push(f.to_string());
                }
            }
            Some("text") => {
                if let Some(t) = n.get("text").and_then(Value::as_str) {
                    let m = parse::parse(t);
                    out.extend(m.links.into_iter().chain(m.embeds).map(|l| l.link));
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_file_nodes_and_text_links() {
        let c = r##"{"nodes":[
            {"id":"a","type":"file","file":"dir/Note.md","subpath":"#H","x":0,"y":0,"width":1,"height":1},
            {"id":"b","type":"text","text":"see [[Other]] and ![[pic.png]]","x":0,"y":0,"width":1,"height":1},
            {"id":"c","type":"link","url":"https://example.com","x":0,"y":0,"width":1,"height":1},
            {"id":"d","type":"group","label":"G","x":0,"y":0,"width":1,"height":1},
            {"id":"e","type":"file","file":"","x":0,"y":0,"width":1,"height":1}
        ],"edges":[]}"##;
        assert_eq!(canvas_links(c), vec!["dir/Note.md", "Other", "pic.png"]);
    }

    #[test]
    fn tolerates_empty_and_invalid_files() {
        assert!(canvas_links("").is_empty());
        assert!(canvas_links("{}").is_empty());
        assert!(canvas_links("not json").is_empty());
        assert!(canvas_links(r#"{"nodes":{}}"#).is_empty());
    }
}
