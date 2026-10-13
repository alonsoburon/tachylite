// Popout windows end to end against the fake backend: a second happy-dom Window plays the WindowProxy that
// window.open returns in the app. Views move between documents (same objects), editing and saving work in the
// popout, menus/modals/notices open in the focused window, styles are mirrored, the OS close button closes the
// window's leaves, and popouts persist in workspace.json (`floating`) and come back on restart.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { installFakePopouts, type FakePopouts } from "./helpers/popout";
import { startSession, type Session } from "../src/app/session";
import { MarkdownView, Menu, Modal, Notice, WorkspaceWindow, type WorkspaceLeaf } from "../src/obsidian";

const PLUGIN_MAIN = `
const { Plugin, ItemView } = require("obsidian");
class ProbeView extends ItemView {
  getViewType() { return "probe-view"; }
  getDisplayText() { return "Probe"; }
  async onOpen() {
    this.contentEl.createDiv({ cls: "probe-body", text: "probe" });
    this.register(this.containerEl.onWindowMigrated((win) => window.__probe.migrated.push(win === window ? "main" : "popout")));
  }
}
module.exports = class Probe extends Plugin {
  async onload() {
    window.__probe = { opened: [], closed: [], migrated: [], active: [] };
    this.registerView("probe-view", (leaf) => new ProbeView(leaf));
    this.registerEvent(this.app.workspace.on("window-open", (ww, win) => {
      window.__probe.opened.push({ isWin: ww.win === win, label: ww.id });
      // Plugins build DOM for a new window through its own document.
      win.document.body.createDiv({ cls: "probe-banner", text: "hi from plugin" });
    }));
    this.registerEvent(this.app.workspace.on("window-close", (ww, win) => window.__probe.closed.push(ww.win === win)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => window.__probe.active.push(activeDocument === document ? "main" : "popout")));
  }
};`;

let v: FakeVault;
let pop: FakePopouts;
let session: Session | null = null;
const q = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];
const probe = () => (globalThis as any).__probe;
const cmOf = (v: unknown) => ((v as MarkdownView).editor as any).cm as { root: Document | ShadowRoot };

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  v = makeVault(
    { "A.md": "# A\nfirst line\n", "B.md": "# B\nsee [[A]]\n" },
    { plugins: { probe: { manifest: { id: "probe", name: "Probe", version: "1.0.0", minAppVersion: "0.15.0" }, main: PLUGIN_MAIN } }, enabled: ["probe"] },
  );
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
  pop = installFakePopouts();
});
afterEach(async () => {
  await session?.stop();
  session = null;
  await pop.restore();
  v.cleanup();
  document.body.innerHTML = "";
});

async function boot(withPlugin = true): Promise<Session> {
  const host = document.body.appendChild(document.createElement("div"));
  host.id = "app";
  session = await startSession((await v.backend("vault_info")) as any, host);
  if (withPlugin) {
    session.app.saveLocalStorage("enable-plugin", true);
    await session.app.plugins.turnOnCommunityPlugins();
    await vi.waitFor(() => expect(session!.app.plugins.getPlugin("probe")).toBeTruthy());
  }
  return session;
}
async function openA(s: Session): Promise<WorkspaceLeaf> {
  await s.app.workspace.openLinkText("A", "", false);
  const leaf = s.app.workspace.activeLeaf!;
  await leaf.whenReady();
  return leaf;
}
const popDoc = (i = 0) => pop.opened[i].win.document as unknown as Document;
const key = (doc: Document, k: string, mods: Partial<KeyboardEventInit> = {}) =>
  (doc.activeElement ?? doc.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));

describe("popout windows (fake backend)", () => {
  it("moves a live view into a new window with the app skeleton, mirrored styles and window-open", async () => {
    const s = await boot();
    const ws = s.app.workspace;
    const leaf = await openA(s);
    const view = leaf.view as MarkdownView;
    document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ".x-before { color: red }" }));
    const win = ws.moveLeafToPopout(leaf);
    expect(win).toBeInstanceOf(WorkspaceWindow);
    expect(pop.opened).toHaveLength(1);
    expect(pop.opened[0].url).toMatch(/^about:blank#tachylite-popout\?label=popout-[0-9a-f]+/);
    const doc = popDoc();
    expect(win.doc).toBe(doc);
    // same view object, its DOM now owned by the popout's document
    expect(leaf.view).toBe(view);
    expect(view.containerEl.ownerDocument).toBe(doc);
    expect(cmOf(view).root).toBe(doc); // CodeMirror re-rooted (styles + listeners follow the window)
    expect(leaf.getContainer()).toBe(win);
    expect(leaf.getRoot()).toBe(win);
    expect(ws.floatingSplit.children).toEqual([win]);
    expect(q(".app-container > .horizontal-main-container > .workspace > .workspace-split.mod-root.workspace-window .workspace-tabs .workspace-leaf", doc as any)).toBeTruthy();
    expect(doc.body.classList.contains("is-popout-window")).toBe(true);
    expect(doc.body.classList.contains("theme-dark") || doc.body.classList.contains("theme-light")).toBe(true);
    // the main window keeps a (new, empty) tab
    expect(ws.rootSplit.leaves()).toHaveLength(1);
    expect(ws.rootSplit.leaves()[0].view.getViewType()).toBe("empty");
    // plugin hooks: window-open(WorkspaceWindow, Window), plugin DOM through win.document, activeDocument/activeWindow
    expect(probe().opened).toEqual([{ isWin: true, label: win.id }]);
    expect(q(".probe-banner", doc as any)?.textContent).toBe("hi from plugin");
    expect((globalThis as any).activeDocument).toBe(doc);
    expect((globalThis as any).activeWindow).toBe(win.win);
    expect(probe().active.at(-1)).toBe("popout");
    // stylesheets mirrored, and kept in sync (a plugin adds one later, the theme's body class changes)
    expect([...doc.head.querySelectorAll("style")].some((e) => e.textContent === ".x-before { color: red }")).toBe(true);
    const later = document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ".x-later { color: blue }" }));
    document.body.classList.add("x-theme-flag");
    await vi.waitFor(() => expect([...doc.head.querySelectorAll("style")].some((e) => e.textContent === ".x-later { color: blue }")).toBe(true));
    expect(doc.body.classList.contains("x-theme-flag")).toBe(true);
    later.textContent = ".x-later { color: green }";
    await vi.waitFor(() => expect([...doc.head.querySelectorAll("style")].some((e) => e.textContent === ".x-later { color: green }")).toBe(true));
    later.remove();
    await vi.waitFor(() => expect([...doc.head.querySelectorAll("style")].some((e) => e.textContent?.startsWith(".x-later"))).toBe(false));
    // the popout's own sheets (CodeMirror mounts its base theme per document, at the top) stay before the mirrored
    // block, so app/theme CSS keeps winning over them
    const own = doc.head.insertBefore(doc.createElement("style"), doc.head.firstChild);
    own.textContent = ".own {}";
    document.head.appendChild(Object.assign(document.createElement("style"), { textContent: ".x-last {}" }));
    await vi.waitFor(() => expect([...doc.head.querySelectorAll("style")].some((e) => e.textContent === ".x-last {}")).toBe(true));
    const sheets = [...doc.head.querySelectorAll("style")];
    expect(sheets.indexOf(own)).toBeLessThan(sheets.findIndex((e) => e.hasAttribute("data-tachylite-mirror")));
    expect(sheets.at(-1)?.textContent).toBe(".x-last {}");
    // the popout's tab chrome is wired like the main area's
    await vi.waitFor(() => expect(q(".workspace-tab-header-new-tab", doc as any)).toBeTruthy());
    expect(q(".workspace-tab-header-inner-close-button", doc as any)).toBeTruthy();
  });

  it("edits and saves in the popout; keyboard, menus, modals and notices use the popout's document", async () => {
    const s = await boot(false);
    const ws = s.app.workspace;
    const leaf = await openA(s);
    const view = leaf.view as MarkdownView;
    const win = ws.moveLeafToPopout(leaf);
    const doc = win.doc;
    view.editor.replaceRange("typed in popout\n", { line: 2, ch: 0 });
    await view.save();
    expect(fs.readFileSync(path.join(v.root, "A.md"), "utf8")).toBe("# A\nfirst line\ntyped in popout\n");
    // an app hotkey pressed in the popout reaches the keymap (Ctrl+E toggles reading view)
    key(doc, "e", { ctrlKey: true });
    await vi.waitFor(() => expect(view.getMode()).toBe("preview"));
    expect(q(".markdown-reading-view", doc as any) ?? q(".markdown-preview-view", doc as any)).toBeTruthy();
    // tab context menu opens inside the popout, with the window items
    leaf.tabHeaderEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    const menu = q(".menu", doc as any)!;
    expect(menu).toBeTruthy();
    expect(q(".menu")).toBeNull();
    const titles = qa(".menu-item-title", menu).map((e) => e.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Move to new window", "Open in new window", "Move to main window"]));
    key(doc, "Escape");
    expect(q(".menu", doc as any)).toBeNull();
    // anchorless menus, modals and notices go to the focused (active) window
    new Menu().addItem((i) => i.setTitle("Here")).showAtPosition({ x: 5, y: 5 });
    expect(q(".menu", doc as any)).toBeTruthy();
    key(doc, "Escape");
    const m = new Modal(s.app); m.setTitle("In popout"); m.open();
    expect(q(".modal-container .modal-title", doc as any)?.textContent).toBe("In popout");
    expect(q(".modal-container")).toBeNull();
    key(doc, "Escape");
    expect(q(".modal-container", doc as any)).toBeNull();
    new Notice("popout notice");
    expect(q(".notice-container .notice", doc as any)?.textContent).toBe("popout notice");
    // focusing the main window makes a main leaf active again
    window.dispatchEvent(new Event("focus"));
    expect((globalThis as any).activeDocument).toBe(document);
    expect(ws.activeLeaf?.getRoot()).toBe(ws.rootSplit);
    new Notice("main notice");
    expect(qa(".notice-container .notice").map((e) => e.textContent)).toContain("main notice");
  });

  it("closing the OS window closes its leaves (saving them), fires window-close and forgets the window", async () => {
    const s = await boot();
    const ws = s.app.workspace;
    const leaf = await openA(s);
    const win = ws.moveLeafToPopout(leaf);
    const label = s.shell.popouts.labelOf(win)!;
    (leaf.view as MarkdownView).editor.replaceRange("unsaved edit\n", { line: 2, ch: 0 });
    v.emitEvent("popout-close-requested", label);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(v.root, "A.md"), "utf8")).toContain("unsaved edit"));
    expect(leaf.parent).toBeNull();
    expect(ws.floatingSplit.children).toHaveLength(0);
    expect(v.popouts.closed).toEqual([label]);
    expect(probe().closed).toEqual([true]);
    expect((globalThis as any).activeDocument).toBe(document);
    expect(ws.activeLeaf?.getRoot()).toBe(ws.rootSplit);
    expect(ws.getLayout().floating).toBeUndefined();
    // closing the last tab inside a popout closes the window too
    const l2 = ws.openPopoutLeaf();
    const w2 = l2.getContainer() as WorkspaceWindow;
    l2.detach();
    expect(ws.floatingSplit.children).toHaveLength(0);
    expect(v.popouts.closed).toEqual([label, s.shell.popouts.labelOf(w2) ?? v.popouts.closed[1]]);
  });

  it("moves tabs back to the main window (menu or drag), re-rooting editors and migrating plugin views", async () => {
    const s = await boot();
    const ws = s.app.workspace;
    const leaf = ws.getLeaf("tab");
    await leaf.setViewState({ type: "probe-view", active: true });
    const win = ws.moveLeafToPopout(leaf);
    expect(probe().migrated).toEqual(["popout"]);
    s.shell.moveToMain(leaf);
    expect(leaf.getRoot()).toBe(ws.rootSplit);
    expect(leaf.containerEl.ownerDocument).toBe(document);
    expect(probe().migrated).toEqual(["popout", "main"]);
    expect(ws.floatingSplit.children).not.toContain(win); // its only tab left: the window closed
    expect(v.popouts.focused).toContain("main");
    // drag a markdown tab from a popout onto the main tab bar
    const a = await openA(s);
    const w2 = ws.moveLeafToPopout(a);
    const cm = cmOf(a.view);
    expect(cm.root).toBe(w2.doc);
    a.tabHeaderEl.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const bar = (ws.rootSplit.children[0] as any).tabHeaderContainerEl.parentElement as HTMLElement;
    bar.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    bar.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    expect(a.getRoot()).toBe(ws.rootSplit);
    expect(cm.root).toBe(document);
    expect(ws.floatingSplit.children).toHaveLength(0);
  });

  it("persists popouts in workspace.json (floating, geometry) and restores them on restart", async () => {
    let s = await boot(false);
    const ws = s.app.workspace;
    const leaf = await openA(s);
    const win = ws.moveLeafToPopout(leaf);
    const label = s.shell.popouts.labelOf(win)!;
    v.emitEvent("popout-geometry", { label, x: 40, y: 50, width: 900, height: 700, maximize: false });
    await s.shell.flushAsync();
    const saved = JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/workspace.json"), "utf8"));
    expect(saved.floating.type).toBe("floating");
    expect(saved.floating.children).toHaveLength(1);
    const w = saved.floating.children[0];
    expect(w).toMatchObject({ type: "window", x: 40, y: 50, width: 900, height: 700, maximize: false, direction: "vertical" });
    expect(w.children[0].type).toBe("tabs");
    expect(w.children[0].children[0].state).toMatchObject({ type: "markdown", state: { file: "A.md" } });
    expect(saved.active).toBe(leaf.id);
    // restart
    await session!.stop();
    session = null;
    document.body.innerHTML = "";
    s = await boot(false);
    expect(pop.opened).toHaveLength(2);
    expect(pop.opened[1].url).toContain("x=40");
    expect(pop.opened[1].url).toContain("width=900");
    const restored = s.app.workspace.floatingSplit.children;
    expect(restored).toHaveLength(1);
    expect(restored[0].geometry).toEqual({ x: 40, y: 50, width: 900, height: 700 });
    const rl = restored[0].leaves();
    expect(rl.map((l) => (l.view as MarkdownView).file?.path)).toEqual(["A.md"]);
    expect(rl[0].view.containerEl.ownerDocument).toBe(popDoc(1));
    expect(cmOf(rl[0].view).root).toBe(popDoc(1));
    expect(s.app.workspace.activeLeaf).toBe(rl[0]);
  });

  it("window commands and link menus: open/move to new window, close window, Mod+Alt+Shift link clicks", async () => {
    const s = await boot(false);
    const ws = s.app.workspace;
    for (const id of ["workspace:new-window", "workspace:open-in-new-window", "workspace:move-to-new-window", "workspace:close-window"]) expect(s.app.commands.findCommand(id), id).toBeTruthy();
    const leaf = await openA(s);
    expect(s.app.commands.executeCommandById("workspace:open-in-new-window")).toBe(true);
    await vi.waitFor(() => expect(ws.floatingSplit.children[0]?.leaves()[0]?.view.getViewType()).toBe("markdown"));
    expect(leaf.getRoot()).toBe(ws.rootSplit); // a copy: the original stays
    expect(s.app.commands.executeCommandById("workspace:close-window")).toBe(true);
    expect(ws.floatingSplit.children).toHaveLength(0);
    ws.setActiveLeaf(leaf);
    expect(s.app.commands.executeCommandById("workspace:move-to-new-window")).toBe(true);
    expect(leaf.getContainer()).toBeInstanceOf(WorkspaceWindow);
    expect(s.app.commands.executeCommandById("workspace:close-window")).toBe(true);
    // link context menu and "window" pane type
    const m = new Menu();
    ws.handleLinkContextMenu(m, "B", "A.md");
    expect(m.items.map((i: any) => i.titleEl?.textContent)).toContain("Open in new window");
    await ws.openLinkText("B", "A.md", "window");
    const w = ws.floatingSplit.children[0];
    expect((w.leaves()[0].view as MarkdownView).file?.path).toBe("B.md");
    // following a link inside a popout stays in that popout
    await ws.openLinkText("A", "B.md", false);
    expect((w.leaves()[0].view as MarkdownView).file?.path).toBe("A.md");
    expect(w.leaves()).toHaveLength(1);
  });

  it("falls back to a tab when no window can be opened, and forgets windows destroyed behind its back", async () => {
    const s = await boot(false);
    const ws = s.app.workspace;
    const leaf = await openA(s);
    const { setPopoutOpener } = await import("../src/app/popout");
    setPopoutOpener(() => null);
    const nl = ws.openPopoutLeaf();
    expect(nl.getRoot()).toBe(ws.rootSplit);
    expect(ws.floatingSplit.children).toHaveLength(0);
    expect(qa(".notice").map((e) => e.textContent)).toContain("Unable to open a new window.");
    expect(() => ws.moveLeafToPopout(leaf)).toThrow();
    expect(leaf.getRoot()).toBe(ws.rootSplit);
    await pop.restore(); pop = installFakePopouts();
    const win = ws.moveLeafToPopout(leaf);
    v.emitEvent("popout-destroyed", s.shell.popouts.labelOf(win));
    expect(ws.floatingSplit.children).toHaveLength(0);
    expect(leaf.parent).toBeNull();
  });
});
