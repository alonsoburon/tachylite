//! Seeded random Markdown soup (with multibyte characters) must never panic the metadata parser, and positions stay inside the text.
use tachylite_core::parse::parse;

const TOKENS: &[&str] = &[
    "[[",
    "]]",
    "![[",
    "|",
    "#",
    "#tag",
    "#é",
    "日本",
    "😀",
    "e\u{301}",
    "^blk",
    " ^id",
    "**",
    "`",
    "```",
    "\n",
    "\n\n",
    "> ",
    "- ",
    "- [ ] ",
    "1. ",
    "---",
    "===",
    "%%",
    "$$",
    "[a](",
    "](u)",
    "<",
    ">",
    "\\",
    "\t",
    " ",
    "word",
    "[^1]",
    "[^1]: n",
    "# H",
    "## ",
    "\r\n",
    "\u{feff}",
    "---\ntags: [a]\n---\n",
    "tags: x",
    "N#H#S",
    "[[N#^b|al]]",
];

#[test]
fn parser_never_panics_on_random_markdown() {
    let mut seed: u64 = 0x9e3779b97f4a7c15;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    for _ in 0..4000 {
        let n = 3 + next() % 30;
        let doc: String = (0..n).map(|_| TOKENS[next() % TOKENS.len()]).collect();
        let m = parse(&doc);
        // Offsets are UTF-16 code units (like the plugin API's), so they stay within the document's UTF-16 length.
        let len = doc.encode_utf16().count();
        for t in &m.tags {
            assert!(t.position.start.offset < t.position.end.offset && t.position.end.offset <= len, "{doc:?}");
        }
        for l in m.links.iter().chain(m.embeds.iter()) {
            assert!(l.position.start.offset <= l.position.end.offset && l.position.end.offset <= len, "{doc:?}");
        }
    }
}

#[test]
fn escapes_and_code_before_multibyte_characters() {
    // A backslash or code span right before a multibyte character used to leave the scanner inside the character.
    for doc in ["\\é [[a]] #tag", "`é` [[a]]", "\\\u{feff}[[a]]", "\\😀#t"] {
        let m = parse(doc);
        assert!(m.links.len() + m.tags.len() <= 2, "{doc:?}");
    }
    assert_eq!(parse("\\é [[a]]").links[0].link, "a");
}

#[test]
fn search_never_panics_on_random_queries() {
    use tachylite_core::{search::search, Workspace};
    let d = tempfile::tempdir().unwrap();
    for (p, c) in [
        ("A.md", "---\nstatus: draft\ntags: [x]\n---\n# Apples é\nRed apples 😀 are sweet. #tag\n- [ ] task\n"),
        ("B/é.md", "日本語 text\n\n```\ncode block\n```\n"),
        ("C.md", ""),
    ] {
        let abs = d.path().join(p);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(abs, c).unwrap();
    }
    let ws = Workspace::open(d.path()).unwrap();
    const Q: &[&str] = &[
        "file:",
        "path:",
        "content:",
        "tag:",
        "tag:#x",
        "line:(",
        "block:(",
        "section:(",
        "task:",
        "task-todo:",
        "task-done:",
        "match-case:",
        "ignore-case:",
        "[status:draft]",
        "[status]",
        "[",
        "]",
        "[x:",
        "/re/",
        "/[/",
        "/(a|b)+/",
        "/",
        "\"",
        "\"phrase",
        "(",
        ")",
        "-",
        "OR",
        "AND",
        " ",
        "apples",
        "é",
        "日本",
        "😀",
        "\\",
        "*",
        "?",
        "^",
        "$",
        ":",
        "#",
        "-tag:",
        "(a OR (b",
        "\u{301}",
    ];
    let mut seed: u64 = 0xdeadbeefcafef00d;
    let mut next = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as usize
    };
    for _ in 0..3000 {
        let n = 1 + next() % 8;
        let q: String = (0..n).map(|_| Q[next() % Q.len()]).collect::<Vec<_>>().join(if next() % 2 == 0 { " " } else { "" });
        let _ = search(&ws.vault, &ws.meta, &q);
    }
}

#[test]
fn garbage_config_files_never_panic() {
    use tachylite_core::Workspace;
    let junk: &[&str] = &[
        "",
        "null",
        "[]",
        "[1,2]",
        "\"str\"",
        "42",
        "{",
        "{\"a\":",
        "\u{feff}{\"newLinkFormat\":5}",
        "{\"userIgnoreFilters\":\"x\"}",
        "{\"userIgnoreFilters\":[1,null,\"/[/\"]}",
        "{\"trashOption\":[]}",
        "\u{0}\u{1}",
        "{\"attachmentFolderPath\":{}}",
    ];
    for (i, j) in junk.iter().enumerate() {
        let d = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(d.path().join(".obsidian")).unwrap();
        for f in ["app.json", "core-plugins.json", "community-plugins.json", "hotkeys.json", "appearance.json", "workspace.json", "graph.json"] {
            std::fs::write(d.path().join(".obsidian").join(f), j).unwrap();
        }
        std::fs::write(d.path().join("Note.md"), "[[Other]] #t").unwrap();
        std::fs::write(d.path().join("Other.md"), "x").unwrap();
        let ws = Workspace::open(d.path()).unwrap_or_else(|e| panic!("case {i} {j:?}: {e}"));
        let c = &ws.vault.config;
        let _ = (
            c.new_link_format(),
            c.use_markdown_links(),
            c.always_update_links(),
            c.new_file_folder_path(),
            c.new_file_location(),
            c.attachment_folder_path(),
            c.trash_option(),
            c.user_ignore_filters(),
        );
        let _ = tachylite_core::config::core_plugin_state(d.path());
        let _ = tachylite_core::config::enabled_community_plugins(d.path());
        assert!(ws.meta.first_linkpath_dest("Other", "Note.md").is_some(), "case {i} {j:?}");
    }
}
