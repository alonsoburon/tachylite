Sixth pre-release: a small follow-up to 0.1.4 with fixes the real-window smoke test turned up after that release was cut. Still early and not a drop-in replacement; the README lists the gaps.

## Fixed
- **"Open linked view" linked the wrong tab** when the same note was open in more than one tab: it picked the first tab showing that file instead of the tab whose menu you used. It links the right tab now.
- **Long menus ran off the screen.** A note's tab menu has about 30 entries and was cut off at the bottom of an 800 px window; menus taller than the window now scroll.

## Tested
- The real-window smoke test is stricter: "Link with tab..." and "Open linked view" go through the tab's real context menu, the graph time-lapse is checked to actually advance, Bases "Copy table" checks the table text, and the tab menu is checked to fit the window.

## Not done / not verified
- Everything from the 0.1.4 notes still applies: seen in a real window on Linux only; the printed PDF, the canvas image export and the clipboard contents of Bases "Copy table" were not checked; macOS and Windows have been built and run through the headless tests in CI but nobody has run the app there.
- The graph's "Copy screenshot" menu entry does not exist. Web viewer, Format converter, Sync and Publish are still unavailable.
- This is a goal, not a claim of 1:1 compatibility with Obsidian.

## Downloads (Linux x86_64)
- `Tachylite_0.1.5_amd64.AppImage`: `chmod +x` and run.
- `Tachylite_0.1.5_amd64.deb`: needs `libwebkit2gtk-4.1-0` and `libgtk-3-0`.
- `Tachylite-0.1.5-1.x86_64.rpm`: on Fedora, `sudo dnf install ./Tachylite-0.1.5-1.x86_64.rpm`.
- `SHA256SUMS`

macOS and Windows build in CI but there are no installers yet, and nobody has run them.

If the AppImage opens a blank window, try `WEBKIT_DISABLE_COMPOSITING_MODE=1` and tell me your distro and GPU.
