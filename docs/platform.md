# Platform integration

How Tachylite behaves on Linux, macOS and Windows: URIs, single instance, the menu bar, window chrome, paths and
packages. Only Linux is built and run in CI today; the macOS and Windows parts are configured and reviewed but not
tested on those systems (each item below says so).

## `tachylite://` URIs

Tachylite registers **only** the `tachylite://` scheme. It never claims `obsidian://`, so installing Tachylite does
not take links away from Obsidian. The URI shapes and decoding are the ones Obsidian documents for `obsidian://`, with
the scheme swapped:

| URI | Does |
|---|---|
| `tachylite://open?vault=<name or path>&file=<path or link>` | Opens a note (`file` may carry `#heading`; `.md` is optional). `paneType=tab\|split\|window` picks the pane. |
| `tachylite://open?path=<absolute path>` and `tachylite:///<absolute path>` | Opens the file in whichever known vault contains it (the deepest vault root wins). |
| `tachylite://vault/<vault>/<file path>` | Short form of `open`. |
| `tachylite://open?vault=<name>` | Opens (or switches to) the vault only. |
| `tachylite://new?vault=&name=&file=&content=&clipboard&append&prepend&overwrite&silent&paneType=` | Creates a note (`name` in the default new-note folder, `file` as a vault path). With `append`/`prepend`/`overwrite` an existing note is edited instead; without them an existing name gets a numbered copy. `silent` does not open it. |
| `tachylite://search?vault=&query=` | Opens Search with the query. |
| `tachylite://daily?vault=` | Opens today's daily note (Daily notes must be on). |
| `tachylite://choose-vault` | Shows the vault picker. |
| `tachylite://<action>?...` | Calls the handler a plugin registered with `registerObsidianProtocolHandler(action, fn)`. It receives `{ action, vault, ...query }` with values URI-decoded and value-less flags as `"true"`; `hash` holds the `#fragment`. |

`vault` matches the open vault or a recent one by folder name or full path, case-insensitively. A URI for another
known vault switches to it (the window reloads) and then runs. Unknown vaults and unknown actions show a notice.
Not implemented: `x-success`/`x-error` callbacks, `hook-get-address`, `unique`, `show-plugin`, `show-theme`.
`app.getObsidianUrl(file)` and the "Copy Tachylite URL" command (`workspace:copy-url`) produce `tachylite://open` URIs.

### Where the scheme gets registered

- **Linux .deb/.rpm**: the desktop entry declares `MimeType=x-scheme-handler/tachylite` and `Exec=tachylite %u`.
- **Linux AppImage**: nothing installs it, so on start the app writes `tachylite-handler.desktop` under
  `~/.local/share/applications` and makes it the `x-scheme-handler/tachylite` default (only when running as an AppImage, or with `TACHYLITE_REGISTER_SCHEME=1`).
- **macOS** (not tested): the bundler adds `CFBundleURLTypes` for `tachylite` to `Info.plist`; links arrive as
  open-URL events, also while the app runs.
- **Windows** (not tested): the NSIS and MSI installers register the handler under `Software\Classes\tachylite`.

### Single instance

Release builds run one process: a second launch (for example `xdg-open tachylite://...` while Tachylite is open)
hands its URI to the running app and exits; the running window comes to the front. Debug builds allow several
instances so development runs do not interfere; `TACHYLITE_SINGLE_INSTANCE=1` or `=0` forces either behaviour.

### Using Tachylite for `obsidian://` links (opt-in)

Tachylite understands `obsidian://` URIs the same way, but only acts on them when you route them to it yourself and
set `TACHYLITE_URL_SCHEMES=obsidian` in its environment. On Linux, for example: copy `tachylite.desktop` to
`~/.local/share/applications/`, change its `Exec=` line to `env TACHYLITE_URL_SCHEMES=obsidian tachylite %u`, add
`x-scheme-handler/obsidian;` to `MimeType=`, then run `xdg-mime default tachylite.desktop x-scheme-handler/obsidian`.
On Windows the same works by pointing `HKCU\Software\Classes\obsidian\shell\open\command` at Tachylite with the
variable set. On macOS the schemes are fixed in the signed app bundle, so this is not possible without rebuilding.

## Menu bar and window chrome

- **macOS** (not tested): a native menu bar with Tachylite (About, Settings, Services, Hide, Quit), File (New Note,
  New Tab, Open Vault, Close Tab), Edit (the standard Undo/Redo/Cut/Copy/Paste/Select All items, which are what make
  Cmd+C/V/X/A/Z work inside the webview on macOS), View (Command Palette, sidebars, Reading view, Reload, Developer
  Tools in debug builds), Window and Help. Items run the matching command ids. Quit goes through the same flush as
  closing the window. Custom items have no accelerators so they never shadow your hotkeys (except Cmd+Q).
- **Linux and Windows**: no menu bar, like Obsidian's default. `TACHYLITE_MENU=1` shows the same menu (debugging).
- All systems use the native window frame (decorations). Tachylite does not draw its own title bar, so `body` never
  has `is-frameless` / `is-hidden-frameless`; themes see the same state as Obsidian with the "native" frame style.
  macOS uses the standard title bar, not an inset traffic-light overlay.
- `body` gets `mod-macos`, `mod-windows` or `mod-linux`, plus `is-focused`, `is-fullscreen` and `is-maximized`.
- `Platform.isMacOS` / `isWin` / `isLinux` come from the OS the shell injects into every webview before page scripts
  run (the user agent is only a fallback). `Mod` in hotkeys is Cmd on macOS and Ctrl elsewhere.

## Paths

- Vault paths are always `/`-separated. `FileSystemAdapter.getBasePath()` and `getFullPath()` use the OS separator
  (`C:\Users\me\Vault\folder\note.md` on Windows); `getFilePath()` returns a `file://` URL.
- `getResourcePath()` returns Tauri asset-protocol URLs: `asset://localhost/<percent-encoded absolute path>?<mtime>`
  on Linux and macOS, `http://asset.localhost/...` on Windows. The whole path is encoded, so `#`, `?`, `%`, spaces and
  non-ASCII names load. `Platform.resourcePathPrefix` is the matching prefix.
- On Windows the vault root drops the `\\?\` prefix `canonicalize` adds.
- Renaming a note to a different case (`Note.md` -> `note.md`) works on case-insensitive file systems (macOS,
  Windows) and never overwrites a distinct file on case-sensitive ones.

## Packages

`cd crates/tachylite-app && npx @tauri-apps/cli@2 build` (after `cd ui && npm run build`) produces, on Linux, a
.deb, an .rpm and an AppImage under `target/release/bundle/`; `--bundles deb,appimage` limits it. On macOS the same
command gives `.app`/`.dmg`, on Windows `.msi` and an NSIS `-setup.exe` (current-user install, WebView2 bootstrapper);
neither is signed or notarized. No file associations are registered: claiming `.md` would take Markdown files away
from other editors, and opening a file passed on the command line is not implemented yet.
