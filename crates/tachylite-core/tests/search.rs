use std::fs;
use tachylite_core::search::search;
use tachylite_core::Workspace;

fn vault(files: &[(&str, &str)]) -> (tempfile::TempDir, Workspace) {
    let d = tempfile::tempdir().unwrap();
    for (p, c) in files {
        let abs = d.path().join(p);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        fs::write(abs, c).unwrap();
    }
    let ws = Workspace::open(d.path()).unwrap();
    (d, ws)
}

fn found(ws: &Workspace, q: &str) -> Vec<String> {
    let mut v: Vec<String> = search(&ws.vault, &ws.meta, q).into_iter().map(|h| h.path).collect();
    v.sort();
    v
}

fn sample() -> (tempfile::TempDir, Workspace) {
    vault(&[
        ("Apples.md", "---\nstatus: draft\nauthors: [Ann, Bob]\ntags: [fruit]\n---\n# Apples\nRed apples are sweet.\n\nGreen apples are sour.\n- [ ] buy apples\n- [x] eat an apple\n"),
        ("Pears.md", "# Pears\nPears are sweet and green.\n\n## Storage\nKeep pears cool. #fruit/pear\n- [ ] wash pears\n"),
        ("notes/Plan.md", "---\nstatus: done\n---\n# Plan\nCall Ann about apples.\nTODO: Apples vs Pears\n"),
        ("Empty.md", ""),
    ])
}

#[test]
fn plain_words_all_must_match_anywhere_in_name_path_or_body() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "sweet green"), ["Apples.md", "Pears.md"]);
    assert_eq!(found(&ws, "sweet pears"), ["Pears.md"]);
    assert_eq!(found(&ws, "plan"), ["notes/Plan.md"]);
    assert_eq!(found(&ws, "SWEET"), ["Apples.md", "Pears.md"]); // case-insensitive
    assert_eq!(found(&ws, ""), Vec::<String>::new());
}

#[test]
fn phrases_negation_or_and_grouping() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "\"are sweet\""), ["Apples.md", "Pears.md"]);
    assert_eq!(found(&ws, "\"sweet are\""), Vec::<String>::new());
    assert_eq!(found(&ws, "apples -pears"), ["Apples.md"]); // Plan.md also has apples, but mentions pears
    assert_eq!(found(&ws, "-apples pears"), ["Pears.md"]);
    assert_eq!(found(&ws, "storage OR plan"), ["Pears.md", "notes/Plan.md"]);
    // Parentheses group OR inside an AND.
    assert_eq!(found(&ws, "(storage OR plan) pears"), ["Pears.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "(storage OR plan) -pears"), Vec::<String>::new());
    assert_eq!(found(&ws, "-(apples OR pears)"), ["Empty.md"]);
}

#[test]
fn file_path_content_and_tag_operators() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "file:plan"), ["notes/Plan.md"]);
    assert_eq!(found(&ws, "file:.md"), ["Apples.md", "Empty.md", "Pears.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "path:notes/"), ["notes/Plan.md"]);
    assert_eq!(found(&ws, "file:empty"), ["Empty.md"]);
    assert_eq!(found(&ws, "content:empty"), Vec::<String>::new()); // the word is only in the file name
    assert_eq!(found(&ws, "content:apples"), ["Apples.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "tag:#fruit"), ["Apples.md", "Pears.md"]); // frontmatter tag and the nested inline #fruit/pear
    assert_eq!(found(&ws, "tag:fruit/pear"), ["Pears.md"]);
    assert_eq!(found(&ws, "tag:#nothing"), Vec::<String>::new());
    assert_eq!(found(&ws, "file:(apples OR pears)"), ["Apples.md", "Pears.md"]);
}

#[test]
fn scoped_operators_need_the_whole_group_inside_one_line_block_or_section() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "line:(apples sour)"), ["Apples.md"]); // both words are on the "Green apples are sour." line
    assert_eq!(found(&ws, "line:(red sour)"), Vec::<String>::new()); // ...but "red" and "sour" are on different lines
    assert_eq!(found(&ws, "line:(green sour)"), ["Apples.md"]);
    assert_eq!(found(&ws, "line:(sweet green)"), ["Pears.md"]);
    assert_eq!(found(&ws, "block:(red sweet)"), ["Apples.md"]);
    assert_eq!(found(&ws, "block:(red sour)"), Vec::<String>::new()); // different paragraphs
    assert_eq!(found(&ws, "section:(keep cool)"), ["Pears.md"]);
    assert_eq!(found(&ws, "section:(sweet storage)"), Vec::<String>::new()); // the storage section does not contain "sweet"
}

#[test]
fn task_operators() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "task:apple"), ["Apples.md"]);
    assert_eq!(found(&ws, "task-todo:apples"), ["Apples.md"]);
    assert_eq!(found(&ws, "task-todo:eat"), Vec::<String>::new()); // "eat" is a completed task
    assert_eq!(found(&ws, "task-done:eat"), ["Apples.md"]);
    assert_eq!(found(&ws, "task-todo:wash"), ["Pears.md"]);
    assert_eq!(found(&ws, "task:sweet"), Vec::<String>::new()); // only task lines count
}

#[test]
fn properties() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "[status]"), ["Apples.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "[status:draft]"), ["Apples.md"]);
    assert_eq!(found(&ws, "[status:done]"), ["notes/Plan.md"]);
    assert_eq!(found(&ws, "[authors:ann]"), ["Apples.md"]); // list values match any item
    assert_eq!(found(&ws, "property:[status:done]"), ["notes/Plan.md"]);
    assert_eq!(found(&ws, "[status:draft] apples"), ["Apples.md"]);
    assert_eq!(found(&ws, "-[status]"), ["Empty.md", "Pears.md"]);
}

#[test]
fn regex_and_case_operators() {
    let (_d, ws) = sample();
    assert_eq!(found(&ws, "/app?les/"), ["Apples.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "/^# P/"), ["Pears.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "file:/^Pe/"), ["Pears.md"]);
    assert_eq!(found(&ws, "match-case:Apples"), ["Apples.md", "notes/Plan.md"]); // "# Apples" and "Call Ann about apples" has lowercase only
    assert_eq!(found(&ws, "match-case:APPLES"), Vec::<String>::new());
    assert_eq!(found(&ws, "ignore-case:APPLES"), ["Apples.md", "notes/Plan.md"]);
    assert_eq!(found(&ws, "note: hello"), Vec::<String>::new()); // an unknown "word:" prefix is plain text
}

#[test]
fn hits_report_the_lines_that_matched() {
    let (_d, ws) = sample();
    let hits = search(&ws.vault, &ws.meta, "content:sweet");
    let apples = hits.iter().find(|h| h.path == "Apples.md").unwrap();
    assert_eq!(apples.lines, vec![(6, "Red apples are sweet.".to_string())]);
    let hits = search(&ws.vault, &ws.meta, "line:(green sour)");
    assert_eq!(hits[0].lines, vec![(8, "Green apples are sour.".to_string())]);
}
