use std::fs;
use tachylite_core::{TrashMode, Workspace};

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

#[test]
fn shortest_path_prefers_source_folder_then_shortest() {
    let (_d, ws) = vault(&[("a/Note.md", ""), ("b/deep/Note.md", ""), ("Note.md", ""), ("b/src.md", ""), ("a/src.md", "")]);
    // Unique-by-name does not apply (3 candidates); exact root path wins for a bare name.
    assert_eq!(ws.meta.first_linkpath_dest("Note", "b/src.md").as_deref(), Some("Note.md"));
    // Path-qualified links match as suffixes, nearest folder first.
    assert_eq!(ws.meta.first_linkpath_dest("deep/Note", "a/src.md").as_deref(), Some("b/deep/Note.md"));
    // Case-insensitive; an exact root-path match beats a nearer folder.
    assert_eq!(ws.meta.first_linkpath_dest("note", "a/src.md").as_deref(), Some("Note.md"));
    // Relative.
    assert_eq!(ws.meta.first_linkpath_dest("../Note", "a/src.md").as_deref(), Some("Note.md"));
    assert_eq!(ws.meta.first_linkpath_dest("missing", "a/src.md"), None);
}

#[test]
fn resolved_unresolved_and_backlinks() {
    let (_d, ws) = vault(&[("A.md", "[[B]] [[B#h]] [[Nope]] ![[pic.png]]"), ("B.md", "[[A]]"), ("pic.png", "x")]);
    assert_eq!(ws.meta.resolved_links["A.md"]["B.md"], 2);
    assert_eq!(ws.meta.resolved_links["A.md"]["pic.png"], 1);
    assert_eq!(ws.meta.unresolved_links["A.md"]["Nope"], 1);
    assert_eq!(ws.meta.backlinks("A.md").len(), 1);
}

#[test]
fn rename_updates_links_keeping_alias_and_subpath() {
    let (d, mut ws) = vault(&[("A.md", "see [[B|bee]] and [[B#Head]] and ![[B]] and [md](B.md) and [[C]]"), ("B.md", "# Head"), ("C.md", "")]);
    let changed = ws.rename("B.md", "Folder/Bravo.md", true).unwrap();
    assert_eq!(changed, ["A.md"]);
    let a = fs::read_to_string(d.path().join("A.md")).unwrap();
    assert_eq!(a, "see [[Bravo|bee]] and [[Bravo#Head]] and ![[Bravo]] and [md](Bravo.md) and [[C]]");
    assert!(ws.meta.unresolved_links["A.md"].is_empty());
}

#[test]
fn hidden_and_ignored_are_not_indexed() {
    let (d, ws) = vault(&[(".obsidian/app.json", "{\"userIgnoreFilters\":[\"private/\"]}"), ("private/x.md", ""), ("ok.md", ""), (".trash/t.md", "")]);
    let _ = d;
    let paths: Vec<_> = ws.vault.files().map(|f| f.path.clone()).collect();
    assert_eq!(paths, ["ok.md"]);
}

#[test]
fn nearest_folder_wins_without_root_match() {
    let (_d, ws) = vault(&[("x/Dup.md", ""), ("y/z/Dup.md", ""), ("y/src.md", ""), ("x/src.md", ""), ("q/src.md", "")]);
    assert_eq!(ws.meta.first_linkpath_dest("Dup", "x/src.md").as_deref(), Some("x/Dup.md"));
    assert_eq!(ws.meta.first_linkpath_dest("Dup", "y/src.md").as_deref(), Some("y/z/Dup.md"));
    // From an unrelated folder: shortest path first.
    assert_eq!(ws.meta.first_linkpath_dest("Dup", "q/src.md").as_deref(), Some("x/Dup.md"));
}

#[test]
fn rename_opt_can_skip_or_force_link_rewriting() {
    let (_d, mut ws) = vault(&[("A.md", "see [[B]]"), ("B.md", "b"), ("C.md", "c")]);
    // alwaysUpdateLinks is off by default: `None` leaves links alone, `Some(false)` always does.
    assert!(ws.rename_opt("B.md", "B2.md", None).unwrap().is_empty());
    assert_eq!(ws.vault.read("A.md").unwrap(), "see [[B]]");
    ws.rename_opt("B2.md", "B.md", Some(false)).unwrap();
    // `Some(true)` rewrites even when the vault setting is off.
    let changed = ws.rename_opt("B.md", "Bee.md", Some(true)).unwrap();
    assert_eq!(changed, vec!["A.md".to_string()]);
    assert_eq!(ws.vault.read("A.md").unwrap(), "see [[Bee]]");
}

#[test]
fn delete_mode_moves_to_trash_or_removes_for_good() {
    let (d, mut ws) = vault(&[("keep.md", "k"), ("gone.md", "g")]);
    ws.delete_mode("keep.md", TrashMode::Local).unwrap();
    assert!(!d.path().join("keep.md").exists());
    assert!(d.path().join(".trash/keep.md").exists());
    ws.delete_mode("gone.md", TrashMode::Permanent).unwrap();
    assert!(!d.path().join("gone.md").exists());
    assert!(!d.path().join(".trash/gone.md").exists());
}

/// The OS trash on Linux follows the freedesktop spec under `$XDG_DATA_HOME/Trash` when the file is on the
/// same device; point it at a temp dir so the test does not touch the user's trash.
#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn system_trash_and_trash_option() {
    let home = tempfile::tempdir().unwrap();
    std::env::set_var("XDG_DATA_HOME", home.path().join("data"));
    fs::create_dir_all(home.path().join("data")).unwrap();
    let root = home.path().join("vault");
    for (p, c) in [("a.md", "a"), ("b.md", "b"), ("c.md", "c")] {
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(p), c).unwrap();
    }
    let mut ws = Workspace::open(&root).unwrap();
    // Default trashOption is "system".
    assert_eq!(ws.delete("a.md").unwrap(), TrashMode::System);
    assert!(!root.join("a.md").exists());
    assert!(home.path().join("data/Trash/files/a.md").exists());
    assert!(home.path().join("data/Trash/info/a.md.trashinfo").exists());
    assert!(ws.vault.get("a.md").is_none());
    ws.vault.config.file.set("trashOption", "local".into());
    assert_eq!(ws.delete("b.md").unwrap(), TrashMode::Local);
    assert!(root.join(".trash/b.md").exists());
    ws.vault.config.file.set("trashOption", "none".into());
    assert_eq!(ws.delete("c.md").unwrap(), TrashMode::Permanent);
    assert!(!root.join("c.md").exists() && !root.join(".trash/c.md").exists());
    assert!(matches!(ws.delete("missing.md"), Err(tachylite_core::VaultError::NotFound(_))));
}

#[test]
fn case_only_rename_keeps_a_distinct_target() {
    let (d, mut ws) = vault(&[("a.md", "lower"), ("A.md", "upper"), ("Note.md", "n")]);
    let case_sensitive = fs::read_to_string(d.path().join("a.md")).unwrap() == "lower" && fs::read_to_string(d.path().join("A.md")).unwrap() == "upper";
    if case_sensitive {
        // Two different files that only differ in case: renaming one onto the other is a conflict, not an overwrite.
        assert!(ws.rename("a.md", "A.md", false).is_err());
        assert_eq!(fs::read_to_string(d.path().join("A.md")).unwrap(), "upper");
    }
    ws.rename("Note.md", "note.md", false).unwrap();
    assert!(ws.vault.get("note.md").is_some());
    assert!(ws.vault.get("Note.md").is_none());
    assert!(fs::read_dir(d.path()).unwrap().any(|e| e.unwrap().file_name() == "note.md"));
}
