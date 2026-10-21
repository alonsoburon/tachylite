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

### 1. Persisted reading-view folds
- Accept: folds on headings and lists in the reading view are remembered per note across closing and reopening, and stored
  where Obsidian stores them (check the real app: run the fold, read `app.workspace.getLayout()`).
- Verified how: unit tests; storage format against the real app (`scripts/obsidian-reference.sh` with `OBSIDIAN_EVAL`).

### 2. Graph bookmarks
- Accept: a graph view with its settings can be bookmarked (`type: "graph"`) and reopened.
- Verified how: unit tests plus a `bookmarks.json` round-trip.

### 3. Web viewer and Format converter core plugins
- Accept: the Core plugins list can enable them; they do something useful (open a page in a tab; import Markdown from
  other apps). Until then they stay marked unavailable. (The reference has `webviewer` but no Format converter in 1.14.4.)
- Verified how: unit tests, then a real-window run (`scripts/smoke.sh` step).

### 4. Verify the new features in the real window
- Stacked tabs, export to PDF, linked tabs, backlinks in document, canvas export, graph time-lapse and the dialog-based
  commands were built from the real app's DOM and menus and tested in happy-dom. None has been looked at in a Tachylite
  window yet. Add steps to `scripts/smoke.sh` and screenshots with `scripts/screenshot.sh`.

## What the reference comparison still lists (run `scripts/compare-reference.sh`)

- **Out of scope:** the Sync commands and "Open version history", `app:migrate-frontmatter` (Format converter) and the mobile
  quick action.
- **`theme:switch`** exists now; the rest of the command list matches (zoom hotkeys are an intentional difference).
- **Intentional differences:** the zoom commands keep their Ctrl/Cmd +/-/0 hotkeys here (Obsidian handles those in the
  Electron menu, not as commands); the tab menu keeps "Close others", "Close tabs to the right", "Close all" and
  "Duplicate tab"; the Tags view has a context menu here (Require/Exclude tag in search, Rename tag...) where Obsidian
  has none; bookmarks have Move up/down.
- **Guesses to re-check against the real app:** the pane widths in stacked mode, the image drawn by canvas export, the
  clipboard format of `bases:copy-table`, the margins in the PDF dialog, how a linked tab follows navigation, and the
  three outside-vault commands (`app:open-another-vault`, `app:open-sandbox-vault`, `app:open-file`).

## Needs a person at a keyboard

- Audio recording with a real microphone, and webview microphone permission.
- Middle-click paste on KDE Wayland (only verified on X11).
- macOS and Windows: CI compiles them, nobody has run them.
- A real third-party theme, and HTML pasted from a browser.

## Out of scope

- Sync and Publish (paid Obsidian services).
