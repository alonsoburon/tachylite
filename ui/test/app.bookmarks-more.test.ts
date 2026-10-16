// "Bookmark all tabs" and "Bookmark current search".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { readJson } from "./helpers/settings";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "A.md": "a\n", "B.md": "b\n", "C.md": "c\n" });
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
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session.app;
}
const saved = () => readJson(v, ".obsidian/bookmarks.json")?.items ?? [];

describe("Bookmark all tabs", () => {
  it("is unavailable without an open file; otherwise groups one file bookmark per open tab, in tab order", async () => {
    const app = await boot();
    expect(app.commands.executeCommandById("bookmarks:bookmark-all-tabs")).toBe(false);
    for (const n of ["B", "A", "C"]) await app.workspace.openLinkText(n, "", "tab");
    await app.workspace.openLinkText("A", "", "tab"); // a second tab for A: still bookmarked once
    expect(app.commands.executeCommandById("bookmarks:bookmark-all-tabs")).toBe(true);
    await vi.waitFor(() => expect(saved().length).toBe(1));
    const group = saved()[0];
    expect(group.type).toBe("group");
    expect(group.title).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(group.items.map((i: any) => [i.type, i.path])).toEqual([["file", "B.md"], ["file", "A.md"], ["file", "C.md"]]);
  });
});

describe("Bookmark current search", () => {
  it("needs the Search view with a query, and does not add the same search twice", async () => {
    const app = await boot();
    const leaf = await app.workspace.ensureSideLeaf("search", "left", { active: true });
    const view = leaf.view as any;
    app.workspace.setActiveLeaf(leaf, { focus: true });
    view.setQuery?.("");
    expect(app.commands.executeCommandById("bookmarks:bookmark-current-search")).toBe(false); // empty query
    view.setQuery("tag:#todo line:(a b)");
    await vi.waitFor(() => expect(view.query).toBe("tag:#todo line:(a b)"));
    expect(app.commands.executeCommandById("bookmarks:bookmark-current-search")).toBe(true);
    await vi.waitFor(() => expect(saved().map((i: any) => [i.type, i.query])).toEqual([["search", "tag:#todo line:(a b)"]]));
    app.commands.executeCommandById("bookmarks:bookmark-current-search");
    await new Promise((r) => setTimeout(r, 50));
    expect(saved().length).toBe(1);
  });
});
