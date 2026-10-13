import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootCore, type Core } from "./helpers/core";
import { BookmarksStore, BookmarksView, getStore } from "../src/app/core/bookmarks";
import { GraphView, buildGraph, createSimulation, hitTest, isSettled, stepSimulation } from "../src/app/core/graph";
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
    const entry = m.items.find((i: any) => i.titleEl?.textContent === "Bookmark") as any;
    expect(entry).toBeTruthy();
    entry.dom.click();
    expect(getStore(c.app)!.isBookmarked(A)).toBe(true);
    await c.app.workspace.getLeaf("tab").openFile(A, { active: true });
    const cmd = c.app.commands.findCommand("bookmarks:bookmark-current-view")!;
    expect(cmd.name).toBe("Bookmarks: Bookmark current file");
    c.app.commands.executeCommand(cmd);
    expect(getStore(c.app)!.isBookmarked(A)).toBe(false);
    c.app.commands.executeCommand(cmd);
    expect(getStore(c.app)!.isBookmarked(A)).toBe(true);
    expect(c.app.commands.findCommand("bookmarks:open")).toBeTruthy();
  });
});

describe("graph layout", () => {
  const resolved = { "a.md": { "b.md": 1, "c.md": 2 }, "b.md": { "a.md": 1 }, "c.md": {}, "d.md": {}, "e.md": { "img.png": 1 } };
  const unresolved = { "a.md": { Ghost: 1 } };

  it("buildGraph: undirected unique edges, degree-sized nodes, option filters", () => {
    const g = buildGraph(resolved, unresolved);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["?Ghost", "a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(g.links).toHaveLength(3); // a-b (deduped), a-c, a-ghost
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(byId["a.md"].degree).toBe(3); expect(byId["a.md"].r).toBeGreaterThan(byId["c.md"].r);
    expect(byId["?Ghost"].kind).toBe("unresolved"); expect(byId["b.md"].label).toBe("b");
    expect(buildGraph(resolved, unresolved, { existingOnly: true }).nodes.some((n) => n.kind === "unresolved")).toBe(false);
    expect(buildGraph(resolved, unresolved, { orphans: false }).nodes.map((n) => n.id).sort()).toEqual(["?Ghost", "a.md", "b.md", "c.md"]);
    expect(buildGraph(resolved, unresolved, { search: "B" }).nodes.map((n) => n.id)).toEqual(["b.md"]);
    const att = buildGraph(resolved, unresolved, { attachments: true });
    expect(att.nodes.find((n) => n.id === "img.png")!.kind).toBe("attachment");
    expect(buildGraph(resolved, unresolved).nodes.some((n) => n.id === "img.png")).toBe(false);
  });

  it("simulation is deterministic, cools down, pulls linked nodes together and respects fixed nodes", () => {
    const run = () => {
      const s = createSimulation(buildGraph(resolved, {}, {}), {});
      let i = 0;
      while (!isSettled(s) && i++ < 2000) stepSimulation(s);
      return { s, i };
    };
    const { s, i } = run();
    expect(i).toBeLessThan(2000);
    expect(s.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(run().s.nodes.map((n) => [n.x, n.y])).toEqual(s.nodes.map((n) => [n.x, n.y]));
    const pos = (id: string) => s.nodes.find((n) => n.id === id)!;
    const d = (a: string, b: string) => Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y);
    expect(d("a.md", "b.md")).toBeLessThan(d("a.md", "d.md"));
    const fixed = createSimulation(buildGraph(resolved, {}, {}), {});
    fixed.nodes[0].fixed = true; const [x, y] = [fixed.nodes[0].x, fixed.nodes[0].y];
    for (let k = 0; k < 20; k++) stepSimulation(fixed);
    expect([fixed.nodes[0].x, fixed.nodes[0].y]).toEqual([x, y]);
    const hit = hitTest(s.nodes, pos("a.md").x, pos("a.md").y);
    expect(s.nodes[hit].id).toBe("a.md");
    expect(hitTest(s.nodes, 1e5, 1e5)).toBe(-1);
  });

  it("large graphs use the grid path and stay finite", () => {
    const big: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 600; i++) big[`n${i}.md`] = i ? { [`n${i - 1}.md`]: 1 } : {};
    const s = createSimulation(buildGraph(big, {}), {});
    for (let i = 0; i < 30; i++) stepSimulation(s);
    expect(s.nodes.every((n) => Number.isFinite(n.x))).toBe(true);
  });
});

describe("graph view", () => {
  it("opens in a tab, builds from the metadata cache, filters, opens notes on click and cleans up", async () => {
    c.app.commands.executeCommand(c.app.commands.findCommand("graph:open")!);
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("graph")).toHaveLength(1));
    const v = c.app.workspace.getLeavesOfType("graph")[0].view as GraphView;
    expect(v.getDisplayText()).toBe("Graph view"); expect(v.getIcon()).toBe("lucide-git-fork");
    expect(v.getViewType()).toBe("graph");
    expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["?Gone", "A.md", "B.md", "C.md", "dir/D.md"]);
    expect(v.controlsEl.querySelectorAll(".checkbox-container")).toHaveLength(3);
    expect(v.controlsEl.querySelectorAll("input[type=range]")).toHaveLength(2);
    (v.controlsEl.querySelectorAll(".checkbox-container")[1] as HTMLElement).click(); // existing files only
    expect(v.options.existingOnly).toBe(true);
    expect(v.sim.nodes.some((n) => n.kind === "unresolved")).toBe(false);
    expect(v.getState()).toMatchObject({ options: { existingOnly: true } });
    v.openNode("dir/D.md", "note");
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("dir/D.md"));
    // a created note shows up
    await c.app.vault.create("New.md", "[[A]]");
    await vi.waitFor(() => expect(v.sim.nodes.some((n) => n.id === "New.md")).toBe(true), { timeout: 2000 });
    expect(c.app.workspace.leftRibbon.items.some((i) => i.title === "Open graph view")).toBe(true);
    await c.app.internalPlugins.plugins["graph"].disable();
    expect(c.app.commands.findCommand("graph:open")).toBeUndefined();
    expect(c.app.workspace.getLeavesOfType("graph")).toHaveLength(0);
  });
});
