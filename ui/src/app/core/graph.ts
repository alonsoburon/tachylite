// Graph core view ("graph"): force-directed canvas drawing of metadataCache.resolvedLinks.
// The layout half (buildGraph / createSimulation / stepSimulation) is DOM-free and unit-tested.
import { Keymap, Setting, type App, type WorkspaceLeaf } from "../../obsidian";
import { buildFileMenu } from "../files";
import { addCommand, addRibbon, PanelView, whileCoreEnabled, type CoreModule } from "./util";

export const GRAPH_VIEW = "graph";

// ===================================================================== pure layout
export type NodeKind = "note" | "attachment" | "unresolved";
export interface GraphNode { id: string; label: string; kind: NodeKind; degree: number; r: number; x: number; y: number; vx: number; vy: number; fixed: boolean }
export interface GraphLink { source: number; target: number }
export interface GraphData { nodes: GraphNode[]; links: GraphLink[] }
export interface GraphOptions { attachments: boolean; existingOnly: boolean; orphans: boolean; search: string }
export const DEFAULT_GRAPH_OPTIONS: GraphOptions = { attachments: false, existingOnly: false, orphans: true, search: "" };
export interface SimParams { linkDistance: number; repulsion: number; centerStrength: number; linkStrength: number }
export const DEFAULT_SIM: SimParams = { linkDistance: 60, repulsion: 400, centerStrength: 0.05, linkStrength: 1 };
export interface SimState extends GraphData { alpha: number; params: SimParams }

type LinkMap = Record<string, Record<string, number>>;

function baseName(p: string): string {
  const n = p.slice(p.lastIndexOf("/") + 1);
  return n.endsWith(".md") ? n.slice(0, -3) : n;
}
export function nodeRadius(degree: number): number { return Math.min(14, 3.5 + Math.sqrt(degree) * 1.6); }

/** Turn link maps into nodes + undirected edges, honouring the filter options. Positions are left at the origin. */
export function buildGraph(resolved: LinkMap, unresolved: LinkMap, opts: Partial<GraphOptions> = {}, notes: Iterable<string> = []): GraphData {
  const o = { ...DEFAULT_GRAPH_OPTIONS, ...opts };
  const nodes: GraphNode[] = [];
  const index = new Map<string, number>();
  const make = (id: string, kind: NodeKind, label: string): number => {
    let i = index.get(id);
    if (i === undefined) { i = nodes.length; index.set(id, i); nodes.push({ id, label, kind, degree: 0, r: 0, x: 0, y: 0, vx: 0, vy: 0, fixed: false }); }
    return i;
  };
  const edges = new Set<string>();
  const links: GraphLink[] = [];
  const connect = (a: number, b: number) => {
    if (a === b) return;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edges.has(k)) return;
    edges.add(k);
    links.push({ source: a, target: b });
    nodes[a].degree++; nodes[b].degree++;
  };
  for (const p of notes) make(p, "note", baseName(p)); // notes without links still count (orphans)
  for (const src of Object.keys(resolved)) {
    const s = make(src, src.endsWith(".md") ? "note" : "attachment", baseName(src));
    for (const dst of Object.keys(resolved[src] ?? {})) {
      const isNote = dst.endsWith(".md");
      if (!isNote && !o.attachments) continue;
      connect(s, make(dst, isNote ? "note" : "attachment", isNote ? baseName(dst) : dst.slice(dst.lastIndexOf("/") + 1)));
    }
  }
  if (!o.existingOnly) {
    for (const src of Object.keys(unresolved)) {
      const s = make(src, "note", baseName(src));
      for (const dst of Object.keys(unresolved[src] ?? {})) connect(s, make("?" + dst, "unresolved", dst));
    }
  }
  if (!o.attachments) for (const n of nodes) if (n.kind === "attachment") n.degree = -1;
  // Filter: drop hidden attachments, orphans and non-matching nodes, then re-index.
  const q = o.search.trim().toLowerCase();
  const keep = nodes.map((n) => {
    if (n.degree < 0) return false;
    if (!o.orphans && n.degree === 0) return false;
    if (q && !(n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))) return false;
    return true;
  });
  const remap = new Map<number, number>();
  const outNodes: GraphNode[] = [];
  nodes.forEach((n, i) => { if (keep[i]) { remap.set(i, outNodes.length); outNodes.push({ ...n, degree: 0 }); } });
  const outLinks: GraphLink[] = [];
  for (const l of links) {
    const a = remap.get(l.source), b = remap.get(l.target);
    if (a === undefined || b === undefined) continue;
    outLinks.push({ source: a, target: b });
    outNodes[a].degree++; outNodes[b].degree++;
  }
  for (const n of outNodes) n.r = nodeRadius(n.degree);
  return { nodes: outNodes, links: outLinks };
}

/** Deterministic starting layout (golden-angle spiral) so tests and reloads look the same. */
export function seedPositions(nodes: GraphNode[], spread = 18): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((n, i) => { const r = spread * Math.sqrt(i + 0.5); n.x = Math.cos(i * golden) * r; n.y = Math.sin(i * golden) * r; n.vx = n.vy = 0; });
}

export function createSimulation(data: GraphData, params: Partial<SimParams> = {}): SimState {
  seedPositions(data.nodes);
  return { ...data, alpha: 1, params: { ...DEFAULT_SIM, ...params } };
}

/** Re-warm a cooled simulation (after a drag, a filter change or new data). */
export function reheat(state: SimState, alpha = 0.4): void { state.alpha = Math.max(state.alpha, alpha); }

const ALPHA_MIN = 0.003;
export const isSettled = (s: SimState): boolean => s.alpha < ALPHA_MIN;

/**
 * Advance the simulation one tick: pairwise repulsion (all pairs up to ~400 nodes, a spatial grid beyond that),
 * spring links, a pull to the origin, damping. Returns the remaining alpha (heat); the caller stops at `isSettled`.
 */
export function stepSimulation(s: SimState): number {
  const { nodes, links, params: p } = s;
  const n = nodes.length;
  const a = s.alpha;
  if (n === 0) { s.alpha = 0; return 0; }
  // repulsion
  const push = (u: GraphNode, v: GraphNode) => {
    let dx = v.x - u.x, dy = v.y - u.y;
    let d2 = dx * dx + dy * dy;
    if (d2 < 1) { dx = 0.01; dy = 0.01; d2 = 1; }
    const d = Math.sqrt(d2);
    const f = (p.repulsion * a) / d;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    u.vx -= fx; u.vy -= fy; v.vx += fx; v.vy += fy;
  };
  if (n <= 400) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) push(nodes[i], nodes[j]);
  } else {
    const cell = Math.max(40, p.linkDistance * 4);
    const grid = new Map<string, number[]>();
    const key = (cx: number, cy: number) => `${cx},${cy}`;
    nodes.forEach((u, i) => {
      const k = key(Math.floor(u.x / cell), Math.floor(u.y / cell));
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    });
    nodes.forEach((u, i) => {
      const cx = Math.floor(u.x / cell), cy = Math.floor(u.y / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        for (const j of grid.get(key(cx + ox, cy + oy)) ?? []) if (j > i) push(u, nodes[j]);
      }
    });
  }
  // links
  for (const l of links) {
    const u = nodes[l.source], v = nodes[l.target];
    let dx = v.x + v.vx - u.x - u.vx, dy = v.y + v.vy - u.y - u.vy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const strength = (p.linkStrength / Math.max(1, Math.min(u.degree, v.degree))) * a;
    const k = ((d - p.linkDistance) / d) * strength;
    dx *= k; dy *= k;
    const bu = u.degree / ((u.degree + v.degree) || 1);
    v.vx -= dx * bu; v.vy -= dy * bu;
    u.vx += dx * (1 - bu); u.vy += dy * (1 - bu);
  }
  // centre + integrate
  for (const u of nodes) {
    if (u.fixed) { u.vx = u.vy = 0; continue; }
    u.vx -= u.x * p.centerStrength * a;
    u.vy -= u.y * p.centerStrength * a;
    u.vx *= 0.6; u.vy *= 0.6;
    u.x += u.vx; u.y += u.vy;
  }
  s.alpha = a * 0.978;
  return s.alpha;
}

/** Index of the node under world point (x, y), preferring the closest; -1 when none. */
export function hitTest(nodes: GraphNode[], x: number, y: number, slack = 2): number {
  let best = -1, bd = Infinity;
  nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d <= n.r + slack && d < bd) { bd = d; best = i; }
  });
  return best;
}

// ===================================================================== view
interface Colors { line: string; node: string; accent: string; faint: string; attachment: string; text: string; bg: string }
interface Viewport { k: number; x: number; y: number }

export class GraphView extends PanelView {
  options: GraphOptions = { ...DEFAULT_GRAPH_OPTIONS };
  params: SimParams = { ...DEFAULT_SIM };
  sim: SimState = createSimulation({ nodes: [], links: [] });
  view: Viewport = { k: 1, x: 0, y: 0 };
  hover = -1;
  canvas!: HTMLCanvasElement;
  controlsEl!: HTMLElement;
  private width = 800;
  private height = 600;
  private raf = 0;
  private colors: Colors | null = null;
  private activePath: string | null = null;
  private dragNode = -1;
  private panning = false;
  private moved = 0;
  private last = { x: 0, y: 0 };
  private resizeObs: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = true; }
  getViewType(): string { return GRAPH_VIEW; }
  getDisplayText(): string { return "Graph view"; }
  getIcon(): string { return "lucide-git-fork"; }
  getState(): Record<string, unknown> { return { options: { ...this.options }, params: { ...this.params } }; }
  async setState(s: any): Promise<void> {
    if (s?.options && typeof s.options === "object") this.options = { ...DEFAULT_GRAPH_OPTIONS, ...s.options };
    if (s?.params && typeof s.params === "object") this.params = { ...DEFAULT_SIM, ...s.params };
    if (this.canvas) { this.rebuild(); this.renderControls(); }
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl.createDiv({ cls: "graph-view-container" });
    this.canvas = root.createEl("canvas", { cls: "graph-view-canvas" });
    this.controlsEl = root.createDiv({ cls: "graph-controls is-close" });
    this.renderControls();
    const c = this.canvas;
    this.registerDomEvent(c, "pointerdown", (e) => this.onDown(e));
    this.registerDomEvent(c, "pointermove", (e) => this.onMove(e));
    this.registerDomEvent(c, "pointerup", (e) => this.onUp(e));
    this.registerDomEvent(c, "pointerleave", () => { if (this.hover !== -1 && this.dragNode < 0) { this.hover = -1; this.draw(); } });
    this.registerDomEvent(c, "wheel", (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(c, "contextmenu", (e) => this.onContext(e));
    const mc = this.app.metadataCache as any;
    this.registerEvent(mc.on("resolved", () => this.requestRefresh(250)));
    for (const ev of ["create", "delete", "rename"] as const) this.registerEvent(this.app.vault.on(ev as any, () => this.requestRefresh(250)));
    const sync = () => { const p = this.app.workspace.getActiveFile()?.path ?? null; if (p !== this.activePath) { this.activePath = p; this.draw(); } };
    this.registerEvent(this.app.workspace.on("file-open", sync));
    this.registerEvent(this.app.workspace.on("active-leaf-change", sync));
    this.registerEvent(this.app.workspace.on("css-change", () => { this.colors = null; this.draw(); }));
    if (typeof ResizeObserver !== "undefined") { this.resizeObs = new ResizeObserver(() => this.onResize()); this.resizeObs.observe(root); this.register(() => this.resizeObs?.disconnect()); }
    this.activePath = this.app.workspace.getActiveFile()?.path ?? null;
    this.onResize();
    this.rebuild();
  }
  async onClose(): Promise<void> { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }

  onResize(): void {
    if (!this.canvas) return;
    const w = this.canvas.parentElement?.clientWidth || this.width, h = this.canvas.parentElement?.clientHeight || this.height;
    this.width = w; this.height = h;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.draw();
  }

  refresh(): void { this.rebuild(); }

  /** Recompute nodes/edges from the metadata cache, keeping positions of nodes that already existed. */
  rebuild(): void {
    const mc = this.app.metadataCache;
    const data = buildGraph(mc.resolvedLinks, mc.unresolvedLinks, this.options, this.app.vault.getMarkdownFiles().map((f) => f.path));
    const old = new Map(this.sim.nodes.map((n) => [n.id, n]));
    const fresh = createSimulation(data, this.params);
    let reused = 0;
    for (const n of fresh.nodes) {
      const o = old.get(n.id);
      if (o) { n.x = o.x; n.y = o.y; reused++; }
    }
    // Brand-new nodes start next to the first neighbour that already has a position.
    if (reused) {
      const pos = new Map(fresh.nodes.map((n) => [n, old.has(n.id)]));
      for (const l of fresh.links) {
        const a = fresh.nodes[l.source], b = fresh.nodes[l.target];
        if (pos.get(a) && !pos.get(b)) { b.x = a.x + 10; b.y = a.y + 10; pos.set(b, true); }
        else if (pos.get(b) && !pos.get(a)) { a.x = b.x - 10; a.y = b.y - 10; pos.set(a, true); }
      }
    }
    fresh.alpha = reused ? 0.3 : 1;
    this.sim = fresh;
    this.hover = -1;
    this.kick();
  }

  /** Start (or continue) the animation loop; it stops by itself once the layout has cooled. */
  private kick(): void {
    if (this.raf || typeof requestAnimationFrame === "undefined") { if (!this.raf) this.draw(); return; }
    const tick = () => {
      this.raf = 0;
      const steps = this.sim.nodes.length > 300 ? 2 : 1;
      if (!isSettled(this.sim)) for (let i = 0; i < steps; i++) stepSimulation(this.sim);
      this.draw();
      if (!isSettled(this.sim) || this.dragNode >= 0) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // ---- coordinates
  private toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.width / 2 - this.view.x) / this.view.k, y: (py - this.height / 2 - this.view.y) / this.view.k };
  }
  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---- input
  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.local(e), w = this.toWorld(p.x, p.y);
    this.moved = 0;
    this.last = p;
    this.dragNode = hitTest(this.sim.nodes, w.x, w.y, 3 / this.view.k);
    if (this.dragNode >= 0) this.sim.nodes[this.dragNode].fixed = true; else this.panning = true;
    this.canvas.setPointerCapture?.(e.pointerId);
  }
  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.dragNode >= 0) {
      this.moved += Math.hypot(p.x - this.last.x, p.y - this.last.y);
      this.last = p;
      const n = this.sim.nodes[this.dragNode], w = this.toWorld(p.x, p.y);
      n.x = w.x; n.y = w.y;
      if (this.moved > 3) { reheat(this.sim, 0.3); this.kick(); }
      return;
    }
    if (this.panning) {
      this.moved += Math.hypot(p.x - this.last.x, p.y - this.last.y);
      this.view.x += p.x - this.last.x; this.view.y += p.y - this.last.y;
      this.last = p;
      this.draw();
      return;
    }
    const w = this.toWorld(p.x, p.y);
    const h = hitTest(this.sim.nodes, w.x, w.y, 3 / this.view.k);
    if (h !== this.hover) { this.hover = h; this.canvas.style.cursor = h >= 0 ? "pointer" : ""; this.draw(); }
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
    this.kick();
  }
  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const k0 = this.view.k, k1 = Math.min(8, Math.max(0.1, k0 * Math.exp(-e.deltaY * 0.0015)));
    const w = this.toWorld(p.x, p.y);
    this.view.k = k1;
    // keep the world point under the cursor fixed
    this.view.x = p.x - this.width / 2 - w.x * k1;
    this.view.y = p.y - this.height / 2 - w.y * k1;
    this.draw();
  }
  private onContext(e: MouseEvent): void {
    const p = this.local(e), w = this.toWorld(p.x, p.y);
    const i = hitTest(this.sim.nodes, w.x, w.y, 3 / this.view.k);
    if (i < 0) return;
    const f = this.app.vault.getFileByPath(this.sim.nodes[i].id);
    if (!f) return;
    e.preventDefault();
    buildFileMenu(this.app, f, "graph").showAtMouseEvent(e);
  }

  /** Open the note behind node `id` (creating it for an unresolved link) without replacing the graph tab. */
  openNode(id: string, kind: NodeKind, evt?: MouseEvent | KeyboardEvent | null): void {
    const ws = this.app.workspace;
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
  private renderControls(): void {
    const el = this.controlsEl;
    el.empty();
    const head = el.createDiv({ cls: "graph-controls-button mod-close clickable-icon", attr: { "aria-label": "Graph settings" } });
    head.createSpan({ text: "Settings" });
    head.addEventListener("click", () => el.toggleClass("is-close", !el.hasClass("is-close")));
    const body = el.createDiv({ cls: "graph-control-body" });
    const changed = () => { this.rebuild(); this.app.workspace.requestSaveLayout(); };
    new Setting(body).setClass("graph-control-search").addSearch((s) => s.setPlaceholder("Search files...").setValue(this.options.search).onChange((v) => { this.options.search = v; changed(); }));
    new Setting(body).setName("Attachments").addToggle((t) => t.setValue(this.options.attachments).onChange((v) => { this.options.attachments = v; changed(); }));
    new Setting(body).setName("Existing files only").addToggle((t) => t.setValue(this.options.existingOnly).onChange((v) => { this.options.existingOnly = v; changed(); }));
    new Setting(body).setName("Orphans").addToggle((t) => t.setValue(this.options.orphans).onChange((v) => { this.options.orphans = v; changed(); }));
    new Setting(body).setName("Link distance").addSlider((s) => s.setLimits(20, 200, 5).setValue(this.params.linkDistance).onChange((v) => { this.params.linkDistance = v; this.sim.params.linkDistance = v; reheat(this.sim, 0.5); this.kick(); this.app.workspace.requestSaveLayout(); }));
    new Setting(body).setName("Repel force").addSlider((s) => s.setLimits(50, 1500, 25).setValue(this.params.repulsion).onChange((v) => { this.params.repulsion = v; this.sim.params.repulsion = v; reheat(this.sim, 0.5); this.kick(); this.app.workspace.requestSaveLayout(); }));
  }

  // ---- drawing
  private readColors(): Colors {
    if (this.colors) return this.colors;
    const cs = getComputedStyle(document.body);
    const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
    return (this.colors = {
      line: v("--background-modifier-border", "#444"), node: v("--text-muted", "#999"), accent: v("--interactive-accent", "#7c3aed"),
      faint: v("--text-faint", "#666"), attachment: v("--text-accent", "#5b9"), text: v("--text-normal", "#ddd"), bg: v("--background-primary", "#111"),
    });
  }

  draw(): void {
    const ctx = this.canvas?.getContext?.("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return;
    const col = this.readColors();
    const dpr = this.canvas.width / (this.width || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const { k, x, y } = this.view;
    ctx.translate(this.width / 2 + x, this.height / 2 + y);
    ctx.scale(k, k);
    const { nodes, links } = this.sim;
    const near = new Set<number>();
    if (this.hover >= 0) { near.add(this.hover); for (const l of links) { if (l.source === this.hover) near.add(l.target); else if (l.target === this.hover) near.add(l.source); } }
    const dim = this.hover >= 0;
    ctx.lineWidth = 1 / k;
    for (const l of links) {
      const hot = dim && (l.source === this.hover || l.target === this.hover);
      ctx.globalAlpha = dim ? (hot ? 1 : 0.1) : 0.8;
      ctx.strokeStyle = hot ? col.accent : col.line;
      ctx.beginPath(); ctx.moveTo(nodes[l.source].x, nodes[l.source].y); ctx.lineTo(nodes[l.target].x, nodes[l.target].y); ctx.stroke();
    }
    nodes.forEach((n, i) => {
      const active = n.id === this.activePath;
      ctx.globalAlpha = dim && !near.has(i) ? 0.15 : 1;
      ctx.fillStyle = active || i === this.hover ? col.accent : n.kind === "unresolved" ? col.faint : n.kind === "attachment" ? col.attachment : col.node;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r * (active ? 1.3 : 1), 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = col.text;
    ctx.textAlign = "center";
    ctx.font = `${12 / Math.max(k, 0.6)}px sans-serif`;
    const showAll = k >= 1.4;
    nodes.forEach((n, i) => {
      const hot = near.has(i) || n.id === this.activePath;
      if (!hot && !showAll) return;
      ctx.globalAlpha = dim && !near.has(i) ? 0.1 : hot ? 1 : Math.min(1, (k - 1.4) / 0.6 + 0.2);
      ctx.fillText(n.label, n.x, n.y + n.r + 12 / k);
    });
    ctx.globalAlpha = 1;
  }
}

async function openGraph(app: App): Promise<void> {
  const existing = app.workspace.getLeavesOfType(GRAPH_VIEW)[0];
  if (existing) { await app.workspace.revealLeaf(existing); return; }
  await app.workspace.getLeaf("tab").setViewState({ type: GRAPH_VIEW, active: true });
}

export const graph: CoreModule = {
  id: "graph",
  install(app: App) {
    app.viewRegistry.registerView(GRAPH_VIEW, (leaf) => new GraphView(leaf));
    const stop = whileCoreEnabled(app, "graph", () => {
      const offs = [
        addCommand(app, { id: "graph:open", name: "Graph view: Open graph view", icon: "lucide-git-fork", callback: () => { void openGraph(app); } }),
        addRibbon(app, "lucide-git-fork", "Open graph view", () => { void openGraph(app); }),
      ];
      return () => { offs.forEach((o) => o()); app.workspace.detachLeavesOfType(GRAPH_VIEW); };
    });
    return () => { stop(); app.viewRegistry.unregisterView(GRAPH_VIEW); };
  },
};
