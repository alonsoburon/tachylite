import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import fs from "node:fs";
import { bootCore, tick, type Core } from "./helpers/core";
import { compareEntries, FileExplorerView } from "../src/app/core/explorer";
import { TFile, TFolder } from "../src/obsidian";

let c: Core;
const files = { "Alpha.md": "# A", "Beta.md": "# B", "docs/Guide.md": "# G", "docs/deep/Note.md": "# N", "img.png": "x", "data.csv": "a,b", "z.canvas": "{}" };
beforeEach(async () => { c = await bootCore(files); });
afterEach(async () => { await c.dispose(); });

async function open(): Promise<FileExplorerView> {
  const leaf = await c.app.workspace.ensureSideLeaf("file-explorer", "left", { active: true });
  return leaf.view as FileExplorerView;
}
const titles = (v: FileExplorerView) => Array.from(v.filesEl.querySelectorAll<HTMLElement>(".tree-item-self")).map((t) => t.dataset.path);
const title = (v: FileExplorerView, p: string) => v.filesEl.querySelector<HTMLElement>(`[data-path="${p}"]`)!;

describe("file explorer", () => {
  it("renders folders first, hides unsupported files, shows extension badge on non-md", async () => {
    const v = await open();
    expect(v.getViewType()).toBe("file-explorer"); expect(v.getDisplayText()).toBe("Files"); expect(v.getIcon()).toBe("lucide-folder-closed");
    expect(titles(v)).toEqual(["docs", "Alpha.md", "Beta.md", "img.png", "z.canvas"]);
    expect(v.filesEl.querySelector(".tree-item.nav-folder.is-collapsed .nav-folder-title .collapse-icon svg")).not.toBeNull();
    expect(title(v, "Alpha.md").querySelector(".nav-file-title-content")!.textContent).toBe("Alpha");
    expect(title(v, "img.png").querySelector(".nav-file-tag")!.textContent).toBe("png");
    expect(title(v, "Alpha.md").querySelector(".nav-file-tag")).toBeNull();
    expect(title(v, "z.canvas").querySelector(".nav-file-tag")!.textContent).toBe("canvas"); // the Canvas core plugin's view type
    expect(v.contentEl.querySelectorAll(".nav-header .nav-buttons-container .clickable-icon")).toHaveLength(4);
    // unsupported files appear with the setting
    c.app.vault.setConfig("showUnsupportedFiles", true); v.refresh();
    expect(titles(v)).toContain("data.csv");
  });

  it("click toggles folders, opens files; ctrl-click opens a new tab", async () => {
    const v = await open();
    title(v, "docs").click();
    expect(titles(v)).toContain("docs/Guide.md"); expect(titles(v)).toContain("docs/deep");
    expect(title(v, "docs").hasClass("is-collapsed")).toBe(false);
    expect(v.getState().expanded).toEqual(["docs"]);
    title(v, "Alpha.md").click();
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("Alpha.md"));
    const before = c.app.workspace.getLeavesOfType("markdown").length;
    title(v, "Beta.md").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("markdown").length).toBe(before + 1));
    title(v, "docs").click();
    expect(titles(v)).not.toContain("docs/Guide.md");
  });

  it("auto-reveals the active file, marks it and exposes reveal()", async () => {
    const v = await open();
    const f = c.app.vault.getFileByPath("docs/deep/Note.md")!;
    await c.app.workspace.getLeaf("tab").openFile(f, { active: true });
    await vi.waitFor(() => expect(title(v, "docs/deep/Note.md")).not.toBeNull());
    expect(title(v, "docs/deep/Note.md").hasClass("is-active")).toBe(true);
    // collapse everything, then reveal explicitly
    v.toggleCollapseAll();
    expect(titles(v)).not.toContain("docs/deep/Note.md");
    v.reveal(f);
    expect(title(v, "docs/deep/Note.md").hasClass("is-active")).toBe(true);
    // autoReveal off: opening another file does not expand
    v.expanded.clear(); v.refresh();
    c.app.vault.setConfig("autoReveal", false);
    await c.app.workspace.getLeaf("tab").openFile(c.app.vault.getFileByPath("docs/Guide.md")!, { active: true });
    await tick(5);
    expect(titles(v)).not.toContain("docs/Guide.md");
  });

  it("sort order menu persists and orders by name / mtime", async () => {
    const v = await open();
    v.setSortOrder("alphabeticalReverse");
    expect(titles(v).filter((p) => !p!.includes("/")).slice(1)).toEqual(["z.canvas", "img.png", "Beta.md", "Alpha.md"]);
    expect(c.app.loadLocalStorage("file-explorer-sort")).toBe("alphabeticalReverse");
    const menu = v.sortMenu();
    expect(menu.items.filter((i: any) => i.titleEl).map((i: any) => i.titleEl.textContent)).toEqual(["File name (A to Z)", "File name (Z to A)", "Modified time (new to old)", "Modified time (old to new)", "Created time (new to old)", "Created time (old to new)"]);
    const a = c.app.vault.getFileByPath("Alpha.md")!, b = c.app.vault.getFileByPath("Beta.md")!;
    a.stat.mtime = 100; b.stat.mtime = 200;
    expect(compareEntries(a, b, "byModifiedTime")).toBeGreaterThan(0);
    expect(compareEntries(a, b, "byModifiedTimeReverse")).toBeLessThan(0);
    expect(compareEntries(c.app.vault.getFolderByPath("docs")!, a, "byModifiedTime")).toBeLessThan(0);
    const l2 = await c.app.workspace.getLeaf("split"); await l2.setViewState({ type: "file-explorer" });
    expect((l2.view as FileExplorerView).sortOrder).toBe("alphabeticalReverse");
  });

  it("restores state, collapse-all / expand-all button", async () => {
    const v = await open();
    await v.setState({ expanded: ["docs", "docs/deep"], sortOrder: "alphabetical" });
    expect(titles(v)).toContain("docs/deep/Note.md");
    (v.contentEl.querySelector('[aria-label="Collapse all"]') as HTMLElement).click();
    expect(titles(v)).toEqual(["docs", "Alpha.md", "Beta.md", "img.png", "z.canvas"]);
    (v.contentEl.querySelector('[aria-label="Expand all"]') as HTMLElement).click();
    expect(titles(v)).toContain("docs/deep/Note.md");
  });

  it("vault events refresh the tree (create, rename, delete)", async () => {
    const v = await open();
    await c.app.vault.create("New.md", "");
    await vi.waitFor(() => expect(titles(v)).toContain("New.md"));
    await c.app.fileManager.renameFile(c.app.vault.getFileByPath("New.md")!, "Renamed.md");
    await vi.waitFor(() => expect(titles(v)).toContain("Renamed.md"));
    expect(titles(v)).not.toContain("New.md");
    await c.app.vault.delete(c.app.vault.getFileByPath("Renamed.md")!);
    await vi.waitFor(() => expect(titles(v)).not.toContain("Renamed.md"));
  });

  it("drag and drop moves into folders and root, errors become notices", async () => {
    const v = await open();
    title(v, "docs").click();
    const drag = (src: string, target: HTMLElement) => {
      title(v, src).dispatchEvent(new Event("dragstart", { bubbles: true }));
      target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
      target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    };
    drag("Beta.md", title(v, "docs"));
    await vi.waitFor(() => expect(c.app.vault.getAbstractFileByPath("docs/Beta.md")).toBeInstanceOf(TFile));
    expect(fs.existsSync(c.v.root + "/docs/Beta.md")).toBe(true);
    // back to root by dropping on the empty area
    await vi.waitFor(() => expect(title(v, "docs/Beta.md")).not.toBeNull());
    drag("docs/Beta.md", v.filesEl);
    await vi.waitFor(() => expect(c.app.vault.getAbstractFileByPath("Beta.md")).toBeInstanceOf(TFile));
    // folder into itself is refused with a notice
    drag("docs", title(v, "docs/deep"));
    await tick(20);
    expect(c.app.vault.getAbstractFileByPath("docs")).toBeInstanceOf(TFolder);
    expect(document.body.textContent).toContain("Cannot move a folder into itself");
  });

  it("keyboard: arrows move focus, Enter opens, F2 renames inline, Delete confirms", async () => {
    const v = await open();
    const key = (k: string) => v.filesEl.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
    key("ArrowDown"); key("ArrowDown");
    expect(v.focusPath).toBe("Alpha.md");
    key("ArrowUp"); expect(v.focusPath).toBe("docs");
    key("ArrowRight"); expect(titles(v)).toContain("docs/Guide.md");
    key("ArrowLeft"); expect(titles(v)).not.toContain("docs/Guide.md");
    key("ArrowDown"); key("Enter");
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("Alpha.md"));
    key("F2");
    const content = title(v, "Alpha.md").querySelector<HTMLElement>(".nav-file-title-content")!;
    expect(content.contentEditable).toBe("true");
    content.textContent = "Omega";
    content.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(c.app.vault.getAbstractFileByPath("Omega.md")).toBeInstanceOf(TFile));
    await vi.waitFor(() => expect(titles(v)).toContain("Omega.md"));
    (v as any).setFocus("Omega.md");
    key("Delete");
    await vi.waitFor(() => expect(document.querySelector(".mod-confirmation")).not.toBeNull());
    (document.querySelector(".mod-confirmation .mod-warning") as HTMLElement).click();
    await vi.waitFor(() => expect(c.app.vault.getAbstractFileByPath("Omega.md")).toBeNull());
  });

  it("context menu uses file-menu so plugins can extend it; empty area offers new note/folder", async () => {
    const v = await open();
    let seen = "";
    c.app.workspace.on("file-menu", (menu: any, file: any, source: string) => { seen = `${file.path}|${source}`; menu.addItem((i: any) => i.setTitle("Plugin item")); });
    title(v, "Alpha.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    expect(seen).toBe("Alpha.md|file-explorer");
    expect(document.querySelector(".menu")!.textContent).toContain("Plugin item");
    document.querySelector(".menu")!.remove();
    v.filesEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".menu")!.textContent).toContain("New folder");
  });

  it("commands, disposal and toggling the core plugin", async () => {
    await open();
    expect(c.app.commands.findCommand("file-explorer:open")).toBeTruthy();
    expect(c.app.commands.findCommand("file-explorer:new-file")?.hotkeys?.[0].key).toBe("n");
    await c.app.internalPlugins.plugins["file-explorer"].disable();
    expect(c.app.commands.findCommand("file-explorer:open")).toBeUndefined();
    expect(c.app.workspace.getLeavesOfType("file-explorer")).toHaveLength(0);
    expect(c.app.viewRegistry.getViewCreatorByType("file-explorer")).toBeTruthy();
  });
});

describe("file explorer multi-selection", () => {
  const click = (v: FileExplorerView, p: string, init: MouseEventInit = {}) => title(v, p).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const selected = (v: FileExplorerView) => Array.from(v.filesEl.querySelectorAll<HTMLElement>(".is-selected")).map((t) => t.dataset.path);

  it("shift-click selects the visible range, ctrl-click then toggles, and a plain click clears it", async () => {
    const v = await open();
    click(v, "Alpha.md");
    click(v, "img.png", { shiftKey: true });
    expect(selected(v)).toEqual(["Alpha.md", "Beta.md", "img.png"]);
    click(v, "Beta.md", { ctrlKey: true }); // toggles off while a selection exists (instead of opening a tab)
    expect(selected(v)).toEqual(["Alpha.md", "img.png"]);
    click(v, "z.canvas", { ctrlKey: true });
    expect(selected(v)).toEqual(["Alpha.md", "img.png", "z.canvas"]);
    click(v, "Beta.md");
    expect(selected(v)).toEqual([]);
  });

  it("the context menu on a selection is the bulk menu, and plugins extend it through files-menu", async () => {
    const v = await open();
    const seen: unknown[] = [];
    c.app.workspace.on("files-menu", (menu: any, files: any[], source: string) => { seen.push([files.map((f) => f.path), source]); menu.addItem((i: any) => i.setTitle("Plugin bulk item")); });
    click(v, "Alpha.md"); click(v, "Beta.md", { shiftKey: true });
    title(v, "Beta.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const items = () => Array.from(document.querySelectorAll(".menu .menu-item-title")).map((e) => e.textContent);
    await vi.waitFor(() => expect(items()).toContain("Plugin bulk item"));
    expect(items()).toContain("Delete 2 items");
    expect(items()).not.toContain("Rename...");
    expect(seen).toEqual([[["Alpha.md", "Beta.md"], "file-explorer"]]);
  });

  it("deletes the whole selection after one confirmation", async () => {
    const v = await open();
    c.app.vault.setConfig("promptDelete", false);
    click(v, "Alpha.md"); click(v, "Beta.md", { shiftKey: true });
    v.filesEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(c.app.vault.getAbstractFileByPath("Alpha.md")).toBeNull());
    expect(c.app.vault.getAbstractFileByPath("Beta.md")).toBeNull();
    expect(c.app.vault.getAbstractFileByPath("img.png")).not.toBeNull();
  });
});

describe("file menu system actions", () => {
  it("offers Open in default app for files and Show in system file manager for everything, through the vault-scoped command", async () => {
    const calls: unknown[] = [];
    const { setBackend } = await import("../src/ipc");
    setBackend(async (cmd: string, a: any) => { if (cmd === "open_in_system") { calls.push([a.path, a.reveal]); return null; } return null; });
    const { buildFileMenu } = await import("../src/app/files");
    const file = c.app.vault.getFileByPath("Alpha.md")!;
    const menu = buildFileMenu(c.app, file, "file-explorer");
    const item = (t: string) => menu.items.find((i: any) => i.titleEl?.textContent === t || i.title === t) as any;
    const titlesOf = menu.items.map((i: any) => i.titleEl?.textContent ?? i.title);
    expect(titlesOf).toEqual(expect.arrayContaining(["Open in default app", expect.stringMatching(/Show in system|Reveal in Finder/)]));
    item("Open in default app").dom.click();
    item(titlesOf.find((t: string) => /Show in system|Reveal/.test(t))!).dom.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([["Alpha.md", false], ["Alpha.md", true]]);
    const folder = buildFileMenu(c.app, c.app.vault.getFolderByPath("docs")!, "file-explorer");
    expect(folder.items.map((i: any) => i.titleEl?.textContent ?? i.title)).not.toContain("Open in default app");
  });
});

describe("file menu extras", () => {
  it("offers Open in new window, Move file to..., and Copy Obsidian URL", async () => {
    const { buildFileMenu } = await import("../src/app/files");
    const titles = (m: any) => m.items.map((i: any) => i.titleEl?.textContent ?? i.title);
    const menu = buildFileMenu(c.app, c.app.vault.getFileByPath("Alpha.md")!, "file-explorer");
    expect(titles(menu)).toEqual(expect.arrayContaining(["Open in new window", "Move file to...", "Copy path", "Show in system explorer"]));
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => { copied = t; } }, configurable: true });
    const copyPath: any = menu.items.find((i: any) => (i.titleEl?.textContent ?? i.title) === "Copy path");
    const subTitles = copyPath.submenu.items.map((i: any) => i.titleEl?.textContent ?? i.title);
    expect(subTitles).toEqual(["Copy path from vault folder", "Copy path from system root", "Copy Obsidian URL"]);
    copyPath.submenu.items[2].dom.click();
    expect(copied).toBe(`obsidian://open?vault=${encodeURIComponent(c.app.vault.getName())}&file=Alpha`);
    (menu.items.find((i: any) => (i.titleEl?.textContent ?? i.title) === "Move file to...") as any).dom.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector(".prompt-input")).toBeTruthy();
    const folder = buildFileMenu(c.app, c.app.vault.getFolderByPath("docs")!, "file-explorer");
    expect(titles(folder)).toEqual(expect.arrayContaining(["Move folder to...", "Search in folder"]));
    expect(titles(folder)).not.toContain("Open in new window");
  });
});

describe("make a copy (names and behaviour recorded from Obsidian 1.14.4)", () => {
  it("copies a folder with its contents as 'name 1', 'name 2' and files likewise", async () => {
    const { duplicateFile } = await import("../src/app/files");
    const folder = c.app.vault.getFolderByPath("docs")!;
    await duplicateFile(c.app, folder);
    await duplicateFile(c.app, folder);
    for (const p of ["docs 1/Guide.md", "docs 1/deep/Note.md", "docs 2/Guide.md"]) expect(c.app.vault.getAbstractFileByPath(p), p).toBeTruthy();
    expect(await c.app.vault.read(c.app.vault.getFileByPath("docs 1/deep/Note.md")!)).toBe("# N");
    const copy = await duplicateFile(c.app, c.app.vault.getFileByPath("Alpha.md")!);
    expect(copy.path).toBe("Alpha 1.md");
    expect(c.app.workspace.getActiveFile()?.path).toBe("Alpha 1.md");
  });

});
