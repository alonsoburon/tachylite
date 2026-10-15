// File explorer core view ("file-explorer"): the vault tree, built on the public API only.
import { Keymap, Menu, Notice, TFile, TFolder, setIcon, type App, type TAbstractFile, type WorkspaceLeaf } from "../../obsidian";
import { confirmDialog } from "../dialogs";
import { buildFileMenu, deleteWithPrompt, moveInto, newFolder, newNote, promptRename, renameTo } from "../files";
import { addCommand, openFile, PanelView, whileCoreEnabled, type CoreModule } from "./util";
import { collapseIcon, fileLabel, naturalCompare, navButton, navHeader } from "./panel";

export const EXPLORER_VIEW = "file-explorer";
export type SortOrder = "alphabetical" | "alphabeticalReverse" | "byModifiedTime" | "byModifiedTimeReverse" | "byCreatedTime" | "byCreatedTimeReverse";
const SORTS: [SortOrder, string][] = [
  ["alphabetical", "File name (A to Z)"], ["alphabeticalReverse", "File name (Z to A)"],
  ["byModifiedTime", "Modified time (new to old)"], ["byModifiedTimeReverse", "Modified time (old to new)"],
  ["byCreatedTime", "Created time (new to old)"], ["byCreatedTimeReverse", "Created time (old to new)"],
];
const SORT_KEY = "file-explorer-sort";

/** Compare two vault entries: folders first, then by the chosen order (ties fall back to the name). */
export function compareEntries(a: TAbstractFile, b: TAbstractFile, order: SortOrder): number {
  const af = a instanceof TFolder, bf = b instanceof TFolder;
  if (af !== bf) return af ? -1 : 1;
  const name = (x: TAbstractFile) => (x instanceof TFile ? fileLabel(x) : x.name);
  const byName = naturalCompare(name(a), name(b));
  if (af || order === "alphabetical") return byName;
  if (order === "alphabeticalReverse") return -byName;
  const key = order.startsWith("byModified") ? "mtime" : "ctime";
  const d = (b as TFile).stat[key] - (a as TFile).stat[key];
  const r = d || byName;
  return order.endsWith("Reverse") ? -r : r;
}

export class FileExplorerView extends PanelView {
  sortOrder: SortOrder = "alphabetical";
  /** Folder paths currently expanded (folders are collapsed by default, as in Obsidian). */
  expanded = new Set<string>();
  navEl!: HTMLElement;
  filesEl!: HTMLElement;
  collapseBtn!: HTMLElement;
  focusPath: string | null = null;
  activePath: string | null = null;
  private dragged: TAbstractFile | null = null;
  /** Multi-selection (Shift+click for a range, Ctrl/Cmd+click to toggle once one exists), by path, and the range anchor. */
  private selection = new Set<string>();
  private anchor: string | null = null;
  private renaming = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    const saved = this.app.loadLocalStorage(SORT_KEY);
    if (SORTS.some(([k]) => k === saved)) this.sortOrder = saved;
    this.navigation = false;
  }
  getViewType(): string { return EXPLORER_VIEW; }
  getDisplayText(): string { return "Files"; }
  getIcon(): string { return "lucide-folder-closed"; }

  getState(): Record<string, unknown> { return { sortOrder: this.sortOrder, expanded: [...this.expanded] }; }
  async setState(state: any): Promise<void> {
    if (state?.sortOrder && SORTS.some(([k]) => k === state.sortOrder)) this.sortOrder = state.sortOrder;
    if (Array.isArray(state?.expanded)) this.expanded = new Set(state.expanded.filter((p: unknown) => typeof p === "string"));
    if (this.filesEl) this.refresh();
  }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.addClass("nav-files-view");
    this.navEl = el.createDiv({ cls: "nav-files-wrapper" });
    const bar = navHeader(this.navEl);
    navButton(bar, "lucide-edit", "New note", () => { void newNote(this.app).catch((e) => new Notice(String(e.message ?? e))); });
    navButton(bar, "lucide-folder-plus", "New folder", () => { void newFolder(this.app).catch((e) => new Notice(String(e.message ?? e))); });
    navButton(bar, "lucide-arrow-up-narrow-wide", "Change sort order", (e) => this.sortMenu().showAtMouseEvent(e));
    this.collapseBtn = navButton(bar, "lucide-chevrons-down-up", "Collapse all", () => this.toggleCollapseAll());
    this.filesEl = this.navEl.createDiv({ cls: "nav-files-container node-insert-event", attr: { tabindex: "0" } });
    this.bindEvents();
    this.refresh();
    this.updateActive(true);
  }

  // ------------------------------------------------------------------ events
  private bindEvents(): void {
    const { vault, workspace } = this.app;
    for (const ev of ["create", "delete", "rename"] as const) this.registerEvent(vault.on(ev as any, () => this.requestRefresh(50)));
    this.registerEvent(vault.on("modify", () => { if (this.sortOrder.startsWith("byModified")) this.requestRefresh(250); }));
    this.registerEvent(workspace.on("config-changed" as any, () => this.requestRefresh(50)));
    this.registerEvent(workspace.on("file-open", () => this.updateActive()));
    this.registerEvent(workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => { if (leaf !== this.leaf) this.updateActive(); }));
    const c = this.filesEl;
    this.registerDomEvent(c, "click", (e) => this.onClick(e));
    this.registerDomEvent(c, "auxclick", (e) => { if (e.button === 1) this.onClick(e); });
    this.registerDomEvent(c, "contextmenu", (e) => this.onContext(e));
    this.registerDomEvent(c, "keydown", (e) => this.onKey(e));
    this.registerDomEvent(c, "dragstart", (e) => this.onDragStart(e));
    this.registerDomEvent(c, "dragover", (e) => this.onDragOver(e));
    this.registerDomEvent(c, "dragleave", (e) => this.onDragLeave(e));
    this.registerDomEvent(c, "drop", (e) => { void this.onDrop(e); });
    this.registerDomEvent(c, "dragend", () => this.clearDrag());
  }

  private pathOf(target: EventTarget | null): string | null {
    const el = (target as HTMLElement | null)?.closest?.("[data-path]") as HTMLElement | null;
    return el?.dataset.path ?? null;
  }
  private entry(path: string | null): TAbstractFile | null { return path ? this.app.vault.getAbstractFileByPath(path) : null; }

  private onClick(e: MouseEvent): void {
    if (this.renaming && (e.target as HTMLElement).closest(".is-being-renamed")) return;
    const f = this.entry(this.pathOf(e.target));
    if (!f) { this.clearSelection(); this.filesEl.focus(); return; }
    if (e.button === 0 && (e.shiftKey || (this.selection.size > 0 && Keymap.isModifier(e, "Mod")))) { this.extendSelection(f, e); return; }
    this.clearSelection();
    this.anchor = f.path;
    this.setFocus(f.path);
    if (f instanceof TFolder) this.toggleFolder(f);
    else if (f instanceof TFile) void openFile(this.app, f, e);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const f = this.entry(this.pathOf(e.target));
    if (f && this.selection.size > 1 && this.selection.has(f.path)) { this.selectionMenu().showAtMouseEvent(e); return; }
    if (f) { this.clearSelection(); this.setFocus(f.path); buildFileMenu(this.app, f, "file-explorer").showAtMouseEvent(e); return; }
    const root = this.app.vault.getRoot();
    const menu = new Menu()
      .addItem((i) => i.setSection("action").setTitle("New note").setIcon("lucide-edit").onClick(() => { void newNote(this.app, { folder: root }); }))
      .addItem((i) => i.setSection("action").setTitle("New folder").setIcon("lucide-folder-plus").onClick(() => { void newFolder(this.app, root); }));
    // Core and community plugins add their entries for the vault root too ("New canvas", ...).
    this.app.workspace.trigger("file-menu", menu, root, "file-explorer", this.leaf);
    menu.showAtMouseEvent(e);
  }

  // ------------------------------------------------------------------ multi-selection
  private selected(): TAbstractFile[] {
    return [...this.selection].map((p) => this.entry(p)).filter((x): x is TAbstractFile => !!x);
  }
  private applySelection(): void {
    for (const t of this.titles()) t.toggleClass("is-selected", this.selection.has(t.dataset.path ?? ""));
  }
  private clearSelection(): void {
    if (!this.selection.size) return;
    this.selection.clear();
    this.applySelection();
  }
  /** Shift+click selects the visible range from the anchor; Ctrl/Cmd+click toggles one entry. */
  private extendSelection(f: TAbstractFile, e: MouseEvent): void {
    const paths = this.titles().map((t) => t.dataset.path ?? "");
    if (e.shiftKey) {
      const a = paths.indexOf(this.anchor ?? this.focusPath ?? f.path), b = paths.indexOf(f.path);
      const [from, to] = a < 0 || b < 0 ? [Math.max(b, 0), Math.max(b, 0)] : [Math.min(a, b), Math.max(a, b)];
      this.selection = new Set(paths.slice(from, to + 1));
    } else {
      if (this.selection.has(f.path)) this.selection.delete(f.path); else this.selection.add(f.path);
      this.anchor = f.path;
    }
    this.setFocus(f.path);
    this.applySelection();
  }
  /** The menu for several selected entries: bulk actions, then whatever plugins add on `files-menu`. */
  private selectionMenu(): Menu {
    const files = this.selected();
    const menu = new Menu();
    const n = files.length;
    menu.addItem((i) => i.setSection("danger").setTitle(`Delete ${n} items`).setIcon("lucide-trash-2").setWarning(true).onClick(() => { void this.deleteSelected(); }));
    this.app.workspace.trigger("files-menu", menu, files, "file-explorer", this.leaf);
    return menu;
  }
  private async deleteSelected(): Promise<void> {
    // Entries inside a selected folder go with it, so only the top-most ones are deleted.
    const files = this.selected().filter((f) => !this.selected().some((o) => o !== f && o instanceof TFolder && f.path.startsWith(o.path + "/")));
    if (!files.length) return;
    if (this.app.vault.getConfig("promptDelete") !== false) {
      const ok = await confirmDialog(this.app, { title: "Delete items", message: `Are you sure you want to delete these ${files.length} items?`, cta: "Delete", warning: true });
      if (!ok) return;
    }
    for (const f of files) {
      try { await this.app.fileManager.trashFile(f); }
      catch (err) { new Notice(`Couldn't delete "${f.name}": ${(err as Error)?.message ?? err}`); }
    }
    this.clearSelection();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.renaming) return;
    const titles = this.titles();
    const idx = titles.findIndex((t) => t.dataset.path === this.focusPath);
    const cur = this.entry(this.focusPath);
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); this.setFocus(titles[Math.min(titles.length - 1, idx + 1)]?.dataset.path ?? null); break;
      case "ArrowUp": e.preventDefault(); this.setFocus(titles[Math.max(0, idx - 1)]?.dataset.path ?? null); break;
      case "ArrowRight": if (cur instanceof TFolder && !this.expanded.has(cur.path)) { e.preventDefault(); this.toggleFolder(cur); } break;
      case "ArrowLeft":
        if (cur instanceof TFolder && this.expanded.has(cur.path)) { e.preventDefault(); this.toggleFolder(cur); }
        else if (cur?.parent && !cur.parent.isRoot()) { e.preventDefault(); this.setFocus(cur.parent.path); }
        break;
      case "Enter": if (cur instanceof TFile) { e.preventDefault(); void openFile(this.app, cur, e); } else if (cur instanceof TFolder) { e.preventDefault(); this.toggleFolder(cur); } break;
      case "F2": if (cur) { e.preventDefault(); this.startRename(cur); } break;
      case "Escape": if (this.selection.size) { e.preventDefault(); this.clearSelection(); } break;
      case "Delete": case "Backspace":
        if (this.selection.size > 1 && (e.key === "Delete" || Keymap.isModifier(e, "Mod"))) { e.preventDefault(); void this.deleteSelected(); break; }
        if (cur && (e.key === "Delete" || Keymap.isModifier(e, "Mod"))) { e.preventDefault(); void deleteWithPrompt(this.app, cur).catch((err) => new Notice(String(err.message ?? err))); }
        break;
    }
  }

  // ------------------------------------------------------------------ rendering
  private titles(): HTMLElement[] { return Array.from(this.filesEl.querySelectorAll<HTMLElement>(".nav-folder-title, .nav-file-title")); }
  private titleFor(path: string): HTMLElement | null {
    return this.titles().find((t) => t.dataset.path === path) ?? null;
  }

  private setFocus(path: string | null): void {
    this.focusPath = path;
    for (const t of this.titles()) t.toggleClass("has-focus", t.dataset.path === path);
    if (path) this.titleFor(path)?.scrollIntoView?.({ block: "nearest" });
  }

  refresh(): void {
    if (!this.filesEl || this.renaming) return;
    const top = this.filesEl.scrollTop;
    this.filesEl.empty();
    this.renderChildren(this.app.vault.getRoot(), this.filesEl);
    this.filesEl.scrollTop = top;
    this.syncState();
    for (const p of [...this.selection]) if (!this.entry(p)) this.selection.delete(p);
    this.applySelection();
  }

  private visible(f: TAbstractFile): boolean {
    if (f instanceof TFolder) return true;
    const ext = (f as TFile).extension;
    return !!this.app.viewRegistry.getTypeByExtension(ext) || !!this.app.vault.getConfig("showUnsupportedFiles");
  }

  private renderChildren(folder: TFolder, into: HTMLElement): void {
    const kids = folder.children.filter((c) => this.visible(c)).sort((a, b) => compareEntries(a, b, this.sortOrder));
    for (const c of kids) c instanceof TFolder ? this.renderFolder(c, into) : this.renderFile(c as TFile, into);
  }

  private renderFolder(folder: TFolder, into: HTMLElement): void {
    const open = this.expanded.has(folder.path);
    const item = into.createDiv({ cls: "tree-item nav-folder" + (open ? "" : " is-collapsed") });
    const title = item.createDiv({ cls: "tree-item-self nav-folder-title is-clickable mod-collapsible" + (open ? "" : " is-collapsed"), attr: { "data-path": folder.path, draggable: "true" } });
    collapseIcon(title);
    title.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: folder.name });
    if (this.focusPath === folder.path) title.addClass("has-focus");
    if (open) this.renderChildren(folder, item.createDiv({ cls: "tree-item-children nav-folder-children" }));
  }

  private renderFile(file: TFile, into: HTMLElement): void {
    const item = into.createDiv({ cls: "tree-item nav-file" });
    const title = item.createDiv({ cls: "tree-item-self nav-file-title is-clickable tappable", attr: { "data-path": file.path, draggable: "true" } });
    title.createDiv({ cls: "tree-item-inner nav-file-title-content", text: fileLabel(file) });
    if (file.extension !== "md") title.createDiv({ cls: "nav-file-tag", text: file.extension });
    if (file.path === this.activePath) title.addClass("is-active");
    if (this.focusPath === file.path) title.addClass("has-focus");
  }

  private syncState(): void {
    const any = this.expanded.size > 0;
    setIcon(this.collapseBtn, any ? "lucide-chevrons-down-up" : "lucide-chevrons-up-down");
    this.collapseBtn.setAttribute("aria-label", any ? "Collapse all" : "Expand all");
  }

  // ------------------------------------------------------------------ expand / collapse / reveal
  toggleFolder(folder: TFolder): void {
    if (this.expanded.has(folder.path)) {
      this.expanded.delete(folder.path);
    } else this.expanded.add(folder.path);
    this.refresh();
    this.app.workspace.requestSaveLayout();
  }

  toggleCollapseAll(): void {
    if (this.expanded.size) this.expanded.clear();
    else for (const f of this.app.vault.getAllFolders()) this.expanded.add(f.path);
    this.refresh();
    this.app.workspace.requestSaveLayout();
  }

  /** Expand every ancestor of `file`, mark it and scroll it into view (called by "Reveal file in navigation"). */
  reveal(file: TAbstractFile): void {
    if (!this.filesEl || !file) return;
    for (let p = file.parent; p && !p.isRoot(); p = p.parent) this.expanded.add(p.path);
    this.refresh();
    this.setFocus(file.path);
    this.titleFor(file.path)?.scrollIntoView?.({ block: "center" });
  }

  /** Follow the active file: mark it and (autoReveal) open its ancestors. */
  private updateActive(force = false): void {
    const f = this.app.workspace.getActiveFile();
    const path = f?.path ?? null;
    if (!force && path === this.activePath) return;
    this.activePath = path;
    if (f && this.app.vault.getConfig("autoReveal") !== false) {
      const hidden = [] as string[];
      for (let p = f.parent; p && !p.isRoot(); p = p.parent) if (!this.expanded.has(p.path)) hidden.push(p.path);
      if (hidden.length || !this.titleFor(f.path)) this.reveal(f);
    }
    for (const t of this.titles()) t.toggleClass("is-active", t.dataset.path === path);
    if (path && this.app.vault.getConfig("autoReveal") !== false) this.titleFor(path)?.scrollIntoView?.({ block: "nearest" });
  }

  // ------------------------------------------------------------------ sort
  setSortOrder(order: SortOrder): void {
    this.sortOrder = order;
    this.app.saveLocalStorage(SORT_KEY, order);
    this.refresh();
    this.app.workspace.requestSaveLayout();
  }
  sortMenu(): Menu {
    const m = new Menu();
    SORTS.forEach(([k, label], i) => m.addItem((it) => it.setTitle(label).setChecked(this.sortOrder === k).setSection(i < 2 ? "a" : i < 4 ? "b" : "c").onClick(() => this.setSortOrder(k))));
    return m;
  }

  // ------------------------------------------------------------------ inline rename
  startRename(file: TAbstractFile): void {
    const title = this.titleFor(file.path);
    const content = title?.querySelector<HTMLElement>(".tree-item-inner");
    if (!title || !content || this.renaming) { void promptRename(this.app, file); return; }
    this.renaming = true;
    const original = file instanceof TFile ? file.basename : file.name;
    title.addClass("is-being-renamed");
    title.draggable = false;
    content.contentEditable = "true";
    content.textContent = original;
    content.focus();
    const sel = content.ownerDocument.getSelection?.();
    if (sel) { const r = content.ownerDocument.createRange(); r.selectNodeContents(content); sel.removeAllRanges(); sel.addRange(r); }
    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      const value = (content.textContent ?? "").trim();
      this.renaming = false;
      content.contentEditable = "false";
      if (commit && value && value !== original) {
        try { await renameTo(this.app, file, value); } catch (e) { new Notice((e as Error).message); }
      }
      this.refresh();
      this.filesEl.focus();
    };
    content.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); void finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); void finish(false); }
    });
    content.addEventListener("blur", () => { void finish(true); });
  }

  // ------------------------------------------------------------------ drag and drop
  private onDragStart(e: DragEvent): void {
    const f = this.entry(this.pathOf(e.target));
    if (!f) return;
    this.dragged = f;
    e.dataTransfer?.setData("text/plain", f.path);
    e.dataTransfer?.setData("application/x-tachylite-vault-path", f.path); // lets an editor turn the drop into a link
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    (e.target as HTMLElement).closest(".tree-item-self")?.addClass("is-being-dragged");
  }
  /** Folder a drop on `target` lands in: the folder itself, a file's parent, or the vault root. */
  private dropFolder(target: EventTarget | null): TFolder {
    const f = this.entry(this.pathOf(target));
    return f instanceof TFolder ? f : f?.parent ?? this.app.vault.getRoot();
  }
  private onDragOver(e: DragEvent): void {
    if (!this.dragged) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    this.clearOver();
    const dest = this.dropFolder(e.target);
    if (!dest.isRoot()) this.titleFor(dest.path)?.addClass("is-being-dragged-over");
    else this.filesEl.addClass("is-being-dragged-over");
  }
  private onDragLeave(e: DragEvent): void { if (!this.filesEl.contains(e.relatedTarget as Node | null)) this.clearOver(); }
  private clearOver(): void {
    this.filesEl.removeClass("is-being-dragged-over");
    this.filesEl.querySelectorAll(".is-being-dragged-over").forEach((el) => el.removeClass("is-being-dragged-over"));
  }
  private clearDrag(): void {
    this.dragged = null;
    this.clearOver();
    this.filesEl.querySelectorAll(".is-being-dragged").forEach((el) => el.removeClass("is-being-dragged"));
  }
  private async onDrop(e: DragEvent): Promise<void> {
    const src = this.dragged;
    if (!src) return;
    e.preventDefault();
    const dest = this.dropFolder(e.target);
    this.clearDrag();
    try { await this.moveEntry(src, dest); } catch (err) { new Notice((err as Error).message); }
  }
  /** Move `file` into `folder` (the drop action; exposed for tests and other callers). */
  async moveEntry(file: TAbstractFile, folder: TFolder): Promise<void> {
    await moveInto(this.app, file, folder);
  }
}

export const explorer: CoreModule = {
  id: "file-explorer",
  install(app: App) {
    app.viewRegistry.registerView(EXPLORER_VIEW, (leaf) => new FileExplorerView(leaf));
    const stop = whileCoreEnabled(app, "file-explorer", () => {
      const offs = [
        addCommand(app, { id: "file-explorer:open", name: "Files: Show file explorer", icon: "lucide-folder-closed", callback: () => { void app.workspace.ensureSideLeaf(EXPLORER_VIEW, "left", { active: true, reveal: true }); } }),
        addCommand(app, { id: "file-explorer:new-file", name: "Create new note", icon: "lucide-edit", hotkeys: [{ modifiers: ["Mod"], key: "n" }], callback: () => { void newNote(app).catch((e) => new Notice(String(e.message ?? e))); } }),
        addCommand(app, { id: "file-explorer:new-folder", name: "Create new folder", icon: "lucide-folder-plus", callback: () => { void newFolder(app).catch((e) => new Notice(String(e.message ?? e))); } }),
        addCommand(app, {
          id: "file-explorer:reveal-active-file", name: "Files: Reveal current file in navigation", icon: "lucide-folder-search",
          checkCallback: (checking) => {
            const f = app.workspace.getActiveFile();
            if (!f) return false;
            if (!checking) void app.workspace.ensureSideLeaf(EXPLORER_VIEW, "left", { reveal: true, active: false }).then((l) => (l.view as FileExplorerView).reveal(f));
            return true;
          },
        }),
      ];
      return () => { offs.forEach((o) => o()); app.workspace.detachLeavesOfType(EXPLORER_VIEW); };
    });
    return () => { stop(); app.viewRegistry.unregisterView(EXPLORER_VIEW); };
  },
};
