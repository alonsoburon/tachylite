// "Properties" core plugin: the All properties view, the file Properties view, vault-wide rename and type changes.
// The in-note table and the markdown:* property commands are always available (as in Obsidian).
import { MarkdownView, Menu, Modal, Notice, Setting, TFile, setIcon, type App, type WorkspaceLeaf } from "../../obsidian";
import { USER_TYPES, type PropertyInfo } from "../../obsidian/properties";
import { PanelView, activateView, addCommand, coreEnabled, whileCoreEnabled, type CoreModule } from "../core/util";
import { FollowView, naturalCompare, navButton, navHeader } from "../core/panel";
import { propertiesMode } from "./embed";
import { mountMetadataEditor, renameKey, requestPropertyFocus, type MetadataEditor } from "./metadataEditor";

export const ALL_PROPERTIES_VIEW = "all-properties";
export const FILE_PROPERTIES_VIEW = "file-properties";
const SORTS: Record<string, string> = { alphabetical: "Name (A to Z)", alphabeticalReverse: "Name (Z to A)", frequency: "Frequency (high to low)", frequencyReverse: "Frequency (low to high)" };

/** Rename a property in every note that has it (keeps each note's key order) and carry over its assigned type. */
export async function renamePropertyEverywhere(app: App, from: string, to: string): Promise<number> {
  const lc = from.toLowerCase();
  let n = 0;
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const key = fm && Object.keys(fm).find((k) => k.toLowerCase() === lc);
    if (!key) continue;
    await app.fileManager.processFrontMatter(f, (o) => {
      const k = Object.keys(o).find((x) => x.toLowerCase() === lc);
      if (!k) return;
      if (Object.keys(o).some((x) => x !== k && x.toLowerCase() === to.toLowerCase())) { // merge into the existing key
        const merged = [...toArr(o[Object.keys(o).find((x) => x !== k && x.toLowerCase() === to.toLowerCase())!]), ...toArr(o[k])];
        delete o[k];
        o[Object.keys(o).find((x) => x.toLowerCase() === to.toLowerCase())!] = merged;
      } else renameKey(o, k, to);
    });
    n++;
  }
  const mtm = app.metadataTypeManager, assigned = mtm.getAssignedWidget(from);
  if (assigned && from.toLowerCase() !== to.toLowerCase()) { await mtm.unsetType(from); await mtm.setType(to, assigned); }
  else if (assigned) await mtm.setType(to, assigned);
  return n;
}
const toArr = (v: unknown) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

class RenamePropertyModal extends Modal {
  constructor(app: App, private prop: PropertyInfo) { super(app); }
  onOpen(): void {
    this.setTitle("Rename property");
    this.modalEl.addClass("mod-rename-property");
    let value = this.prop.name;
    const go = async () => {
      const to = value.trim();
      if (!to || to === this.prop.name) { this.close(); return; }
      this.close();
      const n = await renamePropertyEverywhere(this.app, this.prop.name, to);
      new Notice(`Renamed "${this.prop.name}" to "${to}" in ${n} note${n === 1 ? "" : "s"}.`);
    };
    new Setting(this.contentEl).setName("New name").setDesc(`Updates ${this.prop.occurrences} note${this.prop.occurrences === 1 ? "" : "s"}.`).addText((t) => {
      t.setValue(value).onChange((v) => { value = v; });
      t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void go(); } });
      setTimeout(() => { t.inputEl.focus(); t.inputEl.select(); }, 0);
    });
    const bar = this.modalEl.createDiv({ cls: "modal-button-container" });
    bar.createEl("button", { cls: "mod-cta", text: "Rename" }).addEventListener("click", () => void go());
    bar.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }
}

/** Menu with "Property type" and "Rename"; shared by the All properties view. */
function propertyMenu(app: App, p: PropertyInfo, evt: MouseEvent): void {
  const mtm = app.metadataTypeManager, menu = new Menu();
  const reserved = ["tags", "aliases", "cssclasses"].includes(p.name.toLowerCase());
  menu.addItem((i) => {
    i.setSection("action").setTitle("Property type").setIcon("lucide-shapes").setDisabled(reserved);
    if (reserved) return;
    const sub = i.setSubmenu();
    for (const t of USER_TYPES) { const w = mtm.getWidget(t); sub.addItem((s) => s.setTitle(w.name()).setIcon(w.icon).setChecked(p.widget === t).onClick(() => { void mtm.setType(p.name, t); })); }
  });
  menu.addItem((i) => i.setSection("action").setTitle("Rename...").setIcon("lucide-pencil").setDisabled(reserved).onClick(() => new RenamePropertyModal(app, p).open()));
  menu.addItem((i) => i.setSection("search").setTitle("Search for notes with this property").setIcon("lucide-search").onClick(() => searchProperty(app, p.name)));
  menu.showAtMouseEvent(evt);
}
async function searchProperty(app: App, name: string): Promise<void> {
  const leaf = await app.workspace.ensureSideLeaf("search", "left", { active: true, reveal: true });
  (leaf.view as any).setQuery?.(`[${name}]`);
}

export class AllPropertiesView extends PanelView {
  sortOrder = "frequency";
  searchQuery = "";
  private showSearch = false;
  private listEl!: HTMLElement;
  private searchEl!: HTMLInputElement;
  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return ALL_PROPERTIES_VIEW; }
  getDisplayText(): string { return "All properties"; }
  getIcon(): string { return "lucide-archive"; }
  getState(): Record<string, unknown> { return { sortOrder: this.sortOrder, searchQuery: this.searchQuery }; }
  async setState(s: any): Promise<void> {
    if (typeof s?.sortOrder === "string" && s.sortOrder in SORTS) this.sortOrder = s.sortOrder;
    if (typeof s?.searchQuery === "string") { this.searchQuery = s.searchQuery; this.showSearch = !!s.searchQuery; }
    if (this.listEl) { this.syncSearch(); this.refresh(); }
  }
  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.addClass("all-properties-view");
    const bar = navHeader(el);
    navButton(bar, "lucide-sort-asc", "Change sort order", (e) => {
      const m = new Menu();
      for (const [k, label] of Object.entries(SORTS)) m.addItem((i) => i.setSection(k.startsWith("alpha") ? "name" : "freq").setTitle(label).setChecked(k === this.sortOrder).onClick(() => { this.sortOrder = k; this.refresh(); this.app.workspace.requestSaveLayout(); }));
      m.showAtMouseEvent(e);
    }, "mod-sort");
    navButton(bar, "lucide-search", "Search properties", () => { this.showSearch = !this.showSearch; this.syncSearch(); if (this.showSearch) this.searchEl.focus(); }, "mod-search");
    const box = el.createDiv({ cls: "search-input-container" });
    this.searchEl = box.createEl("input", { type: "search", attr: { placeholder: "Filter properties...", spellcheck: "false" } });
    this.registerDomEvent(this.searchEl, "input", () => { this.searchQuery = this.searchEl.value; this.requestRefresh(80); this.app.workspace.requestSaveLayout(); });
    this.listEl = el.createDiv({ cls: "all-properties-list" });
    this.syncSearch();
    const again = () => this.requestRefresh(150);
    this.registerEvent(this.app.metadataCache.on("changed", again));
    this.registerEvent(this.app.metadataCache.on("resolved", again));
    this.registerEvent(this.app.metadataCache.on("deleted", again));
    this.registerEvent(this.app.metadataTypeManager.on("changed", again));
    this.refresh();
  }
  private syncSearch(): void { this.searchEl.value = this.searchQuery; this.searchEl.parentElement!.toggle(this.showSearch || !!this.searchQuery); }
  refresh(): void {
    if (!this.listEl) return;
    this.listEl.empty();
    const mtm = this.app.metadataTypeManager, occ = mtm.getPropertyOccurrences(), q = this.searchQuery.trim().toLowerCase();
    let props = Object.entries(mtm.getAllProperties()).map(([lc, p]) => ({ ...p, occurrences: occ[lc] ?? 0 })).filter((p) => p.occurrences > 0 || mtm.getAssignedWidget(p.name) !== null);
    if (q) props = props.filter((p) => p.name.toLowerCase().includes(q));
    const byName = (a: PropertyInfo, b: PropertyInfo) => naturalCompare(a.name, b.name);
    const sorts: Record<string, (a: PropertyInfo, b: PropertyInfo) => number> = {
      alphabetical: byName, alphabeticalReverse: (a, b) => byName(b, a),
      frequency: (a, b) => b.occurrences - a.occurrences || byName(a, b), frequencyReverse: (a, b) => a.occurrences - b.occurrences || byName(a, b),
    };
    props.sort(sorts[this.sortOrder] ?? sorts.frequency);
    if (!props.length) { this.listEl.createDiv({ cls: "pane-empty properties-pane-empty", text: q ? "No properties match." : "No properties found." }); return; }
    for (const p of props) {
      const row = this.listEl.createDiv({ cls: "tree-item", attr: { "data-property-key": p.name } });
      const self = row.createDiv({ cls: "tree-item-self is-clickable" });
      setIcon(self.createDiv({ cls: "tree-item-icon" }), mtm.getWidget(p.widget).icon);
      self.createDiv({ cls: "tree-item-inner", text: p.name });
      self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(p.occurrences) });
      self.addEventListener("click", () => void searchProperty(this.app, p.name));
      self.addEventListener("contextmenu", (e) => { e.preventDefault(); propertyMenu(this.app, p, e); });
    }
  }
}

/** Properties of the active note (or of the note it is bound to) in a side panel. */
export class FilePropertiesView extends FollowView {
  editor: MetadataEditor | null = null;
  private bodyEl!: HTMLElement;
  private shown: string | null = null;
  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return FILE_PROPERTIES_VIEW; }
  getDisplayText(): string { return "Properties"; }
  getIcon(): string { return "lucide-info"; }
  get metadataEditor(): MetadataEditor | null { return this.editor; }
  async onOpen(): Promise<void> {
    this.contentEl.addClass("file-properties-view");
    this.bodyEl = this.contentEl.createDiv({ cls: "file-properties-body" });
    this.follow(["changed", "resolved"]);
    this.refresh();
  }
  refresh(): void {
    if (!this.bodyEl) return;
    const f = this.file;
    const fm = f && f.extension === "md" ? this.app.metadataCache.getFileCache(f)?.frontmatter ?? {} : null;
    const sig = f ? `${f.path}\n${JSON.stringify(fm)}` : null;
    if (sig === this.shown && this.editor) return;
    this.shown = sig;
    this.editor?.unload(); this.editor = null;
    this.bodyEl.empty();
    if (!f) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No file is open." }); return; }
    if (f.extension !== "md") { this.bodyEl.createDiv({ cls: "pane-empty", text: "Properties are only available for Markdown notes." }); return; }
    this.editor = mountMetadataEditor(this.app, f, this.bodyEl, fm, { heading: false });
    if (!Object.keys(fm ?? {}).length) this.bodyEl.createDiv({ cls: "pane-empty", text: "No properties." });
  }
  onunload(): void { this.editor?.unload(); this.editor = null; super.onunload(); }
}

/** Add a property to the active note: the in-note table when shown, else the Properties side view. */
async function addPropertyToActive(app: App, key?: string): Promise<boolean> {
  const view = app.workspace.getActiveViewOfType(MarkdownView) as any;
  const file = app.workspace.getActiveFile();
  if (view?.file && propertiesMode(app) === "visible" && !(view.getMode() === "source" && view.editMode?.sourceMode)) {
    const ed = view.metadataEditor as MetadataEditor | null;
    if (ed) { ed.addProperty(key); return true; }
    // No frontmatter yet: add an empty block and let the table that appears open the new row.
    requestPropertyFocus(view.file.path, key ?? null, "value");
    if (key) await app.fileManager.processFrontMatter(view.file, (fm) => { fm[key] ??= null; });
    else { view.editor.cm.dispatch({ changes: { from: 0, insert: "---\n---\n" } }); await view.save(); }
    return true;
  }
  if (file?.extension === "md" && coreEnabled(app, "properties")) {
    const leaf = await openFileProperties(app);
    (leaf.view as FilePropertiesView).refresh();
    (leaf.view as FilePropertiesView).editor?.addProperty(key);
    return true;
  }
  return false;
}
function openFileProperties(app: App): Promise<WorkspaceLeaf> { return activateView(app, FILE_PROPERTIES_VIEW, "right"); }

export const properties: CoreModule = {
  id: "properties",
  install(app: App) {
    app.viewRegistry.registerView(ALL_PROPERTIES_VIEW, (l) => new AllPropertiesView(l));
    app.viewRegistry.registerView(FILE_PROPERTIES_VIEW, (l) => new FilePropertiesView(l));
    const canAdd = () => {
      const v = app.workspace.getActiveViewOfType(MarkdownView);
      if (v?.file && propertiesMode(app) === "visible") return true;
      return coreEnabled(app, "properties") && app.workspace.getActiveFile()?.extension === "md";
    };
    const always = [
      addCommand(app, { id: "markdown:add-metadata-property", name: "Add file property", icon: "lucide-plus-circle", hotkeys: [{ modifiers: ["Mod"], key: ";" }], checkCallback: (c) => { if (!canAdd()) return false; if (!c) void addPropertyToActive(app); return true; } }),
      addCommand(app, { id: "markdown:add-alias", name: "Add alias", icon: "lucide-forward", checkCallback: (c) => { if (!canAdd()) return false; if (!c) void addPropertyToActive(app, "aliases"); return true; } }),
      addCommand(app, { id: "markdown:clear-metadata-properties", name: "Clear file properties", icon: "lucide-package-x", checkCallback: (c) => {
        const f = app.workspace.getActiveFile();
        if (!(f instanceof TFile) || f.extension !== "md") return false;
        if (!c) void app.fileManager.processFrontMatter(f, (fm) => { for (const k of Object.keys(fm)) delete fm[k]; });
        return true;
      } }),
    ];
    const stop = whileCoreEnabled(app, "properties", () => {
      const offs = [
        addCommand(app, { id: "properties:open", name: "Properties: Show all properties", icon: "lucide-archive", callback: () => { void app.workspace.ensureSideLeaf(ALL_PROPERTIES_VIEW, "right", { active: true, reveal: true }); } }),
        addCommand(app, { id: "properties:open-local", name: "Properties: Show file properties", icon: "lucide-info", callback: () => { void openFileProperties(app); } }),
      ];
      // Status bar: number of properties of the active note.
      const status = app.statusBarEl.createDiv({ cls: "status-bar-item plugin-properties" });
      const upd = () => {
        const f = app.workspace.getActiveFile();
        const n = f?.extension === "md" ? Object.keys(app.metadataCache.getFileCache(f)?.frontmatter ?? {}).length : 0;
        status.setText(`${n} propert${n === 1 ? "y" : "ies"}`);
        status.toggle(n > 0);
      };
      const refs = [app.workspace.on("file-open", upd), app.workspace.on("active-leaf-change", upd)];
      const mref = app.metadataCache.on("changed", upd);
      upd();
      // Like Obsidian, the All properties view lives in the right sidebar while the plugin is on.
      app.workspace.onLayoutReady(() => { if (coreEnabled(app, "properties") && !app.workspace.getLeavesOfType(ALL_PROPERTIES_VIEW).length) void app.workspace.ensureSideLeaf(ALL_PROPERTIES_VIEW, "right", { reveal: false }); });
      return () => {
        offs.forEach((o) => o());
        refs.forEach((r) => app.workspace.offref(r)); app.metadataCache.offref(mref); status.detach();
        app.workspace.detachLeavesOfType(ALL_PROPERTIES_VIEW);
        app.workspace.detachLeavesOfType(FILE_PROPERTIES_VIEW);
      };
    });
    return () => { stop(); always.forEach((o) => o()); app.viewRegistry.unregisterView(ALL_PROPERTIES_VIEW); app.viewRegistry.unregisterView(FILE_PROPERTIES_VIEW); };
  },
};
