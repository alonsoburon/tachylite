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

### 1. Real-window smoke test in CI
- Accept: a Linux CI job runs the built app under xvfb against a fixture vault with a `TACHYLITE_SCRIPT`, and
  checks via the log file that the vault opens, a note opens in Live Preview, Ctrl+P opens the palette, typing
  reaches the document, a rename rewrites a link, and the app exits cleanly.
- Verified how: the job is green in CI, and a deliberately broken build turns it red.

### 2. Stacked tabs
- Accept: the tab group menu has "Stack tabs"; `workspace:toggle-stacked-tabs` toggles it; the choice is saved in
  `workspace.json` (`stacked: true` on the tab group); tab headers rotate and panes slide as in Obsidian.
- Verified how: unit tests for state and layout round-trip; a screenshot from `scripts/screenshot.sh` (needs the
  real-window harness first).

### 3. Fold more / Fold less
- Accept: `editor:fold-more` and `editor:fold-less` fold and unfold one heading/list level across the note.
- Verified how: editor unit tests. The exact semantics are **blocked: needs reference data** until confirmed.

### 4. Persisted reading-view folds
- Accept: folds on headings and lists in the reading view are remembered per note across closing and reopening,
  and stored where Obsidian stores them (confirm first).
- Verified how: unit tests; storage format **blocked: needs reference data**.

### 5. Export to PDF
- Accept: `workspace:export-pdf` and the More options entry produce a PDF of the reading view with the note's
  theme applied.
- Verified how: a real-window run that writes a file and opens it. happy-dom can't show this.

### 6. Graph bookmarks
- Accept: a graph view with its settings can be bookmarked (`type: "graph"`) and reopened.
- Verified how: unit tests plus a `bookmarks.json` round-trip.

### 7. Web viewer and Format converter core plugins
- Accept: the Core plugins list can enable them; they do something useful (open a page in a tab; import Markdown
  from other apps). Until then they stay marked unavailable.
- Verified how: unit tests, then a real-window run.

## Blocked: needs reference data

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
