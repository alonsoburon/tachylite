// Runs inside the real app window (TACHYLITE_SCRIPT; `app`, `shell` and `ipc` are in scope). It logs "SMOKE ..." lines
// that scripts/smoke.sh watches, and waits for real key presses that smoke.sh sends with xdotool.
const log = (m) => console.warn("SMOKE " + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    if (Date.now() - t0 > ms) { log("FAIL " + label); await ipc.quitApp(); throw new Error("smoke: " + label); }
    await sleep(100);
  }
}

log("vault " + app.vault.getName());
await until("note opens", async () => { await app.workspace.openLinkText("Note", "", false); return app.workspace.getActiveFile()?.path === "Note.md"; });
log("OK note-open");
await until("Live Preview editor", () => document.querySelector(".markdown-source-view.is-live-preview .cm-content"));
log("OK live-preview");
// One backlinks item and the editor mode in the real status bar (a duplicate once slipped past the DOM-only tests).
await until("a single backlinks status item", () => document.querySelectorAll(".status-bar-item.plugin-backlink").length === 1);
await until("editor mode in the status bar", () => document.querySelector(".status-bar-item.plugin-editor-status")?.textContent === "Live Preview");
log("OK status-bar");

// The palette must open from a real Ctrl+P.
const view = app.workspace.activeLeaf.view;
view.editor.focus();
log("READY palette");
await until("palette opens on Ctrl+P", () => document.querySelector(".prompt"));
log("OK palette");
await until("palette closes on Escape", () => !document.querySelector(".prompt"));
log("OK palette-closed");

// Real typing must reach the document.
view.editor.focus();
view.editor.setCursor({ line: view.editor.lastLine(), ch: view.editor.getLine(view.editor.lastLine()).length });
log("READY typing");
await until("typed text reaches the note", () => view.editor.getValue().includes("hello smoke"));
log("OK typing");

// Renaming a note rewrites links to it.
app.vault.setConfig("alwaysUpdateLinks", true);
await app.fileManager.renameFile(app.vault.getFileByPath("Target.md"), "Renamed.md");
await until("rename rewrites the link", async () => (await app.vault.read(app.vault.getFileByPath("Note.md"))).includes("[[Renamed]]") || view.editor.getValue().includes("[[Renamed]]"));
log("OK rename");

log("DONE");
await ipc.quitApp();
