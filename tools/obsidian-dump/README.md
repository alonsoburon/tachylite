# Tachylite reference dump

A tiny Obsidian plugin that records how a real Obsidian behaves, so Tachylite can be compared with it instead of
matched from memory. It is original code (MIT, like the rest of the repo), reads only what the public plugin API and the
app's own DOM expose, and writes one JSON file. It sends nothing anywhere.

What ends up in the file:

- every command id and name, with its **default** hotkeys;
- the core plugins and their ids;
- the vault's `app.json` values;
- the entries and their order in the file, folder, tab header, editor, "More options", tag, bookmark and ribbon
  context menus (read from the real menus the app opens);
- for the notes in `corpus/`: the note text and the `metadataCache` output (links, embeds, tags, headings, blocks,
  list items, sections, with positions).

## Automatic route (Linux)

`scripts/obsidian-reference.sh /path/to/squashfs-root/obsidian` does all of the steps below with no clicking: it starts
the Obsidian binary on a private X server in a throwaway vault (own config and data directories, no Wayland socket, no
session bus), enables the plugin through Obsidian's DevTools port, runs the command and copies the result to
`compat/obsidian-reference.json`. Get the binary from the
[Obsidian releases](https://github.com/obsidianmd/obsidian-releases/releases): download `Obsidian-x.y.z.AppImage`, run it
with `--appimage-extract` once (do not start the extracted `obsidian` yourself from a script; a session that exports
`GDK_BACKEND=wayland` would open it on your real desktop). `OBSIDIAN_EVAL=file.js scripts/obsidian-reference.sh ...`
evaluates a JavaScript file inside the running Obsidian and prints the result, for exploring its API.

## Manual steps (you need a desktop Obsidian)

1. **Use a throwaway vault.** Make a new empty vault. Leave settings alone and install no community plugins, or the
   "defaults" in the dump are not defaults. Create a bookmark of any note first if you want the bookmark menu
   captured, and make sure the vault has at least one folder with a note in it.
2. Copy the notes from `tools/obsidian-dump/corpus/` into the vault as a folder named **`tachylite-corpus`**
   (so the notes end up at `tachylite-corpus/links.md`, `tachylite-corpus/tags.md`, and so on).
3. Copy `main.js` and `manifest.json` from this directory into
   `<vault>/.obsidian/plugins/tachylite-reference-dump/`.
4. In Obsidian: Settings > Community plugins > turn off restricted mode if it is on, then enable
   "Tachylite reference dump".
5. Leave one note open in the main pane and the left sidebar visible, then open the command palette and run
   **Dump Tachylite reference data**. Wait for the notice (a few seconds).
6. A file called `tachylite-reference.json` appears in the vault root. Copy it into this repo as
   **`compat/obsidian-reference.json`**.
7. Run the comparison:

   ```
   scripts/compare-reference.sh
   ```

   It prints a readable report of every difference (commands and hotkeys, menus, config defaults, and the
   metadata cache). Add `TACHYLITE_STRICT_REFERENCE=1` to make any difference fail the run.

The dump file is not secret, but it contains the text of the corpus notes and your Obsidian version, so look at it
before committing it.

Menus are read by right-clicking real elements (with genuine mouse events when run through
`scripts/obsidian-reference.sh`), after bringing the view that owns them to the front. In the file a menu is a list of titles
(`"---"` is a separator), or `null` when the element to click did not exist, or `{"none": true}` when it existed and a real
right click opened no menu. In Obsidian 1.14.4 that last case is the Tags view: right-clicking a tag opens nothing. The
bookmark menu needs a bookmark, so the plugin adds one for a moment if the vault has none and removes it again.
