// Bookmarking the graph view: the bookmarks.json shape, the "Add bookmark" dialog, the command and menus, and reopening.
// The expected shape (`{ type, ctime, title, options }`, the option names, the "Untitled Graph" default, reuse of the open
// graph view) was read from the real Obsidian 1.14.4 with OBSIDIAN_EVAL (see ROADMAP.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { readJson } from "./helpers/settings";
import { getStore, openGraphBookmark } from "../src/app/core/bookmarks";
import { Menu } from "../src/obsidian";

let v: FakeVault;
let session: Session | null = null;
// The option names and defaults Obsidian wrote into a graph bookmark.
const REAL_OPTION_KEYS = ["collapse-filter", "search", "showTags", "showAttachments", "hideUnresolved", "showOrphans", "collapse-color-groups", "colorGroups", "collapse-display", "showArrow", "textFadeMultiplier", "nodeSizeMultiplier", "lineSizeMultiplier", "collapse-forces", "centerStrength", "repelStrength", "linkStrength", "linkDistance", "scale", "close"];

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "A.md": "[[B]]\n", "B.md": "b\n" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function boot() {
  session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  const app = session.app;
  await getStore(app)!.ready;
  return app;
}
const saved = () => readJson(v, ".obsidian/bookmarks.json")?.items ?? [];
const graphLeaf = (app: any) => app.workspace.getLeavesOfType("graph")[0];
async function openGraph(app: any) {
  expect(app.commands.executeCommandById("graph:open")).toBe(true);
  await vi.waitFor(() => expect(graphLeaf(app)?.view.canvas).toBeTruthy());
  app.workspace.setActiveLeaf(graphLeaf(app), { focus: true });
  return graphLeaf(app).view;
}
const modal = () => document.querySelector(".modal.mod-bookmark") as HTMLElement | null;

describe("bookmark the graph view", () => {
  it("asks for a title and group with Obsidian's dialog and writes { type, ctime, title, options }", async () => {
    const app = await boot();
    const g = await openGraph(app);
    g.options.search = "tag:#x";
    g.options.showTags = true;
    expect(app.commands.executeCommandById("bookmarks:bookmark-current-view")).toBe(true);
    const m = modal()!;
    expect(m.classList.contains("mod-lg")).toBe(true);
    expect(m.querySelector(".modal-title")!.textContent).toBe("Add bookmark");
    expect([...m.querySelectorAll(".setting-item-name")].map((e) => e.textContent)).toEqual(["Title", "Bookmark group"]);
    expect((m.querySelector("input") as HTMLInputElement).placeholder).toBe("Untitled Graph");
    (m.querySelector("button.mod-cta") as HTMLElement).click();
    await vi.waitFor(() => expect(saved().length).toBe(1));
    const item = saved()[0];
    expect(Object.keys(item)).toEqual(["type", "ctime", "title", "options"]);
    expect(item.type).toBe("graph");
    expect(typeof item.ctime).toBe("number");
    expect(item.title).toBe("Untitled Graph"); // blank title: the placeholder, as in Obsidian
    expect(Object.keys(item.options)).toEqual(REAL_OPTION_KEYS);
    expect(item.options.search).toBe("tag:#x");
    expect(item.options.showTags).toBe(true);
    expect(modal()).toBeNull();
  });

  it("uses the title typed and files the bookmark in the chosen group", async () => {
    const app = await boot();
    const store = getStore(app)!;
    store.newGroup("Maps");
    await vi.waitFor(() => expect(saved().length).toBe(1));
    await openGraph(app);
    app.commands.executeCommandById("bookmarks:bookmark-current-view");
    const m = modal()!;
    const input = m.querySelector("input") as HTMLInputElement;
    input.value = "Only tags";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const select = m.querySelector("select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["/", "Maps"]);
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    (m.querySelector("button.mod-cta") as HTMLElement).click();
    await vi.waitFor(() => expect(saved()[0].items?.length).toBe(1));
    expect(saved()[0].items[0]).toMatchObject({ type: "graph", title: "Only tags" });
  });

  it("Cancel adds nothing; with a note active the command still bookmarks the file", async () => {
    const app = await boot();
    await openGraph(app);
    app.commands.executeCommandById("bookmarks:bookmark-current-view");
    (modal()!.querySelector("button.mod-cancel") as HTMLElement).click();
    expect(modal()).toBeNull();
    expect(getStore(app)!.items).toEqual([]);
    await app.workspace.openLinkText("A", "", "tab");
    app.commands.executeCommandById("bookmarks:bookmark-current-view");
    await vi.waitFor(() => expect(saved()).toEqual([{ type: "file", title: "", path: "A.md" }]));
  });

  it("the graph's tab menu and More options menu offer Bookmark...", async () => {
    const app = await boot();
    const g = await openGraph(app);
    const m = new Menu();
    g.onPaneMenu(m, "tab-header");
    expect((m as any).items.map((i: any) => i.titleEl?.textContent ?? i.title)).toContain("Bookmark...");
    const more = g.containerEl.closest(".workspace-leaf")?.querySelector(".view-action[aria-label='More options']");
    expect(more).toBeTruthy();
  });
});

describe("open a graph bookmark", () => {
  const options = { "collapse-filter": true, search: "tag:#x", showTags: true, showAttachments: false, hideUnresolved: false, showOrphans: true, "collapse-color-groups": true, colorGroups: [], "collapse-display": true, showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1, "collapse-forces": true, centerStrength: 0.5, repelStrength: 10, linkStrength: 1, linkDistance: 250, scale: 1, close: false };

  it("opens the graph view with the bookmarked settings and writes them to graph.json, like Obsidian", async () => {
    const app = await boot();
    const item = getStore(app)!.addItem({ type: "graph", ctime: 1, title: "My graph", options });
    await openGraphBookmark(app, item, "tab");
    const g = graphLeaf(app).view;
    expect(g.options.search).toBe("tag:#x");
    expect(g.options.showTags).toBe(true);
    expect(g.options.close).toBe(false);
    await vi.waitFor(() => expect(readJson(v, ".obsidian/graph.json")?.search).toBe("tag:#x"));
  });

  it("reuses the graph view that is already open instead of opening another", async () => {
    const app = await boot();
    await openGraph(app);
    const item = getStore(app)!.addItem({ type: "graph", title: "My graph", options: { ...options, search: "second" } });
    await openGraphBookmark(app, item, "tab");
    expect(app.workspace.getLeavesOfType("graph").length).toBe(1);
    expect(graphLeaf(app).view.options.search).toBe("second");
  });

  it("a click on the bookmark in the Bookmarks view opens it; it shows the git-fork icon and its title", async () => {
    const app = await boot();
    getStore(app)!.addItem({ type: "graph", ctime: 1, title: "My graph", options });
    await app.commands.executeCommandById("bookmarks:open");
    const row = await vi.waitFor(() => { const r = document.querySelector(".bookmark-item.mod-graph .bookmark"); expect(r).toBeTruthy(); return r as HTMLElement; });
    expect(row.querySelector(".tree-item-inner")!.textContent).toBe("My graph");
    expect(row.querySelector(".tree-item-icon svg")?.classList.contains("lucide-git-fork")).toBe(true);
    row.click();
    await vi.waitFor(() => expect(graphLeaf(app)?.view.options?.search).toBe("tag:#x"));
  });

  it("round-trips through bookmarks.json: what Obsidian wrote loads and is written back unchanged", async () => {
    const real = { items: [{ type: "graph", ctime: 1792588629572, title: "Untitled Graph", options }] };
    v.cleanup();
    v = makeVault({ "A.md": "a\n", ".obsidian/bookmarks.json": JSON.stringify(real) });
    setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
    const app = await boot();
    const store = getStore(app)!;
    expect(store.items).toEqual(real.items);
    store.setTitle(store.items[0], "Renamed");
    await vi.waitFor(() => expect(saved()[0].title).toBe("Renamed"));
    expect(saved()[0]).toEqual({ ...real.items[0], title: "Renamed" });
  });
});
