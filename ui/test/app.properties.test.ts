// Properties: types (types.json), the editable table in Live Preview / reading view, the side views, vault-wide rename.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { inferPropertyType, MetadataTypeManager } from "../src/obsidian/properties";
import { renameKey } from "../src/app/properties/metadataEditor";
import { stringifyYaml } from "../src/obsidian";
import type { AllPropertiesView } from "../src/app/properties";

let v: FakeVault;
let s: Session;
const q = <T extends HTMLElement = HTMLElement>(sel: string, r: ParentNode = document) => r.querySelector<T>(sel);
const qa = (sel: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(sel)];
const disk = (p: string) => fs.readFileSync(path.join(v.root, p), "utf8");
const NOTE = "---\ntitle: Hello [[B]]\nrating: 4\ndone: true\ndue: 2024-05-01\nat: 2024-05-01T10:30\nitems:\n  - a\n  - b\ntags:\n  - x\n---\n# A\nBody\n";

async function boot(files: Record<string, string>): Promise<Session> {
  v = makeVault(files);
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
  const host = document.body.createDiv({ attr: { id: "app" } });
  s = await startSession((await v.backend("vault_info")) as any, host);
  return s;
}
const lpTable = () => q(".workspace-split.mod-root .markdown-source-view .metadata-container");
const row = (key: string, root: ParentNode = document) => q(`.workspace-split.mod-root .metadata-property[data-property-key="${key}"]`, root)!;
async function openA(): Promise<any> {
  await s.app.workspace.openLinkText("A", "", false);
  await vi.waitFor(() => expect(lpTable()).toBeTruthy());
  return s.app.workspace.activeLeaf!.view;
}
const typeInto = (el: HTMLElement, text: string) => { el.focus(); el.textContent = text; el.dispatchEvent(new Event("input", { bubbles: true })); };
const key = (el: HTMLElement, k: string, opts: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

beforeEach(() => { document.body.innerHTML = ""; localStorage.clear(); });
afterEach(async () => { await s?.stop(); v?.cleanup(); document.body.innerHTML = ""; });

describe("property types", () => {
  it("infers types like Obsidian and dumps YAML in its style", () => {
    expect(["x", 1, true, "2024-05-01", "2024-05-01T10:30", ["a"], null, { a: 1 }].map(inferPropertyType)).toEqual(["text", "number", "checkbox", "date", "datetime", "multitext", "text", "unknown"]);
    expect(stringifyYaml({ a: null, l: "[[B]]", t: ["x", "[[C]]"], n: "1" })).toBe('a:\nl: "[[B]]"\nt:\n  - x\n  - "[[C]]"\nn: "1"\n');
    const fm: Record<string, unknown> = { a: 1, b: 2, c: 3 };
    renameKey(fm, "b", "z");
    expect(Object.keys(fm)).toEqual(["a", "z", "c"]);
  });

  it("persists types.json with Obsidian's shape and answers getTypeInfo", async () => {
    await boot({ "A.md": NOTE, "B.md": "---\nrating: 2\nitems: c\n---\n" });
    const mtm = s.app.metadataTypeManager as MetadataTypeManager;
    expect(mtm.getAllProperties().rating).toMatchObject({ name: "rating", widget: "number", occurrences: 2 });
    expect(mtm.getPropertyInfo("Items").widget).toBe("multitext");
    expect(mtm.getTypeInfo("tags").expected.type).toBe("tags");
    expect(mtm.getTypeInfo("due", "2024-05-01").inferred.type).toBe("date");
    await mtm.setType("Rating", "text");
    expect(JSON.parse(disk(".obsidian/types.json"))).toEqual({ types: { aliases: "aliases", cssclasses: "multitext", tags: "tags", Rating: "text" } });
    expect(mtm.getTypeInfo("rating", 4)).toMatchObject({ expected: { type: "text" }, inferred: { type: "number" } });
    expect(mtm.types.rating).toBe("text");
    expect(Object.keys(mtm.registeredTypeWidgets)).toEqual(expect.arrayContaining(["text", "multitext", "number", "checkbox", "date", "datetime", "aliases", "tags"]));
  });
});

describe("Properties table", () => {
  it("renders every type in Live Preview and writes edits as exact YAML", async () => {
    await boot({ "A.md": NOTE, "B.md": "# B\n" });
    const view = await openA();
    expect(qa(".workspace-split.mod-root .metadata-property").map((r) => [r.dataset.propertyKey, r.dataset.propertyType])).toEqual([
      ["title", "text"], ["rating", "number"], ["done", "checkbox"], ["due", "date"], ["at", "datetime"], ["items", "multitext"], ["tags", "tags"],
    ]);
    // the YAML lines are replaced by the table
    expect(qa(".workspace-split.mod-root .cm-line").some((l) => l.textContent?.includes("rating: 4"))).toBe(false);
    // text with a link renders the link; editing shows the raw text
    const title = q(".metadata-input-longtext", row("title"))!;
    expect(q("a.internal-link", title)?.textContent).toBe("B");
    typeInto(title, "Goodbye");
    title.dispatchEvent(new FocusEvent("blur"));
    await vi.waitFor(() => expect(disk("A.md")).toContain("title: Goodbye\n"));
    // number
    const num = q<HTMLInputElement>("input.metadata-input-number", row("rating"))!;
    num.value = "5"; num.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(disk("A.md")).toContain("rating: 5\n"));
    // checkbox
    const cb = q<HTMLInputElement>("input.metadata-input-checkbox", row("done"))!;
    cb.checked = false; cb.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(disk("A.md")).toContain("done: false\n"));
    // date
    const due = q<HTMLInputElement>("input.mod-date", row("due"))!;
    expect(due.type).toBe("date");
    due.value = "2025-01-02"; due.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(disk("A.md")).toContain("due: 2025-01-02\n"));
    expect(q<HTMLInputElement>("input.mod-datetime", row("at"))!.value).toBe("2024-05-01T10:30");
    // list: pills, add with Enter, remove with the x
    expect(qa(".multi-select-pill-content", row("items")).map((p) => p.textContent)).toEqual(["a", "b"]);
    const input = q(".multi-select-input", row("items"))!;
    typeInto(input, "c");
    key(input, "Enter");
    await vi.waitFor(() => expect(disk("A.md")).toContain("items:\n  - a\n  - b\n  - c\n"));
    await vi.waitFor(() => expect(qa(".multi-select-pill", row("items"))).toHaveLength(3));
    q(".multi-select-pill-remove-button", row("items"))!.click();
    await vi.waitFor(() => expect(disk("A.md")).toContain("items:\n  - b\n  - c\n"));
    // tags render without '#'
    expect(qa(".multi-select-pill-content", row("tags")).map((p) => p.textContent)).toEqual(["x"]);
    // rename a key in this note keeps the order
    const k = q<HTMLInputElement>(".metadata-property-key-input", row("rating"))!;
    k.value = "score"; k.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(disk("A.md")).toBe("---\ntitle: Goodbye\nscore: 5\ndone: false\ndue: 2025-01-02\nat: 2024-05-01T10:30\nitems:\n  - b\n  - c\ntags:\n  - x\n---\n# A\nBody\n"));
    // remove via the editor API (the row menu calls the same), reorder
    await view.metadataEditor.removeProperty("done");
    await view.metadataEditor.moveProperty("tags", "title", false);
    expect(disk("A.md")).toBe("---\ntags:\n  - x\ntitle: Goodbye\nscore: 5\ndue: 2025-01-02\nat: 2024-05-01T10:30\nitems:\n  - b\n  - c\n---\n# A\nBody\n");
    // the body (and the editor) keep their content
    expect(view.editor.getValue()).toBe(disk("A.md"));
  });

  it("changes a type from the row menu and adds properties with the command", async () => {
    await boot({ "A.md": NOTE, "B.md": "# B\nno properties\n" });
    await openA();
    q(".metadata-property-icon", row("rating"))!.click();
    const typeItem = qa(".menu .menu-item").find((m) => m.textContent?.includes("Property type"))!;
    typeItem.dispatchEvent(new MouseEvent("mouseenter"));
    qa(".menu .menu-item").find((m) => m.textContent === "Text")!.click();
    await vi.waitFor(() => expect(JSON.parse(disk(".obsidian/types.json")).types.rating).toBe("text"));
    await vi.waitFor(() => expect(row("rating").dataset.propertyType).toBe("text"));
    // a note without frontmatter: the command adds a block and a new row whose name is typed
    await s.app.workspace.openLinkText("B", "", false);
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("B.md"));
    expect(s.app.commands.executeCommandById("markdown:add-metadata-property")).toBe(true);
    await vi.waitFor(() => expect(q(".metadata-property.is-new input.metadata-property-key-input")).toBeTruthy());
    const ki = q<HTMLInputElement>(".metadata-property.is-new input.metadata-property-key-input")!;
    ki.value = "status";
    ki.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 10));
    key(ki, "Enter");
    await vi.waitFor(() => expect(disk("B.md")).toBe("---\nstatus:\n---\n# B\nno properties\n"));
    await vi.waitFor(() => expect(row("status")).toBeTruthy());
    // markdown:add-alias focuses (creating) the aliases list
    s.app.commands.executeCommandById("markdown:add-alias");
    await vi.waitFor(() => expect(disk("B.md")).toBe("---\nstatus:\naliases:\n---\n# B\nno properties\n"));
    s.app.commands.executeCommandById("markdown:clear-metadata-properties");
    await vi.waitFor(() => expect(disk("B.md")).toBe("# B\nno properties\n"));
  });

  it("honours propertiesInDocument (hidden / source) and edits in reading view", async () => {
    await boot({ "A.md": NOTE, "B.md": "# B\n" });
    const view = await openA();
    s.app.vault.setConfig("propertiesInDocument", "source");
    s.app.workspace.trigger("config-changed");
    await vi.waitFor(() => expect(lpTable()).toBeNull());
    expect(qa(".workspace-split.mod-root .cm-line").some((l) => l.textContent === "rating: 4")).toBe(true);
    s.app.vault.setConfig("propertiesInDocument", "hidden");
    s.app.workspace.trigger("config-changed");
    await vi.waitFor(() => expect(qa(".workspace-split.mod-root .cm-line").some((l) => l.textContent === "rating: 4")).toBe(false));
    expect(lpTable()).toBeNull();
    s.app.vault.setConfig("propertiesInDocument", "visible");
    s.app.workspace.trigger("config-changed");
    await vi.waitFor(() => expect(lpTable()).toBeTruthy());
    // reading view: same editable table
    s.app.commands.executeCommandById("markdown:toggle-preview");
    await view.previewMode.whenRendered();
    const rv = q(".markdown-reading-view .metadata-container")!;
    expect(qa(".metadata-property", rv)).toHaveLength(7);
    const num = q<HTMLInputElement>('.metadata-property[data-property-key="rating"] input.metadata-input-number', rv)!;
    num.value = "1"; num.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(disk("A.md")).toContain("rating: 1\n"));
  });
});

describe("Properties core plugin", () => {
  it("All properties lists types and counts, renames across the vault, and disappears when off", async () => {
    await boot({ "A.md": NOTE, "B.md": "---\nrating: 2\nRating2: x\n---\nb\n", "C.md": "---\nitems: [z]\n---\n", ".obsidian/core-plugins.json": JSON.stringify({ properties: true }) });
    const leaf = await s.app.workspace.ensureSideLeaf("all-properties", "right", { active: true });
    const view = leaf.view as unknown as AllPropertiesView;
    await vi.waitFor(() => expect(qa(".all-properties-list .tree-item", view.contentEl).length).toBeGreaterThan(5));
    const names = () => qa(".all-properties-list .tree-item", view.contentEl).map((r) => `${r.dataset.propertyKey}:${q(".tree-item-flair", r)!.textContent}`);
    expect(names().slice(0, 2)).toEqual(["items:2", "rating:2"]);
    view.sortOrder = "alphabetical"; view.refresh();
    expect(names().slice(0, 2)).toEqual(["aliases:0", "at:1"]);
    expect(view.getState()).toEqual({ sortOrder: "alphabetical", searchQuery: "" });
    // context menu > Rename...
    q('.all-properties-list .tree-item[data-property-key="rating"] .tree-item-self', view.contentEl)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    qa(".menu .menu-item").find((m) => m.textContent === "Rename...")!.click();
    const input = q<HTMLInputElement>(".mod-rename-property input")!;
    input.value = "stars"; input.dispatchEvent(new Event("input"));
    key(input, "Enter");
    await vi.waitFor(() => expect(disk("B.md")).toBe("---\nstars: 2\nRating2: x\n---\nb\n"));
    expect(disk("A.md")).toContain("\nstars: 4\n");
    // file properties view follows the active note
    await openA();
    s.app.commands.executeCommandById("properties:open-local");
    await vi.waitFor(() => expect(qa(".file-properties-view .metadata-property").length).toBe(7));
    // turning the plugin off removes its views and commands; the in-note table and add-property stay
    await s.app.internalPlugins.plugins["properties"].disable();
    expect(s.app.workspace.getLeavesOfType("all-properties")).toHaveLength(0);
    expect(s.app.workspace.getLeavesOfType("file-properties")).toHaveLength(0);
    expect(s.app.commands.findCommand("properties:open")).toBeFalsy();
    expect(s.app.commands.findCommand("markdown:add-metadata-property")).toBeTruthy();
    expect(lpTable()).toBeTruthy();
    expect(JSON.parse(disk(".obsidian/core-plugins.json")).properties).toBe(false);
  });
});
