Fifth pre-release. This one is mostly about checking the newest features in a real window instead of a headless DOM, and the fixes that came out of it. Still early and not a drop-in replacement; the README lists the gaps.

## Fixed
- **Stacked tabs were broken in a real window:** the panes were laid out one under another, off screen, so you saw header strips and nothing else. They now sit side by side like Obsidian's (130 to 520 px wide), each with its close button, icon and vertical title, and the active one scrolls into view.
- The canvas "Convert to file" name box was a small default textarea; it is a single full-width line now.
- "Fold all headings and lists" folds nested blocks too (CodeMirror's version skipped what was inside an outer fold, so unfolding the outer one showed everything open).
- "More options" listed Split right/down before Reading view; the order follows Obsidian's now.
- **Corrections to the 0.1.3 notes:** `Ctrl+Enter` does not tick a task (Obsidian's task toggle is `Ctrl+L`, "Toggle checkbox status"), and there are no list indent/unindent hotkeys by default.

## Added
- **Folds are remembered per note**, in the editor and in the reading view, and carried over when you switch between them. They are stored the way Obsidian 1.14.4 stores them (`<appId>-note-fold-<path>` in local storage, `{folds: [{from, to}], lines}`), and dropped if the note's length changed since.
- **Bookmark the graph view** with its current settings: "Bookmarks: Bookmark..." on a graph opens the "Add bookmark" dialog (title and group), the graph's tab menu and its new More options menu have "Bookmark...", and clicking the bookmark reopens the graph with those settings. The `bookmarks.json` entry has Obsidian's shape (`type`, `ctime`, `title`, `options`).
- The real-window smoke test now covers table commands, coloured highlights, Rename this heading, the editor context menu, Fold more/less, remembered folds, backlinks in document, stacked and linked tabs, the Export to PDF dialog, canvas jump to group and convert to file, Bases copy, the graph time-lapse and graph bookmarks.

## Not done / not verified
- Seen in a real window on Linux only. macOS and Windows build and run the headless tests in CI, but nobody has run the app there.
- The printed PDF itself was not produced (the test stops at the options dialog), canvas image export was not looked at, and what Bases "Copy table" puts on the clipboard was not checked: the test display refuses clipboard writes without a user gesture.
- The graph's "Copy screenshot" menu entry does not exist. Web viewer, Format converter, Sync and Publish are still unavailable.
- Audio recording has only been tested against a fake recorder. Middle-click paste is only verified on X11.
- Some command ids, menus and defaults were compared with a real Obsidian 1.14.4 (`compat/obsidian-reference.json`); the remaining differences are listed in `ROADMAP.md`. This is a goal, not a claim of 1:1 compatibility.

## Downloads (Linux x86_64)
- `Tachylite_0.1.4_amd64.AppImage`: `chmod +x` and run.
- `Tachylite_0.1.4_amd64.deb`: needs `libwebkit2gtk-4.1-0` and `libgtk-3-0`.
- `Tachylite-0.1.4-1.x86_64.rpm`: on Fedora, `sudo dnf install ./Tachylite-0.1.4-1.x86_64.rpm`.
- `SHA256SUMS`

macOS and Windows build in CI but there are no installers yet, and nobody has run them.

If the AppImage opens a blank window, try `WEBKIT_DISABLE_COMPOSITING_MODE=1` and tell me your distro and GPU.
