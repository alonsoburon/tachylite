use std::fs;
use tachylite_core::Workspace;

const CANVAS: &str = r#"{"nodes":[{"id":"a","type":"file","file":"dir/B.md","x":0,"y":0,"width":400,"height":400},{"id":"b","type":"text","text":"[[C]] [[Gone]]","x":0,"y":0,"width":250,"height":60}],"edges":[]}"#;

#[test]
fn canvas_references_count_as_links_and_follow_writes() {
    let d = tempfile::tempdir().unwrap();
    for (p, c) in [("board.canvas", CANVAS), ("dir/B.md", ""), ("C.md", "")] {
        let abs = d.path().join(p);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, c).unwrap();
    }
    let mut ws = Workspace::open(d.path()).unwrap();
    assert_eq!(ws.meta.resolved_links["board.canvas"]["dir/B.md"], 1);
    assert_eq!(ws.meta.resolved_links["board.canvas"]["C.md"], 1);
    assert_eq!(ws.meta.unresolved_links["board.canvas"]["Gone"], 1);
    assert_eq!(ws.meta.backlinks("dir/B.md").keys().collect::<Vec<_>>(), vec!["board.canvas"]);
    // No markdown metadata is made up for the canvas itself.
    assert!(ws.meta.get("board.canvas").is_none());

    ws.write("board.canvas", r#"{"nodes":[],"edges":[]}"#).unwrap();
    assert!(ws.meta.resolved_links["board.canvas"].is_empty());
    ws.write("new.canvas", r#"{"nodes":[{"id":"x","type":"file","file":"C.md","x":0,"y":0,"width":1,"height":1}]}"#).unwrap();
    assert_eq!(ws.meta.backlinks("C.md").keys().collect::<Vec<_>>(), vec!["new.canvas"]);
    ws.vault.delete("new.canvas").unwrap();
    ws.meta.remove_file("new.canvas");
    assert!(ws.meta.backlinks("C.md").is_empty());
}
