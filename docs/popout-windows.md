# Popout windows

Popouts are extra OS windows that share the main window's JavaScript: one `app`, one set of plugins, and views that
are moved between windows rather than re-created. Code: `crates/tachylite-app/src/popout.rs` (OS windows),
`ui/src/app/popout.ts` (popout documents), `ui/src/obsidian/workspace.ts` (`WorkspaceWindow`, `floatingSplit`).

## How it works

- The UI calls `window.open("about:blank#tachylite-popout?label=popout-<id>&x=..&y=..&width=..&height=..")`. The
  main webview's new-window handler answers with a Tauri window whose webview is *related* to the opener (same
  WebKitGTK web process, same WebView2 environment, same WKWebView configuration), so `window.open` returns a
  scriptable, same-origin `WindowProxy`. Other `window.open` calls are denied; `http(s):`/`mailto:` URLs open in the
  system browser.
- The UI builds the popout's DOM from the main realm: `.app-container > .horizontal-main-container > .workspace >
  .workspace-split.mod-root.workspace-window`, `body.is-popout-window`. Leaves are moved with their live views;
  CodeMirror editors are re-rooted (`EditorView.setRoot`) and `el.onWindowMigrated(cb)` listeners fire.
- Stylesheets (app CSS, theme, snippets, plugin `styles.css` and any `<style>` a plugin adds to the main `<head>`)
  and the `<html>`/`<body>` classes and inline CSS variables are mirrored into every popout and kept in sync.
  Constructable stylesheets (`adoptedStyleSheets`) of the main document are not mirrored.
- Keyboard scopes and hotkeys, `app.lastEvent`, click-to-activate, tab drag and drop (also between windows),
  resizing, menus, modals, notices and suggestion popups work in popouts. Menus open in the window of the event;
  anchorless ones, modals and notices open in the focused window.
- `activeWindow` / `activeDocument` follow the active leaf and the focused OS window. `Node.win`, `Node.doc`,
  `Node.constructorWin`, `Node.instanceOf` and `UIEvent.instanceOf` work across windows; the DOM helpers
  (`createDiv`, `addClass`, ...) are installed in each popout's realm too.
- Events: `window-open (WorkspaceWindow, Window)`, `window-close (WorkspaceWindow, Window)`.

## Using it

- Tab menu: **Move to new window**, **Open in new window**; in a popout also **Move to main window** (a Tachylite
  addition; in Obsidian you drag the tab back). Link menu: **Open in new window**. Mod+Alt+Shift+click on a link.
- Commands: `workspace:new-window`, `workspace:open-in-new-window`, `workspace:move-to-new-window`,
  `workspace:close-window`.
- Closing a popout's OS window, or its last tab, closes the window; its notes are saved first.
- Links followed inside a popout open in that popout.

## Persistence

`.obsidian/workspace.json` gets a `floating` item (`type: "floating"`) whose children are `type: "window"` items
with the usual `children`/`direction` plus `x`, `y`, `width`, `height` and `maximize`. They are reopened on start
(and after a reload of the main window, which destroys the old popouts first).

## Platform status

- **Linux (WebKitGTK 4.1)**: run and verified (moving views, editing and saving, menus, close, restore, reload).
  WebKitGTK only lets scripts open windows outside a user gesture when told to; Tachylite enables that for the main
  webview so popouts can be restored at start. Window positions are not observable on Wayland (they read as 0,0),
  so only sizes round-trip there.
- **Windows (WebView2)** and **macOS (WKWebView)**: the same code path (Tauri's `window_features` sets the shared
  environment / configuration), reviewed but not run. WebView2 answers `window.open` asynchronously; if an engine
  replaces the initial blank document the popout is rebuilt in the new one.
