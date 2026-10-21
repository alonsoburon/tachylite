// Graph views: the global graph ("graph", options in .obsidian/graph.json) and the local graph ("localgraph", options in
// its view state, following the active file). Canvas rendering batched per colour with viewport culling; the force
// layout runs in requestAnimationFrame and stops once settled; redraws are coalesced to one per frame.
import { Keymap, Menu, Setting, setIcon, TFile, debounce, type App, type WorkspaceLeaf } from "../../../obsidian";
import { ipc } from "../../../ipc";
import { buildFileMenu } from "../../files";
import { PanelView } from "../util";
import { bookmarkGraphView, getStore } from "../bookmarks";
import { collapseIcon } from "../panel";
import {
  DEFAULT_LOCAL, appearTimes, applyGroups, buildGraph, subGraph, normalizeLocal, normalizeOptions,
  type GraphNode, type GraphOptions, type LocalOptions, type NodeKind,
} from "./model";
import { bounds, createSimulation, forcesFrom, hitTest, isSettled, reheat, stepSimulation, type SimState } from "./sim";

export const GRAPH_VIEW = "graph";
export const LOCAL_GRAPH_VIEW = "localgraph";

interface Viewport { k: number; x: number; y: number }
interface Colors { fill: string; focused: string; tag: string; attachment: string; unresolved: string; line: string; lineHi: string; text: string; arrow: string; highlight: string; circle: string }

/** Results of search queries (filter and colour groups) through the backend search, cached until the vault changes. */
export class QueryCache {
  private map = new Map<string, Set<string> | null>();
  private pending = new Set<string>();
  constructor(private onResult: () => void, private run: (q: string) => Promise<{ path: string }[]> = (q) => ipc.vaultSearch(q) as any) {}
  /** The matching files; `undefined` while the backend is still answering (onResult fires once it does). */
  get(query: string): Set<string> | null | undefined {
    const q = query.trim();
    if (!q) return null;
    if (this.map.has(q)) return this.map.get(q)!;
    if (!this.pending.has(q)) {
      this.pending.add(q);
      void this.run(q).then((hits) => { this.map.set(q, new Set((hits ?? []).map((h) => h.path))); }, () => { this.map.set(q, new Set()); })
        .finally(() => { this.pending.delete(q); this.onResult(); });
    }
    return undefined;
  }
  clear(): void { this.map.clear(); }
}

const rgbHex = (n: number) => "#" + (n & 0xffffff).toString(16).padStart(6, "0");
const hexRgb = (s: string) => parseInt(s.replace("#", ""), 16) || 0;

export abstract class BaseGraphView extends PanelView {
  options: GraphOptions = normalizeOptions({});
  sim: SimState = createSimulation({ nodes: [], links: [] }, forcesFrom(this.options));
  view: Viewport = { k: 1, x: 0, y: 0 };
  hover = -1;
  /** HoverParent: the page preview of the hovered node. */
  hoverPopover: any = null;
  canvas!: HTMLCanvasElement;
  controlsEl!: HTMLElement;
  queries: QueryCache;
  /** Fit the drawing to the view while the layout is young, until the user pans or zooms. */
  autoFit = true;
  protected width = 800;
  protected height = 600;
  private raf = 0;
  private colors: Colors | null = null;
  private probeEl: HTMLElement | null = null;
  protected activePath: string | null = null;
  private dragNode = -1;
  private panning = false;
  private moved = 0;
  private last = { x: 0, y: 0 };
  private searchToken = "";
  /** Frames drawn (tests and profiling). */
  frames = 0;
  /** While the time-lapse runs: the cutoff time (ms since epoch); nodes created later are left out. */
  animCutoff: number | null = null;
  private animTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = true;
    this.queries = new QueryCache(() => this.requestRefresh(0));
    this.addAction("lucide-more-vertical", "More options", (evt) => {
      const m = new Menu();
      m.addItem((i) => i.setSection("window").setTitle("Split right").setIcon("lucide-separator-vertical").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "vertical"); }));
      m.addItem((i) => i.setSection("window").setTitle("Split down").setIcon("lucide-separator-horizontal").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "horizontal"); }));
      this.onPaneMenu(m, "more-options");
      m.showAtMouseEvent(evt);
    });
  }
  getIcon(): string { return "lucide-git-fork"; }
  abstract get isLocal(): boolean;
  /** Persist options (graph.json or the leaf state). */
  protected abstract saveOptions(): void;
  /** Files and options the graph is built from. */
  protected abstract localCenter(): string | null;

  async onOpen(): Promise<void> {
    const root = this.contentEl.createDiv({ cls: "graph-view-container" });
    this.canvas = root.createEl("canvas", { cls: "graph-view-canvas" });
    this.controlsEl = root.createDiv({ cls: "graph-controls" });
    this.probeEl = root.createDiv({ cls: "graph-color-probes" });
    const c = this.canvas;
    this.registerDomEvent(c, "pointerdown", (e) => this.onDown(e));
    this.registerDomEvent(c, "pointermove", (e) => this.onMove(e));
    this.registerDomEvent(c, "pointerup", (e) => this.onUp(e));
    this.registerDomEvent(c, "pointerleave", (e) => { if (this.hover !== -1 && this.dragNode < 0) { this.hover = -1; this.requestDraw(); this.onHoverChange(e); } });
    this.registerDomEvent(c, "wheel", (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(c, "contextmenu", (e) => this.onContext(e));
    const mc = this.app.metadataCache as any;
    this.registerEvent(mc.on("resolved", () => { this.queries.clear(); this.requestRefresh(250); }));
    for (const ev of ["create", "delete", "rename"] as const) this.registerEvent(this.app.vault.on(ev as any, () => { this.queries.clear(); this.requestRefresh(250); }));
    const sync = () => this.onActiveFileChange();
    this.registerEvent(this.app.workspace.on("file-open", sync));
    this.registerEvent(this.app.workspace.on("active-leaf-change", sync));
    this.registerEvent(this.app.workspace.on("css-change", () => { this.colors = null; this.sprites.clear(); this.requestDraw(); }));
    if (typeof ResizeObserver !== "undefined") { const ro = new ResizeObserver(() => this.onResize()); ro.observe(root); this.register(() => ro.disconnect()); }
    this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
    await this.loadOptions();
    this.renderControls();
    this.onResize();
    this.rebuild();
  }
  protected async loadOptions(): Promise<void> {}
  /** Replace the settings (a bookmark's, say) and redraw; the global graph writes them to graph.json like a change made by hand. */
  applyOptions(raw: unknown): void {
    this.options = normalizeOptions(raw);
    if (this.options.scale) this.view.k = this.options.scale;
    if (this.canvas) { this.renderControls(); this.rebuild(); }
    this.saveOptions();
  }
  /** Tab header and "More options" menus: bookmarking the graph with its settings (the global graph only). */
  onPaneMenu(menu: Menu, _source: string): void {
    if (this.isLocal || !getStore(this.app)) return;
    menu.addItem((i) => i.setSection("action").setTitle("Bookmark...").setIcon("lucide-bookmark").onClick(() => bookmarkGraphView(this.app, this.options as unknown as Record<string, unknown>)));
  }
  async onClose(): Promise<void> { this.stopAnimation(); if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  protected onActiveFileChange(): void {
    const p = this.app.workspace.getActiveFile()?.path ?? null;
    if (p !== this.activePath) { this.activePath = p; this.requestDraw(); }
  }

  onResize(): void {
    if (!this.canvas) return;
    const w = this.canvas.parentElement?.clientWidth || this.width, h = this.canvas.parentElement?.clientHeight || this.height;
    this.width = w; this.height = h;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.requestDraw();
  }

  refresh(): void { this.rebuild(); }

  /** Recompute nodes/edges, keeping the positions of nodes that already existed. */
  rebuild(): void {
    const o = this.options;
    const match = o.search.trim() ? this.queries.get(o.search) : null;
    if (match === undefined) return; // waiting for the search backend; refresh() runs again when it answers
    const mc = this.app.metadataCache;
    const center = this.localCenter();
    const local = this.isLocal ? (center ? { center, ...this.localOptions() } : null) : null;
    if (this.isLocal && !local) { this.setData({ nodes: [], links: [] }); return; }
    const files = this.app.vault.getFiles().map((f) => f.path);
    const data = buildGraph({
      resolved: mc.resolvedLinks, unresolved: mc.unresolvedLinks, files,
      tagsOf: (p) => { const f = this.app.vault.getFileByPath(p); const c = f ? mc.getFileCache(f) : null; return c ? tagsOfCache(c) : []; },
    }, { showTags: o.showTags, showAttachments: o.showAttachments, hideUnresolved: o.hideUnresolved, showOrphans: o.showOrphans, match, local });
    this.setData(this.animCutoff === null ? data : this.animated(data, this.animCutoff));
  }

  private creationTimes(data: { nodes: GraphNode[]; links: { source: number; target: number }[] }): number[] {
    return appearTimes(data, (id) => this.app.vault.getFileByPath(id)?.stat.ctime);
  }
  private animated(data: { nodes: GraphNode[]; links: { source: number; target: number }[] }, cutoff: number): { nodes: GraphNode[]; links: { source: number; target: number }[] } {
    const t = this.creationTimes(data);
    return subGraph(data, (i) => t[i] <= cutoff);
  }

  get isAnimating(): boolean { return this.animCutoff !== null; }
  /** Replay the graph growing by note creation time over `durationMs`; calling it again restarts. */
  startAnimation(durationMs = 6000, stepMs = 100): void {
    this.stopAnimation(false);
    const mc = this.app.metadataCache;
    const data = buildGraph({ resolved: mc.resolvedLinks, unresolved: mc.unresolvedLinks, files: this.app.vault.getFiles().map((f) => f.path) }, { showTags: this.options.showTags, showAttachments: this.options.showAttachments, hideUnresolved: this.options.hideUnresolved, showOrphans: this.options.showOrphans });
    const times = this.creationTimes(data);
    const lo = Math.min(...times, Infinity), hi = Math.max(...times, -Infinity);
    if (!times.length || lo === hi) { this.animCutoff = null; this.rebuild(); return; }
    const t0 = Date.now();
    // Start from the oldest nodes only, so the first frame already shows the beginning.
    this.animCutoff = lo;
    this.setData({ nodes: [], links: [] });
    this.autoFit = true;
    const tick = () => {
      const f = Math.min(1, (Date.now() - t0) / durationMs);
      if (f >= 1) { this.stopAnimation(); return; }
      this.animCutoff = lo + (hi - lo) * f;
      this.rebuild();
      this.animTimer = setTimeout(tick, stepMs);
    };
    tick();
  }
  /** Stop the time-lapse; the full graph comes back (unless `restore` is false). */
  stopAnimation(restore = true): void {
    if (this.animTimer) { clearTimeout(this.animTimer); this.animTimer = null; }
    if (this.animCutoff === null) return;
    this.animCutoff = null;
    if (restore) this.rebuild();
  }
  protected localOptions(): LocalOptions { return DEFAULT_LOCAL; }

  private setData(data: { nodes: GraphNode[]; links: { source: number; target: number }[] }): void {
    const old = new Map(this.sim.nodes.map((n) => [n.id, n]));
    const fresh = createSimulation(data, forcesFrom(this.options));
    let reused = 0;
    for (const n of fresh.nodes) { const o = old.get(n.id); if (o) { n.x = o.x; n.y = o.y; reused++; } }
    if (reused) {
      // Brand-new nodes start next to a neighbour that already has a position.
      const placed = new Set(fresh.nodes.filter((n) => old.has(n.id)));
      for (const l of fresh.links) {
        const a = fresh.nodes[l.source], b = fresh.nodes[l.target];
        if (placed.has(a) && !placed.has(b)) { b.x = a.x + 8; b.y = a.y + 8; placed.add(b); }
        else if (placed.has(b) && !placed.has(a)) { a.x = b.x - 8; a.y = b.y - 8; placed.add(a); }
      }
    } else this.autoFit = true;
    // A local graph keeps its centre in the middle.
    if (this.isLocal) for (const n of fresh.nodes) if (n.depth === 0) { if (!reused) { n.x = 0; n.y = 0; } }
    fresh.alpha = reused ? 0.3 : 1;
    this.sim = fresh;
    this.hover = -1;
    this.recolor();
    this.kick();
  }

  /** Re-apply colour groups (their queries may still be pending; they repaint when answered). */
  recolor(): void {
    const groups = this.options.colorGroups.map((g) => ({ color: g.color.rgb, files: g.query.trim() ? this.queries.get(g.query) ?? null : null }));
    applyGroups(this.sim.nodes, groups);
    this.requestDraw();
  }

  // ---- frame loop
  /** Start the layout (it stops by itself once settled). */
  kick(): void { this.requestDraw(); }
  /** One frame: a simulation tick while hot, fit, draw. Calls coalesce into a single animation frame. */
  requestDraw(): void {
    if (this.raf) return;
    if (typeof requestAnimationFrame === "undefined") { this.frame(); return; }
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.frame(); });
  }
  private frame(): void {
    if (!this.canvas) return;
    const hot = !isSettled(this.sim);
    if (hot) {
      // Small graphs get a few ticks per frame (they are cheap); large ones one.
      const n = this.sim.nodes.length;
      const ticks = n < 500 ? 3 : 1;
      for (let i = 0; i < ticks && !isSettled(this.sim); i++) stepSimulation(this.sim);
      if (this.autoFit) this.fit();
    }
    this.draw();
    // Hidden views (another tab selected) stop animating; they redraw when shown (onResize).
    const visible = this.canvas.isConnected && (this.width > 0 && this.height > 0);
    if (visible && (hot || this.dragNode >= 0) && typeof requestAnimationFrame !== "undefined") this.raf = requestAnimationFrame(() => { this.raf = 0; this.frame(); });
  }
  /** Run the layout to rest synchronously (tests, "animate" off). */
  settle(maxTicks = 3000): number {
    let i = 0;
    while (!isSettled(this.sim) && i++ < maxTicks) stepSimulation(this.sim);
    return i;
  }

  fit(): void {
    // The pane may have been resized since the last ResizeObserver callback (e.g. right after a split).
    const pw = this.canvas?.parentElement?.clientWidth, ph = this.canvas?.parentElement?.clientHeight;
    if (pw && ph && (pw !== this.width || ph !== this.height)) this.onResize();
    const b = bounds(this.sim.nodes);
    if (!b) return;
    const pad = 40;
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxY - b.minY);
    const k = Math.min(4, Math.max(0.02, Math.min((this.width - pad) / bw, (this.height - pad) / bh)));
    this.view = { k, x: -((b.minX + b.maxX) / 2) * k, y: -((b.minY + b.maxY) / 2) * k };
  }

  // ---- coordinates
  toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.width / 2 - this.view.x) / this.view.k, y: (py - this.height / 2 - this.view.y) / this.view.k };
  }
  private pointerPos(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private nodeAt(p: { x: number; y: number }): number {
    const w = this.toWorld(p.x, p.y);
    return hitTest(this.sim.nodes, w.x, w.y, 3 / this.view.k, this.options.nodeSizeMultiplier);
  }

  // ---- input
  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.pointerPos(e);
    this.moved = 0;
    this.last = p;
    this.dragNode = this.nodeAt(p);
    if (this.dragNode >= 0) this.sim.nodes[this.dragNode].fixed = true; else this.panning = true;
    this.canvas.setPointerCapture?.(e.pointerId);
  }
  private onMove(e: PointerEvent): void {
    const p = this.pointerPos(e);
    if (this.dragNode >= 0) {
      this.moved += Math.hypot(p.x - this.last.x, p.y - this.last.y);
      this.last = p;
      const n = this.sim.nodes[this.dragNode], w = this.toWorld(p.x, p.y);
      n.x = w.x; n.y = w.y;
      if (this.moved > 3) { this.autoFit = false; reheat(this.sim, 0.3); }
      this.requestDraw();
      return;
    }
    if (this.panning) {
      this.moved += Math.hypot(p.x - this.last.x, p.y - this.last.y);
      this.view.x += p.x - this.last.x; this.view.y += p.y - this.last.y;
      this.last = p;
      if (this.moved > 3) this.autoFit = false;
      this.drawMoved();
      return;
    }
    const h = this.nodeAt(p);
    if (h !== this.hover) { this.hover = h; this.canvas.style.cursor = h >= 0 ? "pointer" : ""; this.requestDraw(); this.onHoverChange(e); }
  }
  /** Emit `hover-link` for the node under the pointer (page preview); release the preview when leaving it. */
  private onHoverChange(e: MouseEvent): void {
    const pop = this.hoverPopover;
    if (pop) { pop.onTarget = false; pop.transition?.(); }
    const n = this.sim.nodes[this.hover];
    if (!n || n.kind === "unresolved" || n.kind === "tag") return;
    this.app.workspace.trigger("hover-link", { event: e, source: "graph", hoverParent: this, targetEl: null, linktext: n.id, sourcePath: "" });
  }
  private onUp(e: PointerEvent): void {
    const dragged = this.dragNode;
    if (dragged >= 0) {
      const n = this.sim.nodes[dragged];
      n.fixed = false;
      if (this.moved <= 3) this.openNode(n.id, n.kind, e);
    }
    this.dragNode = -1; this.panning = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.requestDraw();
  }
  private saveScale = debounce(() => { this.options.scale = this.view.k; this.saveOptions(); }, 800, true);
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.pointerPos(e);
    const k0 = this.view.k, k1 = Math.min(8, Math.max(0.02, k0 * Math.exp(-e.deltaY * 0.0015)));
    const w = this.toWorld(p.x, p.y);
    this.view.k = k1;
    this.view.x = p.x - this.width / 2 - w.x * k1;
    this.view.y = p.y - this.height / 2 - w.y * k1;
    this.autoFit = false;
    this.drawMoved();
    this.saveScale();
  }
  private onContext(e: MouseEvent): void {
    const i = this.nodeAt(this.pointerPos(e));
    if (i < 0) return;
    const f = this.app.vault.getFileByPath(this.sim.nodes[i].id);
    if (!f) return;
    e.preventDefault();
    buildFileMenu(this.app, f, "graph").showAtMouseEvent(e);
  }

  /** Open the node: a file (in another leaf than the graph), a tag (search) or an unresolved link (creates the note). */
  openNode(id: string, kind: NodeKind, evt?: MouseEvent | KeyboardEvent | null): void {
    const ws = this.app.workspace;
    if (kind === "tag") { void ws.ensureSideLeaf("search", "left", { active: true, reveal: true }).then((l) => (l.view as any).setQuery?.(`tag:${id}`)); return; }
    if (kind === "unresolved") { void ws.openLinkText(id.slice(1), "", "tab"); return; }
    const f = this.app.vault.getFileByPath(id);
    if (!f) return;
    const mod = evt ? Keymap.isModEvent(evt) : false;
    let target: WorkspaceLeaf | null = null;
    if (!mod) {
      const others: WorkspaceLeaf[] = [];
      ws.iterateRootLeaves((l) => { if (l !== this.leaf && !l.pinned && ["markdown", "empty"].includes(l.view.getViewType())) others.push(l); });
      target = others.find((l) => l === ws.getMostRecentLeaf()) ?? others[0] ?? null;
    }
    void (target ?? ws.getLeaf(mod || "tab")).openFile(f, { active: true });
  }

  // ---- controls
  /** Options changed: rebuild/recolour/re-force as needed and persist. */
  protected changed(what: "data" | "colors" | "forces" | "display" | "ui"): void {
    if (what === "data") this.rebuild();
    else if (what === "colors") this.recolor();
    else if (what === "forces") { this.sim.forces = forcesFrom(this.options); reheat(this.sim, 0.5); this.requestDraw(); }
    else if (what === "display") { if (this.sim.nodes.length) this.requestDraw(); }
    this.saveOptions();
  }
  protected renderFilterExtras(_body: HTMLElement): void {}

  renderControls(): void {
    const el = this.controlsEl, o = this.options;
    el.empty();
    el.toggleClass("is-close", o.close);
    const closeBtn = el.createDiv({ cls: "graph-controls-button mod-close clickable-icon", attr: { "aria-label": "Close" } });
    setIcon(closeBtn, "lucide-x");
    closeBtn.addEventListener("click", () => { o.close = true; el.addClass("is-close"); this.saveOptions(); });
    const openBtn = el.createDiv({ cls: "graph-controls-button mod-open clickable-icon", attr: { "aria-label": "Open graph settings" } });
    setIcon(openBtn, "lucide-settings");
    openBtn.addEventListener("click", () => { o.close = false; el.removeClass("is-close"); this.saveOptions(); });
    const section = (key: "filter" | "color-groups" | "display" | "forces", title: string): HTMLElement => {
      const ck = `collapse-${key}` as const;
      const sec = el.createDiv({ cls: `tree-item graph-control-section mod-${key}` + (o[ck] ? " is-collapsed" : "") });
      const head = sec.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
      const icon = collapseIcon(head);
      head.createDiv({ cls: "tree-item-inner" }).createEl("header", { cls: "graph-control-section-header", text: title });
      const body = sec.createDiv({ cls: "tree-item-children" });
      head.addEventListener("click", () => {
        o[ck] = !o[ck];
        sec.toggleClass("is-collapsed", o[ck]);
        this.saveOptions();
      });
      return body;
    };
    const toggle = (body: HTMLElement, name: string, get: () => boolean, set: (v: boolean) => void, what: "data" | "display" = "data") =>
      new Setting(body).setName(name).addToggle((t) => t.setValue(get()).onChange((v) => { set(v); this.changed(what); }));
    const slider = (body: HTMLElement, name: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, what: "forces" | "display" | "data") =>
      new Setting(body).setName(name).setClass("mod-slider").addSlider((s) => s.setLimits(min, max, step).setValue(get()).setDynamicTooltip().setInstant(true).onChange((v) => { set(v); this.changed(what); }));

    const filters = section("filter", "Filters");
    new Setting(filters).setClass("graph-control-search").addSearch((s) => s.setPlaceholder("Search files...").setValue(o.search).onChange((v) => {
      o.search = v;
      const tok = (this.searchToken = v);
      setTimeout(() => { if (tok === this.searchToken) this.changed("data"); }, 250);
    }));
    this.renderFilterExtras(filters);
    toggle(filters, "Tags", () => o.showTags, (v) => (o.showTags = v));
    toggle(filters, "Attachments", () => o.showAttachments, (v) => (o.showAttachments = v));
    toggle(filters, "Existing files only", () => o.hideUnresolved, (v) => (o.hideUnresolved = v));
    toggle(filters, "Orphans", () => o.showOrphans, (v) => (o.showOrphans = v));

    const groups = section("color-groups", "Groups");
    const list = groups.createDiv({ cls: "graph-color-groups-container" });
    o.colorGroups.forEach((g, i) => {
      const s = new Setting(list).setClass("graph-color-group");
      s.addText((t) => t.setPlaceholder("Enter query...").setValue(g.query).onChange((v) => { g.query = v; this.changed("colors"); }));
      s.addColorPicker((c) => c.setValue(rgbHex(g.color.rgb)).onChange((v) => { g.color = { a: 1, rgb: hexRgb(v) }; this.changed("colors"); }));
      s.addExtraButton((b) => b.setIcon("lucide-x").setTooltip("Delete group").onClick(() => { o.colorGroups.splice(i, 1); this.renderControls(); this.changed("colors"); }));
    });
    new Setting(groups).addButton((b) => b.setButtonText("New group").setCta().onClick(() => {
      // A new hue for each group (golden-angle steps on the colour wheel).
      const hue = (o.colorGroups.length * 137.5) % 360;
      o.colorGroups.push({ query: "", color: { a: 1, rgb: hslToRgb(hue, 0.65, 0.6) } });
      this.renderControls();
      this.changed("colors");
    }));

    const display = section("display", "Display");
    toggle(display, "Arrows", () => o.showArrow, (v) => (o.showArrow = v), "display");
    slider(display, "Text fade threshold", -3, 3, 0.1, () => o.textFadeMultiplier, (v) => (o.textFadeMultiplier = v), "display");
    slider(display, "Node size", 0.1, 5, 0.1, () => o.nodeSizeMultiplier, (v) => (o.nodeSizeMultiplier = v), "display");
    slider(display, "Link thickness", 0.1, 5, 0.1, () => o.lineSizeMultiplier, (v) => (o.lineSizeMultiplier = v), "display");
    new Setting(display).addButton((b) => b.setButtonText("Animate").onClick(() => { this.sim.alpha = 0; this.sim = createSimulation({ nodes: this.sim.nodes, links: this.sim.links }, forcesFrom(o)); this.autoFit = true; this.recolor(); this.kick(); }));

    const forces = section("forces", "Forces");
    slider(forces, "Center force", 0, 1, 0.01, () => o.centerStrength, (v) => (o.centerStrength = v), "forces");
    slider(forces, "Repel force", 0, 20, 0.1, () => o.repelStrength, (v) => (o.repelStrength = v), "forces");
    slider(forces, "Link force", 0, 1, 0.01, () => o.linkStrength, (v) => (o.linkStrength = v), "forces");
    slider(forces, "Link distance", 30, 500, 1, () => o.linkDistance, (v) => (o.linkDistance = v), "forces");
  }

  // ---- drawing
  private readColors(): Colors {
    if (this.colors) return this.colors;
    const probe = this.probeEl;
    const read = (cls: string, fb: string) => {
      if (!probe || typeof getComputedStyle === "undefined") return fb;
      const d = probe.createDiv({ cls: `graph-view ${cls}` });
      const c = getComputedStyle(d).color;
      d.remove();
      return c && c !== "rgba(0, 0, 0, 0)" ? c : fb;
    };
    return (this.colors = {
      fill: read("color-fill", "#999"), focused: read("color-fill-focused", "#7c3aed"), tag: read("color-fill-tag", "#5b9"),
      attachment: read("color-fill-attachment", "#cb6"), unresolved: read("color-fill-unresolved", "#666"), line: read("color-line", "#444"),
      lineHi: read("color-line-highlight", "#7c3aed"), text: read("color-text", "#ddd"), arrow: read("color-arrow", "#666"),
      highlight: read("color-fill-highlight", "#7c3aed"), circle: read("color-circle", "#7c3aed"),
    });
  }
  private nodeStyle(n: GraphNode, i: number, col: Colors): string {
    if (n.id === this.activePath || (this.isLocal && n.depth === 0)) return col.focused;
    if (i === this.hover) return col.highlight;
    if (n.color >= 0) return rgbHex(n.color);
    return n.kind === "unresolved" ? col.unresolved : n.kind === "attachment" ? col.attachment : n.kind === "tag" ? col.tag : col.fill;
  }

  // Sprites: one pre-rendered disc per (colour, pixel radius); blitting them is far cheaper than arcs.
  private sprites = new Map<string, HTMLCanvasElement | null>();
  private sprite(color: string, r: number): HTMLCanvasElement | null {
    const key = color + "|" + r;
    let sp = this.sprites.get(key);
    if (sp !== undefined) return sp;
    if (this.sprites.size > 400) this.sprites.clear();
    const size = Math.ceil(r * 2) + 2;
    const cv = this.canvas.ownerDocument.createElement("canvas");
    cv.width = cv.height = size;
    const c = cv.getContext("2d");
    if (c) { c.fillStyle = color; c.beginPath(); c.arc(size / 2, size / 2, r, 0, Math.PI * 2); c.fill(); sp = cv; } else sp = null;
    this.sprites.set(key, sp);
    return sp;
  }
  /** Last full frame of a large graph, reused (scaled/translated) while panning and zooming. */
  private snapshot: { canvas: HTMLCanvasElement; view: Viewport } | null = null;
  private fullRedraw = debounce(() => { this.snapshot = null; this.requestDraw(); }, 150, true);
  /** Pan/zoom feedback: big settled graphs blit the last frame and redraw for real once the gesture pauses. */
  private drawMoved(): void {
    const snap = this.snapshot;
    const ctx = this.canvas?.getContext?.("2d") as CanvasRenderingContext2D | null;
    if (!snap || !ctx || !isSettled(this.sim) || this.dragNode >= 0) { this.requestDraw(); return; }
    const dpr = this.canvas.width / (this.width || 1);
    const s = this.view.k / snap.view.k;
    const o0x = this.width / 2 + snap.view.x, o0y = this.height / 2 + snap.view.y;
    const o1x = this.width / 2 + this.view.x, o1y = this.height / 2 + this.view.y;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(o1x - o0x * s, o1y - o0y * s);
    ctx.scale(s / dpr, s / dpr);
    ctx.drawImage(snap.canvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.fullRedraw();
  }

  draw(): void {
    const ctx = this.canvas?.getContext?.("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return;
    this.frames++;
    const col = this.readColors();
    const o = this.options;
    const W = this.width, H = this.height;
    const dpr = this.canvas.width / (W || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // Everything is drawn in screen pixels: sx = x * k + ox.
    const { k } = this.view;
    const ox = W / 2 + this.view.x, oy = H / 2 + this.view.y;
    const m = 30;
    const { nodes, links } = this.sim;
    const n = nodes.length;
    const sx = new Float32Array(n), sy = new Float32Array(n);
    const vis = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = nodes[i].x * k + ox, y = nodes[i].y * k + oy;
      sx[i] = x; sy[i] = y;
      vis[i] = x >= -m && x <= W + m && y >= -m && y <= H + m ? 1 : 0;
    }
    const sizeMul = o.nodeSizeMultiplier;
    const hov = this.hover;
    const near = new Set<number>();
    if (hov >= 0) { near.add(hov); for (const l of links) { if (l.source === hov) near.add(l.target); else if (l.target === hov) near.add(l.source); } }
    const dim = hov >= 0;
    const big = n > 2500;
    // Links (skipped while a big graph is still flying apart: they are long, slow to rasterise and unreadable then).
    if (!(big && this.sim.alpha > 0.5)) {
      ctx.lineWidth = Math.min(3 * o.lineSizeMultiplier, Math.max(0.5, o.lineSizeMultiplier * k));
      ctx.strokeStyle = col.line;
      ctx.globalAlpha = dim ? 0.15 : 0.7;
      ctx.beginPath();
      const hot: number[] = [];
      for (let i = 0; i < links.length; i++) {
        const a = links[i].source, b = links[i].target;
        if (!vis[a] && !vis[b] && ((sx[a] < 0 && sx[b] < 0) || (sx[a] > W && sx[b] > W) || (sy[a] < 0 && sy[b] < 0) || (sy[a] > H && sy[b] > H))) continue;
        if (dim && (a === hov || b === hov)) { hot.push(i); continue; }
        ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]);
      }
      ctx.stroke();
      if (hot.length) {
        ctx.globalAlpha = 1; ctx.strokeStyle = col.lineHi; ctx.beginPath();
        for (const i of hot) { const a = links[i].source, b = links[i].target; ctx.moveTo(sx[a], sy[a]); ctx.lineTo(sx[b], sy[b]); }
        ctx.stroke();
      }
      // Arrow heads at the target's rim.
      if (o.showArrow && k > 0.25) {
        ctx.globalAlpha = dim ? 0.3 : 0.8;
        ctx.fillStyle = col.arrow;
        ctx.beginPath();
        const s = Math.max(2, 3 * Math.min(1.5, k) * Math.max(1, o.lineSizeMultiplier));
        for (const l of links) {
          const a = l.source, b = l.target;
          if (!vis[b]) continue;
          const dx = sx[b] - sx[a], dy = sy[b] - sy[a], d = Math.hypot(dx, dy);
          if (d < 4) continue;
          const ux = dx / d, uy = dy / d, rr = nodes[b].r * sizeMul * k;
          const tx = sx[b] - ux * rr, ty = sy[b] - uy * rr;
          ctx.moveTo(tx, ty);
          ctx.lineTo(tx - ux * s * 2 - uy * s, ty - uy * s * 2 + ux * s);
          ctx.lineTo(tx - ux * s * 2 + uy * s, ty - uy * s * 2 - ux * s);
          ctx.closePath();
        }
        ctx.fill();
      }
    }
    // Nodes, bucketed by colour and dimming.
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      const key = (dim && !near.has(i) ? "d" : "b") + this.nodeStyle(nodes[i], i, col);
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, (arr = []));
      arr.push(i);
    }
    for (const [key, arr] of buckets) {
      const color = key.slice(1);
      ctx.globalAlpha = key[0] === "d" ? 0.2 : 1;
      ctx.fillStyle = color;
      for (const i of arr) {
        const nd = nodes[i];
        const r = nd.r * sizeMul * k * (nd.id === this.activePath ? 1.2 : 1);
        if (r < 1.25) { const d = Math.max(1, r * 2); ctx.fillRect(sx[i] - d / 2, sy[i] - d / 2, d, d); continue; }
        const rr = Math.round(r * 2) / 2;
        const sp = this.sprite(color, rr);
        if (sp) ctx.drawImage(sp, Math.round(sx[i] - sp.width / 2), Math.round(sy[i] - sp.height / 2));
        else { ctx.beginPath(); ctx.arc(sx[i], sy[i], rr, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    // Labels fade in with zoom; the text fade slider moves the zoom level where that happens.
    const z0 = 1.1 * Math.pow(2, -o.textFadeMultiplier);
    const fade = Math.max(0, Math.min(1, (k - z0) / (0.6 * z0)));
    const forcedLabel = (i: number) => near.has(i) || nodes[i].id === this.activePath || (this.isLocal && nodes[i].depth === 0);
    ctx.fillStyle = col.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = `${Math.round(12 * Math.min(1.5, Math.max(0.85, Math.sqrt(k))))}px ${getComputedStyle?.(this.canvas).getPropertyValue("--font-interface").trim() || "sans-serif"}`;
    let drawn = 0;
    for (let i = 0; i < n; i++) {
      if (!vis[i]) continue;
      const forced = forcedLabel(i);
      if (!forced && (fade <= 0.01 || (big && this.sim.alpha > 0.5))) continue;
      if (!forced && ++drawn > 1500) continue; // far too many to read anyway
      ctx.globalAlpha = dim && !near.has(i) ? 0.1 * fade : forced ? 1 : fade;
      ctx.fillText(nodes[i].label, sx[i], sy[i] + nodes[i].r * sizeMul * k + 4);
    }
    ctx.globalAlpha = 1;
    // Keep the frame for cheap pan/zoom feedback once a big graph is at rest.
    if (n > 1500 && isSettled(this.sim)) {
      const doc = this.canvas.ownerDocument;
      const snap = this.snapshot?.canvas ?? doc.createElement("canvas");
      if (snap.width !== this.canvas.width || snap.height !== this.canvas.height) { snap.width = this.canvas.width; snap.height = this.canvas.height; }
      const sc = snap.getContext("2d");
      if (sc) { sc.clearRect(0, 0, snap.width, snap.height); sc.drawImage(this.canvas, 0, 0); this.snapshot = { canvas: snap, view: { ...this.view } }; }
    } else this.snapshot = null;
  }
}

/** Tags of a file from its metadata cache (inline and frontmatter), with '#'. */
export function tagsOfCache(c: any): string[] {
  const out = new Set<string>();
  for (const t of c?.tags ?? []) if (t?.tag) out.add(t.tag);
  const fm = c?.frontmatter?.tags ?? c?.frontmatter?.tag;
  for (const t of Array.isArray(fm) ? fm : typeof fm === "string" ? fm.split(/[,\s]+/) : []) if (t) out.add(String(t).startsWith("#") ? String(t) : "#" + t);
  return [...out];
}

function hslToRgb(h: number, s: number, l: number): number {
  const f = (n: number) => { const k = (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

// ===================================================================== the two views

export class GraphView extends BaseGraphView {
  get isLocal(): boolean { return false; }
  getViewType(): string { return GRAPH_VIEW; }
  getDisplayText(): string { return "Graph view"; }
  protected localCenter(): string | null { return null; }
  protected async loadOptions(): Promise<void> {
    try { this.options = normalizeOptions(await ipc.configRead("graph.json")); } catch { this.options = normalizeOptions({}); }
    if (this.options.scale) this.view.k = this.options.scale;
  }
  private writeOptions = debounce(() => { void ipc.configWrite("graph.json", this.options).catch((e) => console.warn("graph.json not saved", e)); }, 500, true);
  protected saveOptions(): void { this.writeOptions(); }
  getState(): Record<string, unknown> { return {}; }
}

export class LocalGraphView extends BaseGraphView {
  file: string | null = null;
  local: LocalOptions = { ...DEFAULT_LOCAL };
  get isLocal(): boolean { return true; }
  getViewType(): string { return LOCAL_GRAPH_VIEW; }
  getDisplayText(): string {
    const f = this.file ? this.app.vault.getFileByPath(this.file) : null;
    return f ? `Graph of ${f.basename}` : "Local graph";
  }
  protected localCenter(): string | null { return this.file; }
  protected localOptions(): LocalOptions { return this.local; }
  protected saveOptions(): void { this.app.workspace.requestSaveLayout(); }
  getState(): Record<string, unknown> { return { file: this.file, options: { ...this.options, ...this.local } }; }
  async setState(s: any): Promise<void> {
    if (s?.options && typeof s.options === "object") { this.options = normalizeOptions(s.options); this.local = normalizeLocal(s.options); }
    if (typeof s?.file === "string" || s?.file === null) this.file = s.file;
    if (this.canvas) { this.renderControls(); this.rebuild(); }
    this.leaf.updateHeader();
  }
  protected async loadOptions(): Promise<void> {
    if (!this.file) this.file = this.currentFile();
  }
  /** The file the local graph should show: the active file, if it is one the graph can centre on. */
  private currentFile(): string | null {
    const f = this.app.workspace.getActiveFile();
    return f instanceof TFile ? f.path : null;
  }
  protected onActiveFileChange(): void {
    super.onActiveFileChange();
    if (this.leaf.pinned) return;
    const active = this.app.workspace.activeLeaf;
    if (active === this.leaf) return;
    const p = this.currentFile();
    if (p && p !== this.file) {
      this.file = p;
      this.leaf.updateHeader();
      this.rebuild();
      this.app.workspace.requestSaveLayout();
    }
  }
  protected renderFilterExtras(body: HTMLElement): void {
    const l = this.local;
    const save = () => { this.rebuild(); this.saveOptions(); };
    new Setting(body).setName("Depth").setClass("mod-slider").addSlider((s) => s.setLimits(1, 5, 1).setValue(l.localJumps).setDynamicTooltip().setInstant(true).onChange((v) => { l.localJumps = v; save(); }));
    new Setting(body).setName("Incoming links").addToggle((t) => t.setValue(l.localBacklinks).onChange((v) => { l.localBacklinks = v; save(); }));
    new Setting(body).setName("Outgoing links").addToggle((t) => t.setValue(l.localForelinks).onChange((v) => { l.localForelinks = v; save(); }));
    new Setting(body).setName("Neighbor links").addToggle((t) => t.setValue(l.localInterlinks).onChange((v) => { l.localInterlinks = v; save(); }));
  }
}

export async function openGraph(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(GRAPH_VIEW)[0];
  if (existing) { await app.workspace.revealLeaf(existing); return; }
  await app.workspace.getLeaf("tab").setViewState({ type: GRAPH_VIEW, active: true });
}
export async function openLocalGraph(app: App): Promise<void> {
  const f = app.workspace.getActiveFile();
  const leaf = app.workspace.getLeaf("split");
  await leaf.setViewState({ type: LOCAL_GRAPH_VIEW, active: true, state: { file: f?.path ?? null } });
}
