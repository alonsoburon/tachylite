// The `canvas` view for .canvas files: a TextFileView (so plugins' instanceof checks and requestSave work) whose
// `canvas` property is the engine plugins script against. Adds the editing chrome: selection toolbar, colour
// picker, card toolbar, context menus, file pickers and inline label editing.
import { FuzzySuggestModal, Menu, TFile, TextFileView, setIcon, type App, type WorkspaceLeaf } from "../obsidian";
import { Canvas, buildControls, type CanvasItem } from "./canvas";
import { parseCanvas, serializeCanvas, type CanvasColor, type Point } from "./model";
import { CanvasEdge, CanvasFileNode, CanvasGroupNode, CanvasNode, CanvasTextNode, applyColor } from "./nodes";

export const CANVAS_VIEW = "canvas";
const MEDIA = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "mp3", "wav", "m4a", "ogg", "3gp", "flac", "opus", "mp4", "webm", "ogv", "mov", "mkv", "pdf"]);

/** Pick a vault file (notes or media). */
export class CanvasFileSuggestModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private filter: (f: TFile) => boolean, private onPick: (f: TFile) => void, placeholder: string) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getItems(): TFile[] { return this.app.vault.getFiles().filter(this.filter).sort((a, b) => b.stat.mtime - a.stat.mtime); }
  getItemText(f: TFile): string { return f.extension === "md" ? f.path.slice(0, -3) : f.path; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}
export const isNote = (f: TFile): boolean => f.extension === "md";
export const isMedia = (f: TFile): boolean => MEDIA.has(f.extension.toLowerCase());

const COLORS: [CanvasColor, string][] = [["1", "Red"], ["2", "Orange"], ["3", "Yellow"], ["4", "Green"], ["5", "Cyan"], ["6", "Purple"]];
type Opener = (url: string) => void;
let urlOpener: Opener = (url) => { window.open(url, "_blank", "noopener"); };
/** The shell routes external URLs through the OS (installed by the core module). */
export function setCanvasUrlOpener(fn: Opener): void { urlOpener = fn; }

export class CanvasView extends TextFileView {
  canvas: Canvas;
  private menuEl: HTMLElement;
  private submenuEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private parseError: string | null = null;
  private fitPending = false;
  private resizeObs: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-layout-dashboard";
    this.contentEl.addClass("canvas-view-content");
    this.canvas = new Canvas(this.app, {
      sourcePath: () => this.file?.path ?? "",
      requestSave: () => this.markDirty(),
      openUrl: (u) => urlOpener(u),
      onSelectionChange: () => this.updateMenu(),
      onViewportChange: () => this.positionMenu(),
      onContextMenu: (e, item, pos) => this.showContextMenu(e, item, pos),
      onLabelEdit: (item) => this.editLabel(item),
    }, this.contentEl);
    (this.canvas as any).view = this;
    buildControls(this.canvas);
    this.menuEl = this.canvas.wrapperEl.createDiv({ cls: "canvas-menu-container" }).createDiv({ cls: "canvas-menu" });
    this.menuEl.parentElement!.hide();
    this.buildCardMenu();
    this.addAction("lucide-more-vertical", "More options", (e) => this.showMoreMenu(e));
  }
  getViewType(): string { return CANVAS_VIEW; }
  getIcon(): string { return "lucide-layout-dashboard"; }
  canAcceptExtension(ext: string): boolean { return ext === "canvas"; }

  onload(): void {
    super.onload();
    const vault = this.app.vault;
    const fileNodes = () => [...this.canvas.nodes.values()].filter((n): n is CanvasFileNode => n instanceof CanvasFileNode);
    this.registerEvent(vault.on("modify", (f: any) => { for (const n of fileNodes()) if (n.filePath === f.path) n.onFileModified(); }));
    this.registerEvent(vault.on("create", (f: any) => { for (const n of fileNodes()) if (n.filePath === f.path) n.onFileModified(); }));
    this.registerEvent(vault.on("delete", (f: any) => { for (const n of fileNodes()) if (n.filePath === f.path) n.render(); }));
    // A card follows its file when it is renamed or moved (the file on disk is updated by the next save).
    this.registerEvent(vault.on("rename", (f: any, old: string) => {
      for (const n of fileNodes()) if (n.filePath === old) n.setFilePath(f.path, n.subpath);
      for (const n of this.canvas.nodes.values()) if (n instanceof CanvasGroupNode && n.background === old) { n.background = f.path; n.render(); this.canvas.requestSave(); }
    }));
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => { this.canvas.onResize(); if (this.fitPending) this.fitWhenSized(); });
      this.resizeObs.observe(this.contentEl);
    }
  }
  onunload(): void { this.resizeObs?.disconnect(); this.canvas.destroy(); super.onunload(); }
  onResize(): void { this.canvas.onResize(); }

  getViewData(): string {
    if (this.parseError !== null) return this.data;
    return serializeCanvas(this.canvas.getData());
  }
  setViewData(data: string, clear: boolean): void {
    this.errorEl?.remove(); this.errorEl = null;
    let parsed;
    try { parsed = parseCanvas(data); this.parseError = null; }
    catch (e) {
      // Never overwrite a file we could not read.
      this.parseError = String((e as Error).message ?? e);
      this.canvas.clear();
      this.canvas.setReadonly(true);
      this.errorEl = this.contentEl.createDiv({ cls: "canvas-placeholder-message", text: `This canvas could not be read: ${this.parseError}` });
      return;
    }
    if (this.canvas.readonly && !(this.canvas as any).lockedReadonly) this.canvas.setReadonly(false);
    const keep = new Set([...this.canvas.selection].map((i) => i.id));
    this.canvas.setData(parsed);
    if (clear) { this.canvas.history.past = []; this.canvas.history.future = []; this.fitPending = true; this.fitWhenSized(); }
    else this.canvas.selectOnlyMany([...keep].map((id) => this.canvas.nodes.get(id) ?? this.canvas.edges.get(id)).filter((i): i is CanvasItem => !!i));
  }
  /** Zoom to fit once the view has a size (a freshly opened leaf may not be laid out yet). */
  private fitWhenSized(): void {
    if (!this.contentEl.isConnected || !this.canvas.wrapperEl.clientWidth) {
      if (!this.resizeObs) { this.fitPending = false; this.canvas.zoomToFit(); }
      return;
    }
    this.fitPending = false;
    this.canvas.zoomToFit();
  }
  clear(): void { this.canvas.clear(); }

  getEphemeralState(): Record<string, unknown> { return { x: this.canvas.x, y: this.canvas.y, zoom: this.canvas.zoom }; }
  setEphemeralState(state: any): void {
    if (state && typeof state.x === "number" && typeof state.y === "number" && typeof state.zoom === "number") { this.fitPending = false; this.canvas.setViewport(state.x, state.y, state.zoom); }
    if (state?.focus) this.canvas.wrapperEl.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- chrome
  private nodeSel(): CanvasNode[] { return [...this.canvas.selection].filter((i): i is CanvasNode => i instanceof CanvasNode); }
  private edgeSel(): CanvasEdge[] { return [...this.canvas.selection].filter((i): i is CanvasEdge => i instanceof CanvasEdge); }

  private updateMenu(): void {
    const c = this.canvas, box = this.menuEl?.parentElement;
    if (!c || !box) return; // during construction
    this.submenuEl?.remove(); this.submenuEl = null;
    const b = c.getSelectionBBox();
    if (!b || c.readonly || this.contentEl.querySelector(".canvas-wrapper.is-dragging")) { box.hide(); return; }
    this.menuEl.empty();
    const btn = (icon: string, label: string, fn: (el: HTMLElement) => void, cls = "") => {
      const el = this.menuEl.createEl("button", { cls: `clickable-icon ${cls}`.trim(), attr: { "aria-label": label } });
      setIcon(el, icon);
      el.addEventListener("click", (e) => { e.stopPropagation(); fn(el); });
      return el;
    };
    const nodes = this.nodeSel(), edges = this.edgeSel();
    btn("lucide-trash-2", "Remove", () => c.deleteSelection());
    btn("lucide-palette", "Set color", (el) => this.toggleColorPicker(el));
    btn("lucide-scan", "Zoom to selection", () => c.zoomToSelection());
    if (nodes.length === 1 && nodes[0].isEditable()) btn("lucide-pencil", "Edit", () => nodes[0].startEditing());
    if (nodes.length === 1 && nodes[0] instanceof CanvasGroupNode) btn("lucide-text-cursor-input", "Edit label", () => this.editLabel(nodes[0] as CanvasGroupNode));
    if (nodes.length > 1) btn("lucide-group", "Create group", () => c.createGroupFromSelection());
    if (edges.length === 1 && !nodes.length) {
      btn("lucide-text-cursor-input", "Edit label", () => this.editLabel(edges[0]));
      btn("lucide-arrow-right-left", "Line direction", (el) => { const r = el.getBoundingClientRect(); this.directionMenu(edges[0]).showAtPosition({ x: r.left, y: r.bottom }); });
    }
    box.show();
    this.positionMenu();
  }
  private positionMenu(): void {
    const box = this.menuEl?.parentElement, b = this.canvas?.getSelectionBBox();
    if (!box || !b) return;
    const top = this.canvas.posToWrapper({ x: (b.minX + b.maxX) / 2, y: b.minY });
    box.style.left = `${top.x}px`;
    box.style.top = `${Math.max(8, top.y - 52)}px`;
  }

  private toggleColorPicker(anchor: HTMLElement): void {
    if (this.submenuEl) { this.submenuEl.remove(); this.submenuEl = null; return; }
    const sub = (this.submenuEl = this.menuEl.parentElement!.createDiv({ cls: "canvas-submenu canvas-color-picker" }));
    const items = [...this.canvas.selection];
    const current = items.length === 1 ? items[0].color : null;
    const apply = (color: CanvasColor) => {
      this.canvas.pushHistory();
      for (const i of this.canvas.selection) i.setColor(color, false);
      this.updateMenu();
    };
    const none = sub.createDiv({ cls: "canvas-color-picker-item mod-none", attr: { "aria-label": "No color" } });
    setIcon(none, "lucide-ban");
    none.toggleClass("is-active", current === "");
    none.addEventListener("click", () => apply(""));
    for (const [id, name] of COLORS) {
      const el = sub.createDiv({ cls: "canvas-color-picker-item", attr: { "aria-label": name, "data-color": id } });
      applyColor(el, id);
      el.toggleClass("is-active", current === id);
      el.addEventListener("click", () => apply(id));
    }
    const custom = sub.createEl("input", { cls: "canvas-color-picker-custom", attr: { type: "color", "aria-label": "Custom color" } });
    if (current && current.startsWith("#")) custom.value = current.length === 4 ? "#" + [...current.slice(1)].map((ch) => ch + ch).join("") : current.slice(0, 7);
    custom.addEventListener("change", () => apply(custom.value));
    sub.style.left = `${anchor.offsetLeft}px`;
  }

  private directionMenu(edge: CanvasEdge): Menu {
    const m = new Menu();
    const set = (from: "none" | "arrow", to: "none" | "arrow") => edge.setData({ fromEnd: from, toEnd: to }, true);
    m.addItem((i) => i.setTitle("Nondirectional").setChecked(edge.from.end === "none" && edge.to.end === "none").onClick(() => set("none", "none")));
    m.addItem((i) => i.setTitle("One-way").setChecked(edge.from.end === "none" && edge.to.end === "arrow").onClick(() => set("none", "arrow")));
    m.addItem((i) => i.setTitle("Bidirectional").setChecked(edge.from.end === "arrow" && edge.to.end === "arrow").onClick(() => set("arrow", "arrow")));
    m.addItem((i) => i.setTitle("Flip direction").setIcon("lucide-repeat").onClick(() => {
      const d = edge.getData();
      edge.setData({ fromNode: d.toNode, toNode: d.fromNode, fromSide: d.toSide, toSide: d.fromSide, fromEnd: d.toEnd ?? "arrow", toEnd: d.fromEnd ?? "none" }, true);
    }));
    return m;
  }

  /** Inline editor for an edge label or a group label. */
  editLabel(item: CanvasEdge | CanvasGroupNode): void {
    if (this.canvas.readonly) return;
    const c = this.canvas;
    const at = item instanceof CanvasEdge ? (item.geometry?.mid ?? { x: 0, y: 0 }) : { x: item.x, y: item.y };
    const p = c.posToWrapper(at);
    const input = c.wrapperEl.createEl("input", { cls: "canvas-path-label-editor", attr: { type: "text", placeholder: item instanceof CanvasEdge ? "Label" : "Group name" } });
    input.value = item.label;
    Object.assign(input.style, { left: `${p.x}px`, top: `${p.y}px` });
    if (item instanceof CanvasGroupNode) input.addClass("mod-group");
    let done = false;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      input.remove();
      if (commit && v !== item.label) { c.pushHistory(); item.setLabel(v); }
      c.wrapperEl.focus({ preventScroll: true });
    };
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); });
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }

  private buildCardMenu(): void {
    const bar = this.canvas.wrapperEl.createDiv({ cls: "canvas-card-menu" });
    const add = (icon: string, label: string, fn: () => void) => {
      const b = bar.createDiv({ cls: "canvas-card-menu-button mod-draggable", attr: { "aria-label": label, "data-tooltip-position": "top" } });
      setIcon(b, icon);
      b.addEventListener("click", (e) => { e.stopPropagation(); if (!this.canvas.readonly) fn(); });
    };
    const center = () => { const b = this.canvas.getViewportBBox(); return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }; };
    add("lucide-sticky-note", "Add card", () => this.addTextCard(center()));
    add("lucide-file-text", "Add note from vault", () => this.pickFile(center(), isNote, "Search for a note to add"));
    add("lucide-image", "Add media from vault", () => this.pickFile(center(), isMedia, "Search for media to add"));
  }
  addTextCard(pos: Point): CanvasTextNode { const n = this.canvas.createTextNode({ pos }); n.startEditing(); return n; }
  /** Open a picker and add the chosen file as a card at `pos`. */
  pickFile(pos: Point, filter: (f: TFile) => boolean = () => true, placeholder = "Search for a file to add"): CanvasFileSuggestModal {
    const m = new CanvasFileSuggestModal(this.app, (f) => filter(f) && f !== this.file, (f) => { this.canvas.createFileNode({ pos, file: f }); }, placeholder);
    m.open();
    return m;
  }

  private showContextMenu(e: MouseEvent, item: CanvasItem | null, pos: Point): void {
    const c = this.canvas, m = new Menu();
    if (!item) {
      if (!c.readonly) {
        m.addItem((i) => i.setSection("create").setTitle("Add card").setIcon("lucide-sticky-note").onClick(() => this.addTextCard(pos)));
        m.addItem((i) => i.setSection("create").setTitle("Add note from vault").setIcon("lucide-file-text").onClick(() => this.pickFile(pos, isNote, "Search for a note to add")));
        m.addItem((i) => i.setSection("create").setTitle("Add media from vault").setIcon("lucide-image").onClick(() => this.pickFile(pos, isMedia, "Search for media to add")));
        m.addItem((i) => i.setSection("create").setTitle("Add group").setIcon("lucide-group").onClick(() => { const g = c.createGroupNode({ pos }); this.editLabel(g); }));
      }
      m.addItem((i) => i.setSection("view").setTitle("Select all").setIcon("lucide-box-select").onClick(() => c.selectAll()));
      m.addItem((i) => i.setSection("view").setTitle("Zoom to fit").setIcon("lucide-maximize").onClick(() => c.zoomToFit()));
    } else {
      const nodes = this.nodeSel();
      if (item instanceof CanvasFileNode && item.file) {
        const f = item.file;
        m.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => { void this.app.workspace.getLeaf("tab").openFile(f, { active: true, ...(item.subpath ? { eState: { subpath: item.subpath } } : {}) }); }));
      }
      if (item instanceof CanvasNode && item.type === "link") m.addItem((i) => i.setSection("open").setTitle("Open link").setIcon("lucide-external-link").onClick(() => urlOpener((item as any).url)));
      if (!c.readonly) {
        if (item instanceof CanvasNode && item.isEditable()) m.addItem((i) => i.setSection("action").setTitle("Edit").setIcon("lucide-pencil").onClick(() => item.startEditing()));
        if (item instanceof CanvasEdge || item instanceof CanvasGroupNode) m.addItem((i) => i.setSection("action").setTitle("Edit label").setIcon("lucide-text-cursor-input").onClick(() => this.editLabel(item)));
        if (item instanceof CanvasEdge) {
          for (const mi of this.directionMenu(item).items as any[]) if (mi.titleEl) m.addItem((i) => { i.setSection("direction").setTitle(mi.titleEl.textContent).onClick((ev) => mi.callback?.(ev)); if (mi.checked) i.setChecked(true); });
        }
        if (nodes.length > 1) m.addItem((i) => i.setSection("action").setTitle("Create group").setIcon("lucide-group").onClick(() => c.createGroupFromSelection()));
        for (const [id, name] of [["", "No color"], ...COLORS] as [string, string][]) {
          m.addItem((i) => i.setSection("color").setTitle(name).setChecked(item.color === id).onClick(() => { c.pushHistory(); for (const s of c.selection) s.setColor(id, false); }));
        }
        m.addItem((i) => i.setSection("action").setTitle("Duplicate").setIcon("lucide-copy").setDisabled(!nodes.length).onClick(() => c.duplicate()));
        m.addItem((i) => i.setSection("danger").setTitle("Remove").setIcon("lucide-trash-2").setWarning(true).onClick(() => c.deleteSelection()));
      }
      m.addItem((i) => i.setSection("view").setTitle("Zoom to selection").setIcon("lucide-scan").onClick(() => c.zoomToSelection()));
    }
    if (item) this.app.workspace.trigger(item instanceof CanvasEdge ? "canvas:edge-menu" : "canvas:node-menu", m, item);
    m.showAtMouseEvent(e);
  }

  private showMoreMenu(evt: MouseEvent): void {
    const m = new Menu();
    m.addItem((i) => i.setSection("view").setTitle("Zoom to fit").setIcon("lucide-maximize").onClick(() => this.canvas.zoomToFit()));
    m.addItem((i) => i.setSection("view").setTitle("Snap to grid").setChecked(this.canvas.options.snapToGrid).onClick(() => { this.canvas.options.snapToGrid = !this.canvas.options.snapToGrid; }));
    m.addItem((i) => i.setSection("pane").setTitle("Split right").setIcon("lucide-separator-vertical").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "vertical"); }));
    m.addItem((i) => i.setSection("pane").setTitle("Split down").setIcon("lucide-separator-horizontal").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "horizontal"); }));
    if (this.file) this.app.workspace.trigger("file-menu", m, this.file, "more-options", this.leaf);
    this.onPaneMenu(m, "more-options");
    m.showAtMouseEvent(evt);
  }
}
