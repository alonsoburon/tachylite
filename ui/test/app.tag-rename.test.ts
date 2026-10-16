// Tag pane: rename across the vault, and refining the search from the tag menu.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { renameTag, validateTagName } from "../src/app/core/tagRename";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({
    "A.md": "---\ntags: [idea, other]\n---\nText #idea and #idea/sub, not #ideal.\n",
    "B.md": "---\ntag: Idea\n---\n#Idea/deep end\n",
    "C.md": "---\ntags: \"idea, keep\"\n---\nplain\n",
    "D.md": "#unrelated\n",
  });
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

const read = (rel: string) => fs.readFileSync(path.join(v.root, rel), "utf8");

async function boot() {
  session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  const app = session.app;
  await vi.waitFor(() => expect(app.metadataCache.getFileCache(app.vault.getFileByPath("B.md")!)?.tags?.length).toBe(1));
  return app;
}

describe("renameTag", () => {
  it("validates names like Obsidian's tag rules", () => {
    expect(validateTagName("ok/nested_1-x")).toBeNull();
    expect(validateTagName("")).not.toBeNull();
    expect(validateTagName("has space")).not.toBeNull();
    expect(validateTagName("123")).not.toBeNull();
    expect(validateTagName("a//b")).not.toBeNull();
  });

  it("renames inline tags, nested children and tag properties, leaving look-alikes alone", async () => {
    const app = await boot();
    const n = await renameTag(app, "idea", "plan");
    expect(n).toBe(3);
    expect(read("A.md")).toContain("tags:\n  - plan\n  - other");
    expect(read("A.md")).toContain("Text #plan and #plan/sub, not #ideal.");
    expect(read("B.md")).toContain("tag: plan");
    expect(read("B.md")).toContain("#plan/deep end");
    expect(read("C.md")).toMatch(/tags: "?plan, keep"?/);
    expect(read("D.md")).toBe("#unrelated\n");
  });
});

describe("tag menu", () => {
  it("offers search refinements and rename", async () => {
    const app = await boot();
    const leaf = await app.workspace.ensureSideLeaf("tag", "right", { active: true, reveal: true });
    const view = leaf.view as any;
    await vi.waitFor(() => expect(view.containerEl.querySelector(".tag-pane-tag-text")).toBeTruthy());
    const self = ([...(view.containerEl as HTMLElement).querySelectorAll<HTMLElement>(".tree-item-self")]).find((e) => e.textContent?.includes("#idea"))!;
    self.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const titles = [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent);
    expect(titles).toEqual(expect.arrayContaining(["Require tag in search", "Exclude tag from search", "Rename tag...", "Copy tag"]));
    (view as any).refineSearch("-tag:#idea");
    const search = (await vi.waitFor(() => { const l = app.workspace.getLeavesOfType("search")[0]; if (!l) throw new Error("no search"); return l; })).view as any;
    await vi.waitFor(() => expect(search.query).toBe("-tag:#idea"));
    await view.refineSearch("tag:#other");
    expect(search.query).toBe("-tag:#idea tag:#other");
  });
});
