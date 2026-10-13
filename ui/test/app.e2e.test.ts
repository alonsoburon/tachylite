// End-to-end check of the application shell against the fake backend (no Tauri): boot a session, open notes,
// switch modes, run commands, move tabs, install + enable a plugin through the settings UI, restore the layout.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

const PLUGIN_MAIN = `
const { Plugin, PluginSettingTab, Setting, ItemView } = require("obsidian");
class DemoView extends ItemView {
  getViewType() { return "demo-view"; }
  getDisplayText() { return "Demo view"; }
  async onOpen() { this.contentEl.createDiv({ cls: "demo-view-content", text: "hello from demo" }); }
}
module.exports = class Demo extends Plugin {
  async onload() {
    this.addRibbonIcon("star", "Demo ribbon", () => {});
    this.addCommand({ id: "ping", name: "Ping", callback: () => { document.body.setAttribute("data-demo-ping", "1"); } });
    this.registerView("demo-view", (leaf) => new DemoView(leaf));
    this.addSettingTab(new (class extends PluginSettingTab {
      display() { this.containerEl.empty(); new Setting(this.containerEl).setName("Demo option"); }
    })(this.app, this));
  }
};
`;

let v: FakeVault;
let session: Session | null = null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];
const btn = (text: string, root: ParentNode = document) => qa("button", root).find((b) => b.textContent?.trim() === text);

function stubBackend(extra: Record<string, (a: any) => unknown> = {}): void {
  setBackend(async (cmd, a) => {
    if (extra[cmd]) return extra[cmd](a);
    switch (cmd) {
      case "meta_backlinks": return {};
      case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
}

async function boot(): Promise<Session> {
  const host = document.createElement("div");
  host.id = "app";
  document.body.appendChild(host);
  const info = (await v.backend("vault_info")) as any;
  session = await startSession(info, host);
  return session;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  v = makeVault(
    { "A.md": "---\ntags: [x]\n---\n# A\nLink to [[B]] and text.\n", "B.md": "# B\nback to [[A]]\n", "folder/C.md": "c\n" },
    {},
  );
});
afterEach(async () => {
  await session?.stop();
  session = null;
  v.cleanup();
  document.body.innerHTML = "";
});

describe("application shell (fake backend)", () => {
  it("boots the Obsidian DOM skeleton with ribbon, docks, tabs and status bar", async () => {
    stubBackend();
    const s = await boot();
    for (const sel of [".app-container", ".horizontal-main-container", ".workspace", ".workspace-split.mod-root", ".workspace-split.mod-left-split", ".workspace-split.mod-right-split", ".workspace-ribbon.side-dock-ribbon", ".workspace-tabs", ".workspace-tab-header", ".workspace-leaf", ".workspace-leaf-content", ".view-header", ".view-content", ".status-bar"]) {
      expect(q(sel), sel).toBeTruthy();
    }
    // default layout: file explorer, search, bookmarks on the left; backlinks, outgoing links, tags, outline on the right
    expect(s.app.workspace.getLeavesOfType("file-explorer")).toHaveLength(1);
    expect(s.app.workspace.getLeavesOfType("search")).toHaveLength(1);
    expect(s.app.workspace.getLeavesOfType("backlink")).toHaveLength(1);
    expect(qa(".mod-left-split .nav-file-title").map((e) => e.textContent)).toContain("A");
    // the app skeleton adds sidebar toggles and a new-tab button
    expect(q(".sidebar-toggle-button.mod-left")).toBeTruthy();
    expect(q(".workspace-tab-header-new-tab")).toBeTruthy();
  });

  it("opens a note in Live Preview, switches to Source and Reading, and runs commands", async () => {
    stubBackend();
    const s = await boot();
    await s.app.workspace.openLinkText("A", "", false);
    await vi.waitFor(() => expect(q(".workspace-split.mod-root .markdown-source-view .cm-line")).toBeTruthy());
    const view = s.app.workspace.activeLeaf!.view as any;
    expect(view.getViewType()).toBe("markdown");
    expect(view.getViewData()).toContain("Link to [[B]]");
    expect(view.isSourceMode).toBe(false);
    expect(q(".markdown-source-view.is-live-preview")).toBeTruthy();
    // inline title shows the file name
    await vi.waitFor(() => expect(q(".markdown-source-view .inline-title")?.textContent).toBe("A"));

    s.app.commands.executeCommandById("editor:toggle-source");
    expect(view.isSourceMode).toBe(true);
    expect(q(".markdown-source-view.is-live-preview")).toBeNull();
    expect(view.getState()).toMatchObject({ file: "A.md", mode: "source", source: true });
    s.app.commands.executeCommandById("editor:toggle-source");

    s.app.commands.executeCommandById("markdown:toggle-preview"); // Ctrl-E
    expect(view.getMode()).toBe("preview");
    await view.previewMode.whenRendered();
    expect(q(".markdown-reading-view .markdown-preview-view")).toBeTruthy();
    expect(q(".markdown-reading-view")!.style.display).not.toBe("none");
    expect(qa(".markdown-reading-view a.internal-link").map((a) => a.textContent)).toContain("B");
    expect(q(".markdown-reading-view .inline-title")?.textContent).toBe("A");
    await vi.waitFor(() => expect(q(".status-bar")!.textContent).toContain("Reading"));

    // clicking the internal link in reading view opens B in the same leaf
    qa(".markdown-reading-view a.internal-link").find((a) => a.textContent === "B")!.click();
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("B.md"));
    s.app.commands.executeCommandById("markdown:toggle-preview");
    expect((s.app.workspace.activeLeaf!.view as any).getMode()).toBe("source");

    // palette lists core commands
    expect(s.app.commands.findCommand("app:open-settings")?.hotkeys).toEqual([{ modifiers: ["Mod"], key: "," }]);
    expect(s.app.commands.findCommand("file-explorer:new-file")?.hotkeys).toEqual([{ modifiers: ["Mod"], key: "n" }]);
    s.app.commands.executeCommandById("file-explorer:new-file");
    await vi.waitFor(() => expect(fs.existsSync(path.join(v.root, "Untitled.md"))).toBe(true));
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("Untitled.md"));
  });

  it("renames a note by editing its inline title", async () => {
    stubBackend();
    const s = await boot();
    await s.app.workspace.openLinkText("B", "", false);
    await vi.waitFor(() => expect(q(".markdown-source-view .inline-title")).toBeTruthy());
    const title = q(".markdown-source-view .inline-title")!;
    title.textContent = "Beta";
    title.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(fs.existsSync(path.join(v.root, "Beta.md"))).toBe(true));
    expect(fs.existsSync(path.join(v.root, "B.md"))).toBe(false);
    await vi.waitFor(() => expect(q(".mod-root .workspace-tab-header.is-active .workspace-tab-header-inner-title")?.textContent).toBe("Beta"));
  });

  it("splits, reorders and moves tabs between groups, and persists the layout", async () => {
    stubBackend();
    const s = await boot();
    const ws = s.app.workspace;
    await ws.openLinkText("A", "", false);
    await ws.openLinkText("B", "", "tab");
    await ws.openLinkText("folder/C", "", "tab");
    await vi.waitFor(() => expect(ws.rootSplit.leaves().filter((l) => l.view.getViewType() === "markdown")).toHaveLength(3));
    const leaves = () => ws.rootSplit.leaves();
    // reorder: move the last tab to the front
    const first = leaves()[0];
    const last = leaves()[2];
    s.shell.moveLeaf(last, last.parent as any, 0);
    expect(leaves()[0]).toBe(last);
    // split right: a new tab group appears and the tab can be moved into it
    const holder = ws.createLeafBySplit(first, "vertical");
    s.shell.moveLeaf(first, holder.parent as any, 0);
    holder.detach();
    expect(qa(".workspace-split.mod-root .workspace-tabs").length).toBe(2);
    expect(q(".workspace-leaf-resize-handle")).toBeTruthy();
    // pin
    last.setPinned(true);
    s.shell.decorate();
    expect(last.tabHeaderEl.classList.contains("mod-pinned")).toBe(true);
    // persist and restore in a second session
    await s.app.workspace.requestSaveLayout.run();
    await tick(30);
    const saved = JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/workspace.json"), "utf8"));
    expect(saved.main.children).toHaveLength(2);
    expect(JSON.stringify(saved.main)).toContain('"pinned":true');
    expect(saved.left.children[0].children.map((l: any) => l.state.type)).toContain("file-explorer");
    await session!.stop();
    session = null;
    document.body.innerHTML = "";
    const s2 = await boot();
    const files = s2.app.workspace.rootSplit.leaves().map((l) => (l.view as any).file?.path).filter(Boolean).sort();
    expect(files).toEqual(["A.md", "B.md", "folder/C.md"]);
    expect(s2.app.workspace.rootSplit.leaves().some((l) => l.pinned)).toBe(true);
  });

  it("reorders tabs with drag and drop (dragstart on a header, drop on the tab bar)", async () => {
    stubBackend();
    const s = await boot();
    const ws = s.app.workspace;
    await ws.openLinkText("A", "", false);
    await ws.openLinkText("B", "", "tab");
    await vi.waitFor(() => expect(ws.rootSplit.leaves().filter((l) => l.view.getViewType() === "markdown")).toHaveLength(2));
    const tabs = ws.rootSplit.leaves()[0].parent as any;
    const [l0] = tabs.children;
    l0.tabHeaderEl.dispatchEvent(new Event("dragstart", { bubbles: true }));
    const bar = tabs.tabHeaderContainerEl.parentElement as HTMLElement;
    bar.dispatchEvent(new MouseEvent("dragover", { bubbles: true, cancelable: true, clientX: 5 }));
    expect(tabs.tabHeaderContainerEl.querySelector(".mod-drop-after, .mod-drop-before")).toBeTruthy();
    bar.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientX: 5 }));
    expect(tabs.children[tabs.children.length - 1]).toBe(l0);
    expect([...tabs.tabHeaderContainerEl.children].pop()).toBe(l0.tabHeaderEl);
  });

  it("collapses and resizes sidebars and keeps the width in the saved layout", async () => {
    stubBackend();
    const s = await boot();
    const ws = s.app.workspace;
    expect(q(".mod-left-split")!.classList.contains("is-collapsed")).toBe(false);
    q(".sidebar-toggle-button.mod-left")!.click();
    expect(ws.leftSplit.collapsed).toBe(true);
    expect(q(".mod-left-split")!.classList.contains("is-collapsed")).toBe(true);
    q(".sidebar-toggle-button.mod-left")!.click();
    const handle = q(".mod-left-split > .workspace-leaf-resize-handle.mod-dock")!;
    handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 380 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(ws.leftSplit.width).toBeGreaterThanOrEqual(180);
    expect(ws.getLayout()).toMatchObject({ left: { width: ws.leftSplit.width, collapsed: false } });
  });

  it("installs and enables a plugin through the settings UI and shows its ribbon icon, command, view and settings tab", async () => {
    let installed = false;
    stubBackend({
      plugin_catalog: () => [{ id: "demo", name: "Demo plugin", author: "me", description: "A demo", repo: "me/demo" }],
      plugin_install: () => {
        v.write(".obsidian/plugins/demo/manifest.json", JSON.stringify({ id: "demo", name: "Demo plugin", version: "1.0.0", minAppVersion: "0.15.0", description: "A demo", author: "me" }));
        v.write(".obsidian/plugins/demo/main.js", PLUGIN_MAIN);
        installed = true;
        return { id: "demo", name: "Demo plugin", version: "1.0.0", minAppVersion: "0.15.0", description: "A demo", author: "me" };
      },
    });
    const s = await boot();
    expect(s.app.plugins.restrictedMode).toBe(true);
    s.app.commands.executeCommandById("app:open-settings");
    expect(q(".modal.mod-settings")).toBeTruthy();
    const nav = (t: string) => qa(".vertical-tab-nav-item").find((e) => e.textContent?.trim() === t)!;
    nav("Community plugins").click();
    await vi.waitFor(() => expect(btn("Turn on community plugins")).toBeTruthy());
    btn("Turn on community plugins")!.click();
    await vi.waitFor(() => expect(btn("Turn on community plugins", q(".modal.mod-confirmation")!)).toBeTruthy());
    btn("Turn on community plugins", q(".modal.mod-confirmation")!)!.click();
    await vi.waitFor(() => expect(s.app.plugins.restrictedMode).toBe(false));
    await vi.waitFor(() => expect(btn("Browse")).toBeTruthy());
    btn("Browse")!.click();
    await vi.waitFor(() => expect(qa(".community-item")).toHaveLength(1));
    btn("Install", q(".community-item")!)!.click();
    await vi.waitFor(() => expect(installed).toBe(true));
    await vi.waitFor(() => expect(btn("Enable", q(".community-item")!)).toBeTruthy());
    btn("Enable", q(".community-item")!)!.click();
    await vi.waitFor(() => expect(s.app.plugins.plugins["demo"]).toBeTruthy());

    // what the plugin contributed shows up in the real UI
    expect(qa(".side-dock-ribbon-action").some((e) => e.getAttribute("aria-label") === "Demo ribbon")).toBe(true);
    expect(s.app.commands.findCommand("demo:ping")?.name).toBe("Demo plugin: Ping");
    expect(s.app.viewRegistry.getViewCreatorByType("demo-view")).toBeTruthy();
    expect(qa(".vertical-tab-nav-item").map((e) => e.textContent)).toContain("Demo plugin");
    nav("Demo plugin").click();
    await vi.waitFor(() => expect(qa(".setting-item-name").map((e) => e.textContent)).toContain("Demo option"));
    // community-plugins.json written
    expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/community-plugins.json"), "utf8"))).toContain("demo");
    // run the command
    s.app.commands.executeCommandById("demo:ping");
    expect(document.body.getAttribute("data-demo-ping")).toBe("1");
    // the plugin view mounts into a real leaf
    s.app.setting.close();
    const leaf = s.app.workspace.getRightLeaf(false)!;
    await leaf.setViewState({ type: "demo-view" });
    expect(q(".demo-view-content", leaf.containerEl)?.textContent).toBe("hello from demo");
    // disabling removes everything again
    await s.app.plugins.disablePluginAndSave("demo");
    expect(qa(".side-dock-ribbon-action").some((e) => e.getAttribute("aria-label") === "Demo ribbon")).toBe(false);
    expect(s.app.commands.findCommand("demo:ping")).toBeUndefined();
  });

  it("renders plugin code-block processors as widgets in Live Preview and in Reading view", async () => {
    stubBackend();
    v.write("Q.md", "intro\n\n```demoblock\nhello block\n```\n\noutro\n");
    const { MarkdownPreviewRenderer, clearPostProcessors } = await import("../src/obsidian/markdown");
    const pp = MarkdownPreviewRenderer.createCodeBlockPostProcessor("demoblock", (src, el) => { el.createDiv({ cls: "demo-out", text: "RENDERED:" + src }); });
    MarkdownPreviewRenderer.registerPostProcessor(pp as any);
    try {
      const s = await boot();
      await s.app.vault.sync();
      await s.app.workspace.openLinkText("Q", "", false);
      await vi.waitFor(() => expect(q(".markdown-source-view .cm-code-block-widget .demo-out")?.textContent).toBe("RENDERED:hello block"));
      const view = s.app.workspace.activeLeaf!.view as any;
      view.setMode("preview");
      await view.previewMode.whenRendered();
      expect(q(".markdown-reading-view .block-language-demoblock .demo-out")?.textContent).toBe("RENDERED:hello block");
    } finally { MarkdownPreviewRenderer.unregisterPostProcessor(pp as any); void clearPostProcessors; }
  });

  it("applies external edits to open notes (watcher event -> editor)", async () => {
    stubBackend();
    const s = await boot();
    await s.app.workspace.openLinkText("B", "", false);
    await vi.waitFor(() => expect(q(".markdown-source-view .cm-line")).toBeTruthy());
    v.write("B.md", "# B\nchanged outside\n");
    v.emit({ kind: "modify", path: "B.md" });
    const view = s.app.workspace.activeLeaf!.view as any;
    await vi.waitFor(() => expect(view.getViewData()).toContain("changed outside"), { timeout: 3000 });
  });

  it("shows the Obsidian-compatible core view of the active file in backlinks and outline", async () => {
    stubBackend();
    const s = await boot();
    await s.app.workspace.openLinkText("A", "", false);
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("A.md"));
    await vi.waitFor(() => expect(qa(".mod-right-split .tree-item-inner, .mod-right-split .search-result-file-title").map((e) => e.textContent).join("|")).toContain("B"));
  });
});
