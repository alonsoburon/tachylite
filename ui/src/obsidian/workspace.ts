// Workspace layout model, decoupled from any shell. The model owns a plain DOM skeleton
// (workspace-split / workspace-tabs / workspace-leaf) that a shell may mount, and calls
// optional LayoutHost hooks for everything that is the shell's business.
import { Component, Events } from "./events";
import { TFile } from "./files";
import { debounce, getLinkpath, parseLinktext, type Debouncer } from "./util";
import { setIcon } from "./icons";
import { notifyWindowMigrated, setActiveWindow } from "./dom";
import { Menu, Notice } from "./ui";
import { DeferredView, EmptyView, FileView, MarkdownView, View, type ViewCreator } from "./views";
import type { App } from "./app";
import type { EditorSuggestManager } from "./editorSuggest";

export type SplitDirection = "vertical" | "horizontal";
export type PaneType = "tab" | "split" | "window";
export type Side = "primary" | "secondary" | "left" | "right";

/** Hooks the shell implements. All optional. */
export interface LayoutHost {
  /** The layout tree changed (leaf added/removed/moved, tab selected). */
  onLayoutChange?(): void;
  /** A leaf should become visible (select its tab, expand the dock, focus the window). */
  revealLeaf?(leaf: WorkspaceLeaf): void;
  onActiveLeafChange?(leaf: WorkspaceLeaf | null): void;
  /** A view finished opening in a leaf (mount `leaf.containerEl` if not already mounted). */
  onViewOpened?(leaf: WorkspaceLeaf, view: View): void;
  onViewClosed?(leaf: WorkspaceLeaf, view: View): void;
  onSidedockToggle?(side: "left" | "right", collapsed: boolean): void;
  /** Persist the layout (debounced). */
  saveLayout?(layout: Record<string, unknown>): void | Promise<void>;
  /** Open the OS window of a popout and mount `win.containerEl` in it; return its Window, or nothing to keep it detached. */
  openPopout?(win: WorkspaceWindow, data?: WorkspaceWindowInitData): Window | void;
  /** The popout was closed by the model (its leaves are detached already): tear the OS window down. */
  closePopout?(win: WorkspaceWindow): void;
  /** Bring a popout (or the main window, `null`) to the front. */
  focusWindow?(win: WorkspaceWindow | null): void;
}

/** Options for creating a popout window (obsidian.d.ts); `width`/`height` are also accepted, as workspace.json stores them. */
export interface WorkspaceWindowInitData { x?: number; y?: number; size?: { width: number; height: number }; width?: number; height?: number; maximize?: boolean }

export interface OpenViewState { state?: Record<string, unknown>; eState?: Record<string, unknown>; active?: boolean; group?: WorkspaceLeaf }
export interface ViewState { type: string; state?: Record<string, unknown>; active?: boolean; pinned?: boolean; group?: WorkspaceLeaf }

function rid(): string { return Math.random().toString(16).slice(2, 18).padEnd(16, "0"); }

export abstract class WorkspaceItem extends Events {
  abstract parent: WorkspaceParent | null;
  containerEl: HTMLElement;
  /** Relative size inside the parent split (flex-grow); persisted as `size` like Obsidian's workspace.json. */
  size: number | null = null;
  constructor(public app: App, cls: string) {
    super();
    this.containerEl = createDiv({ cls });
  }
  /** The top of this item's tree: the root split, a sidedock or a popout window. */
  getRoot(): WorkspaceItem {
    let n: WorkspaceItem = this;
    while (n.parent && !(n instanceof WorkspaceContainer)) n = n.parent;
    return n;
  }
  /** The window container this item lives in (sidebars belong to the main window's root). */
  getContainer(): WorkspaceContainer {
    const r = this.getRoot();
    if (r instanceof WorkspaceContainer) return r;
    return this.app.workspace.rootSplit;
  }
}

export abstract class WorkspaceParent extends WorkspaceItem {
  parent: WorkspaceParent | null = null;
  children: WorkspaceItem[] = [];
  protected childHost(): HTMLElement { return this.containerEl; }
  insertChild(index: number, child: WorkspaceItem): void {
    child.parent = this;
    this.children.splice(index, 0, child);
    const host = this.childHost();
    const before = host.children[index] ?? null;
    const doc = child.containerEl.ownerDocument;
    host.insertBefore(child.containerEl, before);
    // Moved into another window (popout <-> main): editors re-root, `onWindowMigrated` listeners fire.
    if (child.containerEl.ownerDocument !== doc) notifyWindowMigrated(child.containerEl);
  }
  removeChild(child: WorkspaceItem): void {
    const i = this.children.indexOf(child);
    if (i < 0) return;
    this.children.splice(i, 1);
    child.parent = null;
    child.containerEl.detach();
    this.onChildRemoved(child);
  }
  protected onChildRemoved(_child: WorkspaceItem): void {}
  /** Depth-first leaves under this node. */
  leaves(): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    const walk = (n: WorkspaceItem) => {
      if (n instanceof WorkspaceLeaf) out.push(n);
      else if (n instanceof WorkspaceParent) n.children.forEach(walk);
    };
    this.children.forEach(walk);
    return out;
  }
}

export class WorkspaceTabs extends WorkspaceParent {
  declare parent: WorkspaceSplit;
  currentTab = 0;
  /** Stacked mode: panes slide over each other, each with a vertical title strip (`mod-stacked`, `stacked: true` in workspace.json). */
  isStacked = false;
  tabHeaderContainerEl: HTMLElement;
  tabContainerEl: HTMLElement;
  constructor(app: App) {
    super(app, "workspace-tabs");
    this.tabHeaderContainerEl = this.containerEl.createDiv({ cls: "workspace-tab-header-container" }).createDiv({ cls: "workspace-tab-header-container-inner" });
    this.tabContainerEl = this.containerEl.createDiv({ cls: "workspace-tab-container" });
  }
  protected childHost(): HTMLElement { return this.tabContainerEl; }
  insertChild(index: number, child: WorkspaceItem): void {
    super.insertChild(index, child);
    if (child instanceof WorkspaceLeaf && !this.isStacked) {
      this.tabHeaderContainerEl.insertBefore(child.tabHeaderEl, this.tabHeaderContainerEl.children[index] ?? null);
    }
  }
  setStacked(stacked: boolean): void {
    if (this.isStacked === stacked) return;
    this.isStacked = stacked;
    this.containerEl.toggleClass("mod-stacked", stacked);
    if (!stacked) {
      // headers go back to the tab bar, panes lose their stacked geometry
      for (const c of this.children as WorkspaceLeaf[]) {
        this.tabHeaderContainerEl.appendChild(c.tabHeaderEl);
        c.tabHeaderEl.style.left = c.tabHeaderEl.style.right = "";
        c.containerEl.style.left = c.containerEl.style.minWidth = c.containerEl.style.maxWidth = "";
      }
    }
    this.refreshTabs();
    this.app.workspace.requestSaveLayout?.();
    this.app.workspace.trigger("layout-change");
  }
  toggleStacked(): void { this.setStacked(!this.isStacked); }
  protected onChildRemoved(child: WorkspaceItem): void {
    if (child instanceof WorkspaceLeaf) child.tabHeaderEl.detach();
    if (this.currentTab >= this.children.length) this.currentTab = Math.max(0, this.children.length - 1);
    this.refreshTabs();
    // An emptied tab group disappears from its split (the root split re-creates one when no leaf is left).
    if (this.children.length === 0 && this.parent) this.parent.removeChild(this);
  }
  selectTab(leaf: WorkspaceLeaf): void {
    const i = this.children.indexOf(leaf);
    if (i < 0) return;
    this.currentTab = i;
    this.refreshTabs();
  }
  private layoutStacked(): void {
    const n = this.children.length, strip = 40;
    this.children.forEach((c, i) => {
      const leaf = c as WorkspaceLeaf, on = i === this.currentTab;
      // each pane is preceded by its own header strip, in tab order
      this.tabContainerEl.appendChild(leaf.tabHeaderEl);
      this.tabContainerEl.appendChild(leaf.containerEl);
      leaf.tabHeaderEl.style.left = `${i * strip}px`;
      leaf.tabHeaderEl.style.right = `${(n - 1 - i) * strip}px`;
      leaf.tabHeaderEl.toggleClass("is-active", on);
      leaf.containerEl.style.display = "";
      leaf.containerEl.removeClass("mod-hidden");
      leaf.containerEl.style.left = `${(i + 1) * strip}px`;
      leaf.containerEl.style.minWidth = "300px";
      leaf.containerEl.style.maxWidth = "600px";
    });
  }
  refreshTabs(): void {
    if (this.isStacked) { this.layoutStacked(); return; }
    this.children.forEach((c, i) => {
      const on = i === this.currentTab;
      c.containerEl.toggleClass("mod-hidden", !on);
      c.containerEl.style.display = on ? "" : "none";
      (c as WorkspaceLeaf).tabHeaderEl?.toggleClass("is-active", on);
    });
  }
}

export class WorkspaceSplit extends WorkspaceParent {
  direction: SplitDirection;
  constructor(app: App, direction: SplitDirection = "vertical", cls = "") {
    super(app, `workspace-split mod-${direction}${cls ? " " + cls : ""}`);
    this.direction = direction;
  }
  protected onChildRemoved(): void { this.prune(); }
  /** Remove empty tab groups / collapse single-child splits. */
  prune(): void {
    for (const c of this.children.slice()) {
      if (c instanceof WorkspaceParent && !(c instanceof WorkspaceSidedock) && c.children.length === 0) this.removeChild(c);
    }
    // A nested split with one child is redundant: hoist the child into this split.
    for (const c of this.children.slice()) {
      if (c instanceof WorkspaceSplit && !(c instanceof WorkspaceSidedock) && c.children.length === 1) {
        const only = c.children[0];
        const idx = this.children.indexOf(c);
        const size = c.size;
        c.children.splice(0, 1);
        only.parent = null;
        this.removeChild(c);
        this.insertChild(idx, only);
        if (size !== null) only.size = size;
      }
    }
  }
}

export abstract class WorkspaceContainer extends WorkspaceSplit {
  win: Window = window;
  doc: Document = document;
  /** Lives as long as the window; plugins hang per-window components on it. */
  component: Component = new Component();
  constructor(app: App, direction: SplitDirection, cls: string) {
    super(app, direction, cls);
    this.component.load();
  }
}
export class WorkspaceRoot extends WorkspaceContainer {
  constructor(app: App) { super(app, "vertical", "mod-root"); }
}
/** A popout: an OS window showing its own split of tab groups. Lives in `workspace.floatingSplit`. */
export class WorkspaceWindow extends WorkspaceContainer {
  declare parent: WorkspaceFloating | null;
  id = rid();
  /** Last known screen geometry (logical px), persisted as `x`/`y`/`width`/`height` in workspace.json. */
  geometry: { x?: number; y?: number; width?: number; height?: number } = {};
  maximize = false;
  private closing = false;
  constructor(app: App, data?: WorkspaceWindowInitData) {
    super(app, "vertical", "mod-root workspace-window");
    if (data) {
      const width = data.size?.width ?? data.width, height = data.size?.height ?? data.height;
      for (const [k, val] of [["x", data.x], ["y", data.y], ["width", width], ["height", height]] as const) if (typeof val === "number" && Number.isFinite(val)) this.geometry[k] = val;
      this.maximize = !!data.maximize;
    }
  }
  get isClosing(): boolean { return this.closing; }
  /** The window lost its last tab group. */
  protected onChildRemoved(): void {
    super.onChildRemoved();
    if (this.children.length === 0) this.close();
  }
  /** Close the popout: detach its leaves (pending saves run), drop it from the layout and close the OS window. */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    const ws = this.app.workspace;
    for (const l of this.leaves()) l.detach();
    this.component.unload();
    ws.onWindowClosed(this);
  }
}
/** Holds the popout windows. It has no DOM of its own: each window's container lives in its own document. */
export class WorkspaceFloating extends WorkspaceParent {
  declare children: WorkspaceWindow[];
  constructor(app: App) { super(app, "workspace-split mod-floating"); }
  insertChild(index: number, child: WorkspaceItem): void {
    child.parent = this;
    this.children.splice(index, 0, child as WorkspaceWindow);
  }
  removeChild(child: WorkspaceItem): void {
    const i = this.children.indexOf(child as WorkspaceWindow);
    if (i < 0) return;
    this.children.splice(i, 1);
    child.parent = null;
  }
}
export class WorkspaceMobileDrawer extends WorkspaceParent {
  collapsed = true;
  expand(): void { this.collapsed = false; }
  collapse(): void { this.collapsed = true; }
  toggle(): void { this.collapsed = !this.collapsed; }
}

export class WorkspaceSidedock extends WorkspaceSplit {
  collapsed: boolean;
  /** Pixel width when expanded (persisted as `width`). */
  width = 300;
  constructor(app: App, public side: "left" | "right", collapsed = false) {
    super(app, "horizontal", `mod-${side}-split`);
    this.collapsed = collapsed;
    this.containerEl.toggleClass("is-collapsed", collapsed);
  }
  private set(c: boolean): void {
    if (this.collapsed === c) return;
    this.collapsed = c;
    this.containerEl.toggleClass("is-collapsed", c);
    this.app.workspace.host?.onSidedockToggle?.(this.side, c);
    this.app.workspace.trigger("layout-change");
  }
  toggle(): void { this.set(!this.collapsed); }
  collapse(): void { this.set(true); }
  expand(): void { this.set(false); }
}

export class WorkspaceRibbon {
  containerEl: HTMLElement;
  ribbonEl: HTMLElement;
  items: { id: string; icon: string; title: string; callback: (evt: MouseEvent) => any; buttonEl: HTMLElement }[] = [];
  /** Items the user hid from the ribbon, keyed the item id, `<plugin id>:<title>` (workspace.json's `left-ribbon.hiddenItems`). `false` or absent means shown. */
  hiddenItems: Record<string, boolean> = {};
  /** Called when the user shows or hides an item, so the layout can be saved. */
  onHiddenChange: (() => void) | null = null;
  constructor(public app: App, public side: "left" | "right") {
    this.containerEl = createDiv({ cls: `workspace-ribbon side-dock-ribbon mod-${side}` });
    this.ribbonEl = this.containerEl.createDiv({ cls: "side-dock-actions" });
    this.containerEl.addEventListener("contextmenu", (e) => {
      // Right-clicking an item is that item's own business; the bare ribbon offers the show/hide list.
      if (this.items.some((i) => i.buttonEl.contains(e.target as Node)) || !this.items.length) return;
      e.preventDefault();
      this.showMenu(e);
    });
  }
  // Items are registered under Obsidian's `<plugin id>:<title>` ids already, which is also the key workspace.json uses.
  private keyOf(i: { id: string }): string { return i.id; }
  isHidden(i: { id: string; title: string }): boolean { return !!this.hiddenItems[this.keyOf(i)]; }
  private applyHidden(i: { id: string; title: string; buttonEl: HTMLElement }): void { i.buttonEl.toggleClass("is-hidden", this.isHidden(i)); i.buttonEl.style.display = this.isHidden(i) ? "none" : ""; }
  setHiddenItems(hidden: Record<string, boolean> | undefined): void {
    this.hiddenItems = { ...(hidden ?? {}) };
    for (const i of this.items) this.applyHidden(i);
  }
  setItemVisible(i: { id: string; title: string; buttonEl: HTMLElement }, visible: boolean): void {
    if (visible) delete this.hiddenItems[this.keyOf(i)]; else this.hiddenItems[this.keyOf(i)] = true;
    this.applyHidden(i);
    this.onHiddenChange?.();
  }
  showMenu(e: MouseEvent): void {
    const menu = new Menu();
    for (const item of this.items) menu.addItem((m) => m.setSection("items").setTitle(item.title).setIcon(item.icon).setChecked(!this.isHidden(item)).onClick(() => this.setItemVisible(item, this.isHidden(item))));
    // Obsidian ends the ribbon menu with "Hide ribbon" (Settings > Appearance > Show ribbon turns it back on).
    menu.addItem((m) => m.setSection("hide").setTitle("Hide ribbon").setIcon("lucide-eye-off").onClick(() => { this.app.vault.setConfig("showRibbon", false); this.app.workspace.trigger("config-changed"); }));
    menu.showAtMouseEvent(e);
  }
  addRibbonItemButton(id: string, icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const el = this.ribbonEl.createDiv({ cls: "clickable-icon side-dock-ribbon-action", attr: { "aria-label": title, "data-tooltip-position": this.side === "left" ? "right" : "left" } });
    setIcon(el, icon);
    el.addEventListener("click", callback);
    const item = { id, icon, title, callback, buttonEl: el };
    this.items.push(item);
    this.applyHidden(item);
    return el;
  }
  removeRibbonItemButton(el: HTMLElement): void {
    this.items = this.items.filter((i) => i.buttonEl !== el);
    el.detach();
  }
}

export class WorkspaceLeaf extends WorkspaceItem {
  declare parent: WorkspaceTabs | WorkspaceMobileDrawer;
  id = rid();
  view: View;
  hoverPopover: any = null;
  pinned = false;
  group: string | null = null;
  tabHeaderEl: HTMLElement;
  tabHeaderIconEl: HTMLElement;
  tabHeaderTitleEl: HTMLElement;
  working = false;
  private opening: Promise<void> = Promise.resolve();

  constructor(app: App) {
    super(app, "workspace-leaf");
    this.tabHeaderEl = createDiv({ cls: "workspace-tab-header tappable" });
    const inner = this.tabHeaderEl.createDiv({ cls: "workspace-tab-header-inner" });
    this.tabHeaderIconEl = inner.createDiv({ cls: "workspace-tab-header-inner-icon" });
    this.tabHeaderTitleEl = inner.createDiv({ cls: "workspace-tab-header-inner-title" });
    inner.createDiv({ cls: "workspace-tab-header-status-container" });
    this.tabHeaderEl.addEventListener("click", () => { this.app.workspace.setActiveLeaf(this, { focus: true }); });
    this.view = new EmptyView(this);
    this.mountView(this.view);
    void this.view.load();
    void this.view._open();
  }
  private mountView(view: View): void {
    view.containerEl.setAttribute("data-type", view.getViewType());
    this.containerEl.empty();
    const doc = view.containerEl.ownerDocument;
    this.containerEl.appendChild(view.containerEl);
    if (view.containerEl.ownerDocument !== doc) notifyWindowMigrated(view.containerEl);
  }
  /** Await the last (async) setViewState; handy for tests and shells. */
  whenReady(): Promise<void> { return this.opening; }

  get isDeferred(): boolean { return false; }
  async loadIfDeferred(): Promise<void> {}
  updateHeader(): void {
    const v = this.view;
    try {
      const title = v.getDisplayText();
      this.tabHeaderTitleEl.setText(title);
      this.tabHeaderEl.setAttribute("aria-label", title);
      setIcon(this.tabHeaderIconEl, v.getIcon());
      (v as any).updateHeader?.();
    } catch (e) { console.warn(`header update failed for view "${v.getViewType()}"`, e); }
  }
  getViewState(): ViewState {
    const vs: ViewState = { type: this.view.getViewType(), state: this.view.getState() };
    if (this.pinned) vs.pinned = true;
    if (this.group) (vs as any).group = this.group;
    return vs;
  }
  setViewState(viewState: ViewState, eState?: any): Promise<void> {
    const run = this.opening.then(() => this.doSetViewState(viewState, eState));
    this.opening = run.catch(() => {});
    return run;
  }
  private async doSetViewState(vs: ViewState, eState?: any): Promise<void> {
    const ws = this.app.workspace;
    const type = vs.type;
    const old = this.view;
    const sameType = old.getViewType() === type && !(old instanceof DeferredView && this.app.viewRegistry.getViewCreatorByType(type));
    if (!sameType) {
      await this.closeView();
      const creator: ViewCreator | undefined = this.app.viewRegistry.getViewCreatorByType(type);
      let view: View;
      try {
        view = type === "empty" ? new EmptyView(this) : creator ? creator(this) : new DeferredView(this, type);
      } catch (e) {
        console.error(`Failed to create view "${type}"`, e);
        view = new DeferredView(this, type);
      }
      this.view = view;
      this.mountView(view);
      void view.load();
      try { await view._open(); } catch (e) { console.error(e); }
      ws.host?.onViewOpened?.(this, view);
    }
    if (vs.pinned !== undefined) this.pinned = !!vs.pinned;
    if (vs.state !== undefined || !sameType) {
      try { await this.view.setState(vs.state ?? {}, { history: false }); } catch (e) { console.error(`setState failed for "${type}"`, e); }
    }
    if (eState) { try { this.view.setEphemeralState(eState); } catch (e) { console.error(e); } }
    this.containerEl.setAttribute("data-type", type);
    this.updateHeader();
    ws.onLeafChanged(this);
    if (vs.active) ws.setActiveLeaf(this, { focus: true });
  }
  /** Same order as Obsidian's View.close: detach the element, unload the component, then onClose (which saves). */
  private async closeView(): Promise<void> {
    const v = this.view;
    v.containerEl.detach();
    try { v.unload(); } catch (e) { console.error(e); }
    try { await v._close(); } catch (e) { console.error(e); }
    this.app.workspace.host?.onViewClosed?.(this, v);
  }
  async open(view: View): Promise<View> {
    await this.closeView();
    this.view = view;
    this.mountView(view);
    void view.load();
    await view._open();
    this.updateHeader();
    this.app.workspace.onLeafChanged(this);
    return view;
  }
  async openFile(file: TFile, openState?: OpenViewState): Promise<void> {
    const type = this.app.viewRegistry.getTypeByExtension(file.extension) ?? "file-unsupported";
    const state = { ...(openState?.state ?? {}), file: file.path };
    await this.setViewState({ type, state, active: openState?.active }, openState?.eState);
  }
  getEphemeralState(): any { return this.view.getEphemeralState(); }
  setEphemeralState(state: any): void { this.view.setEphemeralState(state); }
  togglePinned(): void { this.setPinned(!this.pinned); }
  setPinned(p: boolean): void {
    if (this.pinned === p) return;
    this.pinned = p;
    this.tabHeaderEl.toggleClass("mod-pinned", p);
    this.trigger("pinned-change", p);
  }
  setGroupMember(other: WorkspaceLeaf): void { this.setGroup(other.group ?? other.id); if (!other.group) other.setGroup(other.id); }
  setGroup(group: string | null): void {
    this.group = group;
    this.trigger("group-change", group);
    this.app.workspace?.trigger("layout-change");
    this.app.workspace?.requestSaveLayout();
  }
  getIcon(): string { return this.view.getIcon(); }
  getDisplayText(): string { return this.view.getDisplayText(); }
  onResize(): void { this.view.onResize(); }
  detach(): void {
    const ws = this.app.workspace;
    ws.rememberClosed(this);
    void this.closeView();
    const parent = this.parent;
    if (parent) parent.removeChild(this);
    ws.onLeafDetached(this);
  }
}

// ---------------------------------------------------------------- Workspace

export class Workspace extends Events {
  host: LayoutHost | null = null;
  leftSplit: WorkspaceSidedock;
  rightSplit: WorkspaceSidedock;
  leftRibbon: WorkspaceRibbon;
  rightRibbon: WorkspaceRibbon;
  rootSplit: WorkspaceRoot;
  floatingSplit: WorkspaceFloating;
  containerEl: HTMLElement;
  activeLeaf: WorkspaceLeaf | null = null;
  activeEditor: any = null;
  layoutReady = false;
  requestSaveLayout: Debouncer<[], Promise<void>>;
  editorExtensions: any[] = [];
  editorSuggestManager: EditorSuggestManager | null = null;
  /** Obsidian's name for the editor suggest registry (`workspace.editorSuggest.suggests`; Kanban reads it). */
  get editorSuggest(): EditorSuggestManager | null { return this.editorSuggestManager; }
  hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {};
  private readyCbs: (() => any)[] = [];
  private recent: WorkspaceLeaf[] = [];
  private recentFile: TFile | null = null;
  private lastOpenFiles: string[] = [];
  private lastFileOpened: TFile | null | undefined = undefined;

  constructor(public app: App) {
    super();
    this.containerEl = createDiv({ cls: "workspace" });
    this.leftSplit = new WorkspaceSidedock(app, "left");
    this.rightSplit = new WorkspaceSidedock(app, "right", true);
    this.rootSplit = new WorkspaceRoot(app);
    this.floatingSplit = new WorkspaceFloating(app);
    this.leftRibbon = new WorkspaceRibbon(app, "left");
    this.leftRibbon.onHiddenChange = () => this.requestSaveLayout();
    this.rightRibbon = new WorkspaceRibbon(app, "right");
    this.containerEl.append(this.leftRibbon.containerEl, this.leftSplit.containerEl, this.rootSplit.containerEl, this.rightSplit.containerEl, this.rightRibbon.containerEl);
    this.requestSaveLayout = debounce(async () => { await this.host?.saveLayout?.(this.getLayout()); }, 2000, true) as Debouncer<[], Promise<void>>;
    // initial layout: one tab group with an empty leaf
    const tabs = new WorkspaceTabs(app);
    this.rootSplit.insertChild(0, tabs);
    const leaf = new WorkspaceLeaf(app);
    tabs.insertChild(0, leaf);
    leaf.updateHeader();
    tabs.refreshTabs();
    this.recent.push(leaf);
    this.activeLeaf = leaf;
    leaf.containerEl.addClass("mod-active");
  }

  // ---- lifecycle
  onLayoutReady(callback: () => any): void {
    if (this.layoutReady) { try { callback(); } catch (e) { console.error(e); } return; }
    this.readyCbs.push(callback);
  }
  /** Called by App once plugins are loaded and the layout has been restored. */
  markLayoutReady(): void {
    if (this.layoutReady) return;
    this.layoutReady = true;
    this.trigger("layout-ready");
    const cbs = this.readyCbs.splice(0);
    for (const cb of cbs) { try { cb(); } catch (e) { console.error(e); } }
  }

  /** The layout changed in a way the model did not see (plugins moving leaves around): notify and save. */
  onLayoutChange(): void {
    this.trigger("layout-change");
    this.host?.onLayoutChange?.();
    this.requestSaveLayout();
  }

  // ---- hooks used by leaves
  onLeafChanged(leaf: WorkspaceLeaf): void {
    this.trackFile(leaf);
    this.trigger("layout-change");
    this.host?.onLayoutChange?.();
    this.requestSaveLayout();
    if (leaf === this.activeLeaf) {
      this.activeEditor = leaf.view instanceof MarkdownView ? leaf.view : null;
      this.checkFileOpen();
    }
  }
  /** View states of recently closed tabs in the main area and popouts, newest last (for "Undo close tab"). */
  closedLeaves: ViewState[] = [];
  rememberClosed(leaf: WorkspaceLeaf): void {
    const root = leaf.getRoot();
    if (!(root === this.rootSplit || root instanceof WorkspaceWindow)) return;
    const vs = leaf.getViewState();
    if (vs.type === "empty") return;
    this.closedLeaves.push({ type: vs.type, state: vs.state, pinned: vs.pinned });
    if (this.closedLeaves.length > 20) this.closedLeaves.shift();
  }
  /** Reopen the most recently closed tab whose file still exists; false when there is nothing to reopen. */
  async undoCloseLeaf(): Promise<boolean> {
    while (this.closedLeaves.length) {
      const vs = this.closedLeaves.pop()!;
      const file = typeof vs.state?.file === "string" ? vs.state.file : null;
      if (file && !this.app.vault.getAbstractFileByPath(file)) continue;
      const leaf = this.getLeaf("tab");
      await leaf.setViewState({ ...vs, active: true });
      this.setActiveLeaf(leaf, { focus: true });
      return true;
    }
    return false;
  }
  onLeafDetached(leaf: WorkspaceLeaf): void {
    this.recent = this.recent.filter((l) => l !== leaf);
    if (this.rootSplit.leaves().length === 0) {
      let tabs = this.rootSplit.children.find((c): c is WorkspaceTabs => c instanceof WorkspaceTabs);
      if (!tabs) { tabs = new WorkspaceTabs(this.app); this.rootSplit.insertChild(0, tabs); }
      const nl = new WorkspaceLeaf(this.app);
      tabs.insertChild(tabs.children.length, nl);
      nl.updateHeader();
      tabs.selectTab(nl);
    }
    if (this.activeLeaf === leaf) {
      const next = this.getMostRecentLeaf() ?? this.rootSplit.leaves()[0] ?? null;
      this.activeLeaf = null;
      if (next) this.setActiveLeaf(next); else { this.trigger("active-leaf-change", null); this.host?.onActiveLeafChange?.(null); }
    }
    this.trigger("layout-change");
    this.host?.onLayoutChange?.();
    this.requestSaveLayout();
  }
  private trackFile(leaf: WorkspaceLeaf): void {
    const v = leaf.view;
    if (v instanceof FileView && v.file) {
      this.recentFile = v.file;
      this.lastOpenFiles = [v.file.path, ...this.lastOpenFiles.filter((p) => p !== v.file!.path)].slice(0, 50);
    }
  }
  private checkFileOpen(): void {
    const f = this.activeLeaf?.view instanceof FileView ? (this.activeLeaf.view as FileView).file : null;
    if (f !== this.lastFileOpened) {
      this.lastFileOpened = f;
      this.trigger("file-open", f);
    }
  }

  // ---- leaves
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => any): void {
    for (const l of this.allLeaves()) callback(l);
  }
  /** Visit the leaves under `item` (a leaf or any parent); a callback returning true stops the walk (returns true). */
  iterateLeaves(callback: (leaf: WorkspaceLeaf) => any, item: WorkspaceItem | WorkspaceItem[] = this.rootSplit): boolean {
    if (Array.isArray(item)) return item.some((i) => this.iterateLeaves(callback, i));
    if (item instanceof WorkspaceLeaf) return !!callback(item);
    if (item instanceof WorkspaceParent) return item.children.some((c) => this.iterateLeaves(callback, c));
    return false;
  }
  iterateRootLeaves(callback: (leaf: WorkspaceLeaf) => any): void {
    for (const l of this.rootLeaves()) callback(l);
  }
  /** Leaves of the main area and of every popout (not the sidebars). */
  private rootLeaves(): WorkspaceLeaf[] { return [...this.rootSplit.leaves(), ...this.floatingSplit.leaves()]; }
  private isRootLeaf(l: WorkspaceLeaf): boolean { const r = l.getRoot(); return r === this.rootSplit || r instanceof WorkspaceWindow; }
  /** Open popout windows. */
  get windows(): WorkspaceWindow[] { return this.floatingSplit.children.slice(); }
  allLeaves(): WorkspaceLeaf[] {
    return [...this.rootSplit.leaves(), ...this.leftSplit.leaves(), ...this.rightSplit.leaves(), ...this.floatingSplit.leaves()];
  }
  getLeavesOfType(viewType: string): WorkspaceLeaf[] {
    return this.allLeaves().filter((l) => l.view.getViewType() === viewType);
  }
  detachLeavesOfType(viewType: string): void {
    for (const l of this.getLeavesOfType(viewType)) l.detach();
  }
  getLeafById(id: string): WorkspaceLeaf | null { return this.allLeaves().find((l) => l.id === id) ?? null; }
  getGroupLeaves(group: string): WorkspaceLeaf[] { return this.allLeaves().filter((l) => l.group === group); }
  getMostRecentLeaf(root?: WorkspaceParent): WorkspaceLeaf | null {
    const r = root ?? this.rootSplit;
    return this.recent.find((l) => l.getRoot() === r.getRoot() && l.parent) ?? null;
  }
  getUnpinnedLeaf(): WorkspaceLeaf {
    // The most recent main-area or popout leaf: links followed inside a popout stay in that window.
    const l = this.rootLeaves();
    const recent = this.recent.find((x) => l.includes(x) && !x.pinned);
    return recent ?? this.rootSplit.leaves().find((x) => !x.pinned) ?? this.createTab();
  }
  private createTab(near?: WorkspaceLeaf | null): WorkspaceLeaf {
    let tabs: WorkspaceTabs | undefined;
    const ref = near && this.isRootLeaf(near) ? near : this.getMostRecentLeaf();
    if (ref && ref.parent instanceof WorkspaceTabs) tabs = ref.parent;
    tabs ??= this.rootSplit.children.find((c): c is WorkspaceTabs => c instanceof WorkspaceTabs) ?? this.firstTabs(this.rootSplit);
    return this.createLeafInTabs(tabs);
  }
  private firstTabs(split: WorkspaceSplit): WorkspaceTabs {
    const find = (p: WorkspaceParent): WorkspaceTabs | null => {
      for (const c of p.children) {
        if (c instanceof WorkspaceTabs) return c;
        if (c instanceof WorkspaceParent) { const r = find(c); if (r) return r; }
      }
      return null;
    };
    const t = find(split);
    if (t) return t;
    const nt = new WorkspaceTabs(this.app);
    split.insertChild(split.children.length, nt);
    return nt;
  }
  private createLeafInTabs(tabs: WorkspaceTabs, select = true): WorkspaceLeaf {
    const leaf = new WorkspaceLeaf(this.app);
    tabs.insertChild(tabs.children.length, leaf);
    leaf.updateHeader();
    if (select) tabs.selectTab(leaf);
    this.recent.push(leaf);
    this.trigger("layout-change");
    this.host?.onLayoutChange?.();
    return leaf;
  }
  createLeafInParent(parent: WorkspaceSplit, index: number): WorkspaceLeaf {
    const tabs = new WorkspaceTabs(this.app);
    parent.insertChild(Math.min(index, parent.children.length), tabs);
    return this.createLeafInTabs(tabs);
  }
  createLeafBySplit(leaf: WorkspaceLeaf, direction: SplitDirection = "vertical", before = false): WorkspaceLeaf {
    const tabs = leaf.parent instanceof WorkspaceTabs ? leaf.parent : null;
    const split = tabs?.parent;
    if (!tabs || !split) return this.createTab();
    const idx = split.children.indexOf(tabs);
    if (split.direction === direction || split.children.length === 1) {
      split.direction = direction;
      split.containerEl.className = split.containerEl.className.replace(/mod-(vertical|horizontal)/, `mod-${direction}`);
      return this.createLeafInParent(split, before ? idx : idx + 1);
    }
    const wrap = new WorkspaceSplit(this.app, direction);
    split.removeChild(tabs);
    split.insertChild(idx, wrap);
    wrap.insertChild(0, tabs);
    return this.createLeafInParent(wrap, before ? 0 : 1);
  }
  splitActiveLeaf(direction: SplitDirection = "vertical"): WorkspaceLeaf {
    const base = this.activeLeaf && this.isRootLeaf(this.activeLeaf) ? this.activeLeaf : this.getMostRecentLeaf() ?? this.rootSplit.leaves()[0];
    return this.createLeafBySplit(base, direction);
  }
  async duplicateLeaf(leaf: WorkspaceLeaf, a?: SplitDirection | PaneType | boolean, b?: SplitDirection): Promise<WorkspaceLeaf> {
    const type: PaneType | boolean = a === "vertical" || a === "horizontal" || a === undefined ? "tab" : a;
    const dir = a === "vertical" || a === "horizontal" ? a : b;
    const nl = type === "window" ? this.openPopoutLeaf() : type === "split" ? this.createLeafBySplit(leaf, dir) : this.createTab(leaf);
    await nl.setViewState(leaf.getViewState(), leaf.getEphemeralState());
    return nl;
  }
  getLeaf(newLeaf?: PaneType | boolean | "split", direction?: SplitDirection): WorkspaceLeaf {
    if (newLeaf === "split") return this.splitActiveLeaf(direction);
    if (newLeaf === "window") return this.openPopoutLeaf();
    if (newLeaf === "tab" || newLeaf === true) return this.createTab(this.activeLeaf);
    const unpinned = this.getUnpinnedLeaf();
    return unpinned;
  }
  /** Open a popout window with one new empty leaf and return that leaf. */
  openPopoutLeaf(data?: WorkspaceWindowInitData): WorkspaceLeaf {
    let win: WorkspaceWindow;
    try { win = this.openPopout(data); } catch (e) { console.error(e); new Notice("Unable to open a new window."); return this.createTab(this.activeLeaf); }
    const leaf = this.createLeafInTabs(this.firstTabs(win));
    this.setActiveLeaf(leaf, { focus: true });
    return leaf;
  }
  /** Move a leaf (its live view, not a copy) into a new popout window. */
  moveLeafToPopout(leaf: WorkspaceLeaf, data?: WorkspaceWindowInitData): WorkspaceWindow {
    const win = this.openPopout(data); // throws (nothing moved) when the window cannot be opened
    const tabs = this.firstTabs(win);
    this.moveLeaf(leaf, tabs, 0);
    return win;
  }
  /** Create a popout window (the shell opens the OS window) with an empty tab group. */
  openPopout(data?: WorkspaceWindowInitData, id?: string): WorkspaceWindow {
    const win = new WorkspaceWindow(this.app, data);
    if (id) win.id = id;
    this.floatingSplit.insertChild(this.floatingSplit.children.length, win);
    let w: Window | void;
    try { w = this.host?.openPopout?.(win, data); } catch (e) { this.floatingSplit.removeChild(win); throw e; }
    if (w) { win.win = w; win.doc = w.document; }
    win.insertChild(0, new WorkspaceTabs(this.app));
    this.trigger("window-open", win, win.win);
    return win;
  }
  /** Called by WorkspaceWindow.close once its leaves are gone. */
  onWindowClosed(win: WorkspaceWindow): void {
    for (const c of win.children.slice()) win.removeChild(c);
    this.floatingSplit.removeChild(win);
    this.host?.closePopout?.(win);
    this.trigger("window-close", win, win.win);
    if (this.activeLeaf && this.activeLeaf.getContainer() === win) {
      const next = this.getMostRecentLeaf() ?? this.rootSplit.leaves()[0] ?? null;
      this.activeLeaf = null;
      if (next) this.setActiveLeaf(next);
    }
    if ((globalThis as any).activeWindow === win.win && win.win !== window) setActiveWindow(window);
    this.trigger("layout-change");
    this.host?.onLayoutChange?.();
    this.requestSaveLayout();
  }
  /** Move a leaf (keeping its view) to `index` of a tab group, possibly in another window. Keeps one leaf in the main area. */
  moveLeaf(leaf: WorkspaceLeaf, target: WorkspaceTabs, index: number): void {
    const from = leaf.parent;
    if (!from) return;
    if (from === target) {
      const cur = from.children.indexOf(leaf);
      if (index > cur) index--;
      if (index === cur) return;
    }
    const wasActive = this.activeLeaf === leaf;
    from.removeChild(leaf);
    target.insertChild(Math.min(index, target.children.length), leaf);
    target.selectTab(leaf);
    if (this.rootSplit.leaves().length === 0) {
      // The main area never ends up empty (like closing its last tab).
      const tabs = this.firstTabs(this.rootSplit);
      const nl = new WorkspaceLeaf(this.app);
      tabs.insertChild(tabs.children.length, nl);
      nl.updateHeader();
      tabs.selectTab(nl);
    }
    if (wasActive) this.activeLeaf = null;
    this.setActiveLeaf(leaf);
    leaf.onResize();
    this.trigger("layout-change");
    this.host?.onLayoutChange?.();
    this.requestSaveLayout();
  }
  private sideLeaf(dock: WorkspaceSidedock, split: boolean): WorkspaceLeaf {
    if (split || dock.children.length === 0) {
      const tabs = new WorkspaceTabs(this.app);
      dock.insertChild(dock.children.length, tabs);
      return this.createLeafInTabs(tabs);
    }
    return this.createLeafInTabs(dock.children[0] as WorkspaceTabs);
  }
  getLeftLeaf(split: boolean): WorkspaceLeaf | null { return this.sideLeaf(this.leftSplit, split); }
  getRightLeaf(split: boolean): WorkspaceLeaf | null { return this.sideLeaf(this.rightSplit, split); }
  async ensureSideLeaf(type: string, side: Side, options: { active?: boolean; split?: boolean; reveal?: boolean; state?: any } = {}): Promise<WorkspaceLeaf> {
    let leaf = this.getLeavesOfType(type)[0];
    if (!leaf) {
      const left = side === "left" || side === "primary";
      leaf = (left ? this.getLeftLeaf(!!options.split) : this.getRightLeaf(!!options.split))!;
      await leaf.setViewState({ type, active: !!options.active, state: options.state });
    }
    if (options.reveal !== false) await this.revealLeaf(leaf);
    return leaf;
  }
  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    const parent = leaf.parent;
    if (parent instanceof WorkspaceTabs) {
      parent.selectTab(leaf);
      const root = parent.getRoot();
      if (root === this.leftSplit || root === this.rightSplit) (root as WorkspaceSidedock).expand();
    }
    const c = leaf.getContainer();
    this.host?.focusWindow?.(c instanceof WorkspaceWindow ? c : null);
    this.host?.revealLeaf?.(leaf);
    this.setActiveLeaf(leaf);
  }
  setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean } | boolean, _focus?: boolean): void {
    if (this.activeLeaf === leaf) { this.checkFileOpen(); return; }
    const prev = this.activeLeaf;
    prev?.containerEl.removeClass("mod-active");
    prev?.tabHeaderEl.removeClass("mod-active");
    this.activeLeaf = leaf;
    leaf.containerEl.addClass("mod-active");
    leaf.tabHeaderEl.addClass("mod-active");
    this.recent = [leaf, ...this.recent.filter((l) => l !== leaf)];
    if (leaf.parent instanceof WorkspaceTabs) leaf.parent.selectTab(leaf);
    const c = leaf.getContainer();
    if (c.win && (globalThis as any).activeWindow !== c.win) setActiveWindow(c.win);
    this.activeEditor = leaf.view instanceof MarkdownView ? leaf.view : null;
    this.trackFile(leaf);
    this.trigger("active-leaf-change", leaf);
    this.host?.onActiveLeafChange?.(leaf);
    this.checkFileOpen();
    const focus = typeof params === "boolean" ? _focus : params?.focus;
    if (focus && leaf.view instanceof MarkdownView) leaf.view.editor.focus();
  }
  getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
    const v = this.activeLeaf?.view;
    return v instanceof type ? (v as T) : null;
  }
  getActiveFile(): TFile | null {
    const v = this.activeLeaf?.view;
    if (v instanceof FileView && v.file) return v.file;
    return this.recentFile && this.app.vault.getFileByPath(this.recentFile.path) ? this.recentFile : null;
  }
  /** Declare an emitter of the `hover-link` event; it shows up in the Page preview settings. */
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void { this.hoverLinkSources[id] = info; this.trigger("hover-link-sources-changed"); }
  unregisterHoverLinkSource(id: string): void { delete this.hoverLinkSources[id]; this.trigger("hover-link-sources-changed"); }
  /** Legacy CodeMirror 5 iteration; there are no CM5 editors any more, so the callback is never invoked. */
  iterateCodeMirrors(_callback: (cm: unknown) => any): void {}
  getLastOpenFiles(): string[] { return this.lastOpenFiles.slice(); }

  async openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState): Promise<void> {
    const { path, subpath } = parseLinktext(linktext);
    let file: TFile | null = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : this.app.vault.getFileByPath(sourcePath);
    if (!file) {
      if (!path) return;
      const name = /\.[A-Za-z0-9]+$/.test(path) && !path.endsWith(".md") ? path : path.endsWith(".md") ? path : path + ".md";
      const parent = this.app.fileManager.getNewFileParent(sourcePath, name);
      const full = path.includes("/") ? name : (parent.isRoot() ? name : parent.path + "/" + name);
      file = await this.app.vault.create(full, "");
    }
    // Reuse a leaf that already shows the file when not asked for a new one.
    let leaf: WorkspaceLeaf | null = null;
    if (!newLeaf) leaf = this.rootLeaves().find((l) => l.view instanceof FileView && l.view.file === file) ?? null;
    leaf ??= this.getLeaf(newLeaf as any);
    const eState = { ...(openViewState?.eState ?? {}), ...(subpath ? { subpath } : {}) };
    // "Always focus new tabs" (app.json focusNewTab) decides whether a link opened in a new tab takes the focus.
    const focus = newLeaf === "tab" || newLeaf === true ? this.app.vault.getConfig("focusNewTab") !== false : true;
    await leaf.openFile(file, { ...openViewState, eState, active: openViewState?.active ?? focus });
  }

  /** Some plugins look for the handlers on the workspace; they live on the app (see App.protocolHandlers). */
  get protocolHandlers() { return this.app.protocolHandlers; }
  updateOptions(): void {
    for (const l of this.getLeavesOfType("markdown")) if (l.view instanceof MarkdownView) l.view.reconfigure();
    this.trigger("css-change");
  }
  handleLinkContextMenu(menu: Menu, linktext: string, sourcePath: string, _leaf?: WorkspaceLeaf): boolean {
    menu.addItem((i) => i.setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => { void this.openLinkText(linktext, sourcePath, "tab"); }));
    menu.addItem((i) => i.setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => { void this.openLinkText(linktext, sourcePath, "split"); }));
    menu.addItem((i) => i.setTitle("Open in new window").setIcon("lucide-picture-in-picture-2").onClick(() => { void this.openLinkText(linktext, sourcePath, "window"); }));
    return true;
  }

  // ---- layout (de)serialisation, compatible in spirit with .obsidian/workspace.json
  getLayout(): Record<string, unknown> {
    const ser = (n: WorkspaceItem): any => {
      const size = n.size !== null ? { size: Math.round(n.size * 100) / 100 } : {};
      if (n instanceof WorkspaceLeaf) return { id: n.id, type: "leaf", state: n.getViewState(), ...(n.group ? { group: n.group } : {}) };
      if (n instanceof WorkspaceTabs) return { id: rid(), type: "tabs", ...size, currentTab: n.currentTab, children: n.children.map(ser), ...(n.isStacked ? { stacked: true } : {}) };
      if (n instanceof WorkspaceWindow) {
        const g = n.geometry;
        const geo = Object.fromEntries((["x", "y", "width", "height"] as const).filter((k) => typeof g[k] === "number").map((k) => [k, Math.round(g[k]!)]));
        return { id: n.id, type: "window", children: n.children.map(ser), direction: n.direction, ...geo, maximize: n.maximize };
      }
      const p = n as WorkspaceSplit;
      return { id: rid(), type: "split", ...size, children: p.children.map(ser), direction: p.direction };
    };
    const wins = this.floatingSplit.children.filter((w) => !w.isClosing);
    return {
      main: ser(this.rootSplit),
      left: { ...ser(this.leftSplit), width: this.leftSplit.width, collapsed: this.leftSplit.collapsed },
      right: { ...ser(this.rightSplit), width: this.rightSplit.width, collapsed: this.rightSplit.collapsed },
      ...(wins.length ? { floating: { id: rid(), type: "floating", children: wins.map(ser) } } : {}),
      "left-ribbon": { hiddenItems: this.leftRibbon.hiddenItems },
      active: this.activeLeaf?.id,
      lastOpenFiles: this.lastOpenFiles,
    };
  }
  async changeLayout(layout: any): Promise<void> {
    const build = async (spec: any, parent: WorkspaceParent): Promise<void> => {
      for (const c of spec.children ?? []) {
        if (c.type === "tabs") {
          const tabs = new WorkspaceTabs(this.app);
          if (typeof c.size === "number") tabs.size = c.size;
          parent.insertChild(parent.children.length, tabs);
          for (const l of c.children ?? []) {
            const leaf = new WorkspaceLeaf(this.app);
            if (l.id) leaf.id = l.id;
            if (typeof l.group === "string") leaf.group = l.group;
            tabs.insertChild(tabs.children.length, leaf);
            this.recent.push(leaf);
            await leaf.setViewState(l.state ?? { type: "empty" });
          }
          tabs.currentTab = Math.min(c.currentTab ?? 0, Math.max(0, tabs.children.length - 1));
          tabs.setStacked(c.stacked === true);
          tabs.refreshTabs();
        } else if (c.type === "split") {
          const sp = new WorkspaceSplit(this.app, c.direction ?? "vertical");
          if (typeof c.size === "number") sp.size = c.size;
          parent.insertChild(parent.children.length, sp);
          await build(c, sp);
        }
      }
    };
    for (const w of this.floatingSplit.children.slice()) w.close();
    for (const l of this.allLeaves()) l.detach();
    for (const root of [this.rootSplit, this.leftSplit, this.rightSplit]) for (const c of root.children.slice()) root.removeChild(c);
    this.recent = [];
    if (layout.main) await build(layout.main, this.rootSplit);
    for (const spec of layout.floating?.children ?? []) {
      if (spec?.type !== "window") continue;
      let win: WorkspaceWindow;
      try { win = this.openPopout(spec, typeof spec.id === "string" ? spec.id : undefined); } catch (e) { console.error("Failed to restore popout window", e); continue; }
      const placeholder = win.children[0];
      await build(spec, win);
      if (placeholder && win.children.length > 1) win.removeChild(placeholder);
      if (spec.direction === "horizontal" || spec.direction === "vertical") win.direction = spec.direction;
      if (!win.leaves().length) win.close();
    }
    if (typeof layout.left?.width === "number") this.leftSplit.width = layout.left.width;
    if (typeof layout.right?.width === "number") this.rightSplit.width = layout.right.width;
    if (layout.left) { await build(layout.left, this.leftSplit); layout.left.collapsed ? this.leftSplit.collapse() : this.leftSplit.expand(); }
    if (layout.right) { await build(layout.right, this.rightSplit); layout.right.collapsed ? this.rightSplit.collapse() : this.rightSplit.expand(); }
    if (!this.rootSplit.leaves().length) this.createTab();
    const act = (layout.active && this.getLeafById(layout.active)) || this.rootSplit.leaves()[0];
    setActiveWindow(window);
    this.activeLeaf = null;
    if (act) this.setActiveLeaf(act);
    if (Array.isArray(layout.lastOpenFiles)) this.lastOpenFiles = layout.lastOpenFiles;
    const hidden = layout["left-ribbon"]?.hiddenItems;
    this.leftRibbon.setHiddenItems(hidden && typeof hidden === "object" && !Array.isArray(hidden) ? hidden : undefined);
    this.trigger("layout-change");
  }
  /** Re-instantiate leaves whose placeholder view type was just registered by a plugin. */
  reviveDeferred(type: string): void {
    for (const l of this.getLeavesOfType(type)) if (l.view instanceof DeferredView) void l.setViewState({ type, state: l.view.getState() });
  }
  /** Turn leaves of a type into placeholders (plugin unloaded) so they survive re-enabling. */
  deferLeavesOfType(type: string): void {
    for (const l of this.getLeavesOfType(type)) {
      if (l.view instanceof DeferredView) continue;
      const state = l.view.getState();
      void l.open(new DeferredView(l, type)).then(() => l.view.setState(state, { history: false }));
    }
  }
}
export { getLinkpath };
