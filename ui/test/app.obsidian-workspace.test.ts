// An Obsidian-written .obsidian/workspace.json (as found in a real vault) restores into the right layout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;

const OBSIDIAN_WORKSPACE = {
  main: {
    id: "a1b2c3d4e5f60001", type: "split", direction: "vertical",
    children: [
      { id: "a1b2c3d4e5f60002", type: "tabs", currentTab: 1, children: [
        { id: "a1b2c3d4e5f60003", type: "leaf", state: { type: "markdown", state: { file: "Alpha.md", mode: "source", source: false }, icon: "lucide-file", title: "Alpha" } },
        { id: "a1b2c3d4e5f60004", type: "leaf", state: { type: "markdown", state: { file: "Beta.md", mode: "preview", source: false }, icon: "lucide-file", title: "Beta" } },
      ] },
    ],
  },
  left: {
    id: "a1b2c3d4e5f60005", type: "split", direction: "horizontal", width: 320,
    children: [{ id: "a1b2c3d4e5f60006", type: "tabs", children: [
      { id: "a1b2c3d4e5f60007", type: "leaf", state: { type: "file-explorer", state: { sortOrder: "alphabetical", autoReveal: false }, icon: "lucide-folder-closed", title: "Files" } },
      { id: "a1b2c3d4e5f60008", type: "leaf", state: { type: "search", state: { query: "", matchingCase: false, explainSearch: false, collapseAll: false, extraContext: false, sortOrder: "alphabetical" }, icon: "lucide-search", title: "Search" } },
    ] }],
  },
  right: {
    id: "a1b2c3d4e5f60009", type: "split", direction: "horizontal", width: 300, collapsed: true,
    children: [{ id: "a1b2c3d4e5f6000a", type: "tabs", children: [
      { id: "a1b2c3d4e5f6000b", type: "leaf", state: { type: "backlink", state: { file: "Beta.md", collapseAll: false, extraContext: false, sortOrder: "alphabetical", showSearch: false, searchQuery: "", backlinkCollapsed: false, unlinkedCollapsed: true }, icon: "links-coming-in", title: "Backlinks for Beta" } },
      { id: "a1b2c3d4e5f6000c", type: "leaf", state: { type: "outline", state: { file: "Beta.md" }, icon: "lucide-list", title: "Outline of Beta" } },
    ] }],
  },
  "left-ribbon": { hiddenItems: { "switcher:Open quick switcher": false, "graph:Open graph view": false, "canvas:Create new canvas": false } },
  active: "a1b2c3d4e5f60004",
  lastOpenFiles: ["Beta.md", "Alpha.md"],
};

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Alpha.md": "# Alpha\n", "Beta.md": "# Beta\n", ".obsidian/workspace.json": JSON.stringify(OBSIDIAN_WORKSPACE) });
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

describe("restoring an Obsidian workspace.json", () => {
  it("restores tabs, the active tab, side docks and their widths", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    const app = session.app;
    await vi.waitFor(() => expect(app.workspace.getLeavesOfType("markdown").map((l) => (l.view as any).file?.path)).toEqual(["Alpha.md", "Beta.md"]));
    expect((app.workspace.activeLeaf!.view as any).file?.path).toBe("Beta.md");
    expect(app.workspace.getLeavesOfType("file-explorer")).toHaveLength(1);
    expect(app.workspace.getLeavesOfType("search")).toHaveLength(1);
    expect(app.workspace.getLeavesOfType("backlink")).toHaveLength(1);
    expect(app.workspace.getLeavesOfType("outline")).toHaveLength(1);
    expect(app.workspace.rightSplit.collapsed).toBe(true);
    expect(app.workspace.leftSplit.collapsed).toBe(false);
    expect(app.workspace.getLastOpenFiles()).toEqual(["Beta.md", "Alpha.md"]);
    expect(app.workspace.getLeavesOfType("markdown").map((l) => (l.view as any).getMode())).toEqual(["source", "preview"]);
  });
});
