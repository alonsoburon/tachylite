import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootCore, type Core } from "./helpers/core";
import { BookmarksStore, BookmarksView, getStore } from "../src/app/core/bookmarks";
import { Menu } from "../src/obsidian";

let c: Core;
const files = { "A.md": "# A\n[[B]] [[C]] [[Gone]]", "B.md": "[[A]]", "C.md": "no links", "dir/D.md": "[[A]]", "pic.png": "x" };
const json = () => JSON.parse(fs.readFileSync(path.join(c.v.root, ".obsidian/bookmarks.json"), "utf8"));
beforeEach(async () => { c = await bootCore({ ...files, ".obsidian/bookmarks.json": JSON.stringify({ items: [{ type: "file", title: "", path: "B.md" }, { type: "group", title: "G", items: [{ type: "search", query: "foo" }] }] }) }); });
afterEach(async () => { await c.dispose(); });

describe("bookmarks", () => {
  it("loads Obsidian's format and exposes the store on the core plugin instance", async () => {
    const s = getStore(c.app)!;
    await s.ready;
    expect(s).toBeInstanceOf(BookmarksStore);
    expect(c.app.internalPlugins.getPluginById("bookmarks")!.instance).toBe(s);
    expect(s.items).toHaveLength(2);
    expect(s.isBookmarked(c.app.vault.getFileByPath("B.md")!)).toBe(true);
    expect(s.isBookmarked(c.app.vault.getFileByPath("A.md")!)).toBe(false);
  });

  it("persists add / subpath / folder / group / move / remove to bookmarks.json", async () => {
    const s = getStore(c.app)!; await s.ready;
    const A = c.app.vault.getFileByPath("A.md")!;
    s.bookmarkFile(A);
    s.bookmarkFile(A, "#Heading");
    s.bookmarkFile(c.app.vault.getFolderByPath("dir")!);
    s.bookmarkFile(A); // no duplicates
    await s.save();
    expect(json().items.slice(2)).toEqual([{ type: "file", title: "", path: "A.md" }, { type: "file", title: "", path: "A.md", subpath: "#Heading" }, { type: "folder", path: "dir" }]);
    const g = s.newGroup("New");
    s.bookmarkFile(c.app.vault.getFileByPath("C.md")!, undefined, g);
    s.moveItem(s.items[0], g, "into");
    await s.save();
    expect(json().items.find((i: any) => i.title === "New").items.map((i: any) => i.path)).toEqual(["C.md", "B.md"]);
    expect(s.toggleFile(A)).toBe(false);
    s.shift(s.items[0], 1);
    await s.save();
    expect(json().items.some((i: any) => i.path === "A.md" && !i.subpath)).toBe(false);
  });

  it("follows renames and deletes", async () => {
    const s = getStore(c.app)!; await s.ready;
    await c.app.fileManager.renameFile(c.app.vault.getFileByPath("B.md")!, "B2.md");
    expect(s.items[0].path).toBe("B2.md");
    await c.app.vault.delete(c.app.vault.getFileByPath("B2.md")!);
    expect(s.items.some((i) => i.path === "B2.md")).toBe(false);
    await s.save();
    expect(json().items).toHaveLength(1);
  });

  it("view renders items/groups, opens files and searches, context menu removes", async () => {
    const leaf = await c.app.workspace.ensureSideLeaf("bookmarks", "left", { active: true });
    const v = leaf.view as BookmarksView;
    await vi.waitFor(() => expect(v.contentEl.querySelectorAll(".bookmark").length).toBe(3));
    const texts = Array.from(v.contentEl.querySelectorAll(".bookmark .tree-item-inner")).map((e) => e.textContent);
    expect(texts).toEqual(["B", "G", "foo"]);
    (v.contentEl.querySelectorAll(".bookmark")[0] as HTMLElement).click();
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("B.md"));
    (v.contentEl.querySelectorAll(".bookmark")[2] as HTMLElement).click();
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("search")).toHaveLength(1));
    expect(((c.app.workspace.getLeavesOfType("search")[0].view) as any).query).toBe("foo");
    (v.contentEl.querySelectorAll(".bookmark")[1] as HTMLElement).click(); // collapse group
    expect(v.contentEl.querySelectorAll(".bookmark")).toHaveLength(2);
    expect(v.getState().collapsedGroups).toEqual(["G"]);
    const menu: Menu = v.menu(getStore(c.app)!.items[0]);
    expect(menu.items.map((i: any) => i.titleEl?.textContent)).toEqual(expect.arrayContaining(["Open in new tab", "Open to the right", "Open in new window", "Rename...", "Remove"]));
    const remove = menu.items.find((i: any) => i.titleEl?.textContent === "Remove") as any;
    remove.dom.click();
    await vi.waitFor(() => expect(v.contentEl.querySelectorAll(".bookmark")).toHaveLength(1));
    // drag B-like reorder: drop group item before nothing -> into root keeps one
    expect(getStore(c.app)!.items).toHaveLength(1);
  });

  it("file-menu entry and the toggle command", async () => {
    const A = c.app.vault.getFileByPath("A.md")!;
    const m = new Menu();
    c.app.workspace.trigger("file-menu", m, A, "file-explorer");
    const entry = m.items.find((i: any) => i.titleEl?.textContent === "Bookmark...") as any;
    expect(entry).toBeTruthy();
    entry.dom.click();
    expect(getStore(c.app)!.isBookmarked(A)).toBe(true);
    await c.app.workspace.getLeaf("tab").openFile(A, { active: true });
    const cmd = c.app.commands.findCommand("bookmarks:bookmark-current-view")!;
    expect(cmd.name).toBe("Bookmarks: Bookmark...");
    c.app.commands.executeCommand(cmd);
    expect(getStore(c.app)!.isBookmarked(A)).toBe(false);
    c.app.commands.executeCommand(cmd);
    expect(getStore(c.app)!.isBookmarked(A)).toBe(true);
    expect(c.app.commands.findCommand("bookmarks:open")).toBeTruthy();
  });
});
