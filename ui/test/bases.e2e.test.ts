// Bases end to end against the fake backend: the `.base` file view (table/cards/list), toolbar edits written to the
// file, cell edits written to frontmatter, embeds in Reading view and Live Preview, ```base blocks, commands, and a
// community plugin registering its own Bases view.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as yaml from "js-yaml";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

const BASE = `filters:
  and:
    - file.hasTag("book")
formulas:
  ppu: (price / pages * 100).toFixed(2)
properties:
  formula.ppu:
    displayName: Price per 100 pages
views:
  - type: table
    name: Books
    order: [file.name, author, price, formula.ppu]
    summaries:
      price: Sum
    pluginKeepsThis: 42
  - type: cards
    name: Gallery
    image: cover
    order: [file.name, author]
  - type: list
    name: Reading list
    order: [file.name, status]
    filters: 'status == "reading"'
`;

const PLUGIN_MAIN = `
const { Plugin, BasesView } = require("obsidian");
class CountView extends BasesView {
  type = "count-view";
  constructor(controller, el) { super(controller); this.el = el; }
  onDataUpdated() {
    this.el.empty();
    const n = this.data.data.length;
    this.el.createDiv({ cls: "count-view-out", text: "rows=" + n + " props=" + this.data.properties.join("|") + " label=" + this.config.get("label") + " first=" + (n ? this.data.data[0].getValue("note.price") : "") });
  }
}
module.exports = class extends Plugin {
  async onload() {
    this.ok = this.registerBasesView("count-view", { name: "Count", icon: "lucide-hash", factory: (c, el) => new CountView(c, el),
      options: () => [{ type: "text", key: "label", displayName: "Label", default: "x" }] });
    this.dup = this.registerBasesView("table", { name: "Nope", icon: "x", factory: () => null });
    window.__countPlugin = this;
  }
};
`;

let v: FakeVault;
let session: Session | null = null;
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const q = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];
const read = (p: string) => fs.readFileSync(path.join(v.root, p), "utf8");

function stubBackend(): void {
  setBackend(async (cmd, a) => {
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
  stubBackend();
  const host = document.createElement("div");
  document.body.appendChild(host);
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session;
}
async function openBase(s: Session, p = "Library.base") {
  await s.app.workspace.openLinkText(p, "", false);
  await vi.waitFor(() => expect(q(".workspace-split.mod-root .bases-file-view .bases-toolbar")).toBeTruthy());
  return s.app.workspace.activeLeaf!.view as any;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  v = makeVault({
    "Books/Dune.md": "---\ntags: [book]\nauthor: \"[[Frank Herbert]]\"\nprice: 12\npages: 600\nstatus: reading\ncover: \"[[dune.png]]\"\n---\nSpice.\n",
    "Books/Emma.md": "---\ntags: [book]\nauthor: Jane Austen\nprice: 8\npages: 400\nstatus: done\ncover: \"#336699\"\n---\n",
    "Frank Herbert.md": "Author page\n",
    "dune.png": "PNG",
    "Library.base": BASE,
    "Home.md": "# Home\n\n![[Library.base#Gallery]]\n\n```base\nfilters: 'file.inFolder(\"Books\")'\nviews:\n  - type: table\n    name: Inline\n    order: [file.name, price]\n```\n",
  });
});
afterEach(async () => {
  await session?.stop();
  session = null;
  v.cleanup();
  document.body.innerHTML = "";
  delete (window as any).__countPlugin;
});

describe("Bases (fake backend)", () => {
  it("opens a .base file as a table with headers, rows, formulas and summaries", async () => {
    const s = await boot();
    const view = await openBase(s);
    expect(view.getViewType()).toBe("bases");
    const root = q(".workspace-split.mod-root .bases-file-view")!;
    expect(qa(".bases-table-header-label", root).map((e) => e.textContent)).toEqual(["file name", "author", "price", "Price per 100 pages"]);
    const rows = qa(".bases-tbody .bases-tr", root);
    expect(rows.map((r) => r.getAttribute("data-path"))).toEqual(["Books/Dune.md", "Books/Emma.md"]);
    const cell = (r: HTMLElement, p: string) => q(`.bases-td[data-property="${p}"]`, r)!;
    expect(cell(rows[0], "formula.ppu").textContent).toBe("2.00");
    expect(q("a.internal-link", cell(rows[0], "note.author"))?.textContent).toBe("Frank Herbert");
    expect(q(".bases-table-summary-cell[data-property='note.price']", root)?.textContent).toContain("20");
    expect(q(".bases-toolbar-results-menu", root)?.textContent).toBe("2 results");
    // clicking the file name opens the note
    q<HTMLAnchorElement>("a.internal-link", cell(rows[1], "file.name"))!.click();
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("Books/Emma.md"));
  });

  it("sorts by clicking a header and writes the sort to the .base file, keeping unknown keys", async () => {
    const s = await boot();
    const view = await openBase(s);
    q(".bases-table-header[data-property='note.price'] .bases-table-header-name")!.click();
    q(".bases-table-header[data-property='note.price'] .bases-table-header-name")!.click(); // DESC
    expect(qa(".bases-tbody .bases-tr").map((r) => r.getAttribute("data-path"))).toEqual(["Books/Dune.md", "Books/Emma.md"]);
    q(".bases-table-header[data-property='note.price'] .bases-table-header-name")!.click(); // off
    q(".bases-table-header[data-property='note.price'] .bases-table-header-name")!.click(); // ASC
    expect(qa(".bases-tbody .bases-tr").map((r) => r.getAttribute("data-path"))).toEqual(["Books/Emma.md", "Books/Dune.md"]);
    expect(q(".bases-table-header-sort[data-direction='ASC']")).toBeTruthy();
    await view.save();
    const saved = yaml.load(read("Library.base")) as any;
    expect(saved.views[0].sort).toEqual([{ property: "note.price", direction: "ASC" }]);
    expect(saved.views[0].pluginKeepsThis).toBe(42);
    expect(saved.formulas.ppu).toBe("(price / pages * 100).toFixed(2)");
    expect(saved.views[2].filters).toBe('status == "reading"');
  });

  it("edits a cell and persists it to the note's frontmatter", async () => {
    const s = await boot();
    await openBase(s);
    const cell = q(".bases-tr[data-path='Books/Emma.md'] .bases-td[data-property='note.price'] .bases-table-cell")!;
    cell.click();
    const input = q<HTMLInputElement>("input.bases-cell-input", cell)!;
    expect(input.value).toBe("8");
    input.value = "9.5";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(read("Books/Emma.md")).toContain("price: 9.5"));
    expect(read("Books/Emma.md")).toContain("author: Jane Austen");
    await s.app.metadataCache.flush();
    await vi.waitFor(() => expect(q(".bases-tr[data-path='Books/Emma.md'] .bases-td[data-property='note.price']")?.textContent).toBe("9.5"));
    // text property and list property
    const st = q(".bases-tr[data-path='Books/Dune.md'] .bases-td[data-property='note.author'] .bases-table-cell")!;
    st.click();
    const i2 = q<HTMLInputElement>("input.bases-cell-input", st)!;
    expect(i2.value).toBe("[[Frank Herbert]]");
    i2.value = "Someone Else";
    i2.dispatchEvent(new Event("blur"));
    await vi.waitFor(() => expect(read("Books/Dune.md")).toContain("author: Someone Else"));
  });

  it("switches to cards (cover images and colours) and list views", async () => {
    const s = await boot();
    const view = await openBase(s);
    view.controller.selectView(1);
    await vi.waitFor(() => expect(q(".bases-cards-item")).toBeTruthy());
    const cards = qa(".workspace-split.mod-root .bases-cards-item");
    expect(cards.map((c) => c.getAttribute("data-path"))).toEqual(["Books/Dune.md", "Books/Emma.md"]);
    expect(q(".bases-cards-cover img", cards[0])?.getAttribute("src")).toContain("dune.png");
    expect(q<HTMLElement>(".bases-cards-cover", cards[1])!.style.backgroundColor).toBeTruthy();
    expect(q(".bases-cards-label", cards[0])?.textContent).toBe("author");
    expect(q(".bases-toolbar-views-menu")?.textContent).toBe("Gallery");
    view.controller.selectView(2);
    await vi.waitFor(() => expect(q(".bases-list-item")).toBeTruthy());
    const items = qa(".workspace-split.mod-root .bases-list-item");
    expect(items).toHaveLength(1);
    expect(items[0].textContent).toBe("Dune, reading");
    expect(view.getState().viewName).toBe("Reading list");
  });

  it("re-renders when notes change (debounced)", async () => {
    const s = await boot();
    await openBase(s);
    await s.app.vault.create("Books/New.md", "---\ntags: [book]\nprice: 1\npages: 10\n---\n");
    await s.app.metadataCache.flush();
    await vi.waitFor(() => expect(qa(".workspace-split.mod-root .bases-tbody .bases-tr")).toHaveLength(3), { timeout: 2000 });
  });

  it("renders ![[x.base#View]] and ```base blocks in Reading view and Live Preview", async () => {
    const s = await boot();
    await s.app.workspace.openLinkText("Home", "", false);
    // Live Preview
    await vi.waitFor(() => expect(q(".markdown-source-view .bases-embed .bases-cards-item")).toBeTruthy());
    expect(q(".markdown-source-view .bases-embed .bases-toolbar-views-menu")?.textContent).toBe("Gallery");
    await vi.waitFor(() => expect(qa(".markdown-source-view .cm-code-block-widget .bases-table .bases-tbody .bases-tr")).toHaveLength(2));
    // Reading view
    const view = s.app.workspace.activeLeaf!.view as any;
    view.setMode("preview");
    await view.previewMode.whenRendered();
    await vi.waitFor(() => expect(qa(".markdown-reading-view .internal-embed.bases-embed .bases-cards-item")).toHaveLength(2));
    const block = q(".markdown-reading-view .block-language-base")!;
    expect(qa(".bases-table-header-label", block).map((e) => e.textContent)).toEqual(["file name", "price"]);
    expect(qa(".bases-tbody .bases-tr", block)).toHaveLength(2);
  });

  it("creates a new base from the command and edits filters/properties through the toolbar", async () => {
    const s = await boot();
    await s.app.workspace.openLinkText("Home", "", false);
    expect(s.app.commands.findCommand("bases:new-file")?.name).toBe("Bases: Create new base");
    s.app.commands.executeCommandById("bases:new-file");
    await vi.waitFor(() => expect(s.app.vault.getFileByPath("Untitled.base")).toBeTruthy());
    await vi.waitFor(() => expect(s.app.workspace.getActiveFile()?.path).toBe("Untitled.base"));
    const view = s.app.workspace.activeLeaf!.view as any;
    await vi.waitFor(() => expect(view.controller).toBeTruthy());
    // Filter dialog: add a condition for all views
    q(".workspace-split.mod-root .bases-toolbar-filter-menu")!.click();
    const modal = q(".modal.bases-filter-modal, .modal .bases-filter-modal")!;
    const add = qa(".bases-filter-add input", modal)[0] as HTMLInputElement;
    add.value = 'file.inFolder("Books")';
    qa(".bases-filter-add button", modal)[0].click();
    await vi.waitFor(() => expect(view.controller.config.raw.filters).toEqual({ and: ['file.inFolder("Books")'] }));
    s.app.workspace.activeLeaf; // modal close
    (document.querySelector(".modal-close-button") as HTMLElement | null)?.click();
    await vi.waitFor(() => expect(q(".workspace-split.mod-root .bases-toolbar-results-menu")?.textContent).toBe("2 results"));
    // Properties dialog: add a formula column
    q(".workspace-split.mod-root .bases-toolbar-properties-menu")!.click();
    const pm = q(".bases-properties-modal")!;
    const [nameIn, exprIn] = qa(".bases-formula-add input", pm) as HTMLInputElement[];
    nameIn.value = "double";
    exprIn.value = "price * 2";
    q(".bases-formula-add button", pm)!.click();
    (document.querySelector(".modal-close-button") as HTMLElement | null)?.click();
    await vi.waitFor(() => expect(qa(".bases-td[data-property='formula.double']").map((e) => e.textContent)).toEqual(["24", "16"]));
    await view.save();
    const saved = yaml.load(read("Untitled.base")) as any;
    expect(saved.formulas).toEqual({ double: "price * 2" });
    expect(saved.views[0].order).toEqual(["file.name", "formula.double"]);
    expect(saved.filters).toEqual({ and: ['file.inFolder("Books")'] });
  });

  it("lets plugins register Bases views via Plugin.registerBasesView", async () => {
    v.write(".obsidian/plugins/countview/manifest.json", JSON.stringify({ id: "countview", name: "Count view", version: "1.0.0", minAppVersion: "1.10.0", description: "", author: "t" }));
    v.write(".obsidian/plugins/countview/main.js", PLUGIN_MAIN);
    v.write(".obsidian/community-plugins.json", JSON.stringify(["countview"]));
    v.write("Counted.base", "filters: file.hasTag(\"book\")\nviews:\n  - type: count-view\n    name: Count\n    label: hello\n    order: [file.name, price]\n    sort: [{property: price, direction: DESC}]\n");
    localStorage.setItem(`${path.basename(v.root)}-enable-plugin`, "true");
    const s = await boot();
    await vi.waitFor(() => expect((window as any).__countPlugin).toBeTruthy());
    expect((window as any).__countPlugin.ok).toBe(true);
    expect((window as any).__countPlugin.dup).toBe(false);
    await openBase(s, "Counted.base");
    await vi.waitFor(() => expect(q(".count-view-out")?.textContent).toBe("rows=2 props=file.name|note.price label=hello first=12"));
    const view = s.app.workspace.activeLeaf!.view as any;
    // the plugin's options show in View settings
    view.controller.viewsMenu?.();
    const { ViewSettingsModal } = await import("../src/bases/toolbar");
    const m = new ViewSettingsModal(s.app, view.controller, 0);
    m.open();
    expect(qa(".setting-item-name", m.contentEl).map((e) => e.textContent)).toContain("Label");
    m.close();
    // unloading the plugin removes the registration
    await s.app.plugins.disablePlugin("countview");
    expect(s.app.basesViews["count-view"]).toBeUndefined();
    await tick();
  });
});
