// The canvas engine behind a CanvasView (`view.canvas` for plugins): node/edge registry, selection, viewport, history,
// pointer and keyboard interaction. DOM classes follow the names themes style (.canvas-wrapper, .canvas-node, ...).
import { setIcon, TFile, type App } from "../obsidian";
import {
  DEFAULT_SIZE, bboxCenter, bboxContains, bboxFromPoints, bboxIntersects, closestSide, edgeGeometry, padBBox, randomId, rectBBox, sideNormal,
  sidePoint, snap, unionBBox,
  type AllCanvasNodeData, type BBox, type CanvasData, type CanvasEdgeData, type NodeSide, type Point,
} from "./model";
import { CanvasEdge, CanvasFileNode, CanvasGroupNode, CanvasLinkNode, CanvasNode, CanvasTextNode, svgEl } from "./nodes";

export type CanvasItem = CanvasNode | CanvasEdge;
export interface CanvasHost {
  /** Vault path of the .canvas file (source path for links in text cards). */
  sourcePath(): string;
  requestSave(): void;
  openUrl?(url: string): void;
  /** UI hooks (menus, pickers) supplied by the view; absent for headless canvases. */
  onSelectionChange?(): void;
  /** The viewport moved or zoomed (reposition overlays). */
  onViewportChange?(): void;
  onContextMenu?(evt: MouseEvent, target: CanvasItem | null, pos: Point): void;
  /** Edit an edge label or a group label (double-click). */
  onLabelEdit?(item: CanvasEdge | CanvasGroupNode): void;
}
export interface CreateNodeOptions { pos: Point; size?: { width: number; height: number }; position?: "center" | "topleft"; save?: boolean; focus?: boolean }

const MIN_ZOOM = -4, MAX_ZOOM = 1, MIN_SIZE = 40;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export class Canvas {
  nodes = new Map<string, CanvasNode>();
  edges = new Map<string, CanvasEdge>();
  selection = new Set<CanvasItem>();
  /** Viewport centre (canvas coordinates) and log2 zoom; `t*` are the targets (no animation: always equal). */
  x = 0; y = 0; zoom = 0;
  get tx(): number { return this.x; } get ty(): number { return this.y; } get tZoom(): number { return this.zoom; }
  get scale(): number { return Math.pow(2, this.zoom); }
  readonly = false;
  options = { snapToGrid: true, gridSize: 20, linkFrames: true, wheelZoom: false };
  /** Top-level keys of the file other than nodes/edges, kept for the round trip. */
  extra: Record<string, any> = {};
  /** Key order of the loaded file. */
  private keyOrder: string[] = ["nodes", "edges"];
  history = { past: [] as string[], future: [] as string[], max: 100 };

  wrapperEl: HTMLElement;
  backgroundEl: HTMLElement;
  canvasEl: HTMLElement;
  edgeContainerEl: SVGSVGElement;
  edgeLabelLayerEl: HTMLElement;
  nodeLayerEl: HTMLElement;
  selectionEl: HTMLElement;
  bandEl: HTMLElement;
  private ghostEl: SVGPathElement;
  private disposers: (() => void)[] = [];
  private spaceDown = false;
  private suppressContext = false;

  constructor(public app: App, public host: CanvasHost, parent?: HTMLElement) {
    this.wrapperEl = createDiv({ cls: "canvas-wrapper", attr: { tabindex: "-1" } });
    parent?.appendChild(this.wrapperEl);
    this.backgroundEl = this.wrapperEl.createDiv({ cls: "canvas-background" });
    this.canvasEl = this.wrapperEl.createDiv({ cls: "canvas" });
    this.nodeLayerEl = this.canvasEl.createDiv({ cls: "canvas-node-layer" });
    this.edgeContainerEl = svgEl("svg", this.canvasEl, "canvas-edges");
    this.ghostEl = svgEl("path", this.edgeContainerEl, "canvas-display-path canvas-ghost-path");
    this.ghostEl.style.display = "none";
    this.edgeLabelLayerEl = this.canvasEl.createDiv({ cls: "canvas-edge-label-layer" });
    this.selectionEl = this.canvasEl.createDiv({ cls: "canvas-selection" });
    this.selectionEl.hide();
    this.bandEl = this.wrapperEl.createDiv({ cls: "canvas-rubber-band" });
    this.bandEl.hide();
    this.installInteraction();
    this.applyViewport();
  }

  get sourcePath(): string { return this.host.sourcePath(); }
  get data(): CanvasData { return this.getData(); }
  openUrl(url: string): void { this.host.openUrl?.(url); }

  // ---------------------------------------------------------------- data
  getData(): CanvasData {
    const out: CanvasData = { nodes: [], edges: [] };
    const nodes = [...this.nodes.values()].map((n) => n.getData());
    const edges = [...this.edges.values()].map((e) => e.getData());
    const res: Record<string, any> = {};
    for (const k of this.keyOrder) res[k] = k === "nodes" ? nodes : k === "edges" ? edges : this.extra[k];
    for (const [k, v] of Object.entries(this.extra)) if (!(k in res)) res[k] = v;
    return Object.assign(out, res);
  }
  /** Replace everything (keeps the viewport). */
  setData(data: CanvasData): void {
    this.clear();
    this.keyOrder = Object.keys(data);
    for (const k of ["nodes", "edges"]) if (!this.keyOrder.includes(k)) this.keyOrder.push(k);
    this.extra = Object.fromEntries(Object.entries(data).filter(([k]) => k !== "nodes" && k !== "edges"));
    this.importData({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
  }
  /** Add nodes and edges (paste/import). Edges to unknown nodes are dropped. Returns the created items. */
  importData(data: { nodes?: AllCanvasNodeData[]; edges?: CanvasEdgeData[] }, select = false): CanvasItem[] {
    const made: CanvasItem[] = [];
    for (const d of data.nodes ?? []) { const n = this.makeNode(d); if (n) { this.addNode(n); made.push(n); } }
    for (const d of data.edges ?? []) { const e = this.makeEdge(d); if (e) { this.addEdge(e); made.push(e); } }
    if (select) this.selectOnlyMany(made);
    return made;
  }
  clear(): void {
    for (const e of [...this.edges.values()]) this.removeEdge(e, false);
    for (const n of [...this.nodes.values()]) this.removeNode(n, false);
    this.selection.clear();
    this.updateSelectionUI();
  }
  private makeNode(d: AllCanvasNodeData): CanvasNode | null {
    if (!d || typeof d.id !== "string" || this.nodes.has(d.id)) return null;
    switch (d.type) {
      case "file": return new CanvasFileNode(this, d);
      case "link": return new CanvasLinkNode(this, d);
      case "group": return new CanvasGroupNode(this, d);
      default: return new CanvasTextNode(this, d as any); // "text", and unknown types are kept as (empty) text cards with their data
    }
  }
  private makeEdge(d: CanvasEdgeData): CanvasEdge | null {
    const a = this.nodes.get(d.fromNode), b = this.nodes.get(d.toNode);
    if (!a || !b || this.edges.has(d.id)) return null;
    return new CanvasEdge(this, d, a, b);
  }

  // ---------------------------------------------------------------- registry
  addNode(node: CanvasNode): void {
    this.nodes.set(node.id, node);
    this.nodeLayerEl.appendChild(node.nodeEl);
    node.render();
    this.restack();
  }
  removeNode(node: CanvasNode, save = true): void {
    for (const e of this.getEdgesForNode(node)) this.removeEdge(e, false);
    this.selection.delete(node);
    this.nodes.delete(node.id);
    node.detach();
    this.updateSelectionUI();
    if (save) this.requestSave();
  }
  addEdge(edge: CanvasEdge): void {
    this.edges.set(edge.id, edge);
    this.edgeContainerEl.appendChild(edge.lineGroupEl);
    edge.render();
  }
  removeEdge(edge: CanvasEdge, save = true): void {
    this.selection.delete(edge);
    this.edges.delete(edge.id);
    edge.detach();
    this.updateSelectionUI();
    if (save) this.requestSave();
  }
  getEdgesForNode(node: CanvasNode): CanvasEdge[] { return [...this.edges.values()].filter((e) => e.from.node === node || e.to.node === node); }
  /** Groups render below the cards they hold; otherwise file order is z-order. */
  private restack(): void {
    let i = 0;
    for (const n of this.nodes.values()) n.nodeEl.style.zIndex = String(n instanceof CanvasGroupNode ? i++ : 1000 + i++);
  }
  /** Called by nodes after a geometry/content change. */
  onNodeChanged(node: CanvasNode): void {
    for (const e of this.getEdgesForNode(node)) e.render();
    if (this.selection.has(node)) this.updateSelectionUI();
  }
  requestSave(): void { if (!this.readonly) this.host.requestSave(); }
  setReadonly(ro: boolean): void { this.readonly = ro; this.wrapperEl.toggleClass("mod-readonly", ro); if (ro) for (const n of this.nodes.values()) n.stopEditing(); }

  private place(type: keyof typeof DEFAULT_SIZE, o: CreateNodeOptions): { x: number; y: number; width: number; height: number } {
    const size = o.size ?? DEFAULT_SIZE[type];
    const g = this.options.snapToGrid ? this.options.gridSize : 0;
    const x = o.position === "topleft" ? o.pos.x : o.pos.x - size.width / 2, y = o.position === "topleft" ? o.pos.y : o.pos.y - size.height / 2;
    return { x: snap(x, g), y: snap(y, g), width: size.width, height: size.height };
  }
  private finishCreate(n: CanvasNode, o: CreateNodeOptions): CanvasNode {
    if (o.save !== false) this.pushHistory();
    this.addNode(n);
    if (o.focus !== false && o.save !== false) this.selectOnly(n);
    if (o.save !== false) this.requestSave();
    return n;
  }
  createTextNode(o: CreateNodeOptions & { text?: string }): CanvasTextNode {
    return this.finishCreate(new CanvasTextNode(this, { id: randomId(), type: "text", text: o.text ?? "", ...this.place("text", o) }), o) as CanvasTextNode;
  }
  createFileNode(o: CreateNodeOptions & { file: TFile | string; subpath?: string }): CanvasFileNode {
    const path = typeof o.file === "string" ? o.file : o.file.path;
    const d: any = { id: randomId(), type: "file", file: path, ...this.place("file", o) };
    if (o.subpath) d.subpath = o.subpath.startsWith("#") ? o.subpath : "#" + o.subpath;
    // Keep id/type/file first, like files Obsidian writes.
    return this.finishCreate(new CanvasFileNode(this, d), o) as CanvasFileNode;
  }
  createLinkNode(o: CreateNodeOptions & { url: string }): CanvasLinkNode {
    return this.finishCreate(new CanvasLinkNode(this, { id: randomId(), type: "link", url: o.url, ...this.place("link", o) }), o) as CanvasLinkNode;
  }
  createGroupNode(o: CreateNodeOptions & { label?: string }): CanvasGroupNode {
    const d: any = { id: randomId(), type: "group", ...this.place("group", o) };
    if (o.label) d.label = o.label;
    const n = new CanvasGroupNode(this, d);
    if (o.save !== false) this.pushHistory();
    // Groups go first so they sit below everything.
    const rest = [...this.nodes.values()];
    for (const r of rest) this.nodes.delete(r.id);
    this.nodes.set(n.id, n);
    for (const r of rest) this.nodes.set(r.id, r);
    this.nodeLayerEl.prepend(n.nodeEl);
    n.render();
    this.restack();
    if (o.focus !== false && o.save !== false) this.selectOnly(n);
    if (o.save !== false) this.requestSave();
    return n;
  }
  /** Wrap the selected nodes in a new group. */
  createGroupFromSelection(label = ""): CanvasGroupNode | null {
    const b = unionBBox([...this.selection].filter((i): i is CanvasNode => i instanceof CanvasNode).map((n) => n.getBBox()));
    if (!b) return null;
    const p = padBBox(b, 20);
    return this.createGroupNode({ pos: { x: p.minX, y: p.minY }, position: "topleft", size: { width: p.maxX - p.minX, height: p.maxY - p.minY }, label });
  }
  addEdgeBetween(from: CanvasNode, fromSide: NodeSide | undefined, to: CanvasNode, toSide: NodeSide | undefined, save = true): CanvasEdge {
    if (save) this.pushHistory();
    const d: CanvasEdgeData = { id: randomId(), fromNode: from.id, toNode: to.id };
    if (fromSide) d.fromSide = fromSide;
    if (toSide) d.toSide = toSide;
    const ordered: CanvasEdgeData = { id: d.id, fromNode: d.fromNode, ...(fromSide ? { fromSide } : {}), toNode: d.toNode, ...(toSide ? { toSide } : {}) };
    const e = new CanvasEdge(this, ordered, from, to);
    this.addEdge(e);
    if (save) this.requestSave();
    return e;
  }
  /** Nodes fully inside `bbox` (what moves along with a group). */
  getContainingNodes(bbox: BBox): CanvasNode[] { return [...this.nodes.values()].filter((n) => bboxContains(bbox, n.getBBox())); }
  getIntersectingNodes(bbox: BBox): CanvasNode[] { return [...this.nodes.values()].filter((n) => bboxIntersects(bbox, n.getBBox())); }

  // ---------------------------------------------------------------- history
  /** Snapshot before a change. */
  pushHistory(): void {
    const h = this.history;
    h.past.push(JSON.stringify(this.getData()));
    if (h.past.length > h.max) h.past.shift();
    h.future = [];
  }
  /** Forget the last snapshot (a change that turned out to be a no-op). */
  dropHistory(): void { this.history.past.pop(); }
  canUndo(): boolean { return this.history.past.length > 0; }
  canRedo(): boolean { return this.history.future.length > 0; }
  undo(): void { this.step(this.history.past, this.history.future); }
  redo(): void { this.step(this.history.future, this.history.past); }
  private step(from: string[], to: string[]): void {
    if (this.readonly) return;
    const snap = from.pop();
    if (!snap) return;
    to.push(JSON.stringify(this.getData()));
    const ids = new Set([...this.selection].map((i) => i.id));
    this.setData(JSON.parse(snap));
    this.selectOnlyMany([...ids].map((id) => this.nodes.get(id) ?? this.edges.get(id)).filter((i): i is CanvasItem => !!i));
    this.requestSave();
  }

  // ---------------------------------------------------------------- selection
  select(item: CanvasItem): void { this.selection.add(item); this.updateSelectionUI(); }
  deselect(item: CanvasItem): void { this.selection.delete(item); if (item instanceof CanvasNode) item.blur(); this.updateSelectionUI(); }
  selectOnly(item: CanvasItem): void { this.selectOnlyMany([item]); }
  selectOnlyMany(items: CanvasItem[]): void {
    for (const i of this.selection) if (!items.includes(i) && i instanceof CanvasNode) i.blur();
    this.selection = new Set(items);
    this.updateSelectionUI();
  }
  deselectAll(): void { this.selectOnlyMany([]); }
  selectAll(): void { this.selectOnlyMany([...this.nodes.values(), ...this.edges.values()]); }
  toggleSelect(item: CanvasItem): void { if (this.selection.has(item)) this.deselect(item); else this.select(item); }
  getSelectionData(): CanvasData {
    const nodes = [...this.selection].filter((i): i is CanvasNode => i instanceof CanvasNode);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = [...this.edges.values()].filter((e) => this.selection.has(e) || (ids.has(e.from.node.id) && ids.has(e.to.node.id)));
    return { nodes: nodes.map((n) => n.getData()), edges: edges.filter((e) => ids.has(e.from.node.id) && ids.has(e.to.node.id)).map((e) => e.getData()) };
  }
  getSelectionBBox(): BBox | null { return unionBBox([...this.selection].map((i) => i.getBBox())); }
  deleteSelection(): void {
    if (this.readonly || !this.selection.size) return;
    this.pushHistory();
    for (const i of [...this.selection]) { if (i instanceof CanvasEdge) this.removeEdge(i, false); else this.removeNode(i, false); }
    this.requestSave();
  }
  /** Copy of the selection with fresh ids, offset a little (duplicate / paste). */
  duplicate(data: CanvasData = this.getSelectionData(), offset: Point = { x: 30, y: 30 }): CanvasItem[] {
    if (this.readonly || !data.nodes.length) return [];
    this.pushHistory();
    const map = new Map<string, string>();
    const nodes = data.nodes.map((n) => { const id = randomId(); map.set(n.id, id); return { ...n, id, x: n.x + offset.x, y: n.y + offset.y }; });
    const edges = data.edges.filter((e) => map.has(e.fromNode) && map.has(e.toNode)).map((e) => ({ ...e, id: randomId(), fromNode: map.get(e.fromNode)!, toNode: map.get(e.toNode)! }));
    const made = this.importData({ nodes, edges }, true);
    this.requestSave();
    return made;
  }
  private updateSelectionUI(): void {
    for (const n of this.nodes.values()) n.nodeEl.toggleClass("is-selected", this.selection.has(n));
    for (const e of this.edges.values()) e.lineGroupEl.classList.toggle("is-selected", this.selection.has(e));
    const one = this.selection.size === 1 ? [...this.selection][0] : null;
    for (const n of this.nodes.values()) n.nodeEl.toggleClass("is-focused", n === one);
    const b = this.getSelectionBBox();
    if (b && this.selection.size > 1) {
      const s = this.selectionEl.style;
      s.transform = `translate(${b.minX}px, ${b.minY}px)`; s.width = `${b.maxX - b.minX}px`; s.height = `${b.maxY - b.minY}px`;
      this.selectionEl.show();
    } else this.selectionEl.hide();
    this.host.onSelectionChange?.();
  }

  // ---------------------------------------------------------------- viewport
  viewportSize(): { width: number; height: number } {
    return { width: this.wrapperEl.clientWidth || 800, height: this.wrapperEl.clientHeight || 600 };
  }
  setViewport(x: number, y: number, zoom: number): void {
    this.x = x; this.y = y; this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.applyViewport();
  }
  private applyViewport(): void {
    const { width, height } = this.viewportSize();
    const k = this.scale;
    const tx = width / 2 - this.x * k, ty = height / 2 - this.y * k;
    this.canvasEl.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    const g = this.options.gridSize * k * (k < 0.5 ? 2 : 1);
    const bs = this.backgroundEl.style;
    bs.backgroundSize = `${g}px ${g}px`;
    bs.backgroundPosition = `${tx}px ${ty}px`;
    this.wrapperEl.style.setProperty("--zoom-multiplier", String(1 / k));
    this.wrapperEl.toggleClass("is-zoomed-out", k < 0.4);
    this.host.onViewportChange?.();
  }
  /** Re-centre after the container was resized. */
  onResize(): void { this.applyViewport(); }
  /** Fit `b` with `pad` screen pixels around it (plus room above for the card and group labels). */
  zoomToBbox(b: BBox, pad = 40): void {
    const { width, height } = this.viewportSize();
    const top = 24;
    const k = Math.min((width - pad * 2) / Math.max(1, b.maxX - b.minX), (height - pad * 2 - top) / Math.max(1, b.maxY - b.minY), 1);
    const c = bboxCenter(b);
    this.setViewport(c.x, c.y - top / 2 / Math.max(k, 1e-3), Math.log2(Math.max(k, 1e-3)));
  }
  getContentBBox(): BBox | null { return unionBBox([...this.nodes.values()].map((n) => n.getBBox())); }
  zoomToFit(): void { const b = this.getContentBBox(); if (b) this.zoomToBbox(b); else this.setViewport(0, 0, 0); }
  zoomToSelection(): void { const b = this.getSelectionBBox(); if (b) this.zoomToBbox(b); else this.zoomToFit(); }
  /** Zoom by `delta` (log2 units) keeping `at` (canvas coordinates) fixed on screen. */
  zoomBy(delta: number, at?: Point): void {
    const z = clamp(this.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    if (!at || !isFinite(at.x) || !isFinite(at.y)) { this.setViewport(this.x, this.y, z); return; }
    const k0 = this.scale, k1 = Math.pow(2, z);
    this.setViewport(at.x - (at.x - this.x) * k0 / k1, at.y - (at.y - this.y) * k0 / k1, z);
  }
  getViewportBBox(): BBox {
    const { width, height } = this.viewportSize();
    const k = this.scale;
    return { minX: this.x - width / 2 / k, minY: this.y - height / 2 / k, maxX: this.x + width / 2 / k, maxY: this.y + height / 2 / k };
  }
  /** Client (screen) coordinates -> canvas coordinates. */
  posFromClient(p: Point): Point {
    const r = this.wrapperEl.getBoundingClientRect();
    const { width, height } = this.viewportSize();
    const k = this.scale;
    return { x: (p.x - r.left - width / 2) / k + this.x, y: (p.y - r.top - height / 2) / k + this.y };
  }
  posFromEvt(e: { clientX: number; clientY: number }): Point { return this.posFromClient({ x: e.clientX, y: e.clientY }); }
  /** Canvas coordinates -> position inside the wrapper (for overlays). */
  posToWrapper(p: Point): Point {
    const { width, height } = this.viewportSize();
    const k = this.scale;
    return { x: (p.x - this.x) * k + width / 2, y: (p.y - this.y) * k + height / 2 };
  }

  // ---------------------------------------------------------------- interaction
  private on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Document, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts));
  }
  destroy(): void { this.clear(); for (const d of this.disposers.splice(0)) d(); this.wrapperEl.remove(); }

  itemFromTarget(t: EventTarget | null): CanvasItem | null {
    const el = t instanceof Element ? t : null;
    const nodeEl = el?.closest<HTMLElement>("[data-node-id]");
    if (nodeEl) return this.nodes.get(nodeEl.dataset.nodeId!) ?? null;
    const edgeEl = el?.closest("[data-edge-id]");
    if (edgeEl) return this.edges.get(edgeEl.getAttribute("data-edge-id")!) ?? null;
    return null;
  }
  private isEditingTarget(t: EventTarget | null): boolean {
    const el = t instanceof Element ? t : null;
    return !!el && !!el.closest(".canvas-node.is-editing .canvas-node-content, input, textarea, [contenteditable='true']");
  }
  private isUiTarget(t: EventTarget | null): boolean {
    return t instanceof Element && !!t.closest(".canvas-controls, .canvas-menu-container, .canvas-card-menu, .canvas-path-label-editor, a, audio, video, iframe");
  }

  private installInteraction(): void {
    const w = this.wrapperEl;
    this.on(w, "pointerdown", (e) => this.onPointerDown(e));
    // Focusing an editor inside a card makes the browser scroll the (overflow: hidden) wrapper; the viewport is ours.
    this.on(w, "scroll", () => { if (w.scrollTop || w.scrollLeft) { w.scrollTop = 0; w.scrollLeft = 0; } });
    this.on(w, "dblclick", (e) => this.onDoubleClick(e));
    this.on(w, "wheel", (e) => this.onWheel(e), { passive: false });
    this.on(w, "keydown", (e) => this.onKeyDown(e));
    this.on(w, "keyup", (e) => { if (e.key === " ") { this.spaceDown = false; w.removeClass("is-panning-ready"); } });
    this.on(w, "contextmenu", (e) => {
      if (this.isEditingTarget(e.target) || this.isUiTarget(e.target)) return;
      e.preventDefault();
      if (this.suppressContext) { this.suppressContext = false; return; }
      const item = this.itemFromTarget(e.target);
      if (item && !this.selection.has(item)) this.selectOnly(item);
      this.host.onContextMenu?.(e, item, this.posFromEvt(e));
    });
    this.on(w, "dragover", (e) => { if (!this.readonly && e.dataTransfer) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    this.on(w, "drop", (e) => { if (!this.readonly) this.onDrop(e); });
    // Leave editing when focus moves out of a card.
    this.on(w, "focusout", (e) => {
      const from = (e.target as Element | null)?.closest?.(".canvas-node.is-editing");
      const to = e.relatedTarget as Element | null;
      if (from && !(to && from.contains(to))) {
        const n = this.nodes.get((from as HTMLElement).dataset.nodeId!);
        // A short delay lets clicks inside the card (or a refocus) cancel it.
        setTimeout(() => { if (n?.isEditing && !n.nodeEl.contains(document.activeElement)) n.stopEditing(); }, 0);
      }
    });
  }

  /** One pointer drag: calls move with the pointer position (canvas coords) and end on release. */
  private drag(e: PointerEvent, move: (p: Point, ev: PointerEvent) => void, end: (p: Point, moved: boolean, ev: PointerEvent) => void): void {
    const start = { x: e.clientX, y: e.clientY };
    let moved = false;
    const doc = this.wrapperEl.ownerDocument;
    try { this.wrapperEl.setPointerCapture?.(e.pointerId); } catch { /* synthetic events have no active pointer */ }
    const mv = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
      moved = true;
      move(this.posFromEvt(ev), ev);
    };
    const up = (ev: PointerEvent) => {
      doc.removeEventListener("pointermove", mv);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
      end(this.posFromEvt(ev), moved, ev);
    };
    doc.addEventListener("pointermove", mv);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
  }

  private pointers = new Map<number, Point>();
  private onPointerDown(e: PointerEvent): void {
    if (this.isUiTarget(e.target) || this.isEditingTarget(e.target)) return;
    this.wrapperEl.focus({ preventScroll: true });
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const forget = (ev: PointerEvent) => { if (ev.pointerId === e.pointerId) { this.pointers.delete(e.pointerId); this.wrapperEl.ownerDocument.removeEventListener("pointerup", forget); } };
    this.wrapperEl.ownerDocument.addEventListener("pointerup", forget);
    if (this.pointers.size === 2) return this.startPinch();
    const t = e.target as Element;
    const pos = this.posFromEvt(e);
    // Pan: middle/right button, or space held.
    if (e.button === 1 || e.button === 2 || this.spaceDown) {
      if (e.button === 2) {
        // Right-drag pans; a right click without movement opens the context menu.
        this.dragPan(e, () => { this.suppressContext = true; });
      } else { e.preventDefault(); this.dragPan(e); }
      return;
    }
    if (e.button !== 0) return;
    const resize = t.closest<HTMLElement>("[data-resize]");
    const conn = t.closest<HTMLElement>(".canvas-node-connection-point");
    const item = this.itemFromTarget(t);
    if (resize && item instanceof CanvasNode && !this.readonly) { e.preventDefault(); return this.dragResize(e, item, resize.dataset.resize!); }
    if (conn && item instanceof CanvasNode && !this.readonly) { e.preventDefault(); return this.dragConnect(e, item, conn.dataset.side as NodeSide); }
    if (item instanceof CanvasEdge) {
      if (e.shiftKey) this.toggleSelect(item); else this.selectOnly(item);
      return;
    }
    if (item instanceof CanvasNode) {
      e.preventDefault();
      if (e.shiftKey) { this.toggleSelect(item); return; }
      if (!this.selection.has(item)) this.selectOnly(item);
      if (!this.readonly) this.dragMove(e, pos);
      return;
    }
    // Background: rubber-band selection.
    e.preventDefault();
    this.dragBand(e, pos);
  }

  private dragPan(e: PointerEvent, onMoved?: () => void): void {
    const sx = e.clientX, sy = e.clientY, x0 = this.x, y0 = this.y;
    this.wrapperEl.addClass("is-panning");
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (Math.hypot(dx, dy) < 3) return;
      onMoved?.();
      this.setViewport(x0 - dx / this.scale, y0 - dy / this.scale, this.zoom);
    };
    const doc = this.wrapperEl.ownerDocument;
    const up = () => { doc.removeEventListener("pointermove", mv); doc.removeEventListener("pointerup", up); this.wrapperEl.removeClass("is-panning"); };
    doc.addEventListener("pointermove", mv);
    doc.addEventListener("pointerup", up);
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    const d0 = Math.hypot(a.x - b.x, a.y - b.y) || 1, z0 = this.zoom;
    const ids = [...this.pointers.keys()];
    const doc = this.wrapperEl.ownerDocument;
    const mv = (ev: PointerEvent) => {
      if (!this.pointers.has(ev.pointerId)) return;
      this.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const [p, q] = ids.map((id) => this.pointers.get(id)!);
      if (!p || !q) return;
      const mid = this.posFromClient({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
      this.zoomBy(z0 + Math.log2(Math.hypot(p.x - q.x, p.y - q.y) / d0) - this.zoom, mid);
    };
    const up = () => { if (this.pointers.size < 2) { doc.removeEventListener("pointermove", mv); doc.removeEventListener("pointerup", up); } };
    doc.addEventListener("pointermove", mv);
    doc.addEventListener("pointerup", up);
  }

  private dragMove(e: PointerEvent, start: Point): void {
    const moving = new Set<CanvasNode>();
    for (const i of this.selection) {
      if (!(i instanceof CanvasNode)) continue;
      moving.add(i);
      if (i instanceof CanvasGroupNode) for (const n of this.getContainingNodes(i.getBBox())) moving.add(n);
    }
    const orig = new Map([...moving].map((n) => [n, { x: n.x, y: n.y }]));
    const lead = [...this.selection].find((i): i is CanvasNode => i instanceof CanvasNode);
    let snapshotted = false;
    this.wrapperEl.addClass("is-dragging");
    this.drag(e, (p, ev) => {
      if (!snapshotted) { this.pushHistory(); snapshotted = true; }
      let dx = p.x - start.x, dy = p.y - start.y;
      // Snap the card under the pointer to the grid; the others keep their offsets.
      if (this.options.snapToGrid && lead && !ev.altKey) {
        const o = orig.get(lead)!, g = this.options.gridSize;
        dx = snap(o.x + dx, g) - o.x; dy = snap(o.y + dy, g) - o.y;
      }
      for (const [n, o] of orig) n.moveTo({ x: Math.round(o.x + dx), y: Math.round(o.y + dy) });
    }, (_p, moved) => {
      this.wrapperEl.removeClass("is-dragging");
      this.host.onSelectionChange?.();
      if (moved) this.requestSave();
    });
  }

  private dragResize(e: PointerEvent, node: CanvasNode, dir: string): void {
    const o = { x: node.x, y: node.y, w: node.width, h: node.height };
    const start = this.posFromEvt(e);
    let snapshotted = false;
    this.drag(e, (p, ev) => {
      if (!snapshotted) { this.pushHistory(); snapshotted = true; }
      const g = this.options.snapToGrid && !ev.altKey ? this.options.gridSize : 0;
      const dx = p.x - start.x, dy = p.y - start.y;
      let { x, y, w, h } = o;
      if (dir.includes("e")) w = Math.max(MIN_SIZE, snap(o.x + o.w + dx, g) - o.x);
      if (dir.includes("s")) h = Math.max(MIN_SIZE, snap(o.y + o.h + dy, g) - o.y);
      if (dir.includes("w")) { const nx = Math.min(snap(o.x + dx, g), o.x + o.w - MIN_SIZE); w = o.x + o.w - nx; x = nx; }
      if (dir.includes("n")) { const ny = Math.min(snap(o.y + dy, g), o.y + o.h - MIN_SIZE); h = o.y + o.h - ny; y = ny; }
      node.moveAndResize({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    }, (_p, moved) => { if (moved) this.requestSave(); });
  }

  /** Drag from a side handle; dropping on a card connects to its nearest side, on empty space creates a connected text card. */
  private dragConnect(e: PointerEvent, from: CanvasNode, side: NodeSide): void {
    const a = sidePoint(from, side);
    const ghost = this.ghostEl;
    this.wrapperEl.addClass("is-connecting");
    this.drag(e, (p, ev) => {
      const target = this.nodeAt(ev, from);
      const ts = target ? closestSide(target, p) : this.facingSide(a, p);
      const g = edgeGeometry(a, side, target ? sidePoint(target, ts) : p, ts);
      ghost.setAttribute("d", g.path);
      ghost.style.display = "";
      for (const n of this.nodes.values()) n.nodeEl.toggleClass("is-connect-target", n === target);
    }, (p, moved, ev) => {
      ghost.style.display = "none";
      this.wrapperEl.removeClass("is-connecting");
      for (const n of this.nodes.values()) n.nodeEl.removeClass("is-connect-target");
      if (!moved) return;
      const target = this.nodeAt(ev, from);
      if (target) { this.selectOnly(this.addEdgeBetween(from, side, target, closestSide(target, p))); return; }
      this.pushHistory();
      const ts = this.facingSide(a, p);
      const sz = DEFAULT_SIZE.text, n = sideNormal(ts);
      // Place the new card so the dragged-to point is the middle of its facing side.
      const center = { x: p.x - n.x * sz.width / 2, y: p.y - n.y * sz.height / 2 };
      const card = this.createTextNode({ pos: center, save: false });
      this.addEdgeBetween(from, side, card, ts, false);
      this.selectOnly(card);
      this.requestSave();
      card.startEditing();
    });
  }
  /** Side of a card at `p` that faces back towards `from`. */
  private facingSide(from: Point, p: Point): NodeSide {
    const dx = from.x - p.x, dy = from.y - p.y;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "bottom" : "top");
  }
  private nodeAt(ev: { clientX: number; clientY: number }, except?: CanvasNode): CanvasNode | null {
    const p = this.posFromEvt(ev);
    // Topmost first; groups only when no card is under the pointer.
    const hits = [...this.nodes.values()].filter((n) => n !== except && p.x >= n.x && p.x <= n.x + n.width && p.y >= n.y && p.y <= n.y + n.height);
    return hits.reverse().sort((a, b) => Number(a instanceof CanvasGroupNode) - Number(b instanceof CanvasGroupNode))[0] ?? null;
  }

  private dragBand(e: PointerEvent, start: Point): void {
    const base = e.shiftKey ? new Set(this.selection) : new Set<CanvasItem>();
    if (!e.shiftKey) this.deselectAll();
    const band = this.bandEl;
    this.drag(e, (p) => {
      const b = bboxFromPoints(start, p);
      const tl = this.posToWrapper({ x: b.minX, y: b.minY }), br = this.posToWrapper({ x: b.maxX, y: b.maxY });
      Object.assign(band.style, { left: `${tl.x}px`, top: `${tl.y}px`, width: `${br.x - tl.x}px`, height: `${br.y - tl.y}px` });
      band.show();
      const hit = [...this.nodes.values()].filter((n) => bboxIntersects(b, n.getBBox()) && !(n instanceof CanvasGroupNode && !bboxContains(b, n.getBBox())));
      this.selectOnlyMany([...base, ...hit]);
    }, () => band.hide());
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.readonly || this.isUiTarget(e.target) || this.isEditingTarget(e.target)) return;
    const t = e.target as Element;
    const item = this.itemFromTarget(t);
    if (item instanceof CanvasEdge) { this.host.onLabelEdit?.(item); return; }
    if (item instanceof CanvasGroupNode && t.closest(".canvas-group-label")) { this.host.onLabelEdit?.(item); return; }
    if (item instanceof CanvasNode && !(item instanceof CanvasGroupNode)) {
      if (item.isEditable()) { this.selectOnly(item); item.startEditing(); }
      return;
    }
    const n = this.createTextNode({ pos: this.posFromEvt(e) });
    n.startEditing();
  }

  private onWheel(e: WheelEvent): void {
    if (this.isEditingTarget(e.target) && !(e.ctrlKey || e.metaKey)) return;
    // Scrollable card content scrolls itself.
    const scroller = (e.target as Element).closest?.(".canvas-node.is-focused .canvas-node-content, .canvas-node.is-editing .canvas-node-content");
    if (scroller && scroller.scrollHeight > scroller.clientHeight && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (e.ctrlKey || e.metaKey || this.options.wheelZoom) { this.zoomBy(-dy * 0.01, this.posFromEvt(e)); return; }
    const k = this.scale;
    if (e.shiftKey && !dx) this.setViewport(this.x + dy / k, this.y, this.zoom);
    else this.setViewport(this.x + dx / k, this.y + dy / k, this.zoom);
  }

  /** Clipboard of the last copy (also written to the system clipboard as JSON Canvas). */
  static clipboard: CanvasData | null = null;
  private onKeyDown(e: KeyboardEvent): void {
    if (this.isEditingTarget(e.target)) {
      if (e.key === "Escape") {
        const n = this.itemFromTarget(e.target);
        if (n instanceof CanvasNode) { e.preventDefault(); e.stopPropagation(); n.stopEditing(); this.wrapperEl.focus(); }
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    let handled = true;
    if (e.key === " ") { this.spaceDown = true; this.wrapperEl.addClass("is-panning-ready"); }
    else if (e.key === "Delete" || e.key === "Backspace") this.deleteSelection();
    else if (e.key === "Escape") this.deselectAll();
    else if (mod && k === "z" && !e.shiftKey) this.undo();
    else if (mod && (k === "y" || (k === "z" && e.shiftKey))) this.redo();
    else if (mod && k === "a") this.selectAll();
    else if (mod && k === "d") this.duplicate();
    else if (mod && (k === "c" || k === "x")) {
      const d = this.getSelectionData();
      if (!d.nodes.length) { handled = false; }
      else {
        Canvas.clipboard = d;
        void navigator.clipboard?.writeText(JSON.stringify(d)).catch(() => {});
        if (k === "x") this.deleteSelection();
      }
    }
    else if (mod && k === "v" && Canvas.clipboard) {
      const c = Canvas.clipboard, b = unionBBox(c.nodes.map((n) => rectBBox(n)));
      const at = this.getViewportBBox();
      const off = b ? { x: Math.round(bboxCenter(at).x - bboxCenter(b).x), y: Math.round(bboxCenter(at).y - bboxCenter(b).y) } : { x: 0, y: 0 };
      this.duplicate(c, off);
    }
    else if (mod && (e.key === "=" || e.key === "+")) this.zoomBy(0.5);
    else if (mod && e.key === "-") this.zoomBy(-0.5);
    else if (mod && e.key === "0") this.setViewport(this.x, this.y, 0);
    else if (e.shiftKey && (e.key === "!" || e.code === "Digit1")) this.zoomToFit();
    else if (e.shiftKey && (e.key === "@" || e.code === "Digit2")) this.zoomToSelection();
    else if (e.key === "Enter" && this.selection.size === 1) {
      const n = [...this.selection][0];
      if (n instanceof CanvasNode && n.isEditable()) n.startEditing(); else handled = false;
    }
    else if (e.key.startsWith("Arrow") && this.selection.size && !this.readonly) {
      const step = e.shiftKey ? this.options.gridSize * 5 : this.options.gridSize;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
      this.pushHistory();
      for (const i of this.selection) if (i instanceof CanvasNode) i.moveTo({ x: i.x + d[0], y: i.y + d[1] });
      this.requestSave();
    }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  private onDrop(e: DragEvent): void {
    const dt = e.dataTransfer;
    if (!dt) return;
    e.preventDefault();
    let pos = this.posFromEvt(e);
    const step = (n: CanvasNode) => { pos = { x: pos.x + 30, y: pos.y + 30 }; return n; };
    const made: CanvasNode[] = [];
    const vault = this.app.vault;
    const text = dt.getData("text/plain") ?? "";
    const uri = dt.getData("text/uri-list") ?? "";
    // The file explorer drags vault paths; links (`[[x]]`, obsidian://open?file=) are accepted too.
    const asFile = (s: string): TFile | null => {
      const t = s.trim();
      if (!t) return null;
      const direct = vault.getFileByPath(t);
      if (direct) return direct;
      const m = /^!?\[\[([^\]|#]+)/.exec(t);
      if (m) return this.app.metadataCache.getFirstLinkpathDest(m[1], this.sourcePath);
      const o = /^obsidian:\/\/open\?.*file=([^&]+)/.exec(t);
      if (o) { const p = decodeURIComponent(o[1]); return vault.getFileByPath(p) ?? vault.getFileByPath(p + ".md"); }
      return null;
    };
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const files = lines.map(asFile);
    this.pushHistory();
    if (lines.length && files.every((f) => f)) {
      for (const f of files as TFile[]) made.push(step(this.createFileNode({ pos, file: f, save: false })));
    } else if (/^https?:\/\/\S+$/.test((uri.split(/\r?\n/)[0] || text).trim())) {
      made.push(this.createLinkNode({ pos, url: (uri.split(/\r?\n/)[0] || text).trim(), save: false }));
    } else if (text.trim()) {
      made.push(this.createTextNode({ pos, text, save: false }));
    }
    if (!made.length) { this.dropHistory(); return; }
    this.selectOnlyMany(made);
    this.requestSave();
  }
}

/** Mount the canvas controls (zoom / fit / undo / redo) into the wrapper. */
export function buildControls(canvas: Canvas): HTMLElement {
  const el = canvas.wrapperEl.createDiv({ cls: "canvas-controls" });
  const group = (items: [string, string, () => void][]) => {
    const g = el.createDiv({ cls: "canvas-control-group" });
    for (const [icon, label, fn] of items) {
      const b = g.createDiv({ cls: "canvas-control-item clickable-icon", attr: { "aria-label": label, "data-tooltip-position": "left" } });
      setIcon(b, icon);
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); canvas.wrapperEl.focus({ preventScroll: true }); });
    }
  };
  group([["lucide-plus", "Zoom in", () => canvas.zoomBy(0.5)], ["lucide-rotate-ccw", "Reset zoom", () => canvas.setViewport(canvas.x, canvas.y, 0)], ["lucide-maximize", "Zoom to fit", () => canvas.zoomToFit()], ["lucide-minus", "Zoom out", () => canvas.zoomBy(-0.5)]]);
  group([["lucide-undo-2", "Undo", () => canvas.undo()], ["lucide-redo-2", "Redo", () => canvas.redo()]]);
  return el;
}
