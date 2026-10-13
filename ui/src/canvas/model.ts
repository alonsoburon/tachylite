// JSON Canvas 1.0 data model (https://jsoncanvas.org/spec/1.0/, the format of .canvas files): types matching the
// `obsidian/canvas` typings, tolerant parsing, serialisation in the layout Obsidian writes, and geometry helpers.

export type CanvasColor = string;
export type NodeSide = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";
export type BackgroundStyle = "cover" | "ratio" | "repeat";

export interface CanvasNodeData { id: string; x: number; y: number; width: number; height: number; color?: CanvasColor; [key: string]: any }
export interface CanvasFileData extends CanvasNodeData { type: "file"; file: string; subpath?: string }
export interface CanvasTextData extends CanvasNodeData { type: "text"; text: string }
export interface CanvasLinkData extends CanvasNodeData { type: "link"; url: string }
export interface CanvasGroupData extends CanvasNodeData { type: "group"; label?: string; background?: string; backgroundStyle?: BackgroundStyle }
export type AllCanvasNodeData = CanvasFileData | CanvasTextData | CanvasLinkData | CanvasGroupData;
export interface CanvasEdgeData {
  id: string; fromNode: string; fromSide?: NodeSide; fromEnd?: EdgeEnd; toNode: string; toSide?: NodeSide; toEnd?: EdgeEnd;
  color?: CanvasColor; label?: string; [key: string]: any;
}
export interface CanvasData { nodes: AllCanvasNodeData[]; edges: CanvasEdgeData[]; [key: string]: any }

export const SIDES: readonly NodeSide[] = ["top", "right", "bottom", "left"];
/** Default sizes of new cards (text cards are one line high; file, link and group cards are square). */
export const DEFAULT_SIZE = { text: { width: 250, height: 60 }, file: { width: 400, height: 400 }, link: { width: 400, height: 400 }, group: { width: 400, height: 400 } } as const;

/** Parse .canvas text. Empty files are an empty canvas; `nodes`/`edges` default to []; other keys are kept. Throws on invalid JSON. */
export function parseCanvas(text: string): CanvasData {
  if (!text.trim()) return { nodes: [], edges: [] };
  const raw = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A canvas file must contain a JSON object");
  const out: CanvasData = { ...raw, nodes: [], edges: [] };
  const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!n || typeof n !== "object" || typeof n.id !== "string") continue;
    // Keep the object (key order and unknown keys) but make the geometry usable.
    n.x = num(n.x, 0); n.y = num(n.y, 0); n.width = num(n.width, 250); n.height = num(n.height, 60);
    out.nodes.push(n);
  }
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (e && typeof e === "object" && typeof e.id === "string" && typeof e.fromNode === "string" && typeof e.toNode === "string") out.edges.push(e);
  }
  return out;
}

/**
 * Serialise like Obsidian does: tab-indented top level, one compact JSON object per node/edge line, no trailing newline.
 * `nodes` and `edges` come first unless the source file ordered its top-level keys differently.
 */
export function serializeCanvas(data: CanvasData): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  for (const k of ["edges", "nodes"]) if (!keys.includes(k)) keys.unshift(k);
  const list = (items: unknown[]) => (items.length ? `[\n${items.map((i) => "\t\t" + JSON.stringify(i)).join(",\n")}\n\t]` : "[]");
  const body = keys.map((k) => `\t${JSON.stringify(k)}:${k === "nodes" || k === "edges" ? list((data[k] as unknown[]) ?? []) : JSON.stringify(data[k])}`);
  return `{\n${body.join(",\n")}\n}`;
}

/** 16 hex digits, the id shape Obsidian generates for nodes and edges. */
export function randomId(): string {
  const b = new Uint8Array(8);
  (globalThis.crypto ?? { getRandomValues: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** CSS colour for a canvas colour: presets "1".."6" map to the theme's `--canvas-color-N`, anything else is used as is (hex). */
export function cssColor(c: CanvasColor | undefined): string | null {
  if (!c) return null;
  if (/^[1-6]$/.test(c)) return `var(--canvas-color-${c})`;
  return /^#[0-9a-f]{3,8}$/i.test(c) || /^(rgb|hsl)a?\(/i.test(c) ? c : null;
}

// ---------------------------------------------------------------- geometry

export interface Point { x: number; y: number }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }
export interface Rect { x: number; y: number; width: number; height: number }

export const rectBBox = (r: Rect): BBox => ({ minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height });
export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  return boxes.reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
}
export const bboxContains = (outer: BBox, inner: BBox): boolean => inner.minX >= outer.minX && inner.minY >= outer.minY && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY;
export const bboxIntersects = (a: BBox, b: BBox): boolean => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
export const bboxCenter = (b: BBox): Point => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
export const padBBox = (b: BBox, p: number): BBox => ({ minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p });
export function bboxFromPoints(a: Point, b: Point): BBox { return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) }; }

/** Midpoint of one side of a node. */
export function sidePoint(r: Rect, side: NodeSide): Point {
  switch (side) {
    case "top": return { x: r.x + r.width / 2, y: r.y };
    case "bottom": return { x: r.x + r.width / 2, y: r.y + r.height };
    case "left": return { x: r.x, y: r.y + r.height / 2 };
    default: return { x: r.x + r.width, y: r.y + r.height / 2 };
  }
}
/** Outward unit normal of a side. */
export function sideNormal(side: NodeSide): Point {
  return side === "top" ? { x: 0, y: -1 } : side === "bottom" ? { x: 0, y: 1 } : side === "left" ? { x: -1, y: 0 } : { x: 1, y: 0 };
}
/** Side of `r` whose midpoint is nearest to `p`. */
export function closestSide(r: Rect, p: Point): NodeSide {
  let best: NodeSide = "top", d = Infinity;
  for (const s of SIDES) { const q = sidePoint(r, s); const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (dd < d) { d = dd; best = s; } }
  return best;
}
/** Sides an edge without explicit sides attaches to: the pair facing each other along the dominant axis. */
export function autoSides(a: Rect, b: Rect): [NodeSide, NodeSide] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2), dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

export interface EdgeGeometry { from: Point; to: Point; c1: Point; c2: Point; fromSide: NodeSide; toSide: NodeSide; path: string; mid: Point }
/** Cubic Bézier between two sides; control points leave each side along its normal. */
export function edgeGeometry(from: Point, fromSide: NodeSide, to: Point, toSide: NodeSide): EdgeGeometry {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const k = Math.max(40, Math.min(300, dist / 2));
  const n1 = sideNormal(fromSide), n2 = sideNormal(toSide);
  const c1 = { x: from.x + n1.x * k, y: from.y + n1.y * k }, c2 = { x: to.x + n2.x * k, y: to.y + n2.y * k };
  const r = (v: number) => Math.round(v * 100) / 100;
  const path = `M${r(from.x)},${r(from.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(to.x)},${r(to.y)}`;
  return { from, to, c1, c2, fromSide, toSide, path, mid: bezierPoint(from, c1, c2, to, 0.5) };
}
export function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}
/** Triangle (SVG `points`) for an arrow whose tip touches `tip`, pointing into the node through `side`. */
export function arrowPoints(tip: Point, side: NodeSide, size = 12): string {
  const n = sideNormal(side); // outward: the arrow body sits outside the node
  const bx = tip.x + n.x * size, by = tip.y + n.y * size;
  const px = -n.y * size * 0.55, py = n.x * size * 0.55;
  const r = (v: number) => Math.round(v * 100) / 100;
  return `${r(tip.x)},${r(tip.y)} ${r(bx + px)},${r(by + py)} ${r(bx - px)},${r(by - py)}`;
}
/** Squared distance from `p` to a sampled Bézier (hit-testing edges in tests and for drop targets). */
export function distanceToEdge(g: EdgeGeometry, p: Point, samples = 24): number {
  let d = Infinity;
  for (let i = 0; i <= samples; i++) { const q = bezierPoint(g.from, g.c1, g.c2, g.to, i / samples); d = Math.min(d, (q.x - p.x) ** 2 + (q.y - p.y) ** 2); }
  return Math.sqrt(d);
}
export const snap = (v: number, grid: number): number => (grid > 0 ? Math.round(v / grid) * grid : Math.round(v));
