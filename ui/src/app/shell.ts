// The application shell: mounts the workspace model into the page and implements LayoutHost —
// tab chrome (close, pin, drag-reorder, drop-to-split), resize handles, sidebar toggles, layout persistence.
import { ipc } from "../ipc";
import {
  FileView, Menu, TextFileView, WorkspaceParent, WorkspaceSidedock, WorkspaceSplit, WorkspaceTabs,
  type App, type LayoutHost, type View, type WorkspaceItem, type WorkspaceLeaf,
} from "../obsidian";
import { setIcon } from "../obsidian/icons";
import { buildFileMenu, copyText, revealInExplorer } from "./files";

const MIN_PANE = 90;
type Zone = "left" | "right" | "top" | "bottom" | "center";

export class Shell implements LayoutHost {
  private scheduled = false;
  private drag: WorkspaceLeaf | null = null;
  private leftToggle: HTMLElement;
  private rightToggle: HTMLElement;
  private cleanups: (() => void)[] = [];

  constructor(public app: App) {
    app.workspace.host = this;
    this.leftToggle = this.makeToggle("left");
    this.rightToggle = this.makeToggle("right");
    this.buildRibbonFooter();
    this.installFocusTracking();
    this.installSaveOnHide();
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.app.dom.appContainerEl);
    this.decorate();
  }

  dispose(): void {
    for (const c of this.cleanups.splice(0)) c();
    this.app.workspace.host = null;
  }

  // ---------------------------------------------------------------- LayoutHost
  onLayoutChange(): void { this.scheduleDecorate(); }
  onSidedockToggle(): void { this.scheduleDecorate(); this.app.workspace.requestSaveLayout(); }
  onViewOpened(leaf: WorkspaceLeaf, _view: View): void { this.scheduleDecorate(); void leaf; }
  revealLeaf(leaf: WorkspaceLeaf): void { this.scheduleDecorate(); void leaf; }
  onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
    this.app.dom.appContainerEl.querySelectorAll(".workspace-tabs.mod-active").forEach((e) => e.removeClass("mod-active"));
    leaf?.parent?.containerEl.addClass("mod-active");
    const v = leaf?.view;
    const f = v instanceof FileView ? v.file : null;
    document.title = f ? `${f.basename} - ${this.app.vault.getName()} - Tachylite` : `${this.app.vault.getName()} - Tachylite`;
  }
  async saveLayout(layout: Record<string, unknown>): Promise<void> {
    try { await ipc.configWrite("workspace.json", layout); } catch (e) { console.warn("workspace.json not saved", e); }
  }

  private scheduleDecorate(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; try { this.decorate(); } catch (e) { console.error("decorate failed", e); } });
  }

  // ---------------------------------------------------------------- decoration pass (idempotent)
  decorate(): void {
    const ws = this.app.workspace;
    for (const dock of [ws.leftSplit, ws.rightSplit]) {
      dock.containerEl.style.width = dock.collapsed ? "" : `${dock.width}px`;
      this.decorateSplit(dock);
      this.ensureDockHandle(dock);
    }
    this.decorateSplit(ws.rootSplit);
    this.placeToggles();
    this.app.dom.appContainerEl.toggleClass("is-left-sidedock-open", !ws.leftSplit.collapsed);
    this.app.dom.appContainerEl.toggleClass("is-right-sidedock-open", !ws.rightSplit.collapsed);
    const act = ws.activeLeaf;
    this.app.dom.appContainerEl.querySelectorAll(".workspace-tabs.mod-active").forEach((e) => { if (e !== act?.parent?.containerEl) e.removeClass("mod-active"); });
    act?.parent?.containerEl.addClass("mod-active");
  }

  private decorateSplit(split: WorkspaceSplit): void {
    const kids = split.children;
    const sized = kids.filter((k) => k.size !== null).length;
    if (sized !== 0 && sized !== kids.length) for (const k of kids) k.size = null;
    kids.forEach((child, i) => {
      child.containerEl.style.flexGrow = String(child.size ?? 100 / kids.length);
      if (child instanceof WorkspaceTabs) this.decorateTabs(child);
      else if (child instanceof WorkspaceSplit) this.decorateSplit(child);
      this.syncHandle(split, child, i);
    });
  }

  private syncHandle(split: WorkspaceSplit, child: WorkspaceItem, index: number): void {
    const existing = child.containerEl.querySelector<HTMLElement>(":scope > .workspace-leaf-resize-handle");
    if (index === 0) { existing?.remove(); return; }
    const horiz = split.direction === "vertical"; // children sit side by side
    const h = existing ?? child.containerEl.createDiv({ cls: "workspace-leaf-resize-handle" });
    h.setAttribute("data-dir", horiz ? "x" : "y");
    if (!(h as any)._wired) {
      (h as any)._wired = true;
      h.addEventListener("mousedown", (e) => { e.preventDefault(); const sp = this.parentSplitOf(child); if (sp) this.startResize(e, sp, sp.children.indexOf(child)); });
    }
  }

  private parentSplitOf(item: WorkspaceItem): WorkspaceSplit | null {
    return (item.parent as WorkspaceSplit | null) ?? null;
  }

  private startResize(e: MouseEvent, split: WorkspaceSplit, idx: number): void {
    if (idx < 1) return;
    const horiz = split.direction === "vertical";
    const px = (i: WorkspaceItem) => { const r = i.containerEl.getBoundingClientRect(); return horiz ? r.width : r.height; };
    const sizes = split.children.map(px);
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    const start = horiz ? e.clientX : e.clientY;
    const pair = sizes[idx - 1] + sizes[idx];
    document.body.addClass("is-resizing");
    const move = (ev: MouseEvent) => {
      const d = (horiz ? ev.clientX : ev.clientY) - start;
      const a = Math.max(MIN_PANE, Math.min(pair - MIN_PANE, sizes[idx - 1] + d));
      const next = sizes.slice();
      next[idx - 1] = a;
      next[idx] = pair - a;
      split.children.forEach((c, i) => { c.size = (next[i] / total) * 100; c.containerEl.style.flexGrow = String(c.size); });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.removeClass("is-resizing");
      this.app.workspace.requestSaveLayout();
      for (const l of this.app.workspace.allLeaves()) l.onResize();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  private ensureDockHandle(dock: WorkspaceSidedock): void {
    let h = dock.containerEl.querySelector<HTMLElement>(":scope > .workspace-leaf-resize-handle.mod-dock");
    if (h) return;
    h = dock.containerEl.createDiv({ cls: "workspace-leaf-resize-handle mod-dock", attr: { "data-dir": "x" } });
    h.addEventListener("dblclick", () => { dock.width = 300; dock.containerEl.style.width = "300px"; this.app.workspace.requestSaveLayout(); });
    h.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX, startW = dock.containerEl.getBoundingClientRect().width;
      document.body.addClass("is-resizing");
      const move = (ev: MouseEvent) => {
        const d = (ev.clientX - startX) * (dock.side === "left" ? 1 : -1);
        dock.width = Math.round(Math.max(180, Math.min(window.innerWidth * 0.6, startW + d)));
        dock.containerEl.style.width = `${dock.width}px`;
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        document.body.removeClass("is-resizing");
        this.app.workspace.requestSaveLayout();
        for (const l of this.app.workspace.allLeaves()) l.onResize();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }

  // ---------------------------------------------------------------- sidebar toggles & ribbon footer
  private makeToggle(side: "left" | "right"): HTMLElement {
    const el = createDiv({ cls: `clickable-icon sidebar-toggle-button mod-${side}`, attr: { "aria-label": side === "left" ? "Collapse left sidebar" : "Collapse right sidebar" } });
    setIcon(el, side === "left" ? "lucide-panel-left" : "lucide-panel-right");
    el.addEventListener("click", () => { (side === "left" ? this.app.workspace.leftSplit : this.app.workspace.rightSplit).toggle(); });
    return el;
  }

  private placeToggles(): void {
    const ws = this.app.workspace;
    const first = this.edgeTabs(ws.rootSplit, "start");
    const last = this.edgeTabs(ws.rootSplit, "end");
    if (first) first.tabHeaderContainerEl.parentElement?.insertBefore(this.leftToggle, first.tabHeaderContainerEl.parentElement.firstChild);
    if (last) last.tabHeaderContainerEl.parentElement?.appendChild(this.rightToggle);
    this.leftToggle.setAttribute("aria-label", ws.leftSplit.collapsed ? "Expand left sidebar" : "Collapse left sidebar");
    this.rightToggle.setAttribute("aria-label", ws.rightSplit.collapsed ? "Expand right sidebar" : "Collapse right sidebar");
  }

  /** The tab group in the top-left ("start") or top-right ("end") corner of the main area. */
  private edgeTabs(p: WorkspaceParent, corner: "start" | "end"): WorkspaceTabs | null {
    const child = p instanceof WorkspaceSplit && p.direction === "vertical" && corner === "end" ? p.children[p.children.length - 1] : p.children[0];
    if (!child) return null;
    if (child instanceof WorkspaceTabs) return child;
    return child instanceof WorkspaceParent ? this.edgeTabs(child, corner) : null;
  }

  private buildRibbonFooter(): void {
    const ribbon = this.app.workspace.leftRibbon.containerEl;
    const foot = ribbon.createDiv({ cls: "side-dock-settings" });
    const add = (icon: string, label: string, cb: () => void) => {
      const el = foot.createDiv({ cls: "clickable-icon side-dock-ribbon-action", attr: { "aria-label": label, "data-tooltip-position": "right" } });
      setIcon(el, icon);
      el.addEventListener("click", cb);
      return el;
    };
    add("lucide-vault", "Manage vaults", () => { this.app.commands.executeCommandById("app:open-vault-switcher"); });
    add("lucide-settings", "Settings", () => { this.app.setting.open(); });
  }

  // ---------------------------------------------------------------- tabs
  private decorateTabs(tabs: WorkspaceTabs): void {
    const root = tabs.getRoot() === this.app.workspace.rootSplit;
    if (!(tabs.containerEl as any)._shell) {
      (tabs.containerEl as any)._shell = true;
      this.wireTabGroup(tabs, root);
    }
    for (const c of tabs.children) {
      const leaf = c as WorkspaceLeaf;
      if (!(leaf.tabHeaderEl as any)._shell) { (leaf.tabHeaderEl as any)._shell = true; this.wireTabHeader(leaf); }
      leaf.tabHeaderEl.toggleClass("mod-pinned", leaf.pinned);
      leaf.tabHeaderEl.toggleClass("is-active", tabs.children[tabs.currentTab] === leaf);
      leaf.tabHeaderEl.setAttribute("data-type", leaf.view.getViewType());
    }
    // keep the selected tab visible when the header bar overflows
    const inner = tabs.tabHeaderContainerEl;
    const cur = tabs.children[tabs.currentTab] as WorkspaceLeaf | undefined;
    if (cur && inner.scrollWidth > inner.clientWidth) {
      const el = cur.tabHeaderEl;
      if (el.offsetLeft < inner.scrollLeft) inner.scrollLeft = el.offsetLeft;
      else if (el.offsetLeft + el.offsetWidth > inner.scrollLeft + inner.clientWidth) inner.scrollLeft = el.offsetLeft + el.offsetWidth - inner.clientWidth;
    }
  }

  private wireTabGroup(tabs: WorkspaceTabs, mainArea: boolean): void {
    const bar = tabs.tabHeaderContainerEl.parentElement!;
    if (mainArea) {
      const plus = bar.createDiv({ cls: "workspace-tab-header-new-tab clickable-icon", attr: { "aria-label": "New tab" } });
      setIcon(plus, "lucide-plus");
      plus.addEventListener("click", () => {
        const leaf = (this.app.workspace as any).createLeafInTabs(tabs) as WorkspaceLeaf;
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      });
      const list = bar.createDiv({ cls: "workspace-tab-header-tab-list clickable-icon", attr: { "aria-label": "Open tabs" } });
      setIcon(list, "lucide-chevron-down");
      list.addEventListener("click", (e) => {
        const m = new Menu();
        for (const l of tabs.children as WorkspaceLeaf[]) m.addItem((i) => i.setTitle(l.getDisplayText()).setIcon(l.getIcon()).onClick(() => this.app.workspace.setActiveLeaf(l, { focus: true })));
        m.showAtMouseEvent(e);
      });
    }
    // header-bar drop target: reorder / move between groups
    bar.addEventListener("dragover", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      this.markDropHeader(tabs, e.clientX);
    });
    bar.addEventListener("dragleave", (e) => { if (!bar.contains(e.relatedTarget as Node | null)) this.clearDropMarks(); });
    bar.addEventListener("drop", (e) => {
      if (!this.drag) return;
      e.preventDefault();
      const idx = this.dropIndex(tabs, e.clientX);
      const leaf = this.drag;
      this.drag = null;
      this.clearDropMarks();
      this.moveLeaf(leaf, tabs, idx);
    });
    // content drop target: split or merge
    if (mainArea) {
      const body = tabs.tabContainerEl;
      body.addEventListener("dragover", (e) => {
        if (!this.drag) return;
        e.preventDefault();
        this.showZone(tabs, this.zoneAt(tabs, e));
      });
      body.addEventListener("dragleave", (e) => { if (!body.contains(e.relatedTarget as Node | null)) this.hideZone(tabs); });
      body.addEventListener("drop", (e) => {
        if (!this.drag) return;
        e.preventDefault();
        const zone = this.zoneAt(tabs, e);
        const leaf = this.drag;
        this.drag = null;
        this.hideZone(tabs);
        this.dropOnBody(leaf, tabs, zone);
      });
    }
  }

  private wireTabHeader(leaf: WorkspaceLeaf): void {
    const el = leaf.tabHeaderEl;
    el.draggable = true;
    const close = el.createDiv({ cls: "workspace-tab-header-inner-close-button", attr: { "aria-label": "Close" } });
    setIcon(close, "lucide-x");
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      if (leaf.pinned) leaf.setPinned(false); else leaf.detach();
    });
    close.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); if (!leaf.pinned) leaf.detach(); } });
    el.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.tabMenu(leaf, e); });
    el.addEventListener("dragstart", (e) => {
      this.drag = leaf;
      e.dataTransfer?.setData("application/x-tachylite-leaf", leaf.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      el.addClass("is-dragging");
      document.body.addClass("is-grabbing");
    });
    el.addEventListener("dragend", () => { this.drag = null; el.removeClass("is-dragging"); document.body.removeClass("is-grabbing"); this.clearDropMarks(); this.hideAllZones(); });
  }

  tabMenu(leaf: WorkspaceLeaf, e: MouseEvent): void {
    const ws = this.app.workspace;
    const menu = new Menu();
    const tabs = leaf.parent as WorkspaceTabs;
    const mainArea = leaf.getRoot() === ws.rootSplit;
    menu.addItem((i) => i.setSection("close").setTitle("Close").setIcon("lucide-x").onClick(() => leaf.detach()));
    menu.addItem((i) => i.setSection("close").setTitle("Close others").setIcon("lucide-x").onClick(() => { for (const l of [...tabs.children] as WorkspaceLeaf[]) if (l !== leaf && !l.pinned) l.detach(); }));
    menu.addItem((i) => i.setSection("close").setTitle("Close tabs to the right").onClick(() => { const idx = tabs.children.indexOf(leaf); for (const l of tabs.children.slice(idx + 1) as WorkspaceLeaf[]) if (!l.pinned) l.detach(); }));
    menu.addItem((i) => i.setSection("close").setTitle("Close all").onClick(() => { for (const l of [...tabs.children] as WorkspaceLeaf[]) if (!l.pinned) l.detach(); }));
    menu.addItem((i) => i.setSection("pin").setTitle(leaf.pinned ? "Unpin" : "Pin").setIcon("lucide-pin").onClick(() => leaf.togglePinned()));
    if (mainArea) {
      menu.addItem((i) => i.setSection("split").setTitle("Split right").setIcon("lucide-separator-vertical").onClick(() => { void ws.duplicateLeaf(leaf, "split", "vertical"); }));
      menu.addItem((i) => i.setSection("split").setTitle("Split down").setIcon("lucide-separator-horizontal").onClick(() => { void ws.duplicateLeaf(leaf, "split", "horizontal"); }));
      menu.addItem((i) => i.setSection("split").setTitle("Duplicate tab").setIcon("lucide-copy").onClick(() => { void ws.duplicateLeaf(leaf); }));
    }
    const v = leaf.view;
    if (v instanceof FileView && v.file) {
      const f = v.file;
      menu.addItem((i) => i.setSection("file").setTitle("Copy path").setIcon("lucide-clipboard").onClick(() => copyText(f.path)));
      menu.addItem((i) => i.setSection("file").setTitle("Reveal file in navigation").setIcon("lucide-folder-search").onClick(() => revealInExplorer(this.app, f)));
      buildFileMenu(this.app, f, "tab-header", menu);
    }
    v.onPaneMenu(menu, "tab-header");
    menu.showAtMouseEvent(e);
  }

  // ---------------------------------------------------------------- drag & drop
  private dropIndex(tabs: WorkspaceTabs, x: number): number {
    let idx = 0;
    for (const l of tabs.children as WorkspaceLeaf[]) {
      const r = l.tabHeaderEl.getBoundingClientRect();
      if (x > r.left + r.width / 2) idx++;
    }
    return idx;
  }
  private markDropHeader(tabs: WorkspaceTabs, x: number): void {
    this.clearDropMarks();
    const idx = this.dropIndex(tabs, x);
    const kids = tabs.children as WorkspaceLeaf[];
    if (idx < kids.length) kids[idx].tabHeaderEl.addClass("mod-drop-before");
    else kids[kids.length - 1]?.tabHeaderEl.addClass("mod-drop-after");
  }
  private clearDropMarks(): void {
    this.app.dom.appContainerEl.querySelectorAll(".mod-drop-before, .mod-drop-after").forEach((e) => e.classList.remove("mod-drop-before", "mod-drop-after"));
  }
  private zoneAt(tabs: WorkspaceTabs, e: DragEvent): Zone {
    const r = tabs.tabContainerEl.getBoundingClientRect();
    const fx = (e.clientX - r.left) / Math.max(1, r.width), fy = (e.clientY - r.top) / Math.max(1, r.height);
    if (fx < 0.22) return "left";
    if (fx > 0.78) return "right";
    if (fy < 0.22) return "top";
    if (fy > 0.78) return "bottom";
    return "center";
  }
  private overlayOf(tabs: WorkspaceTabs): HTMLElement {
    let o = tabs.containerEl.querySelector<HTMLElement>(":scope > .workspace-drop-overlay");
    if (!o) o = tabs.containerEl.createDiv({ cls: "workspace-drop-overlay" });
    return o;
  }
  private showZone(tabs: WorkspaceTabs, zone: Zone): void {
    this.hideAllZones();
    const o = this.overlayOf(tabs);
    o.className = `workspace-drop-overlay mod-${zone} is-visible`;
  }
  private hideZone(tabs: WorkspaceTabs): void { tabs.containerEl.querySelector(":scope > .workspace-drop-overlay")?.remove(); }
  private hideAllZones(): void { this.app.dom.appContainerEl.querySelectorAll(".workspace-drop-overlay").forEach((e) => e.remove()); }

  private dropOnBody(leaf: WorkspaceLeaf, tabs: WorkspaceTabs, zone: Zone): void {
    const ws = this.app.workspace;
    const from = leaf.parent as WorkspaceTabs;
    if (zone === "center") { this.moveLeaf(leaf, tabs, tabs.children.length); return; }
    if (from === tabs && tabs.children.length === 1) return;
    const target = tabs.children[tabs.currentTab] as WorkspaceLeaf | undefined;
    if (!target) return;
    const dir = zone === "left" || zone === "right" ? "vertical" : "horizontal";
    const before = zone === "left" || zone === "top";
    const holder = ws.createLeafBySplit(target, dir, before);
    const dest = holder.parent as WorkspaceTabs;
    this.moveLeaf(leaf, dest, 0);
    if (holder.parent) holder.detach();
  }

  /** Move a leaf to `index` of another (or the same) tab group. */
  moveLeaf(leaf: WorkspaceLeaf, target: WorkspaceTabs, index: number): void {
    const ws = this.app.workspace;
    const from = leaf.parent as WorkspaceTabs | null;
    if (!(from instanceof WorkspaceTabs)) return;
    if (from === target) {
      const cur = from.children.indexOf(leaf);
      if (index > cur) index--;
      if (index === cur) return;
      from.children.splice(cur, 1);
      from.children.splice(index, 0, leaf);
      const hdr = from.tabHeaderContainerEl;
      hdr.insertBefore(leaf.tabHeaderEl, (from.children[index + 1] as WorkspaceLeaf | undefined)?.tabHeaderEl ?? null);
      const body = from.tabContainerEl;
      body.insertBefore(leaf.containerEl, (from.children[index + 1] as WorkspaceLeaf | undefined)?.containerEl ?? null);
      from.selectTab(leaf);
    } else {
      // never leave the main area without a leaf
      if (from.getRoot() === ws.rootSplit && ws.rootSplit.leaves().length === 1) return;
      from.removeChild(leaf);
      target.insertChild(Math.min(index, target.children.length), leaf);
      target.selectTab(leaf);
    }
    ws.setActiveLeaf(leaf);
    ws.trigger("layout-change");
    this.scheduleDecorate();
    ws.requestSaveLayout();
  }

  // ---------------------------------------------------------------- global behaviour
  /** Clicking anywhere inside a pane makes it the active leaf (sidebars included). */
  private installFocusTracking(): void {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const el = t?.closest?.(".workspace-leaf") as HTMLElement | null;
      if (!el) return;
      const leaf = this.app.workspace.allLeaves().find((l) => l.containerEl === el);
      if (leaf && leaf !== this.app.workspace.activeLeaf) this.app.workspace.setActiveLeaf(leaf);
    };
    document.addEventListener("mousedown", handler, true);
    this.cleanups.push(() => document.removeEventListener("mousedown", handler, true));
  }

  /** Flush pending editor saves and the layout when the window is hidden or closed. */
  flush(): void {
    for (const l of this.app.workspace.allLeaves()) if (l.view instanceof TextFileView) l.view.requestSave.run();
    this.app.workspace.requestSaveLayout.run();
  }
  /** Await every pending note save and write the layout (used before the window closes). */
  async flushAsync(): Promise<void> {
    const saves = this.app.workspace.allLeaves().map((l) => (l.view instanceof TextFileView ? l.view.save() : Promise.resolve()));
    await Promise.allSettled(saves);
    this.app.workspace.requestSaveLayout.cancel();
    await this.saveLayout(this.app.workspace.getLayout());
  }
  private installSaveOnHide(): void {
    const vis = () => { if (document.visibilityState === "hidden") this.flush(); };
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("beforeunload", () => this.flush());
    window.addEventListener("blur", () => this.flush());
    this.cleanups.push(() => document.removeEventListener("visibilitychange", vis));
  }
}
