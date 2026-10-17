# Roadmap

A ranked queue of work, so each iteration picks the next item instead of inventing one. Every item has
acceptance criteria and a "verified how" line that says what kind of evidence counts. The honesty rule
from [CONTRIBUTING.md](CONTRIBUTING.md) applies: "tested in happy-dom" and "checked in the real window"
are different claims, and the log should say which one it is.

How to work an item: do the top unblocked one, add tests, run `scripts/ship.sh "message"` (gate, commit,
push, wait for CI), then update this file. If nothing unblocked is left, or progress needs data that only
a real Obsidian can give, stop and say so instead of guessing.

Items marked **blocked: needs reference data** wait for `compat/obsidian-reference.json`, produced by the
dump plugin in `tools/obsidian-dump/` run inside a real Obsidian (steps in its README).

## Ready

### 1. Stacked tabs
- Accept: the tab group menu has "Stack tabs"; `workspace:toggle-stacked-tabs` toggles it; the choice is saved in
  `workspace.json` (`stacked: true` on the tab group); tab headers rotate and panes slide as in Obsidian.
- Verified how: unit tests for state and layout round-trip; a screenshot from `scripts/screenshot.sh` and a step added to `scripts/smoke.sh`.

### 2. Fold more / Fold less
- Accept: `editor:fold-more` and `editor:fold-less` fold and unfold one heading/list level across the note.
- Verified how: editor unit tests. The exact semantics are **blocked: needs reference data** until confirmed.

### 3. Persisted reading-view folds
- Accept: folds on headings and lists in the reading view are remembered per note across closing and reopening,
  and stored where Obsidian stores them (confirm first).
- Verified how: unit tests; storage format **blocked: needs reference data**.

### 4. Export to PDF
- Accept: `workspace:export-pdf` and the More options entry produce a PDF of the reading view with the note's
  theme applied.
- Verified how: a real-window run that writes a file and opens it. happy-dom can't show this.

### 5. Graph bookmarks
- Accept: a graph view with its settings can be bookmarked (`type: "graph"`) and reopened.
- Verified how: unit tests plus a `bookmarks.json` round-trip.

### 6. Web viewer and Format converter core plugins
- Accept: the Core plugins list can enable them; they do something useful (open a page in a tab; import Markdown
  from other apps). Until then they stay marked unavailable.
- Verified how: unit tests, then a real-window run.

## From the Obsidian 1.14.4 reference (`compat/obsidian-reference.json`, run `scripts/compare-reference.sh`)

The reference exists now (made with `scripts/obsidian-reference.sh`), and a first round of differences is fixed: tag
rules, link text, list-item parents, core plugin defaults, config defaults, several command ids/names/hotkeys and the
file, tab, More options and editor menus. What the report still lists (re-run it for the current list):

- **Commands Obsidian has that Tachylite lacks (about 57):** the Table commands (`editor:table-*`), coloured highlights
  (`editor:toggle-highlight-*`), `editor:attach-file`, `editor:set-heading`, `editor:rename-heading`,
  `editor:context-menu`, `editor:fold-more/less`, `editor:toggle-fold-properties`, `app:toggle-default-new-pane-mode`,
  `theme:toggle-light-dark`, `theme:switch`, `workspace:export-pdf`, `workspace:toggle-stacked-tabs`,
  `workspace:show-trash`, `window:toggle-always-on-top`, Canvas, Bases and Graph extras, Sync, the Footnotes view.
  Acceptance: the id exists with Obsidian's name and default hotkey and does the obvious thing; verified by the
  comparison report plus a unit test.
- **Menu entries missing:** "Backlinks in document", "Export to PDF...", "Link with tab...", "Open linked view", and
  "Make a copy" for folders (Sync's "Open version history" is out of scope).
- **Parser positions:** a list item or math block at the very end of a note ends after the final newline in Obsidian;
  a lone `^id` line after a table, the `text`/`element` sections Obsidian reports for odd HTML, and the footnote id
  `[inline1` for inline footnotes. Also `frontmatterLinks: []` for notes with properties but no property links.
- **Menus (all eight captured with real right clicks):** the Tags view opens no menu in Obsidian, Tachylite has one (New
  search for #tag, Require/Exclude tag in search, Rename tag..., Copy tag); the bookmark menu here also has Move up/down
  and New group (groups); the ribbon menu here lists "Create new note"-less buttons in a different order than Obsidian's
  (switcher, graph, canvas, daily note, templates, command palette, bases).
- **Intentional differences:** the zoom commands keep their Ctrl/Cmd +/-/0 hotkeys here (Obsidian handles those in the
  Electron menu, not as commands), and the tab menu keeps "Close others", "Close tabs to the right", "Close all" and
  "Duplicate tab".

## Blocked: needs reference data

(Most of these can now be answered from the reference; check the report before guessing.)

- Confirm command ids and default hotkeys against Obsidian (`compat/obsidian-reference.json`): many were written
  from memory.
- Confirm context-menu entries and their order (file, tab header, editor, More options, tags, bookmarks).
- Confirm `app.json` defaults, in particular `alwaysUpdateLinks` and anything the Settings tabs expose.
- Confirm tag display rules (which spelling wins when `#Tag` and `#tag` both exist) and backlink counts
  (references or notes).
- Confirm metadataCache output for odd Markdown (comments, HTML attributes, code spans) on the corpus in
  `tools/obsidian-dump/corpus/`.

## Needs a person at a keyboard

- Audio recording with a real microphone, and webview microphone permission.
- Middle-click paste on KDE Wayland (only verified on X11).
- macOS and Windows: CI compiles them, nobody has run them.
- A real third-party theme, and HTML pasted from a browser.

## Out of scope

- Sync and Publish (paid Obsidian services).
