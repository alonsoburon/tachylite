// Bookmarks core view ("bookmarks"): items persisted to .obsidian/bookmarks.json in Obsidian's format.
import moment from "moment";
import { Events, FileView, Menu, Notice, TFile, TFolder, WorkspaceWindow, type App, type TAbstractFile, type WorkspaceLeaf } from "../../obsidian";
import { ipc } from "../../ipc";
import { promptText } from "../dialogs";
import { revealInExplorer } from "../files";
import { activateView, addCommand, openFile, PanelView, whileCoreEnabled, type CoreModule } from "./util";
import { collapseIcon, navButton, navHeader } from "./panel";
import { SearchView } from "./search";
import { setIcon } from "../../obsidian";

export const BOOKMARKS_VIEW = "bookmarks";
const FILE = "bookmarks.json";

export interface BookmarkItem {
  type: "file" | "folder" | "search" | "group" | string;
  title?: string; path?: string; subpath?: string; query?: string; items?: BookmarkItem[];
  [k: string]: unknown;
}

/** In-memory model + persistence; lives on `app.internalPlugins.getPluginById("bookmarks").instance`. */
export class BookmarksStore extends Events {
  id = "bookmarks";
  name = "Bookmarks";
  options: Record<string, any> = {};
  items: BookmarkItem[] = [];
  ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private app: App) {
    super();
    this.ready = this.load();
  }

  async load(): Promise<void> {
    try {
      const raw = await ipc.configRead(FILE);
      this.items = Array.isArray(raw?.items) ? raw.items.filter((i: unknown) => i && typeof i === "object") : [];
    } catch (e) { console.warn("bookmarks.json unreadable", e); this.items = []; }
    this.trigger("changed");
  }

  /** Persist now (writes are serialized); resolves when the file is written. */
  save(): Promise<void> {
    const p = this.chain.then(() => ipc.configWrite(FILE, { items: this.items })).catch((e) => { console.error("bookmarks save failed", e); });
    this.chain = p;
    return p as Promise<void>;
  }
  private changed(): void { this.trigger("changed"); void this.save(); }

  /** Depth-first walk over every item, with the list that contains it. */
  walk(cb: (item: BookmarkItem, list: BookmarkItem[]) => void, list: BookmarkItem[] = this.items): void {
    for (const it of list.slice()) { cb(it, list); if (it.type === "group" && it.items) this.walk(cb, it.items); }
  }
  findItem(pred: (i: BookmarkItem) => boolean): BookmarkItem | null {
    let hit: BookmarkItem | null = null;
    this.walk((i) => { if (!hit && pred(i)) hit = i; });
    return hit;
  }
  parentList(item: BookmarkItem): BookmarkItem[] | null {
    let found: BookmarkItem[] | null = null;
    this.walk((i, l) => { if (i === item) found = l; });
    return found;
  }

  addItem(item: BookmarkItem, parent?: BookmarkItem | null): BookmarkItem {
    const list = parent && parent.type === "group" ? (parent.items ??= []) : this.items;
    list.push(item);
    this.changed();
    return item;
  }
  removeItem(item: BookmarkItem): void {
    const l = this.parentList(item);
    if (!l) return;
    l.splice(l.indexOf(item), 1);
    this.changed();
  }
  /** Re-order `item` relative to `target` (or into a group). */
  moveItem(item: BookmarkItem, target: BookmarkItem, where: "before" | "after" | "into"): void {
    if (item === target) return;
    if (item.type === "group") { let inside = false; this.walk((i) => { if (i === target) inside = true; }, item.items ?? []); if (inside) return; }
    const from = this.parentList(item);
    if (!from) return;
    from.splice(from.indexOf(item), 1);
    if (where === "into" && target.type === "group") (target.items ??= []).push(item);
    else {
      const to = this.parentList(target) ?? this.items;
      to.splice(to.indexOf(target) + (where === "after" ? 1 : 0), 0, item);
    }
    this.changed();
  }
  /** Shift an item by `delta` positions inside its own list. */
  shift(item: BookmarkItem, delta: number): void {
    const l = this.parentList(item);
    if (!l) return;
    const i = l.indexOf(item), j = i + delta;
    if (j < 0 || j >= l.length) return;
    l.splice(i, 1); l.splice(j, 0, item);
    this.changed();
  }
  setTitle(item: BookmarkItem, title: string): void { item.title = title; this.changed(); }
  newGroup(title: string, parent?: BookmarkItem | null): BookmarkItem { return this.addItem({ type: "group", title, items: [] }, parent); }

  findFileItem(file: TAbstractFile, subpath?: string): BookmarkItem | null {
    const type = file instanceof TFolder ? "folder" : "file";
    return this.findItem((i) => i.type === type && i.path === file.path && (i.subpath ?? "") === (subpath ?? ""));
  }
  isBookmarked(file: TAbstractFile, subpath?: string): boolean { return !!this.findFileItem(file, subpath); }
  bookmarkFile(file: TAbstractFile, subpath?: string, parent?: BookmarkItem | null): BookmarkItem {
    const hit = this.findFileItem(file, subpath);
    if (hit) return hit;
    const item: BookmarkItem = file instanceof TFolder ? { type: "folder", path: file.path } : { type: "file", title: "", path: file.path };
    if (subpath) item.subpath = subpath;
    return this.addItem(item, parent);
  }
  /** Add the bookmark, or remove it when it already exists. Returns true when it is now bookmarked. */
  toggleFile(file: TAbstractFile, subpath?: string): boolean {
    const hit = this.findFileItem(file, subpath);
    if (hit) { this.removeItem(hit); return false; }
    this.bookmarkFile(file, subpath);
    return true;
  }

  // vault synchronisation
  onRename(file: TAbstractFile, oldPath: string): void {
    let touched = false;
    this.walk((i) => { if ((i.type === "file" || i.type === "folder") && i.path === oldPath) { i.path = file.path; touched = true; } });
    if (touched) this.changed();
  }
  onDelete(file: TAbstractFile): void {
    const gone: BookmarkItem[] = [];
    this.walk((i) => { if ((i.type === "file" || i.type === "folder") && i.path === file.path) gone.push(i); });
    for (const g of gone) { const l = this.parentList(g); l?.splice(l.indexOf(g), 1); }
    if (gone.length) this.changed();
  }
}

function labelOf(i: BookmarkItem): string {
  if (i.title) return i.title;
  if (i.type === "file" && i.path) { const n = i.path.slice(i.path.lastIndexOf("/") + 1).replace(/\.md$/, ""); return i.subpath ? `${n} > ${i.subpath.replace(/^#/, "")}` : n; }
  if (i.type === "folder" && i.path) return i.path.slice(i.path.lastIndexOf("/") + 1) || i.path;
  if (i.type === "search") return String(i.query ?? "");
  return i.path ?? i.type;
}
const ICONS: Record<string, string> = { file: "lucide-file", folder: "lucide-folder", search: "lucide-search", graph: "lucide-git-fork" };

export function getStore(app: App): BookmarksStore | null {
  const inst = app.internalPlugins.getPluginById("bookmarks")?.instance as unknown;
  return inst instanceof BookmarksStore ? inst : null;
}

export class BookmarksView extends PanelView {
  private bodyEl!: HTMLElement;
  private collapsed = new Set<string>();
  private dragged: BookmarkItem | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  get store(): BookmarksStore | null { return getStore(this.app); }
  getViewType(): string { return BOOKMARKS_VIEW; }
  getDisplayText(): string { return "Bookmarks"; }
  getIcon(): string { return "lucide-bookmark"; }
  getState(): Record<string, unknown> { return { collapsedGroups: [...this.collapsed] }; }
  async setState(s: any): Promise<void> {
    if (Array.isArray(s?.collapsedGroups)) this.collapsed = new Set(s.collapsedGroups.filter((x: unknown) => typeof x === "string"));
    if (this.bodyEl) this.refresh();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("bookmarks-view");
    const bar = navHeader(this.contentEl);
    navButton(bar, "lucide-bookmark-plus", "Bookmark active file", () => this.bookmarkActive());
    navButton(bar, "lucide-folder-plus", "New group", () => { void this.newGroup(); });
    this.bodyEl = this.contentEl.createDiv({ cls: "bookmarks-container" });
    const st = this.store;
    if (st) this.registerEvent(st.on("changed", () => this.requestRefresh(10)));
    this.registerDomEvent(this.bodyEl, "dragover", (e) => { if (this.dragged && e.target === this.bodyEl) e.preventDefault(); });
    this.registerDomEvent(this.bodyEl, "drop", (e) => {
      if (!this.dragged || e.target !== this.bodyEl) return;
      e.preventDefault();
      const last = st?.items[st.items.length - 1];
      if (last && last !== this.dragged) st!.moveItem(this.dragged, last, "after");
      this.dragged = null;
    });
    this.refresh();
    void st?.ready.then(() => this.refresh());
  }

  bookmarkActive(): void {
    const f = this.app.workspace.getActiveFile();
    if (!f) { new Notice("No active file to bookmark."); return; }
    this.store?.bookmarkFile(f);
  }
  async newGroup(parent?: BookmarkItem): Promise<void> {
    const name = await promptText(this.app, { title: "New group", placeholder: "Group name", cta: "Create", validate: (v) => (v ? null : "Name cannot be empty.") });
    if (name) this.store?.newGroup(name, parent);
  }

  refresh(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const items = this.store?.items ?? [];
    if (!items.length) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No bookmarks yet. Right-click a file and choose Bookmark." }); return; }
    this.renderList(items, this.bodyEl, "");
  }

  private renderList(items: BookmarkItem[], into: HTMLElement, prefix: string): void {
    for (const it of items) {
      const isGroup = it.type === "group";
      const key = prefix + labelOf(it);
      const open = !this.collapsed.has(key);
      const node = into.createDiv({ cls: `tree-item bookmark-item mod-${it.type}` + (isGroup && !open ? " is-collapsed" : "") });
      const self = node.createDiv({ cls: "tree-item-self bookmark is-clickable" + (isGroup ? " mod-collapsible" : ""), attr: { draggable: "true", "data-type": it.type } });
      if (isGroup) collapseIcon(self);
      else if (ICONS[it.type]) setIcon(self.createDiv({ cls: "tree-item-icon" }), ICONS[it.type]);
      self.createDiv({ cls: "tree-item-inner", text: labelOf(it) });
      self.addEventListener("click", (e) => this.activate(it, key, e));
      self.addEventListener("auxclick", (e) => { if (e.button === 1 && !isGroup) this.activate(it, key, e); });
      self.addEventListener("contextmenu", (e) => { e.preventDefault(); this.menu(it).showAtMouseEvent(e); });
      self.addEventListener("dragstart", (e) => { this.dragged = it; e.dataTransfer?.setData("text/plain", labelOf(it)); });
      self.addEventListener("dragend", () => { this.dragged = null; });
      self.addEventListener("dragover", (e) => { if (this.dragged && this.dragged !== it) { e.preventDefault(); e.stopPropagation(); } });
      self.addEventListener("drop", (e) => {
        const d = this.dragged;
        if (!d) return;
        e.preventDefault(); e.stopPropagation();
        this.dragged = null;
        const r = self.getBoundingClientRect();
        const y = e.clientY - r.top;
        const where = isGroup && (r.height === 0 || (y > r.height * 0.25 && y < r.height * 0.75)) ? "into" : r.height && y > r.height / 2 ? "after" : "before";
        this.store?.moveItem(d, it, where);
      });
      if (isGroup && open) this.renderList(it.items ?? [], node.createDiv({ cls: "tree-item-children" }), key + "/");
    }
  }

  private activate(it: BookmarkItem, key: string, e: MouseEvent): void {
    const app = this.app;
    if (it.type === "group") {
      if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
      this.app.workspace.requestSaveLayout();
      this.refresh();
    } else if (it.type === "file") {
      const f = it.path ? app.vault.getFileByPath(it.path) : null;
      if (!f) { new Notice(`File not found: ${it.path}`); return; }
      void openFile(app, f, e, it.subpath ? { subpath: it.subpath } : undefined);
    } else if (it.type === "folder") {
      const f = it.path ? app.vault.getFolderByPath(it.path) : null;
      if (f) revealInExplorer(app, f); else new Notice(`Folder not found: ${it.path}`);
    } else if (it.type === "search") {
      void activateView(app, "search", "left").then((l) => (l.view as any).setQuery?.(it.query ?? ""));
    }
  }

  menu(it: BookmarkItem): Menu {
    const m = new Menu();
    const st = this.store!;
    const file = it.type === "file" && it.path ? this.app.vault.getFileByPath(it.path) : null;
    if (file) {
      m.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => { void this.app.workspace.getLeaf("tab").openFile(file, { active: true, eState: it.subpath ? { subpath: it.subpath } : undefined }); }));
      m.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => { void this.app.workspace.getLeaf("split").openFile(file, { active: true }); }));
    }
    if (it.type === "group") m.addItem((i) => i.setSection("action").setTitle("New group").setIcon("lucide-folder-plus").onClick(() => { void this.newGroup(it); }));
    m.addItem((i) => i.setSection("action").setTitle("Rename...").setIcon("lucide-pencil").onClick(async () => {
      const v = await promptText(this.app, { title: "Rename bookmark", value: labelOf(it), cta: "Rename" });
      if (v !== null) st.setTitle(it, v);
    }));
    m.addItem((i) => i.setSection("move").setTitle("Move up").setIcon("lucide-arrow-up").onClick(() => st.shift(it, -1)));
    m.addItem((i) => i.setSection("move").setTitle("Move down").setIcon("lucide-arrow-down").onClick(() => st.shift(it, 1)));
    m.addItem((i) => i.setSection("danger").setTitle("Remove").setIcon("lucide-trash-2").setWarning(true).onClick(() => st.removeItem(it)));
    return m;
  }
}

export const bookmarks: CoreModule = {
  id: "bookmarks",
  install(app: App) {
    app.viewRegistry.registerView(BOOKMARKS_VIEW, (leaf) => new BookmarksView(leaf));
    const wrapper = app.internalPlugins.getPluginById("bookmarks");
    const prev = wrapper?.instance;
    const store = new BookmarksStore(app);
    if (wrapper) { store.options = (prev as any)?.options ?? {}; wrapper.instance = store as any; }
    const subs = [
      app.vault.on("rename", (f: TAbstractFile, old: string) => store.onRename(f, old)),
      app.vault.on("delete", (f: TAbstractFile) => store.onDelete(f)),
    ];
    const stop = whileCoreEnabled(app, "bookmarks", () => {
      const ref = app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile || file instanceof TFolder)) return;
        const on = store.isBookmarked(file);
        menu.addItem((i) => i.setSection("action").setTitle(on ? "Remove bookmark" : "Bookmark").setIcon(on ? "lucide-bookmark-minus" : "lucide-bookmark").onClick(() => { store.toggleFile(file); }));
      });
      const offs = [
        addCommand(app, { id: "bookmarks:open", name: "Bookmarks: Show bookmarks", icon: "lucide-bookmark", callback: () => { void activateView(app, BOOKMARKS_VIEW, "left"); } }),
        addCommand(app, {
          id: "bookmarks:bookmark-current-view", name: "Bookmarks: Bookmark current file", icon: "lucide-bookmark-plus",
          checkCallback: (checking) => {
            const f = app.workspace.getActiveFile();
            if (!f) return false;
            if (!checking) store.toggleFile(f);
            return true;
          },
        }),
        addCommand(app, {
          id: "bookmarks:bookmark-all-tabs", name: "Bookmarks: Bookmark all tabs", icon: "lucide-bookmarks",
          checkCallback: (checking) => {
            // The files open in the main area (and popouts), once each, in tab order.
            const files: TFile[] = [];
            app.workspace.iterateAllLeaves((l) => {
              const r = l.getRoot();
              const f = l.view instanceof FileView ? l.view.file : null;
              if (f && (r === app.workspace.rootSplit || r instanceof WorkspaceWindow) && !files.includes(f)) files.push(f);
            });
            if (!files.length) return false;
            if (!checking) {
              const group = store.newGroup(moment().format("YYYY-MM-DD HH:mm"));
              for (const f of files) store.addItem({ type: "file", title: "", path: f.path }, group);
            }
            return true;
          },
        }),
        addCommand(app, {
          id: "bookmarks:bookmark-current-search", name: "Bookmarks: Bookmark current search", icon: "lucide-bookmark-plus",
          checkCallback: (checking) => {
            const v = app.workspace.getActiveViewOfType(SearchView);
            const query = v?.query.trim();
            if (!query) return false;
            if (!checking && !store.findItem((i) => i.type === "search" && i.query === query)) store.addItem({ type: "search", title: "", query });
            return true;
          },
        }),
      ];
      return () => { app.workspace.offref(ref); offs.forEach((o) => o()); app.workspace.detachLeavesOfType(BOOKMARKS_VIEW); };
    });
    return () => {
      stop();
      for (const s of subs) app.vault.offref(s);
      app.viewRegistry.unregisterView(BOOKMARKS_VIEW);
      if (wrapper && prev) wrapper.instance = prev;
    };
  },
};
