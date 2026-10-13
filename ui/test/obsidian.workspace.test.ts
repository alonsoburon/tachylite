import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import {
  ItemView, MarkdownView, FileView, TextFileView, WorkspaceLeaf, WorkspaceSidedock, WorkspaceTabs, WorkspaceSplit, WorkspaceRoot, WorkspaceItem, WorkspaceParent, WorkspaceWindow, Plugin,
  EditorSuggest, Editor, editorInfoField, TFile, Menu,
} from "../src/obsidian";
import { CMEditor, setEditorFactory } from "../src/obsidian/editor";
import type { LayoutHost } from "../src/obsidian/workspace";
import type { App } from "../src/obsidian/app";

let v: FakeVault, app: App;
beforeEach(async () => { v = makeVault({ "A.md": "# A\nline two\nline three", "B.md": "# B\n## Sub\nbody ^blk\n", "x.png": "png" }); app = await makeApp(v); });
afterEach(async () => { await app.stop(); v.cleanup(); document.body.innerHTML = ""; });

class TestView extends ItemView {
  opened = 0; closed = 0; state: any = {};
  getViewType() { return "test-view"; } getDisplayText() { return "Test " + (this.state.n ?? ""); } getIcon() { return "lucide-star"; }
  async onOpen() { this.opened++; this.contentEl.createDiv({ cls: "tv" }); } async onClose() { this.closed++; }
  getState() { return this.state; } async setState(s: any) { this.state = s; }
}
const withPlugin = () => { const p = new (class extends Plugin {})(app, { id: "tp", name: "TP", version: "1", minAppVersion: "0", author: "", description: "" } as any); p.load(); return p; };

describe("layout model", () => {
  it("starts with one empty root leaf, active, tab group, DOM skeleton", () => {
    expect(app.workspace.rootSplit).toBeInstanceOf(WorkspaceRoot); expect(app.workspace.leftSplit).toBeInstanceOf(WorkspaceSidedock);
    expect(app.workspace.rightSplit.collapsed).toBe(true); expect(app.workspace.leftSplit.collapsed).toBe(false);
    const leaves: WorkspaceLeaf[] = []; app.workspace.iterateRootLeaves((l) => leaves.push(l)); expect(leaves).toHaveLength(1);
    expect(app.workspace.activeLeaf).toBe(leaves[0]); expect(leaves[0].view.getViewType()).toBe("empty");
    expect(leaves[0].parent).toBeInstanceOf(WorkspaceTabs); expect(leaves[0].parent.parent).toBe(app.workspace.rootSplit);
    expect(leaves[0].getRoot()).toBe(app.workspace.rootSplit); expect(leaves[0].getContainer()).toBe(app.workspace.rootSplit);
    expect(leaves[0]).toBeInstanceOf(WorkspaceItem); expect(leaves[0].parent).toBeInstanceOf(WorkspaceParent);
    const dom = app.dom.appContainerEl; expect(dom.querySelector(".horizontal-main-container > .workspace > .workspace-split.mod-root .workspace-tabs .workspace-leaf")).not.toBeNull();
    expect(dom.querySelector(".workspace-split.mod-left-split")).not.toBeNull(); expect(dom.querySelector(".workspace-ribbon.mod-left")).not.toBeNull(); expect(dom.querySelector(".status-bar")).not.toBeNull();
    expect(app.workspace.getRightLeaf(false)!.getContainer()).toBe(app.workspace.rootSplit); // sidebars live in the main window
  });
  it("getLeaf: reuse vs 'tab' vs 'split'; splits create nested structure; detach prunes and keeps a leaf", () => {
    const ws = app.workspace; const first = ws.getLeaf(false); expect(first).toBe(ws.activeLeaf);
    const t = ws.getLeaf("tab"); expect(t).not.toBe(first); expect(t.parent).toBe(first.parent); expect(ws.getLeaf(true).parent).toBe(first.parent);
    const s = ws.getLeaf("split"); expect(s.parent).not.toBe(first.parent); expect(s.getRoot()).toBe(ws.rootSplit);
    const s2 = ws.getLeaf("split", "horizontal"); expect((s2.parent.parent as any).direction === "horizontal" || (s2.parent.parent!.parent as any)?.direction === "horizontal").toBe(true);
    for (const l of ws.rootSplit.leaves()) l.detach();
    expect(ws.rootSplit.leaves()).toHaveLength(1); expect(ws.activeLeaf).toBe(ws.rootSplit.leaves()[0]);
  });
  it("side leaves: getLeftLeaf/getRightLeaf(split), ensureSideLeaf reveals and expands the dock", async () => {
    const ws = app.workspace; const plugin = withPlugin(); plugin.registerView("test-view", (l) => new TestView(l));
    const a = ws.getRightLeaf(false)!, b = ws.getRightLeaf(false)!; expect(a.parent).toBe(b.parent); expect(ws.getRightLeaf(true)!.parent).not.toBe(a.parent);
    expect(ws.rightSplit.collapsed).toBe(true);
    const leaf = await ws.ensureSideLeaf("test-view", "right", { active: true, reveal: true, state: { n: 5 } });
    expect(ws.rightSplit.collapsed).toBe(false); expect(leaf.view).toBeInstanceOf(TestView); expect((leaf.view as TestView).state).toEqual({ n: 5 });
    expect(await ws.ensureSideLeaf("test-view", "right")).toBe(leaf);
    expect(ws.getLeavesOfType("test-view")).toEqual([leaf]); expect(ws.getLeftLeaf(false)!.getRoot()).toBe(ws.leftSplit);
    ws.detachLeavesOfType("test-view"); expect(ws.getLeavesOfType("test-view")).toHaveLength(0); expect((leaf.view as TestView).closed).toBe(1);
  });
  it("LayoutHost hooks are called", async () => {
    const calls: string[] = []; const host: LayoutHost = { onLayoutChange: () => calls.push("layout"), revealLeaf: () => calls.push("reveal"), onActiveLeafChange: () => calls.push("active"), onViewOpened: (_l, view) => calls.push("opened:" + view.getViewType()), onViewClosed: () => calls.push("closed"), onSidedockToggle: (s, c) => calls.push(`dock:${s}:${c}`), saveLayout: () => { calls.push("save"); } };
    app.workspace.host = host;
    const leaf = app.workspace.getLeaf("tab"); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true });
    await app.workspace.revealLeaf(app.workspace.getRightLeaf(false)!);
    expect(calls).toEqual(expect.arrayContaining(["layout", "opened:markdown", "active", "reveal", "dock:right:false"]));
    app.workspace.requestSaveLayout.run(); await vi.waitFor(() => expect(calls).toContain("save"));
  });
  it("getLayout/changeLayout round trip", async () => {
    const ws = app.workspace; await ws.getLeaf(false).openFile(app.vault.getFileByPath("A.md")!, { active: true }); const l2 = ws.getLeaf("split"); await l2.openFile(app.vault.getFileByPath("B.md")!);
    const layout: any = ws.getLayout(); expect(layout.main.type).toBe("split"); expect(JSON.stringify(layout)).toContain('"file":"B.md"');
    await ws.changeLayout(JSON.parse(JSON.stringify(layout)));
    const files: string[] = []; ws.iterateRootLeaves((l) => { if (l.view instanceof MarkdownView) files.push(l.view.file!.path); });
    expect(files.sort()).toEqual(["A.md", "B.md"]); expect(ws.activeLeaf).not.toBeNull();
  });
});

describe("opening files and events", () => {
  it("leaf.openFile creates a MarkdownView, loads content, fires file-open / active-leaf-change / layout-change once each way", async () => {
    const ev: string[] = [];
    app.workspace.on("file-open", (f: TFile | null) => ev.push("file-open:" + f?.path)); app.workspace.on("active-leaf-change", (l: WorkspaceLeaf | null) => ev.push("active:" + l?.view.getViewType())); app.workspace.on("layout-change", () => ev.push("layout"));
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!);
    const view = leaf.view as MarkdownView; expect(view).toBeInstanceOf(MarkdownView); expect(view).toBeInstanceOf(TextFileView); expect(view).toBeInstanceOf(FileView);
    expect(view.file!.path).toBe("A.md"); expect(view.editor.getValue()).toBe("# A\nline two\nline three"); expect(view.getViewType()).toBe("markdown"); expect(view.getDisplayText()).toBe("A");
    expect(ev).toContain("file-open:A.md"); expect(ev.filter((e) => e.startsWith("file-open"))).toHaveLength(1); expect(ev).toContain("layout");
    expect(app.workspace.getActiveFile()!.path).toBe("A.md"); expect(app.workspace.getActiveViewOfType(MarkdownView)).toBe(view); expect(app.workspace.activeEditor).toBe(view);
    await app.workspace.getLeaf("tab").openFile(app.vault.getFileByPath("B.md")!, { active: true });
    expect(ev.filter((e) => e.startsWith("file-open"))).toEqual(["file-open:A.md", "file-open:B.md"]); expect(app.workspace.getLastOpenFiles()).toEqual(["B.md", "A.md"]);
    const side = app.workspace.getRightLeaf(false)!; await side.setViewState({ type: "markdown" }); // non-file leaf focus must not break getActiveFile
    app.workspace.setActiveLeaf(side); expect(app.workspace.getActiveFile()!.path).toBe("B.md");
  });
  it("MarkdownView: edit -> editor-change event -> save() writes the file (requestSave debounced), view header/data-type DOM", async () => {
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    const changes: string[] = []; app.workspace.on("editor-change", (ed: Editor, info: MarkdownView) => changes.push(ed.getValue() + "|" + info.file!.path));
    view.editor.replaceRange("X", { line: 0, ch: 0 }); expect(changes).toEqual(["X# A\nline two\nline three|A.md"]);
    await view.save(); expect(fs.readFileSync(path.join(v.root, "A.md"), "utf8")).toBe("X# A\nline two\nline three");
    expect(view.containerEl.getAttribute("data-type")).toBe("markdown"); expect(view.containerEl.children[0].classList.contains("view-header")).toBe(true); expect(view.containerEl.children[1]).toBe(view.contentEl);
    expect(view.contentEl.querySelector(".markdown-source-view .cm-editor")).not.toBeNull(); expect(leaf.containerEl.getAttribute("data-type")).toBe("markdown");
    expect(leaf.tabHeaderEl.querySelector(".workspace-tab-header-inner-title")!.textContent).toBe("A");
    // programmatic load does not count as a user edit
    view.setViewData("replaced", false); expect(changes).toHaveLength(1);
  });
  it("external modifications refresh an unmodified view; a dirty view keeps the user's edits", async () => {
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    fs.writeFileSync(path.join(v.root, "A.md"), "external change!"); await app.vault.sync();
    await vi.waitFor(() => expect(view.editor.getValue()).toBe("external change!"));
    view.editor.replaceRange("mine ", { line: 0, ch: 0 }); fs.writeFileSync(path.join(v.root, "A.md"), "external again, longer"); await app.vault.sync();
    await new Promise((r) => setTimeout(r, 30)); expect(view.editor.getValue()).toBe("mine external change!");
  });
  it("rename keeps the view on the file; delete detaches the leaf", async () => {
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    await app.vault.rename(view.file!, "Z.md"); expect(view.file!.path).toBe("Z.md"); expect(leaf.tabHeaderEl.textContent).toContain("Z");
    await app.vault.delete(view.file!); expect(app.workspace.getLeavesOfType("markdown").includes(leaf)).toBe(false);
  });
  it("preview mode renders markdown through the hook; setViewState with mode", async () => {
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    expect(view.getMode()).toBe("source"); await leaf.setViewState({ type: "markdown", state: { file: "A.md", mode: "preview" } });
    expect(view.getMode()).toBe("preview"); await (view.previewMode as any).whenRendered();
    expect(view.contentEl.querySelector(".markdown-reading-view .markdown-preview-view.markdown-rendered .markdown-preview-sizer")!.textContent).toContain("line two");
    expect(view.currentMode).toBe(view.previewMode); expect((view.sourceEl as HTMLElement).style.display).toBe("none");
  });
  it("openLinkText: resolves links, subpaths set ephemeral state, creates missing notes, new leaf, reuses existing leaf", async () => {
    const ws = app.workspace;
    await ws.openLinkText("B#Sub", "A.md"); const view = ws.getActiveViewOfType(MarkdownView)!; expect(view.file!.path).toBe("B.md");
    await vi.waitFor(() => expect(view.editor.getCursor().line).toBe(1));
    await ws.openLinkText("B#^blk", "A.md"); await vi.waitFor(() => expect(view.editor.getCursor().line).toBe(2));
    const before = ws.getLeavesOfType("markdown").length; await ws.openLinkText("B", "A.md"); expect(ws.getLeavesOfType("markdown")).toHaveLength(before);
    await ws.openLinkText("Brand New", "A.md", "tab"); expect(app.vault.getFileByPath("Brand New.md")).not.toBeNull(); expect(ws.getActiveFile()!.path).toBe("Brand New.md"); expect(ws.getLeavesOfType("markdown").length).toBe(before + 1);
    await ws.openLinkText("x.png", "A.md", "tab"); expect(ws.activeLeaf!.view.getViewType()).toBe("image"); // core media viewer
    expect(ws.activeLeaf!.view.containerEl.querySelector(".image-container img")!.getAttribute("src")).toContain("x.png");
    await app.vault.create("weird.xyz", "?"); await ws.openLinkText("weird.xyz", "A.md", "tab"); expect(ws.activeLeaf!.view.getViewType()).toBe("file-unsupported");
  });
  it("unregistered view types become placeholders that revive when registered; unload defers leaves", async () => {
    const ws = app.workspace; const leaf = ws.getRightLeaf(false)!; await leaf.setViewState({ type: "test-view", state: { n: 9 } });
    expect(leaf.view.constructor.name).toBe("DeferredView");
    const p = withPlugin(); p.registerView("test-view", (l) => new TestView(l));
    await vi.waitFor(() => expect(leaf.view).toBeInstanceOf(TestView)); expect((leaf.view as TestView).state).toEqual({ n: 9 });
    p.unload(); await vi.waitFor(() => expect(leaf.view.constructor.name).toBe("DeferredView")); expect(leaf.getViewState().type).toBe("test-view");
  });
  it("View lifecycle: onOpen/onClose/unload, getIcon, header title, pinned, groups", async () => {
    const p = withPlugin(); p.registerView("test-view", (l) => new TestView(l));
    const leaf = ws().getLeaf("tab"); await leaf.setViewState({ type: "test-view", state: { n: 1 } }); const tv = leaf.view as TestView;
    expect([tv.opened, tv.closed]).toEqual([1, 0]); expect(tv.getIcon()).toBe("lucide-star"); expect(leaf.getDisplayText()).toBe("Test 1"); expect(tv.containerEl.querySelector(".view-content .tv")).not.toBeNull();
    const a = tv.addAction("lucide-x", "Close it", () => {}); expect(a.classList.contains("view-action") && a.getAttribute("aria-label") === "Close it").toBe(true);
    leaf.setPinned(true); expect(leaf.getViewState().pinned).toBe(true); expect(ws().getUnpinnedLeaf()).not.toBe(leaf);
    leaf.setGroup("g1"); expect(ws().getGroupLeaves("g1")).toEqual([leaf]); expect(ws().getLeafById(leaf.id)).toBe(leaf);
    // Obsidian's order: the element is detached and the component unloaded before onClose runs.
    let atClose: [boolean, boolean] | null = null;
    tv.onClose = async () => { tv.closed++; atClose = [tv._loaded, tv.containerEl.isConnected]; };
    await leaf.setViewState({ type: "empty" }); expect(tv.closed).toBe(1); expect(tv._loaded).toBe(false);
    expect(atClose).toEqual([false, false]);
    function ws() { return app.workspace; }
  });
  it("Menu hooks: handleLinkContextMenu adds open-in items", () => {
    const m = new Menu(); expect(app.workspace.handleLinkContextMenu(m, "A", "B.md")).toBe(true); expect(m.items.length).toBeGreaterThan(0);
  });
});

describe("commands & hotkeys", () => {
  it("addCommand/removeCommand/listCommands/findCommand; check callbacks; hotkeys dispatch via the global handler", async () => {
    const cmds = app.commands; const run = vi.fn(); let allowed = false;
    cmds.addCommand({ id: "t:a", name: "A", callback: run, hotkeys: [{ modifiers: ["Mod", "Shift"], key: "J" }] });
    cmds.addCommand({ id: "t:b", name: "B", checkCallback: (c) => { if (!allowed) return false; if (!c) run("b"); return true; } });
    expect(cmds.listCommands().map((c) => c.id)).toEqual(expect.arrayContaining(["t:a", "t:b"])); expect(cmds.findCommand("t:a")!.name).toBe("A");
    expect(cmds.canExecute(cmds.findCommand("t:b")!)).toBe(false); allowed = true; expect(cmds.canExecute(cmds.findCommand("t:b")!)).toBe(true);
    expect(app.hotkeyManager.getHotkeys("t:a")).toEqual([{ modifiers: ["Mod", "Shift"], key: "J" }]);
    const mod = navigator.platform.includes("Mac") ? { metaKey: true } : { ctrlKey: true };
    const e = new KeyboardEvent("keydown", { key: "j", shiftKey: true, cancelable: true, ...mod }); expect(app.hotkeyManager.handleKeydown(e)).toBe(true); expect(run).toHaveBeenCalledTimes(1); expect(e.defaultPrevented).toBe(true);
    app.hotkeyManager.setHotkeys("t:a", [{ modifiers: ["Alt"], key: "q" }]); expect(app.hotkeyManager.handleKeydown(new KeyboardEvent("keydown", { key: "j", shiftKey: true, ...mod }))).toBe(false);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/hotkeys.json"), "utf8"))["t:a"]).toBeDefined());
    cmds.removeCommand("t:a"); expect(cmds.findCommand("t:a")).toBeUndefined(); expect(cmds.executeCommandById("t:a")).toBe(false);
    cmds.addCommand({ id: "t:c", name: "boom", callback: () => { throw new Error("x"); } }); const err = vi.spyOn(console, "error").mockImplementation(() => {}); expect(cmds.executeCommandById("t:c")).toBe(false); err.mockRestore();
    expect(document.querySelector(".notice-message")!.textContent).toContain("boom");
  });
  it("core commands: quick switcher and command palette are registered and open modals", async () => {
    expect(app.commands.findCommand("switcher:open")).toBeDefined(); expect(app.commands.executeCommandById("switcher:open")).toBe(true);
    await vi.waitFor(() => expect(document.querySelectorAll(".prompt .suggestion-item").length).toBeGreaterThan(0)); expect(document.querySelector(".prompt-input")).not.toBeNull();
    app.keymap.handleEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(app.internalPlugins.getPluginById("file-explorer")!.enabled).toBe(true); expect(app.internalPlugins.getEnabledPluginById("daily-notes")).toBeNull(); expect(app.internalPlugins.getPluginById("nope")).toBeUndefined();
  });
  it("app.getAccentColor: configured colour, else the theme's accent as hex", () => {
    expect(app.getAccentColor()).toMatch(/^#[0-9a-f]{6}$/);
    document.body.style.setProperty("--accent-h", "0"); document.body.style.setProperty("--accent-s", "100%"); document.body.style.setProperty("--accent-l", "50%");
    expect(app.getAccentColor()).toBe("#ff0000");
    (app.vault as any).config.accentColor = "#123456";
    expect(app.getAccentColor()).toBe("#123456");
  });
  it("app helpers: loadLocalStorage/saveLocalStorage, isDarkMode, config, customCss", async () => {
    expect(app.loadLocalStorage("k")).toBeNull(); app.saveLocalStorage("k", { a: 1 }); expect(app.loadLocalStorage("k")).toEqual({ a: 1 }); app.saveLocalStorage("k", null); expect(app.loadLocalStorage("k")).toBeNull();
    expect(app.isDarkMode()).toBe(false); document.body.classList.add("theme-dark"); expect(app.isDarkMode()).toBe(true); document.body.classList.remove("theme-dark");
    expect(app.isMobile).toBe(false); expect((globalThis as any).app).toBe(app); expect(typeof (globalThis as any).require("obsidian").Plugin).toBe("function");
    v.write(".obsidian/snippets/s.css", ".snip{color:red}"); await app.customCss.requestLoadSnippets(); expect(app.customCss.snippets).toEqual(["s"]);
    await app.customCss.setCssEnabledStatus("s", true); expect(document.head.querySelector('style[data-tachylite-snippet="s"]')!.textContent).toBe(".snip{color:red}");
    await app.customCss.setCssEnabledStatus("s", false); expect(document.head.querySelector("style[data-tachylite-snippet]")).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/appearance.json"), "utf8")).enabledCssSnippets).toEqual([]);
    await app.metadataTypeManager.setType("rating", "number"); expect(app.metadataTypeManager.getAllProperties().rating.type).toBe("number");
    expect(app.embedRegistry.isExtensionRegistered("md")).toBe(true);
  });
});

describe("Editor over a plain CodeMirror EditorView", () => {
  const mk = (doc: string) => { const parent = document.body.createDiv(); const cm = new EditorView({ state: EditorState.create({ doc, extensions: [history(), EditorState.allowMultipleSelections.of(true)] }), parent }); return { ed: new CMEditor(cm), cm }; };
  it("document access and positions", () => {
    const { ed } = mk("héllo\nworld\n\nlast");
    expect(ed).toBeInstanceOf(Editor); expect(ed.getDoc()).toBe(ed);
    expect(ed.getValue()).toBe("héllo\nworld\n\nlast"); expect(ed.lineCount()).toBe(4); expect(ed.lastLine()).toBe(3); expect(ed.getLine(1)).toBe("world"); expect(ed.getLine(99)).toBe("");
    expect(ed.offsetToPos(8)).toEqual({ line: 1, ch: 2 }); expect(ed.posToOffset({ line: 1, ch: 2 })).toBe(8); expect(ed.posToOffset({ line: 9, ch: 0 })).toBe(ed.getValue().length); expect(ed.posToOffset({ line: 0, ch: 99 })).toBe(5);
    expect(ed.getRange({ line: 0, ch: 1 }, { line: 1, ch: 2 })).toBe("éllo\nwo");
    ed.setValue("new"); expect(ed.getValue()).toBe("new"); ed.setLine(0, "NEW"); expect(ed.getValue()).toBe("NEW");
  });
  it("cursor and selections", () => {
    const { ed } = mk("one two\nthree");
    ed.setCursor({ line: 0, ch: 3 }); expect(ed.getCursor()).toEqual({ line: 0, ch: 3 }); expect(ed.somethingSelected()).toBe(false);
    ed.setCursor(1, 2); expect(ed.getCursor("head")).toEqual({ line: 1, ch: 2 });
    ed.setSelection({ line: 0, ch: 4 }, { line: 0, ch: 7 }); expect(ed.getSelection()).toBe("two"); expect(ed.somethingSelected()).toBe(true);
    expect([ed.getCursor("from"), ed.getCursor("to"), ed.getCursor("anchor"), ed.getCursor("head")]).toEqual([{ line: 0, ch: 4 }, { line: 0, ch: 7 }, { line: 0, ch: 4 }, { line: 0, ch: 7 }]);
    ed.setSelection({ line: 0, ch: 7 }, { line: 0, ch: 4 }); expect(ed.getCursor("anchor")).toEqual({ line: 0, ch: 7 }); expect(ed.getCursor("from")).toEqual({ line: 0, ch: 4 });
    ed.setSelections([{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 3 } }, { anchor: { line: 1, ch: 0 } }], 1); expect(ed.listSelections()).toEqual([{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 3 } }, { anchor: { line: 1, ch: 0 }, head: { line: 1, ch: 0 } }]);
    expect(ed.getCursor()).toEqual({ line: 1, ch: 0 });
    ed.replaceSelection("X"); expect(ed.getValue()).toBe("X two\nXthree");
  });
  it("replaceRange / transaction / processLines / wordAt / exec / undo", () => {
    const { ed } = mk("alpha beta\ngamma\n\ndelta");
    ed.replaceRange("ALPHA", { line: 0, ch: 0 }, { line: 0, ch: 5 }); expect(ed.getLine(0)).toBe("ALPHA beta"); ed.replaceRange("> ", { line: 1, ch: 0 }); expect(ed.getLine(1)).toBe("> gamma");
    ed.transaction({ changes: [{ from: { line: 0, ch: 0 }, to: { line: 0, ch: 5 }, text: "a" }, { from: { line: 3, ch: 0 }, text: "# " }], selection: { from: { line: 0, ch: 1 } } });
    expect(ed.getValue()).toBe("a beta\n> gamma\n\n# delta"); expect(ed.getCursor()).toEqual({ line: 0, ch: 1 });
    ed.transaction({ replaceSelection: "!" }); expect(ed.getLine(0)).toBe("a! beta");
    ed.setSelection({ line: 0, ch: 0 }, { line: 3, ch: 3 }); const seen: number[] = [];
    ed.processLines((l, t) => { seen.push(l); return t.length; }, (l, t, n) => ({ from: { line: l, ch: 0 }, to: { line: l, ch: t.length }, text: `${n}:${t}` }));
    expect(seen).toEqual([0, 1, 3]); expect(ed.getLine(3)).toBe("7:# delta"); expect(ed.getLine(2)).toBe("");
    expect(ed.wordAt({ line: 0, ch: 1 })).toEqual({ from: { line: 0, ch: 0 }, to: { line: 0, ch: 1 } }); expect(ed.wordAt({ line: 2, ch: 0 })).toBeNull();
    ed.setCursor(0, 0); ed.exec("goRight"); expect(ed.getCursor()).toEqual({ line: 0, ch: 1 }); ed.exec("goEnd"); expect(ed.getCursor().line).toBe(3); ed.exec("goStart"); expect(ed.getCursor()).toEqual({ line: 0, ch: 0 });
    expect(() => ed.exec("nope" as any)).toThrow(/Unknown editor command/);
    ed.undo(); expect(ed.getLine(3)).toBe("# delta"); ed.redo(); expect(ed.getLine(3)).toBe("7:# delta");
    ed.focus(); expect(typeof ed.hasFocus()).toBe("boolean"); ed.refresh(); expect(ed.getScrollInfo()).toEqual({ top: 0, left: 0 }); ed.scrollTo(0, 0); ed.scrollIntoView({ from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } }, true);
    expect((ed as any).cm).toBeInstanceOf(EditorView);
  });
  it("MarkdownView.editor exposes `cm` and the info field resolves to the view; custom EditorFactory is honoured", async () => {
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    expect((view.editor as any).cm).toBeInstanceOf(EditorView); expect((view.editor as any).cm.state.field(editorInfoField)).toBe(view);
    const created = vi.fn(); setEditorFactory({ create: (o) => { created(o.doc); return new EditorView({ parent: o.parent, doc: o.doc, extensions: o.extensions }); } });
    await app.workspace.getLeaf("tab").openFile(app.vault.getFileByPath("B.md")!); expect(created).toHaveBeenCalled(); setEditorFactory(null);
  });
});

describe("EditorSuggest", () => {
  it("is triggered on editor changes, shows suggestions, keyboard selection replaces text and closes", async () => {
    class Sug extends EditorSuggest<string> {
      onTrigger(cursor: any, editor: Editor) { const line = editor.getLine(cursor.line).slice(0, cursor.ch); const m = /@(\w*)$/.exec(line); return m ? { start: { line: cursor.line, ch: cursor.ch - m[0].length }, end: cursor, query: m[1] } : null; }
      getSuggestions(ctx: any) { return ["alice", "bob"].filter((x) => x.startsWith(ctx.query)); }
      renderSuggestion(v: string, el: HTMLElement) { el.setText(v); }
      selectSuggestion(v: string) { const c = this.context!; c.editor.replaceRange(v, c.start, c.end); }
    }
    const p = withPlugin(); const s = new Sug(app); p.registerEditorSuggest(s);
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    view.editor.setCursor({ line: 2, ch: 10 }); view.editor.replaceRange("@a", { line: 2, ch: 10 }); view.editor.setCursor({ line: 2, ch: 12 });
    await vi.waitFor(() => expect(document.querySelectorAll(".suggestion-container .suggestion-item")).toHaveLength(1));
    expect(s.context!.query).toBe("a");
    const cm = (view.editor as any).cm as EditorView; cm.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(view.editor.getLine(2)).toBe("line three" + "alice"); expect(document.querySelector(".suggestion-container")).toBeNull();
    p.unload(); expect(app.workspace.editorSuggestManager!.suggests).not.toContain(s);
  });
});

describe("plugin-tolerant internals", () => {
  it("keymap.getRootScope returns the app scope; TextFileView survives a nulled requestSave", async () => {
    const { makeApp, makeVault } = await import("./helpers/backend");
    const { TextFileView } = await import("../src/obsidian/views");
    const v = makeVault({ "a.md": "x" });
    const app = await makeApp(v);
    try {
      expect(app.keymap.getRootScope()).toBe(app.scope);
      class V extends TextFileView { data = ""; getViewType() { return "v"; } getViewData() { return this.data; } setViewData(d: string) { this.data = d; } clear() {} }
      const leaf = app.workspace.getLeaf(true);
      const view = new V(leaf);
      (view as any).requestSave = null; // Excalidraw does this while closing
      await expect((view as any).onClose()).resolves.toBeUndefined();
    } finally { await app.stop(); v.cleanup(); }
  });
});

describe("popout windows (model)", () => {
  it("without a shell, popouts are detached WorkspaceWindows in floatingSplit; layout round-trips under `floating`", async () => {
    const ws = app.workspace; const events: string[] = [];
    ws.on("window-open", (w: any, win: Window) => events.push(`open:${w instanceof WorkspaceWindow}:${win === window}`)); ws.on("window-close", () => events.push("close"));
    const leaf = ws.openPopoutLeaf({ x: 10, y: 20, size: { width: 700, height: 500 } });
    const win = leaf.getContainer() as WorkspaceWindow;
    expect(win).toBeInstanceOf(WorkspaceWindow); expect(leaf.getRoot()).toBe(win); expect(win.parent).toBe(ws.floatingSplit); expect(ws.floatingSplit.children).toEqual([win]);
    expect(win.geometry).toEqual({ x: 10, y: 20, width: 700, height: 500 }); expect(ws.activeLeaf).toBe(leaf);
    const roots: WorkspaceLeaf[] = []; ws.iterateRootLeaves((l) => roots.push(l)); expect(roots).toContain(leaf); expect(ws.getLeafById(leaf.id)).toBe(leaf);
    await leaf.openFile(app.vault.getFileByPath("A.md")!);
    const layout = ws.getLayout() as any;
    expect(layout.floating).toMatchObject({ type: "floating", children: [{ type: "window", id: win.id, x: 10, y: 20, width: 700, height: 500, children: [{ type: "tabs", children: [{ type: "leaf", id: leaf.id }] }] }] });
    await ws.changeLayout(JSON.parse(JSON.stringify(layout)));
    const back = ws.floatingSplit.children; expect(back).toHaveLength(1); expect(back[0].id).toBe(win.id); expect(back[0].geometry.width).toBe(700);
    expect((back[0].leaves()[0].view as MarkdownView).file?.path).toBe("A.md"); expect(ws.activeLeaf).toBe(back[0].leaves()[0]);
    back[0].close();
    expect(ws.floatingSplit.children).toHaveLength(0); expect(ws.activeLeaf?.getRoot()).toBe(ws.rootSplit); expect((ws.getLayout() as any).floating).toBeUndefined();
    expect(events).toEqual(["open:true:true", "close", "open:true:true", "close"]);
  });
  it("moving a leaf to another document fires onWindowMigrated, re-roots CodeMirror and keeps the view; Node helpers see the window", async () => {
    const { Window } = await import("happy-dom");
    const other = new Window({ url: "about:blank" }) as unknown as Window;
    const host: LayoutHost = { openPopout: (w) => { other.document.body.appendChild(w.containerEl); return other; } };
    app.workspace.host = host;
    const leaf = app.workspace.getLeaf(false); await leaf.openFile(app.vault.getFileByPath("A.md")!, { active: true }); const view = leaf.view as MarkdownView;
    const seen: Window[] = []; const off = view.containerEl.onWindowMigrated((w) => seen.push(w));
    const win = app.workspace.moveLeafToPopout(leaf);
    expect(win.win).toBe(other); expect(leaf.view).toBe(view); expect(view.containerEl.ownerDocument).toBe(other.document);
    expect(seen).toEqual([other]); expect((view.editor as any).cm.root).toBe(other.document);
    expect(view.containerEl.doc).toBe(other.document); expect(view.containerEl.win).toBe(other); expect(view.containerEl.instanceOf(HTMLDivElement)).toBe(true);
    expect(activeDocument).toBe(other.document); expect(activeWindow).toBe(other);
    expect(app.workspace.rootSplit.leaves()).toHaveLength(1); // the main area got a fresh empty tab
    off(); win.close(); app.workspace.host = null;
    expect(activeWindow).toBe(window);
    await (other as any).happyDOM.close();
  });
});
