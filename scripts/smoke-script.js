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


// ---- Features added after the first smoke test: each step asserts state in the real webview and, on a debug build, saves
// a screenshot (SMOKE_SHOTS is set by smoke.sh) so the layout can be looked at.
const shot = async (name) => {
  if (typeof SMOKE_SHOTS === "undefined" || !SMOKE_SHOTS) return;
  try { await window.__TAURI__.core.invoke("dev_screenshot", { path: SMOKE_SHOTS + "/" + name + ".png" }); } catch { /* release build: no screenshot command */ }
};
const cmd = (id) => app.commands.executeCommandById(id);
const step = async (name, fn) => { await fn(); await shot(name); log("OK " + name); };
const mk = async (path, body) => app.vault.getFileByPath(path) ?? app.vault.create(path, body);
const open = async (path, newLeaf) => {
  const f = app.vault.getFileByPath(path);
  const l = app.workspace.getLeaf(newLeaf ? "tab" : false);
  await l.openFile(f);
  app.workspace.setActiveLeaf(l, { focus: true });
  await sleep(250);
  return l;
};
const closeModals = () => { for (const m of document.querySelectorAll(".modal-container .modal-close-button")) m.click(); };

await mk("Table.md", "| A | B |\n| --- | --- |\n| 1 | 2 |\n");
await mk("Doc.md", "# First heading\n\nSome ==marked== text.\n\n## Second\n\nBody [[Note]].\n");
await mk("Other.md", "Links to [[Doc]]\n");

await step("table-commands", async () => {
  await open("Table.md");
  const ed = app.workspace.activeLeaf.view.editor;
  ed.focus(); ed.setCursor({ line: 2, ch: 3 });
  await until("table rendered", () => document.querySelector(".cm-table-widget, .cm-content table, .HyperMD-table-row, .cm-content"));
  cmd("editor:table-row-after");
  await until("row added", () => ed.getValue().split("\n").filter((l) => l.startsWith("|")).length === 4);
  cmd("editor:table-col-after");
  await until("column added", () => ed.getLine(0).split("|").length === 5);
});

await step("highlights", async () => {
  await open("Doc.md");
  const ed = app.workspace.activeLeaf.view.editor;
  ed.focus(); ed.setSelection({ line: 2, ch: 5 }, { line: 2, ch: 11 });
  const before = ed.getValue();
  cmd("editor:toggle-highlight-red");
  await until("coloured highlight written", () => ed.getValue() !== before);
});

await step("rename-heading", async () => {
  await open("Doc.md");
  const view = app.workspace.activeLeaf.view;
  view.editor.focus(); view.editor.setCursor({ line: 0, ch: 3 });
  cmd("editor:rename-heading");
  const input = await until("rename-heading prompt", () => document.querySelector(".modal input, .modal textarea"));
  input.value = "Renamed heading";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const ok = [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Rename");
  await shot("rename-heading-modal");
  ok.click();
  await until("heading text changed", () => view.editor.getLine(0) === "# Renamed heading");
});

await step("context-menu", async () => {
  await open("Doc.md");
  const view = app.workspace.activeLeaf.view;
  view.editor.focus(); view.editor.setCursor({ line: 4, ch: 2 });
  cmd("editor:context-menu");
  await until("editor menu items", () => document.querySelectorAll(".menu .menu-item").length > 5);
});
document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
document.querySelector(".menu")?.remove();

await step("fold-more-less", async () => {
  await open("Doc.md");
  const view = app.workspace.activeLeaf.view;
  view.editor.focus(); view.editor.setCursor({ line: 0, ch: 0 });
  const lines = () => document.querySelectorAll(".cm-line").length;
  const before = lines();
  cmd("editor:fold-more");
  await until("fold more hid lines", () => lines() < before);
  await shot("fold-more");
  cmd("editor:fold-less");
  await until("fold less showed them again", () => lines() >= before);
});

await step("persisted-folds", async () => {
  // Fold a reading-view heading, close the tab, open the note again: the fold comes back (stored like Obsidian does).
  const first = await open("Doc.md");
  await first.view.setState({ ...first.view.getState(), mode: "preview" }, { history: false });
  const arrow = await until("reading view heading arrows", () => first.view.previewEl.querySelector(".heading-collapse-indicator"));
  arrow.click();
  await until("heading collapsed", () => first.view.previewEl.querySelector("h1.is-collapsed"));
  first.detach();
  await sleep(200);
  const key = app.appId + "-note-fold-Doc.md";
  const saved = JSON.parse(localStorage.getItem(key) ?? "null");
  if (!saved || saved.folds.length !== 1 || saved.folds[0].from !== 0) { log("FAIL fold not stored in Obsidian's shape: " + localStorage.getItem(key)); await ipc.quitApp(); throw new Error("smoke: folds"); }
  const again = await open("Doc.md");
  await again.view.setState({ ...again.view.getState(), mode: "preview" }, { history: false });
  await until("fold restored in the reading view", () => again.view.previewEl.querySelector("h1.is-collapsed"));
  await shot("persisted-folds-restored");
  await again.view.setState({ ...again.view.getState(), mode: "source" }, { history: false });
  await until("fold restored in the editor", () => document.querySelectorAll(".cm-fold-indicator.is-collapsed").length >= 1);
  app.commands.executeCommandById("editor:unfold-all");
  await sleep(100);
});

await step("backlinks-in-document", async () => {
  const view = (await open("Doc.md")).view;
  cmd("backlink:toggle-backlinks-in-document");
  await until("panel in editing view", () => view.containerEl.querySelector(".cm-editor .embedded-backlinks"));
  await sleep(600);
  await shot("backlinks-editing");
  const pr = view.containerEl.querySelector(".embedded-backlinks").getBoundingClientRect(), vr = view.containerEl.querySelector(".cm-scroller").getBoundingClientRect();
  log("backlinks panel in editing view " + JSON.stringify([pr.top, pr.height, vr.top, vr.height]));
  await view.setState({ ...view.getState(), mode: "preview" }, { history: false });
  await until("panel in reading view", () => view.containerEl.querySelector(".markdown-preview-view .embedded-backlinks"));
  await shot("backlinks-reading");
  await view.setState({ ...view.getState(), mode: "source" }, { history: false });
});

await step("stacked-tabs", async () => {
  await open("Table.md", true);
  await open("Other.md", true);
  const tabs = app.workspace.activeLeaf.parent;
  const widthBefore = tabs.tabHeaderContainerEl.getBoundingClientRect().width;
  cmd("workspace:toggle-stacked-tabs");
  await until("mod-stacked class", () => tabs.containerEl.classList.contains("mod-stacked"));
  await until("several stacked panes with headers", () => tabs.containerEl.querySelectorAll(".workspace-leaf").length >= 3);
  await sleep(400);
  // Layout facts only a real engine can check (happy-dom has no layout): panes sit side by side, not stacked vertically
  // below the viewport, headers are narrow vertical strips, and the active pane is on screen with its note rendered.
  const box = tabs.tabContainerEl.getBoundingClientRect();
  const act = app.workspace.activeLeaf;
  const pane = act.containerEl.getBoundingClientRect();
  const hdr = act.tabHeaderEl.getBoundingClientRect();
  if (!(pane.top >= box.top - 1 && pane.bottom <= box.bottom + 1)) { log("FAIL stacked pane is outside the container vertically " + JSON.stringify([pane.top, pane.bottom, box.top, box.bottom])); await ipc.quitApp(); throw new Error("smoke: stacked layout"); }
  if (!(pane.left >= box.left && pane.left < box.right - 100)) { log("FAIL active stacked pane is not on screen " + JSON.stringify([pane.left, box.left, box.right])); await ipc.quitApp(); throw new Error("smoke: stacked layout"); }
  if (!(hdr.width <= 41 && hdr.height > 300)) { log("FAIL stacked header is not a vertical strip " + JSON.stringify([hdr.width, hdr.height])); await ipc.quitApp(); throw new Error("smoke: stacked layout"); }
  await shot("stacked-tabs-on");
  cmd("workspace:toggle-stacked-tabs");
  await until("stacked off again", () => !tabs.containerEl.classList.contains("mod-stacked"));
});

await step("linked-tabs", async () => {
  // "Link with tab..." from the tab header's real context menu, then a click on the other tab; then "Open linked view".
  const menuItem = async (leaf, title) => {
    document.querySelectorAll(".menu").forEach((m) => m.remove()); // no stale menu can answer for this one
    leaf.tabHeaderEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 20 }));
    await until("tab menu opens", () => document.querySelector(".menu .menu-item"));
    const menus = document.querySelectorAll(".menu");
    const item = [...menus[menus.length - 1].querySelectorAll(".menu-item")].find((i) => i.querySelector(".menu-item-title")?.textContent === title);
    if (!item) { log("FAIL tab menu has no '" + title + "': " + [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent).join(" | ")); await ipc.quitApp(); throw new Error("smoke: tab menu"); }
    return item;
  };
  const a = await open("Doc.md", true);
  const b = await open("Other.md", true);
  (await menuItem(b, "Link with tab...")).click();
  await until("link picking overlay", () => document.querySelector(".tachylite-link-picking"));
  a.tabHeaderEl.click();
  await until("both tabs in one group", () => a.group && a.group === b.group);
  await until("linked marker in the tab header", () => b.tabHeaderEl.querySelector(".workspace-tab-header-status-icon.mod-linked") !== null);
  await sleep(300);
  await shot("linked-tabs-marked");
  (await menuItem(b, "Unlink tab")).click();
  await until("unlinked", () => !a.group && !b.group);
  const before = app.workspace.getLeavesOfType("outline").length;
  const lv = await menuItem(a, "Open linked view");
  lv.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true })); lv.click();
  await sleep(400);
  const sub = await until("linked view submenu", () => [...[...document.querySelectorAll(".menu")].pop().querySelectorAll(".menu-item")].find((i) => i.querySelector(".menu-item-title")?.textContent === "Open outline"));
  await shot("open-linked-view-menu");
  sub.click();
  await until("outline opened in a tab linked to the note", () => app.workspace.getLeavesOfType("outline").length > before && app.workspace.getLeavesOfType("outline").some((o) => o.group && o.group === a.group));
  document.querySelector(".menu")?.remove();
});

await step("export-pdf-modal", async () => {
  await open("Doc.md");
  cmd("workspace:export-pdf");
  await until("export options modal", () => document.querySelector(".modal .setting-item"));
  const text = document.querySelector(".modal").textContent;
  if (!/Page size/.test(text) || !/Margin/.test(text)) { log("FAIL export-pdf modal lacks its options"); await ipc.quitApp(); throw new Error("smoke: pdf modal"); }
  await shot("export-pdf-modal-open");
  closeModals();
  [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Cancel")?.click();
  await until("export modal closed", () => !document.querySelector(".modal"));
});

await step("canvas", async () => {
  const data = { nodes: [
    { id: "g1", type: "group", x: -400, y: -200, width: 500, height: 400, label: "Group One" },
    { id: "t1", type: "text", text: "card text", x: -300, y: -100, width: 200, height: 80 },
  ], edges: [] };
  await mk("Board.canvas", JSON.stringify(data));
  const leaf = await open("Board.canvas");
  const view = leaf.view;
  await until("canvas nodes", () => view.canvas && view.canvas.nodes.size === 2);
  const card = view.canvas.nodes.get("t1");
  view.canvas.selectOnly(card);
  cmd("canvas:jump-to-group");
  await until("group picker", () => document.querySelector(".prompt .suggestion-item"));
  await shot("canvas-jump-to-group");
  document.querySelector(".prompt .suggestion-item").click();
  await until("group picker closed", () => !document.querySelector(".prompt"));
  view.canvas.selectOnly(view.canvas.nodes.get("t1"));
  cmd("canvas:convert-to-file");
  const input = await until("file name prompt", () => document.querySelector(".modal textarea"));
  input.value = "Converted card";
  await shot("canvas-convert-to-file");
  [...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Save").click();
  await until("card became a note", () => app.vault.getFileByPath("Converted card.md"));
  await until("canvas now holds a file node", async () => JSON.parse(await app.vault.read(app.vault.getFileByPath("Board.canvas"))).nodes.some((n) => n.type === "file" && n.file === "Converted card.md"));
});

await step("bases-copy-table", async () => {
  await mk("Things.base", "views:\n  - type: table\n    name: Table\n");
  const leaf = await open("Things.base");
  await until("base view rendered", () => leaf.view.containerEl.querySelector(".bases-view, .bases-table-container, table"));
  const view = leaf.view;
  const host = view.host ?? view.controller ?? view;
  const table = host.asTable("\t");
  if (!/file name/.test(table) || !/Doc/.test(table) || !table.includes("\t") && table.split("\n").length < 3) { log("FAIL bases table text is wrong: " + JSON.stringify(table.slice(0, 200))); await ipc.quitApp(); throw new Error("smoke: bases table"); }
  cmd("bases:copy-table");
  // The webview only allows clipboard writes after a user gesture, which an in-app script does not have, so the notice may
  // say "Unable to copy" here; either way the command ran. The text it would copy was checked above.
  const note = await until("copy notice shown", () => [...document.querySelectorAll(".notice")].map((n) => n.textContent).find((t) => /Copied to clipboard|Unable to copy/.test(t)));
  log("bases copy-table notice: " + note);
});

await step("graph-animation", async () => {
  await app.commands.executeCommandById("graph:open");
  const view = await until("graph view", () => app.workspace.getLeavesOfType("graph")[0]?.view);
  await until("graph canvas", () => view.containerEl.querySelector("canvas"));
  // The time-lapse needs notes created at different times.
  await mk("Old.md", "old\n");
  await sleep(1300);
  await mk("New.md", "new [[Old]]\n");
  cmd("graph:animate");
  const first = await until("time-lapse started (cutoff set)", () => view.animCutoff);
  await sleep(1500);
  await shot("graph-animating");
  if (!(view.animCutoff > first)) { log("FAIL time-lapse cutoff did not advance " + first + " -> " + view.animCutoff); await ipc.quitApp(); throw new Error("smoke: animation"); }
  view.stopAnimation?.(false);
  await until("time-lapse stopped", () => view.animCutoff === null);
});

await step("graph-bookmark", async () => {
  const leaf = app.workspace.getLeavesOfType("graph")[0];
  app.workspace.setActiveLeaf(leaf, { focus: true });
  leaf.view.options.search = "smoke";
  cmd("bookmarks:bookmark-current-view");
  await until("Add bookmark dialog", () => document.querySelector(".modal.mod-bookmark"));
  await shot("graph-bookmark-dialog");
  const t = document.querySelector(".modal.mod-bookmark input");
  t.value = "Smoke graph"; t.dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector(".modal.mod-bookmark button.mod-cta").click();
  const store = app.internalPlugins.getPluginById("bookmarks").instance;
  await until("graph bookmark stored", () => store.items.some((i) => i.type === "graph" && i.title === "Smoke graph" && i.options.search === "smoke"));
  leaf.view.options.search = "";
  cmd("bookmarks:open");
  const row = await until("bookmark row in the Bookmarks view", () => document.querySelector(".bookmark-item.mod-graph .bookmark"));
  await shot("graph-bookmark-row");
  row.click();
  await until("opening it restores the settings", () => app.workspace.getLeavesOfType("graph")[0].view.options.search === "smoke");
});

log("DONE");
await ipc.quitApp();
