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

### 1. Persisted reading-view folds (done)
- Stored like Obsidian 1.14.4 does (read from the real app with `OBSIDIAN_EVAL`): `localStorage["<appId>-note-fold-<path>"]` =
  `{"folds":[{"from","to"}],"lines":N}`, saved a moment after a fold changes and when the note closes, removed when no fold
  is left, ignored when the note's line count changed. `from` is the 0-based header line. Editor `to` = last hidden line
  (blank lines after the block included); reading-view `to` = `from + 1` for a heading and the line after the item and its
  sub-items for a list item. Restoring only uses `from`, so both modes read each other's saves, and switching mode carries
  the folds over. Not copied: Obsidian wrote `to: 2` for the first list item of one test note, which looks like a quirk.
- "Fold all headings and lists" now folds nested blocks too, like Obsidian (CodeMirror's own skips them).
- Seen in the real window by `scripts/smoke.sh` (step persisted-folds).

### 2. Graph bookmarks (done)
- `{ "type": "graph", "ctime", "title", "options" }` in `bookmarks.json`, exactly as Obsidian 1.14.4 wrote it (read with
  `OBSIDIAN_EVAL`): `options` is the graph settings object (same keys as `graph.json`), a blank title becomes "Untitled Graph".
  "Bookmarks: Bookmark..." on a graph view opens the "Add bookmark" dialog (Title, Bookmark group); the graph's tab menu and
  its new More options menu have "Bookmark...". Opening the bookmark reuses the open graph view (Obsidian does too), applies
  the options and writes them to `graph.json`. Seen in the real window by `scripts/smoke.sh` (step graph-bookmark).
- Not done: the graph's "Copy screenshot" menu entry (Obsidian has it next to Bookmark...).
- Checked against the real app while here: Backlinks in document in the editing view sits after the text and its bottom
  padding (inside `.cm-sizer` there, directly in the scroller here), so the position is the same.

### 3. Web viewer and Format converter core plugins
- Accept: the Core plugins list can enable them; they do something useful (open a page in a tab; import Markdown from
  other apps). Until then they stay marked unavailable. (The reference has `webviewer` but no Format converter in 1.14.4.)
- Verified how: unit tests, then a real-window run (`scripts/smoke.sh` step).

### 4. Verify the new features in the real window (done, with gaps)
- `scripts/smoke.sh` now drives the real window through: table commands, coloured highlights, Rename this heading, the
  editor context menu, Fold more/less, persisted folds, Backlinks in document (editing and reading view), stacked tabs
  (with a layout check), linked tabs, the Export to PDF dialog, canvas Jump to group and Convert to file, Bases copy,
  graph time-lapse and graph bookmarks. Screenshots go to `/tmp/tachylite-smoke-shots` (or `$SMOKE_SHOTS`) on a debug build.
- What the window showed and was fixed: stacked tabs laid their panes out vertically, off screen (now a flex row like
  Obsidian's, panes 130 to 520 px wide, close button, icon and vertical title as measured in Obsidian 1.14.4), and the
  canvas "Convert to file" name box was a small default textarea. "More options" listed its split entries before
  Reading view; it now follows Obsidian's order.
- **Still not seen:** the printed PDF itself (the test stops at the options dialog, there is no printer), what the canvas image
  export draws, what `bases:copy-table` puts on the clipboard (the private display refuses clipboard writes without a
  user gesture, so the test only sees "Unable to copy"), and any of this on macOS or Windows.
- The graph's "Copy screenshot" menu entry does not exist here.

## What the reference comparison still lists (run `scripts/compare-reference.sh`)

- **Out of scope:** the Sync commands and "Open version history", `app:migrate-frontmatter` (Format converter) and the mobile
  quick action.
- **`theme:switch`** exists now; the rest of the command list matches (zoom hotkeys are an intentional difference).
- **Intentional differences:** the zoom commands keep their Ctrl/Cmd +/-/0 hotkeys here (Obsidian handles those in the
  Electron menu, not as commands); the tab menu keeps "Close others", "Close tabs to the right", "Close all" and
  "Duplicate tab"; the Tags view has a context menu here (Require/Exclude tag in search, Rename tag...) where Obsidian
  has none; bookmarks have Move up/down.
- **Checked against the real app since:** pane widths and header layout in stacked mode, fold storage, the graph bookmark
  shape, and where Backlinks in document sits in the editing view.
- **Guesses still to re-check:** the image drawn by canvas export, the clipboard format of `bases:copy-table`, the margins
  in the PDF dialog, how a linked tab follows navigation, and the three outside-vault commands (`app:open-another-vault`,
  `app:open-sandbox-vault`, `app:open-file`).
- Cosmetic: the folder menu has an empty section in Obsidian (two separators in a row) where Tachylite has one.

## Needs a person at a keyboard

- Audio recording with a real microphone, and webview microphone permission.
- Middle-click paste on KDE Wayland (only verified on X11).
- macOS and Windows: CI compiles them, nobody has run them.
- A real third-party theme, and HTML pasted from a browser.

## Out of scope

- Sync and Publish (paid Obsidian services).
