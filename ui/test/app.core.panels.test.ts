import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootCore, tick, type Core } from "./helpers/core";
import { SearchView, highlightTerms } from "../src/app/core/search";
import { BacklinksView, OutgoingLinksView, findUnlinkedMentions } from "../src/app/core/links";
import { TagView, buildTagTree } from "../src/app/core/tags";
import { OutlineView, buildOutline, cleanHeading } from "../src/app/core/outline";
import { MarkdownView } from "../src/obsidian";

let c: Core;
const files = {
  "Home.md": "# Home\nSee [[Target]] and ![[Target]] here.\nAnother [[Target|alias]]\n#project/alpha #todo\n## Details\ntext\n### Deep dive\n# Second\n",
  "Other.md": "Plain mention of Target in prose.\nSecond line without it.\n#project/beta\n",
  "Target.md": "# Target\nLinks to [[Home]] and [[Missing Note]]\n#project/alpha\n",
  "notes/Linker.md": "Also [[Target]] from notes.\n",
};
let searchArgs: string[] = [];
const hits = [
  { path: "Home.md", lines: [[1, "See [[Target]] and ![[Target]] here."], [2, "Another [[Target|alias]]"]] },
  { path: "Other.md", lines: [[0, "Plain mention of Target in prose."]] },
];
beforeEach(async () => {
  searchArgs = [];
  c = await bootCore(files, { vault_search: (a) => { searchArgs.push(a.query); return a.query === "boom" ? Promise.reject("backend exploded") : a.query === "none" ? [] : hits; } });
});
afterEach(async () => { await c.dispose(); });

const side = async <T>(type: string, side: "left" | "right" = "right") => (await c.app.workspace.ensureSideLeaf(type, side, { active: true })).view as unknown as T;
const openMd = async (path: string) => { const l = c.app.workspace.getLeaf("tab"); await l.openFile(c.app.vault.getFileByPath(path)!, { active: true }); return l; };

describe("search", () => {
  it("parses highlight terms", () => {
    expect(highlightTerms('foo "bar baz" -skip file:x.md tag:#t OR qux')).toEqual(["foo", "bar baz", "qux"]);
  });

  it("debounces, groups results per file, highlights matches and opens at a line", async () => {
    const v = await side<SearchView>("search", "left");
    expect(v.getViewType()).toBe("search"); expect(v.getIcon()).toBe("lucide-search");
    v.inputEl.value = "Target"; v.inputEl.dispatchEvent(new Event("input"));
    expect(searchArgs).toEqual([]);
    await vi.waitFor(() => expect(searchArgs).toEqual(["Target"]), { timeout: 1000 });
    await vi.waitFor(() => expect(v.resultsEl.querySelectorAll(".search-result")).toHaveLength(2));
    expect(v.countEl.textContent).toBe("3 results in 2 files");
    const first = v.resultsEl.querySelector(".search-result")!;
    expect(first.querySelector(".search-result-file-title .tree-item-inner")!.textContent).toBe("Home");
    expect(first.querySelector(".search-result-count")!.textContent).toBe("2");
    expect(first.querySelectorAll(".search-result-file-match")).toHaveLength(2);
    expect(first.querySelector(".search-result-file-matched-text")!.textContent).toBe("Target");
    (first.querySelectorAll(".search-result-file-match")[1] as HTMLElement).click();
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("Home.md"));
    const md = c.app.workspace.activeLeaf!.view as MarkdownView;
    await vi.waitFor(() => expect(md.editor.getCursor().line).toBe(2));
    // clicking the title opens at the top; ctrl-click opens a new tab
    const n = c.app.workspace.getLeavesOfType("markdown").length;
    (v.resultsEl.querySelectorAll(".search-result-file-title")[1] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("markdown").length).toBe(n + 1));
    expect(c.app.workspace.getActiveFile()?.path).toBe("Other.md");
  });

  it("collapse, sort, no results, errors, clear button, state round trip", async () => {
    const v = await side<SearchView>("search", "left");
    v.setQuery("Target"); await vi.waitFor(() => expect(v.resultsEl.querySelectorAll(".search-result")).toHaveLength(2));
    (v.contentEl.querySelector('[aria-label="Collapse results"]') as HTMLElement).click();
    expect(v.resultsEl.querySelectorAll(".search-result.is-collapsed")).toHaveLength(2);
    (v.contentEl.querySelector('[aria-label="Expand results"]') as HTMLElement).click();
    expect(v.resultsEl.querySelectorAll(".search-result.is-collapsed")).toHaveLength(0);
    v.setSortOrder("alphabeticalReverse");
    expect(Array.from(v.resultsEl.querySelectorAll(".search-result-file-title .tree-item-inner")).map((e) => e.textContent)).toEqual(["Other", "Home"]);
    v.setQuery("none"); await vi.waitFor(() => expect(v.resultsEl.textContent).toContain("No matches found."));
    v.setQuery("boom"); await vi.waitFor(() => expect(v.resultsEl.textContent).toContain("backend exploded"));
    expect(v.getState().query).toBe("boom");
    (v.contentEl.querySelector(".search-input-clear-button") as HTMLElement).click();
    expect(v.inputEl.value).toBe(""); expect(v.resultsEl.children).toHaveLength(0);
    const leaf2 = c.app.workspace.getLeaf("split");
    await leaf2.setViewState({ type: "search", state: { query: "Target", sortOrder: "alphabetical" } });
    const v2 = leaf2.view as SearchView;
    await vi.waitFor(() => expect(v2.resultsEl.querySelectorAll(".search-result")).toHaveLength(2));
    expect(v2.inputEl.value).toBe("Target");
  });

  it("shows more context from cachedRead and the open command focuses the input", async () => {
    const v = await side<SearchView>("search", "left");
    v.extraContext = true;
    v.setQuery("Target");
    await vi.waitFor(() => expect(v.resultsEl.querySelector(".search-result-file-match-context")).not.toBeNull());
    expect(v.resultsEl.querySelector(".search-result-file-match-context.is-before")!.textContent).toBe("# Home");
    c.app.commands.executeCommand(c.app.commands.findCommand("global-search:open")!);
    await tick(10);
    expect(c.app.commands.findCommand("global-search:open")!.hotkeys![0]).toEqual({ modifiers: ["Mod", "Shift"], key: "f" });
    expect(document.activeElement).toBe(v.inputEl);
  });
});

describe("tags", () => {
  it("builds a nested tree with rolled-up counts and both sort orders", () => {
    const t = buildTagTree({ "#a": 1, "#a/b": 2, "#a/b/c": 5, "#Z": 4, "#a/B": 1 });
    expect(t.map((n) => [n.name, n.total])).toEqual([["a", 9], ["Z", 4]]);
    expect(t[0].children).toHaveLength(1); expect(t[0].children[0].total).toBe(8);
    expect(buildTagTree({ "#x": 1, "#y": 5 }, "frequency").map((n) => n.name)).toEqual(["y", "x"]);
  });

  it("renders the pane, toggles sort/collapse, and a click opens the search view with tag:#", async () => {
    const v = await side<TagView>("tag");
    expect(v.getIcon()).toBe("lucide-tags");
    const names = () => Array.from(v.contentEl.querySelectorAll(".tag-pane-tag-text")).map((e) => e.textContent);
    expect(names()).toEqual(["#project", "#todo"]);
    expect(v.contentEl.querySelector('[data-tag="#project"] .tag-pane-tag-count')!.textContent).toBe("3");
    expect(v.contentEl.querySelector('[data-tag="#project"] .collapse-icon')).not.toBeNull();
    (v.contentEl.querySelector('[data-tag="#project"] .collapse-icon') as HTMLElement).click();
    expect(names()).toEqual(["#project", "#alpha", "#beta", "#todo"]);
    v.toggleSort();
    expect(names()[0]).toBe("#project");
    (v.contentEl.querySelector('[data-tag="#project/alpha"]') as HTMLElement).click();
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("search")).toHaveLength(1));
    const sv = c.app.workspace.getLeavesOfType("search")[0].view as SearchView;
    await vi.waitFor(() => expect(searchArgs).toContain("tag:#project/alpha"));
    expect(sv.inputEl.value).toBe("tag:#project/alpha");
  });
});

describe("backlinks and outgoing links", () => {
  it("lists linked mentions with context lines and opens at the line", async () => {
    const v = await side<BacklinksView>("backlink");
    await openMd("Target.md");
    await vi.waitFor(() => expect(v.file?.path).toBe("Target.md"));
    await vi.waitFor(() => expect(v.contentEl.querySelectorAll(".backlink-linked .search-result")).toHaveLength(2));
    const home = v.contentEl.querySelector('.backlink-linked [data-path="Home.md"]')!;
    expect(home.querySelector(".search-result-count")!.textContent).toBe("2");
    await vi.waitFor(() => expect(home.querySelectorAll(".search-result-file-match-text").length).toBe(2));
    expect(home.querySelector(".search-result-file-matched-text")!.textContent).toBe("[[Target]]");
    expect(home.querySelectorAll(".search-result-file-match")[0].textContent).toContain("See ");
    (document.activeElement as HTMLElement | null)?.blur(); // happy-dom dispatches selectionchange synchronously while CM updates
    (home.querySelectorAll(".search-result-file-match")[1] as HTMLElement).click();
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("Home.md"));
    // following the active file
    await vi.waitFor(() => expect(v.file?.path).toBe("Home.md"));
    await vi.waitFor(() => expect(v.contentEl.querySelector('.backlink-linked [data-path="Target.md"]')).not.toBeNull());
  });

  it("finds unlinked mentions lazily and ignores existing links", async () => {
    const v = await side<BacklinksView>("backlink");
    await openMd("Target.md");
    await vi.waitFor(() => expect(v.file?.path).toBe("Target.md"));
    await vi.waitFor(() => expect(v.contentEl.querySelector(".backlink-unlinked")).not.toBeNull());
    expect(v.contentEl.querySelector(".backlink-unlinked")!.textContent).toContain("Expand");
    (v.contentEl.querySelector(".backlink-unlinked > .tree-item-self") as HTMLElement).click();
    await vi.waitFor(() => expect(v.contentEl.querySelectorAll(".backlink-unlinked .search-result")).toHaveLength(1));
    expect(v.contentEl.querySelector(".backlink-unlinked .search-result-file-title")!.textContent).toContain("Other");
    expect(findUnlinkedMentions("a [[Target]] b Target c\n```\nTarget\n```\nTargets", ["Target"])).toEqual([{ line: 0, start: 15, end: 21 }]);
  });

  it("outgoing links: resolved open the note, unresolved create it", async () => {
    const v = await side<OutgoingLinksView>("outgoing-link");
    await openMd("Target.md");
    await vi.waitFor(() => expect(v.contentEl.querySelectorAll(".outgoing-link-item")).toHaveLength(2));
    const resolved = v.contentEl.querySelector('[data-path="Home.md"]') as HTMLElement;
    expect(resolved.textContent).toBe("Home");
    const unresolved = v.contentEl.querySelector(".tree-item-self.is-unresolved") as HTMLElement;
    expect(unresolved.textContent).toBe("Missing Note");
    unresolved.click();
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("Missing Note.md")).not.toBeNull());
    resolved.click();
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("Home.md"));
    expect(c.app.commands.findCommand("outgoing-link:open")).toBeTruthy(); expect(c.app.commands.findCommand("backlink:open")).toBeTruthy();
  });
});

describe("outline", () => {
  it("nests headings, collapses, filters and scrolls the editor to the heading", async () => {
    expect(cleanHeading("A [[x|link]] **b** `c`")).toBe("A link b c");
    expect(buildOutline([{ heading: "A", level: 2, position: { start: { line: 0 } } }, { heading: "B", level: 4, position: { start: { line: 1 } } }, { heading: "C", level: 2, position: { start: { line: 2 } } }]).map((n) => n.children.length)).toEqual([1, 0]);
    const v = await side<OutlineView>("outline");
    await openMd("Home.md");
    await vi.waitFor(() => expect(v.contentEl.querySelectorAll(".outline-heading")).toHaveLength(4));
    expect(Array.from(v.contentEl.querySelectorAll(".outline-heading .tree-item-inner")).map((e) => e.textContent)).toEqual(["Home", "Details", "Deep dive", "Second"]);
    expect(v.contentEl.querySelector('[data-level="3"]')).not.toBeNull();
    (document.activeElement as HTMLElement | null)?.blur(); // a click in the sidebar takes focus out of the editor
    (v.contentEl.querySelector('[data-level="3"]') as HTMLElement).click();
    const md = c.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).file?.path === "Home.md")!.view as MarkdownView;
    expect(md.editor.getCursor().line).toBe(6);
    (v.contentEl.querySelector('[data-level="2"] .collapse-icon') as HTMLElement).click();
    expect(v.contentEl.querySelectorAll(".outline-heading")).toHaveLength(3);
    v.filterText = "deep"; v.refresh();
    expect(Array.from(v.contentEl.querySelectorAll(".outline-heading .tree-item-inner")).map((e) => e.textContent)).toEqual(["Home", "Details", "Deep dive"]); // matches keep their ancestors
    expect(v.getState().collapsed).toHaveLength(1);
  });
});
