// The editable Properties table (Live Preview, reading view, the file properties side view).
// Every edit goes through app.fileManager.processFrontMatter, which updates an open editor in place.
import { AbstractInputSuggest, Component, Menu, Notice, setIcon, type App, type TFile } from "../../obsidian";
import { USER_TYPES, type PropertyInfo, type PropertyWidgetComponent } from "../../obsidian/properties";

/** Where to put the caret after the next render of a path's table (survives the widget being rebuilt). */
interface FocusTarget { path: string; key: string | null; part: "key" | "value" }
let pendingFocus: FocusTarget | null = null;
/** Fold state of the Properties heading per note (session only). */
const collapsedPaths = new Set<string>();

class KeySuggest extends AbstractInputSuggest<PropertyInfo> {
  constructor(app: App, el: HTMLInputElement, private taken: () => string[], pick: (name: string) => void) {
    super(app, el as unknown as HTMLDivElement);
    this.limit = 30;
    this.onSelect((p, evt) => { evt.preventDefault?.(); (el as HTMLInputElement).value = p.name; this.close(); pick(p.name); });
  }
  protected getSuggestions(query: string): PropertyInfo[] {
    const q = query.trim().toLowerCase(), taken = new Set(this.taken().map((k) => k.toLowerCase()));
    return Object.values(this.app.metadataTypeManager.getAllProperties())
      .filter((p) => !taken.has(p.name.toLowerCase()) && (!q || p.name.toLowerCase().includes(q)))
      .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
  }
  renderSuggestion(p: PropertyInfo, el: HTMLElement): void {
    el.addClass("mod-complex");
    const icon = el.createDiv({ cls: "suggestion-icon" }).createSpan({ cls: "suggestion-flair" });
    setIcon(icon, this.app.metadataTypeManager.getWidget(p.widget).icon);
    el.createDiv({ cls: "suggestion-content" }).createDiv({ cls: "suggestion-title", text: p.name });
  }
}

export interface MetadataEditorOptions {
  /** Show the collapsible "Properties" heading (not in the side view). */
  heading?: boolean;
}

export class MetadataEditor extends Component {
  containerEl: HTMLElement;
  propertiesEl: HTMLElement;
  addPropertyButtonEl: HTMLElement;
  /** Frontmatter as last rendered. */
  frontmatter: Record<string, unknown> = {};
  private widgets: { key: string; row: HTMLElement; keyInput: HTMLInputElement; widget: PropertyWidgetComponent }[] = [];
  private dragKey: string | null = null;

  constructor(public app: App, public file: TFile, parent: HTMLElement, opts: MetadataEditorOptions = {}) {
    super();
    this.containerEl = parent.createDiv({ cls: "metadata-container", attr: { "data-source-path": file.path, tabindex: -1 } });
    if (opts.heading !== false) {
      const head = this.containerEl.createDiv({ cls: "metadata-properties-heading", attr: { tabindex: 0 } });
      const ind = head.createDiv({ cls: "collapse-indicator collapse-icon" });
      setIcon(ind, "lucide-chevron-down");
      head.createDiv({ cls: "metadata-properties-title", text: "Properties" });
      const toggle = () => {
        const c = !this.containerEl.hasClass("is-collapsed");
        this.containerEl.toggleClass("is-collapsed", c);
        ind.toggleClass("is-collapsed", c);
        if (c) collapsedPaths.add(this.file.path); else collapsedPaths.delete(this.file.path);
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      if (collapsedPaths.has(file.path)) { this.containerEl.addClass("is-collapsed"); ind.addClass("is-collapsed"); }
    }
    const content = this.containerEl.createDiv({ cls: "metadata-content" });
    this.propertiesEl = content.createDiv({ cls: "metadata-properties" });
    this.addPropertyButtonEl = content.createDiv({ cls: "metadata-add-button text-icon-button", attr: { tabindex: 0 } });
    setIcon(this.addPropertyButtonEl.createSpan({ cls: "text-button-icon" }), "lucide-plus");
    this.addPropertyButtonEl.createSpan({ cls: "text-button-label", text: "Add property" });
    this.addPropertyButtonEl.addEventListener("click", () => this.addProperty());
    this.addPropertyButtonEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.addProperty(); } });
  }

  render(fm: Record<string, unknown> | null): void {
    this.frontmatter = fm ?? {};
    for (const w of this.widgets) w.widget.unload();
    this.widgets = [];
    this.propertiesEl.empty();
    for (const [key, value] of Object.entries(this.frontmatter)) this.renderRow(key, value);
    this.consumeFocus();
  }

  private renderRow(key: string | null, value: unknown): void {
    const mtm = this.app.metadataTypeManager;
    const row = this.propertiesEl.createDiv({ cls: "metadata-property", attr: { tabindex: 0 } });
    const info = key === null ? null : mtm.getTypeInfo(key, value);
    const type = info?.expected.type ?? "text";
    if (key !== null) { row.setAttribute("data-property-key", key); row.setAttribute("data-property-type", type); }
    const keyEl = row.createDiv({ cls: "metadata-property-key" });
    const icon = keyEl.createSpan({ cls: "metadata-property-icon", attr: { "aria-label": key === null ? "" : mtm.getWidget(type).name(), draggable: key === null ? "false" : "true" } });
    setIcon(icon, key === null ? "lucide-text" : mtm.getWidget(type).icon);
    const keyInput = keyEl.createEl("input", { cls: "metadata-property-key-input", type: "text", attr: { autocapitalize: "none", enterkeyhint: "next", "aria-label": key ?? "", placeholder: "" } });
    keyInput.value = key ?? "";
    const valueEl = row.createDiv({ cls: "metadata-property-value" });

    if (key === null) {
      // A new, still unnamed row: written once it gets a name.
      row.addClass("is-new");
      const commit = (name: string) => {
        name = name.trim();
        row.remove();
        if (!name) { void this.removeEmptyBlock(); return; }
        const existing = Object.keys(this.frontmatter).find((k) => k.toLowerCase() === name.toLowerCase());
        pendingFocus = { path: this.file.path, key: existing ?? name, part: "value" };
        if (existing) { this.consumeFocus(); return; }
        void this.write((fm) => { fm[name] = null; });
      };
      const suggest = new KeySuggest(this.app, keyInput, () => Object.keys(this.frontmatter), (n) => commit(n));
      keyInput.addEventListener("keydown", (e) => {
        if (suggest.isOpen && (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp")) return;
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); commit(keyInput.value); }
        else if (e.key === "Escape") { e.preventDefault(); commit(""); }
      });
      keyInput.addEventListener("blur", () => { setTimeout(() => { if (row.isConnected && !suggest.isOpen) commit(keyInput.value); }, 150); });
      return;
    }

    const widget = mtm.getWidget(type).render(valueEl, value, {
      app: this.app, key, sourcePath: this.file.path,
      onChange: (v) => { this.rememberFocus(); void this.write((fm) => { fm[key] = v === undefined ? null : v; }); },
      blur: () => row.focus(),
    });
    if (info && value !== null && value !== undefined && !info.expected.validate(value)) {
      row.addClass("has-warning");
      const warn = keyEl.createSpan({ cls: "metadata-property-warning-icon", attr: { "aria-label": `Type mismatch, expected ${info.expected.name()}` } });
      setIcon(warn, "lucide-alert-triangle");
    }
    this.widgets.push({ key, row, keyInput, widget });

    // Rename within this note.
    const suggest = new KeySuggest(this.app, keyInput, () => Object.keys(this.frontmatter), (n) => rename(n));
    const rename = (to: string) => {
      to = to.trim();
      if (!to || to === key) { keyInput.value = key; return; }
      if (Object.keys(this.frontmatter).some((k) => k !== key && k.toLowerCase() === to.toLowerCase())) {
        new Notice(`A property named "${to}" already exists.`);
        keyInput.value = key;
        return;
      }
      pendingFocus = { path: this.file.path, key: to, part: "value" };
      void this.write((fm) => renameKey(fm, key, to));
    };
    keyInput.addEventListener("keydown", (e) => {
      if (suggest.isOpen && (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp")) return;
      if (e.key === "Enter") { e.preventDefault(); if (keyInput.value.trim() === key) widget.focus(); else rename(keyInput.value); }
      else if (e.key === "Escape") { e.preventDefault(); keyInput.value = key; row.focus(); }
    });
    keyInput.addEventListener("change", () => { if (!suggest.isOpen) rename(keyInput.value); });

    icon.addEventListener("click", (e) => { e.preventDefault(); this.showPropertyMenu(key, type, e); });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showPropertyMenu(key, type, e); });
    row.addEventListener("keydown", (e) => {
      if (e.target !== row) return;
      if ((e.key === "Backspace" || e.key === "Delete") && (e.ctrlKey || e.metaKey || e.key === "Delete")) { e.preventDefault(); void this.removeProperty(key); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); ((e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null)?.focus(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); widget.focus(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); keyInput.focus(); }
    });
    // Drag the icon to reorder.
    icon.addEventListener("dragstart", (e) => { this.dragKey = key; row.addClass("is-being-dragged"); e.dataTransfer?.setData("text/plain", key); });
    icon.addEventListener("dragend", () => { this.dragKey = null; row.removeClass("is-being-dragged"); });
    row.addEventListener("dragover", (e) => { if (this.dragKey && this.dragKey !== key) { e.preventDefault(); row.addClass("is-drop-target"); } });
    row.addEventListener("dragleave", () => row.removeClass("is-drop-target"));
    row.addEventListener("drop", (e) => {
      row.removeClass("is-drop-target");
      const from = this.dragKey;
      if (!from || from === key) return;
      e.preventDefault();
      const r = row.getBoundingClientRect();
      void this.moveProperty(from, key, e.clientY > r.top + r.height / 2);
    });
  }

  private showPropertyMenu(key: string, type: string, evt: MouseEvent): void {
    const mtm = this.app.metadataTypeManager, menu = new Menu();
    const reserved = ["tags", "aliases", "cssclasses"].includes(key.toLowerCase());
    menu.addItem((i) => {
      i.setSection("action").setTitle("Property type").setIcon("lucide-shapes").setDisabled(reserved);
      if (reserved) return;
      const sub = i.setSubmenu();
      for (const t of USER_TYPES) {
        const w = mtm.getWidget(t);
        sub.addItem((s) => s.setTitle(w.name()).setIcon(w.icon).setChecked(t === type).onClick(() => { void mtm.setType(key, t).then(() => this.rerenderSoon()); }));
      }
    });
    menu.addItem((i) => i.setSection("clipboard").setTitle("Copy").setIcon("lucide-copy").onClick(() => {
      void navigator.clipboard?.writeText(`${key}: ${JSON.stringify(this.frontmatter[key] ?? null)}`);
    }));
    menu.addItem((i) => i.setSection("danger").setTitle("Remove").setIcon("lucide-trash-2").setWarning(true).onClick(() => { void this.removeProperty(key); }));
    menu.showAtMouseEvent(evt);
  }

  /** Type changes do not touch the note, so redraw from the last frontmatter. */
  private rerenderSoon(): void { this.render(this.frontmatter); }

  /** Add a new row and focus its name; with `key`, focus (or create) that property instead. */
  addProperty(key?: string): void {
    if (this.containerEl.hasClass("is-collapsed")) this.containerEl.querySelector<HTMLElement>(".metadata-properties-heading")?.click();
    if (key) {
      const existing = Object.keys(this.frontmatter).find((k) => k.toLowerCase() === key.toLowerCase());
      pendingFocus = { path: this.file.path, key: existing ?? key, part: "value" };
      if (existing) this.consumeFocus(); else void this.write((fm) => { fm[key] = null; });
      return;
    }
    this.propertiesEl.querySelector(".metadata-property.is-new")?.remove();
    this.renderRow(null, null);
    (this.propertiesEl.lastElementChild?.querySelector("input") as HTMLInputElement | null)?.focus();
  }
  /** Merge properties into the note (used by plugins, e.g. QuickAdd). */
  insertProperties(props: Record<string, unknown>): Promise<void> {
    return this.write((fm) => { for (const [k, v] of Object.entries(props)) fm[k] = v; });
  }
  removeProperty(key: string): Promise<void> {
    const keys = Object.keys(this.frontmatter), i = keys.indexOf(key);
    const next = keys[i + 1] ?? keys[i - 1] ?? null;
    pendingFocus = next ? { path: this.file.path, key: next, part: "key" } : null;
    return this.write((fm) => { delete fm[key]; });
  }
  moveProperty(from: string, to: string, after: boolean): Promise<void> {
    return this.write((fm) => {
      const entries = Object.entries(fm).filter(([k]) => k !== from);
      const at = entries.findIndex(([k]) => k === to) + (after ? 1 : 0);
      entries.splice(at, 0, [from, fm[from]]);
      for (const k of Object.keys(fm)) delete fm[k];
      for (const [k, v] of entries) fm[k] = v;
    });
  }
  focusProperty(key: string, part: "key" | "value" = "value"): void { pendingFocus = { path: this.file.path, key, part }; this.consumeFocus(); }

  private async write(fn: (fm: Record<string, unknown>) => void): Promise<void> {
    try { await this.app.fileManager.processFrontMatter(this.file, fn); }
    catch (e) { new Notice(`Couldn't update properties: ${(e as Error).message}`); }
    restoreFocusSoon();
  }
  /** An empty `---\n---` block added by "Add property" is dropped again when nothing was added. */
  private async removeEmptyBlock(): Promise<void> {
    if (Object.keys(this.frontmatter).length) return;
    await this.write(() => {});
  }
  private rememberFocus(): void {
    const a = document.activeElement as HTMLElement | null;
    const row = a?.closest?.(".metadata-property") as HTMLElement | null;
    if (!a || !row || !this.containerEl.contains(row)) return;
    const key = row.getAttribute("data-property-key");
    if (key) pendingFocus = { path: this.file.path, key, part: a.matches(".metadata-property-key-input") ? "key" : "value" };
  }
  /** Apply a pending focus request aimed at this table. */
  consumeFocus(): boolean {
    const f = pendingFocus;
    if (!f || f.path !== this.file.path || !this.containerEl.isConnected) return false;
    const w = this.widgets.find((x) => x.key === f.key) ?? this.widgets.find((x) => x.key.toLowerCase() === f.key?.toLowerCase());
    if (!w) return false;
    pendingFocus = null;
    if (f.part === "key") w.keyInput.focus(); else w.widget.focus();
    return true;
  }
  onunload(): void { for (const w of this.widgets) w.widget.unload(); this.widgets = []; }
}

/** Live tables register here so a focus request can find the rebuilt table (Live Preview rebuilds on every edit). */
export const liveEditors = new Set<MetadataEditor>();
function restoreFocusSoon(): void {
  let tries = 0;
  const attempt = () => {
    if (!pendingFocus) return;
    for (const ed of liveEditors) if (ed.consumeFocus()) return;
    if (++tries < 20) setTimeout(attempt, 25);
    else pendingFocus = null;
  };
  attempt();
}

/** Rename a key in place, keeping the order of the others. */
export function renameKey(fm: Record<string, unknown>, from: string, to: string): void {
  if (!(from in fm) || from === to) return;
  const entries = Object.entries(fm).map(([k, v]) => [k === from ? to : k, v] as const);
  for (const k of Object.keys(fm)) delete fm[k];
  for (const [k, v] of entries) fm[k] = v;
}

/** Create a table for `file` inside `parent`, tracked for focus restoration; call `destroy` when it goes away. */
export function mountMetadataEditor(app: App, file: TFile, parent: HTMLElement, fm: Record<string, unknown> | null, opts?: MetadataEditorOptions): MetadataEditor {
  const ed = new MetadataEditor(app, file, parent, opts);
  liveEditors.add(ed);
  ed.load();
  ed.register(() => liveEditors.delete(ed));
  ed.render(fm);
  return ed;
}

/** Request focus on a property (or a fresh "new property" row) of `path` for the next table that renders it. */
export function requestPropertyFocus(path: string, key: string | null, part: "key" | "value" = "value"): void {
  pendingFocus = { path, key, part };
}
export function takeNewRowRequest(path: string): boolean {
  if (pendingFocus?.path === path && pendingFocus.key === null) { pendingFocus = null; return true; }
  return false;
}
