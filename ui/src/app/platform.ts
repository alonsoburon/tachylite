// OS integration in the webview: the body classes themes key on, and native menu items -> app commands.
import { listen } from "../ipc";
import { Platform, type App } from "../obsidian";

/** `mod-macos` / `mod-windows` / `mod-linux` and `is-focused`, `is-fullscreen`, `is-maximized` on `body`. */
export function installBodyClasses(win: Window = window): () => void {
  const body = win.document.body;
  body.classList.add(Platform.isMacOS ? "mod-macos" : Platform.isWin ? "mod-windows" : "mod-linux");
  const focus = () => body.classList.toggle("is-focused", win.document.hasFocus());
  const tw = (win as any).__TAURI__?.window?.getCurrentWindow?.();
  const state = () => {
    if (!tw) return;
    void Promise.all([tw.isFullscreen(), tw.isMaximized()]).then(([fs, max]: boolean[]) => {
      body.classList.toggle("is-fullscreen", !!fs);
      body.classList.toggle("is-maximized", !!max);
    }, () => {});
  };
  focus(); state();
  win.addEventListener("focus", focus);
  win.addEventListener("blur", focus);
  win.addEventListener("resize", state);
  return () => { win.removeEventListener("focus", focus); win.removeEventListener("blur", focus); win.removeEventListener("resize", state); };
}

/** Clicks on native menu items (crates/tachylite-app/src/platform.rs) arrive as command ids. */
export function installMenuCommands(app: App): () => void {
  let off: (() => void) | null = null, stopped = false;
  void listen("menu-command", (id: unknown) => {
    if (typeof id === "string" && !app.commands.executeCommandById(id)) console.warn(`menu: command ${id} is not available`);
  }).then((u) => { if (stopped) u(); else off = u; });
  return () => { stopped = true; off?.(); };
}
