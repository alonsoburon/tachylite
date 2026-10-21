// Graph data: options (graph.json key names), node/edge extraction from the link maps, global and local graphs.
// DOM-free and unit-tested.

export type NodeKind = "note" | "attachment" | "unresolved" | "tag";

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Number of edges touching the node (after filtering). */
  degree: number;
  /** Radius before the node size multiplier. */
  r: number;
  x: number; y: number; vx: number; vy: number;
  fixed: boolean;
  /** Distance from the centre file in a local graph (0 = centre); -1 in the global graph. */
  depth: number;
  /** Fill colour from a matching group (0xRRGGBB), or -1. */
  color: number;
}
/** A directed edge between node indices (source links to target). */
export interface GraphLink { source: number; target: number }
export interface GraphData { nodes: GraphNode[]; links: GraphLink[] }

export interface ColorGroup { query: string; color: { a: number; rgb: number } }

/** Options as persisted in `.obsidian/graph.json` (global graph) or in the local graph's view state. */
export interface GraphOptions {
  "collapse-filter": boolean;
  search: string;
  showTags: boolean;
  showAttachments: boolean;
  hideUnresolved: boolean;
  showOrphans: boolean;
  "collapse-color-groups": boolean;
  colorGroups: ColorGroup[];
  "collapse-display": boolean;
  showArrow: boolean;
  textFadeMultiplier: number;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  "collapse-forces": boolean;
  /** Slider positions in [0, 1] mapped on a log curve (see sliderToStrength). */
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
  scale: number;
  close: boolean;
}
export interface LocalOptions { localJumps: number; localBacklinks: boolean; localForelinks: boolean; localInterlinks: boolean }

/**
 * Slider position (0..1) -> strength, on a log curve so the low end gets most of the travel: position 0 is 0,
 * position 1 is 1, and `t` sets the curvature. strengthToSlider is its inverse.
 */
export function sliderToStrength(pos: number, t = 0.01): number { return (Math.pow(t, 1 - pos) - t) / (1 - t); }
export function strengthToSlider(v: number, t = 0.01): number { return 1 - Math.log(v * (1 - t) + t) / Math.log(t); }

export const DEFAULT_OPTIONS: GraphOptions = {
  "collapse-filter": true, search: "", showTags: false, showAttachments: false, hideUnresolved: false, showOrphans: true,
  "collapse-color-groups": true, colorGroups: [],
  "collapse-display": true, showArrow: false, textFadeMultiplier: 0, nodeSizeMultiplier: 1, lineSizeMultiplier: 1,
  "collapse-forces": true, centerStrength: strengthToSlider(0.1), repelStrength: 10, linkStrength: strengthToSlider(1), linkDistance: 250,
  scale: 1, close: true,
};
export const DEFAULT_LOCAL: LocalOptions = { localJumps: 1, localBacklinks: true, localForelinks: true, localInterlinks: false };

const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Merge a (possibly partial or hand-edited) graph.json object over the defaults, clamping numbers. */
export function normalizeOptions(raw: unknown): GraphOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_OPTIONS;
  const groups = Array.isArray(o.colorGroups) ? (o.colorGroups as any[]).filter((g) => g && typeof g === "object").map((g) => ({
    query: typeof g.query === "string" ? g.query : "",
    color: { a: num(g.color?.a, 1, 0, 1), rgb: Math.round(num(g.color?.rgb, 0x888888, 0, 0xffffff)) },
  })) : [];
  return {
    "collapse-filter": bool(o["collapse-filter"], d["collapse-filter"]), search: typeof o.search === "string" ? o.search : "",
    showTags: bool(o.showTags, d.showTags), showAttachments: bool(o.showAttachments, d.showAttachments),
    hideUnresolved: bool(o.hideUnresolved, d.hideUnresolved), showOrphans: bool(o.showOrphans, d.showOrphans),
    "collapse-color-groups": bool(o["collapse-color-groups"], d["collapse-color-groups"]), colorGroups: groups,
    "collapse-display": bool(o["collapse-display"], d["collapse-display"]), showArrow: bool(o.showArrow, d.showArrow),
    textFadeMultiplier: num(o.textFadeMultiplier, d.textFadeMultiplier, -3, 3), nodeSizeMultiplier: num(o.nodeSizeMultiplier, d.nodeSizeMultiplier, 0.1, 5),
    lineSizeMultiplier: num(o.lineSizeMultiplier, d.lineSizeMultiplier, 0.1, 5),
    "collapse-forces": bool(o["collapse-forces"], d["collapse-forces"]),
    centerStrength: num(o.centerStrength, d.centerStrength, 0, 1), repelStrength: num(o.repelStrength, d.repelStrength, 0, 20),
    linkStrength: num(o.linkStrength, d.linkStrength, 0, 1), linkDistance: num(o.linkDistance, d.linkDistance, 30, 500),
    scale: num(o.scale, d.scale, 0.02, 8), close: bool(o.close, d.close),
  };
}
export function normalizeLocal(raw: unknown): LocalOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    localJumps: Math.round(num(o.localJumps, DEFAULT_LOCAL.localJumps, 1, 5)),
    localBacklinks: bool(o.localBacklinks, DEFAULT_LOCAL.localBacklinks), localForelinks: bool(o.localForelinks, DEFAULT_LOCAL.localForelinks),
    localInterlinks: bool(o.localInterlinks, DEFAULT_LOCAL.localInterlinks),
  };
}

export type LinkMap = Record<string, Record<string, number>>;
export interface GraphSource {
  resolved: LinkMap;
  unresolved: LinkMap;
  /** Every note/file that should appear even without links (orphans). */
  files: Iterable<string>;
  /** Tags of a file (with or without '#'); only used when showTags is on. */
  tagsOf?(path: string): string[];
}
export interface BuildOptions {
  showTags?: boolean; showAttachments?: boolean; hideUnresolved?: boolean; showOrphans?: boolean;
  /** Files matching the search filter (null = no filter). */
  match?: Set<string> | null;
  /** Local graph around this file. */
  local?: (LocalOptions & { center: string }) | null;
}

const NOTE_EXT = /\.(md|canvas|base)$/i;
export function isNotePath(p: string): boolean { return NOTE_EXT.test(p); }
function labelOf(p: string): string {
  const n = p.slice(p.lastIndexOf("/") + 1);
  return /\.md$/i.test(n) ? n.slice(0, -3) : n;
}
export function nodeRadius(degree: number): number { return Math.min(16, 4 + Math.sqrt(Math.max(0, degree)) * 1.5); }

/**
 * Build nodes and directed edges. Unresolved targets become "?name" nodes, tags "#tag" nodes. Filters apply in this order:
 * kinds (attachments, unresolved, tags), search match (files outside it go, then dangling unresolved/tag nodes), the local
 * neighbourhood, then orphans.
 */
export function buildGraph(src: GraphSource, opts: BuildOptions = {}): GraphData {
  const showAtt = !!opts.showAttachments, showTags = !!opts.showTags, hideUnres = !!opts.hideUnresolved;
  const showOrphans = opts.showOrphans !== false;
  const ids: string[] = [];
  const kinds: NodeKind[] = [];
  const index = new Map<string, number>();
  const add = (id: string, kind: NodeKind): number => {
    let i = index.get(id);
    if (i === undefined) { i = ids.length; index.set(id, i); ids.push(id); kinds.push(kind); }
    return i;
  };
  const fileOk = (p: string) => (isNotePath(p) || showAtt) && (!opts.match || opts.match.has(p));
  for (const p of src.files) if (fileOk(p)) add(p, isNotePath(p) ? "note" : "attachment");
  const edgeSet = new Set<number>();
  const out: number[][] = [];
  const inc: number[][] = [];
  const edges: GraphLink[] = [];
  const connect = (a: number, b: number) => {
    if (a === b) return;
    const key = a * 1_048_576 + b; // unique for < 1M nodes
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source: a, target: b });
    (out[a] ??= []).push(b);
    (inc[b] ??= []).push(a);
  };
  for (const s of Object.keys(src.resolved)) {
    if (!fileOk(s)) continue;
    const a = add(s, isNotePath(s) ? "note" : "attachment");
    for (const t of Object.keys(src.resolved[s] ?? {})) if (fileOk(t)) connect(a, add(t, isNotePath(t) ? "note" : "attachment"));
  }
  if (!hideUnres) {
    for (const s of Object.keys(src.unresolved)) {
      if (!fileOk(s)) continue;
      const a = add(s, isNotePath(s) ? "note" : "attachment");
      for (const t of Object.keys(src.unresolved[s] ?? {})) connect(a, add("?" + t, "unresolved"));
    }
  }
  if (showTags && src.tagsOf) {
    for (let i = 0, n = ids.length; i < n; i++) {
      if (kinds[i] !== "note") continue;
      for (const raw of src.tagsOf(ids[i])) {
        const tag = raw.startsWith("#") ? raw : "#" + raw;
        connect(i, add(tag, "tag"));
      }
    }
  }
  // Which nodes survive: the local neighbourhood, if any.
  const n = ids.length;
  const depth = new Int32Array(n).fill(-1);
  let keep: Uint8Array;
  const local = opts.local;
  if (local) {
    keep = new Uint8Array(n);
    const c = index.get(local.center);
    if (c !== undefined) {
      depth[c] = 0; keep[c] = 1;
      let frontier = [c];
      for (let d = 1; d <= Math.max(1, local.localJumps) && frontier.length; d++) {
        const next: number[] = [];
        for (const u of frontier) {
          // Tags and unresolved names are leaves: they connect notes but are not walked through.
          if (u !== c && (kinds[u] === "tag" || kinds[u] === "unresolved")) continue;
          const nb = [...(local.localForelinks ? out[u] ?? [] : []), ...(local.localBacklinks ? inc[u] ?? [] : [])];
          // Tags are reached from the notes that carry them, whatever the direction toggles say.
          if (!local.localForelinks) for (const t of out[u] ?? []) if (kinds[t] === "tag") nb.push(t);
          for (const v of nb) if (!keep[v]) { keep[v] = 1; depth[v] = d; next.push(v); }
        }
        frontier = next;
      }
    }
  } else keep = new Uint8Array(n).fill(1);
  // Edges between kept nodes; a local graph without "neighbor links" keeps only edges that step one level away from the centre.
  const kept: GraphLink[] = [];
  for (const e of edges) {
    if (!keep[e.source] || !keep[e.target]) continue;
    if (local && !local.localInterlinks && Math.abs(depth[e.source] - depth[e.target]) !== 1) continue;
    kept.push(e);
  }
  const degree = new Int32Array(n);
  for (const e of kept) { degree[e.source]++; degree[e.target]++; }
  // Dangling unresolved/tag nodes (their notes were filtered out) and, unless asked for, orphans go.
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    if (degree[i] === 0 && (kinds[i] === "unresolved" || kinds[i] === "tag")) keep[i] = 0;
    else if (degree[i] === 0 && !showOrphans && depth[i] !== 0) keep[i] = 0;
  }
  const remap = new Int32Array(n).fill(-1);
  const nodes: GraphNode[] = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    remap[i] = nodes.length;
    const id = ids[i], kind = kinds[i];
    const label = kind === "unresolved" ? id.slice(1) : kind === "tag" ? id : labelOf(id);
    nodes.push({ id, label, kind, degree: degree[i], r: nodeRadius(degree[i]), x: 0, y: 0, vx: 0, vy: 0, fixed: false, depth: local ? depth[i] : -1, color: -1 });
  }
  const links: GraphLink[] = [];
  for (const e of kept) {
    const a = remap[e.source], b = remap[e.target];
    if (a >= 0 && b >= 0) links.push({ source: a, target: b });
  }
  return { nodes, links };
}

/** Colour of the first group whose matching files include the node (groups apply to files only). */
export function applyGroups(nodes: GraphNode[], groups: { color: number; files: Set<string> | null }[]): void {
  for (const n of nodes) {
    n.color = -1;
    if (n.kind === "unresolved" || n.kind === "tag") continue;
    for (const g of groups) if (g.files?.has(n.id)) { n.color = g.color; break; }
  }
}

/**
 * Time-lapse: when each node of `data` appears. A note appears at its creation time; a node without a file of its own
 * (tag, unresolved link) appears with its earliest neighbour. `ctimeOf` gives the creation time of a path, or undefined.
 */
export function appearTimes(data: GraphData, ctimeOf: (id: string) => number | undefined): number[] {
  const own = data.nodes.map((n) => ctimeOf(n.id));
  const out: (number | undefined)[] = [...own];
  for (const l of data.links) {
    for (const [i, j] of [[l.source, l.target], [l.target, l.source]]) {
      if (own[i] !== undefined || own[j] === undefined) continue;
      out[i] = out[i] === undefined ? own[j] : Math.min(out[i]!, own[j]!);
    }
  }
  const known = out.filter((x): x is number => x !== undefined);
  const fallback = known.length ? Math.min(...known) : 0;
  return out.map((x) => x ?? fallback);
}

/** The part of `data` made of the nodes whose index passes `keep` (edges between kept nodes only). */
export function subGraph(data: GraphData, keep: (i: number) => boolean): GraphData {
  const map = new Map<number, number>();
  const nodes: GraphNode[] = [];
  data.nodes.forEach((n, i) => { if (keep(i)) { map.set(i, nodes.length); nodes.push({ ...n, degree: 0 }); } });
  const links: GraphLink[] = [];
  for (const l of data.links) {
    const a = map.get(l.source), b = map.get(l.target);
    if (a !== undefined && b !== undefined) { links.push({ source: a, target: b }); nodes[a].degree++; nodes[b].degree++; }
  }
  for (const n of nodes) n.r = nodeRadius(n.degree);
  return { nodes, links };
}
