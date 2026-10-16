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
