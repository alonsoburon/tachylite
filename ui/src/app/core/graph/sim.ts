// Force layout: Barnes-Hut repulsion (quadtree in flat typed arrays, O(n log n) per tick), spring links, a pull towards
// the origin and velocity damping, cooled by `alpha`. DOM-free and deterministic for a given input.
import { sliderToStrength, type GraphData, type GraphNode, type GraphOptions } from "./model";

export interface Forces { center: number; repel: number; link: number; distance: number }
export interface SimState extends GraphData { alpha: number; forces: Forces }

/** World-space forces from the slider values of graph.json. */
export function forcesFrom(o: Pick<GraphOptions, "centerStrength" | "repelStrength" | "linkStrength" | "linkDistance">): Forces {
  return {
    center: sliderToStrength(o.centerStrength),
    repel: o.repelStrength,
    link: sliderToStrength(o.linkStrength),
    distance: o.linkDistance / 5,
  };
}

const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 400); // ~400 ticks from hot to settled
const THETA2 = 0.81; // Barnes-Hut opening criterion (theta = 0.9), squared

export const isSettled = (s: SimState): boolean => s.alpha < ALPHA_MIN;
export function reheat(s: SimState, alpha = 0.3): void { s.alpha = Math.max(s.alpha, alpha); }

/** Deterministic starting layout (golden-angle spiral), denser for big graphs. */
export function seedPositions(nodes: GraphNode[], spread = 10): void {
  const golden = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((n, i) => { const r = spread * Math.sqrt(i + 0.5); n.x = Math.cos(i * golden) * r; n.y = Math.sin(i * golden) * r; n.vx = n.vy = 0; });
}

export function createSimulation(data: GraphData, forces: Forces): SimState {
  seedPositions(data.nodes);
  return { ...data, alpha: 1, forces };
}

/** Flat quadtree reused between ticks (grows as needed). */
class QuadTree {
  cap = 0;
  x0!: Float64Array; y0!: Float64Array; size!: Float64Array;
  mx!: Float64Array; my!: Float64Array; mass!: Float64Array;
  child!: Int32Array; // 4 per cell, -1 = none
  point!: Int32Array; // node index held by a leaf, -1 = internal or empty
  count = 0;
  private grow(min: number): void {
    if (this.cap >= min) return;
    const cap = Math.max(min, this.cap * 2, 64);
    const f = (old: Float64Array | undefined) => { const a = new Float64Array(cap); if (old) a.set(old.subarray(0, this.count)); return a; };
    this.x0 = f(this.x0); this.y0 = f(this.y0); this.size = f(this.size); this.mx = f(this.mx); this.my = f(this.my); this.mass = f(this.mass);
    const c = new Int32Array(cap * 4).fill(-1); if (this.child) c.set(this.child.subarray(0, this.count * 4)); this.child = c;
    const p = new Int32Array(cap).fill(-1); if (this.point) p.set(this.point.subarray(0, this.count)); this.point = p;
    this.cap = cap;
  }
  private cell(x0: number, y0: number, size: number): number {
    if (this.count >= this.cap) this.grow(this.count + 1);
    const i = this.count++;
    this.x0[i] = x0; this.y0[i] = y0; this.size[i] = size;
    this.mx[i] = 0; this.my[i] = 0; this.mass[i] = 0;
    this.child.fill(-1, i * 4, i * 4 + 4);
    this.point[i] = -1;
    return i;
  }
  build(nodes: GraphNode[]): void {
    this.count = 0;
    this.grow(nodes.length * 2 + 1);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) { if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x; if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y; }
    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.0001;
    const root = this.cell(minX, minY, size);
    for (let i = 0; i < nodes.length; i++) this.insert(root, i, nodes, 0);
    // Children are always created after their parent: a reverse sweep computes centres of mass bottom-up.
    for (let c = this.count - 1; c >= 0; c--) {
      const p = this.point[c];
      if (p >= 0) { this.mass[c] = 1; this.mx[c] = nodes[p].x; this.my[c] = nodes[p].y; continue; }
      let m = 0, sx = 0, sy = 0;
      for (let k = 0; k < 4; k++) {
        const ch = this.child[c * 4 + k];
        if (ch < 0 || this.mass[ch] === 0) continue;
        m += this.mass[ch]; sx += this.mx[ch] * this.mass[ch]; sy += this.my[ch] * this.mass[ch];
      }
      this.mass[c] = m;
      if (m) { this.mx[c] = sx / m; this.my[c] = sy / m; }
    }
  }
  private insert(c: number, i: number, nodes: GraphNode[], depth: number): void {
    for (;;) {
      const half = this.size[c] / 2;
      const hasKids = this.child[c * 4] >= 0 || this.child[c * 4 + 1] >= 0 || this.child[c * 4 + 2] >= 0 || this.child[c * 4 + 3] >= 0;
      if (!hasKids && this.point[c] < 0) { this.point[c] = i; return; }
      if (!hasKids) {
        // Split a leaf: push its point down. Coincident points stop splitting at a depth limit and share the leaf's mass.
        if (depth > 40) return;
        const j = this.point[c];
        this.point[c] = -1;
        this.place(c, j, nodes, half, depth);
      }
      const n = nodes[i];
      const q = (n.x >= this.x0[c] + half ? 1 : 0) + (n.y >= this.y0[c] + half ? 2 : 0);
      let ch = this.child[c * 4 + q];
      if (ch < 0) { ch = this.cell(this.x0[c] + (q & 1 ? half : 0), this.y0[c] + (q & 2 ? half : 0), half); this.child[c * 4 + q] = ch; this.point[ch] = i; return; }
      c = ch; depth++;
    }
  }
  private place(c: number, j: number, nodes: GraphNode[], half: number, depth: number): void {
    const n = nodes[j];
    const q = (n.x >= this.x0[c] + half ? 1 : 0) + (n.y >= this.y0[c] + half ? 2 : 0);
    const ch = this.cell(this.x0[c] + (q & 1 ? half : 0), this.y0[c] + (q & 2 ? half : 0), half);
    this.child[c * 4 + q] = ch;
    this.point[ch] = j;
    void depth;
  }
}
const tree = new QuadTree();
const stack = new Int32Array(4096);

/** Advance one tick; returns the remaining alpha. */
export function stepSimulation(s: SimState): number {
  const { nodes, links, forces: f } = s;
  const n = nodes.length;
  const a = s.alpha;
  if (n === 0) { s.alpha = 0; return 0; }
  // Repulsion: every node is pushed away from far cells as from one body at their centre of mass.
  const k = f.repel * 30 * a;
  if (k > 0 && n > 1) {
    tree.build(nodes);
    for (let i = 0; i < n; i++) {
      const u = nodes[i];
      let sp = 0;
      stack[sp++] = 0;
      let fx = 0, fy = 0;
      while (sp > 0) {
        const c = stack[--sp];
        const m = tree.mass[c];
        if (m === 0) continue;
        const p = tree.point[c];
        if (p === i) continue;
        let dx = tree.mx[c] - u.x, dy = tree.my[c] - u.y;
        let d2 = dx * dx + dy * dy;
        const sz = tree.size[c];
        if (p >= 0 || (sz * sz) / (d2 || 1e-9) < THETA2) {
          if (d2 < 1e-6) { dx = ((i * 7919) % 13) / 13 - 0.5; dy = ((i * 104729) % 17) / 17 - 0.5; d2 = dx * dx + dy * dy; }
          if (d2 < 1) d2 = 1;
          const w = (k * m) / d2;
          fx -= dx * w; fy -= dy * w;
        } else {
          for (let q = 0; q < 4; q++) { const ch = tree.child[c * 4 + q]; if (ch >= 0 && sp < stack.length) stack[sp++] = ch; }
        }
      }
      u.vx += fx; u.vy += fy;
    }
  }
  // Springs towards the link distance; low-degree ends move more.
  const ls = f.link * a;
  if (ls > 0) {
    for (const l of links) {
      const u = nodes[l.source], v = nodes[l.target];
      let dx = v.x + v.vx - u.x - u.vx, dy = v.y + v.vy - u.y - u.vy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const strength = ls / Math.max(1, Math.min(u.degree, v.degree));
      const kk = ((d - f.distance) / d) * strength;
      dx *= kk; dy *= kk;
      const bu = u.degree / ((u.degree + v.degree) || 1);
      v.vx -= dx * bu; v.vy -= dy * bu;
      u.vx += dx * (1 - bu); u.vy += dy * (1 - bu);
    }
  }
  // Pull to the origin, damping, integration.
  const cs = f.center * 0.1 * a;
  for (const u of nodes) {
    if (u.fixed) { u.vx = u.vy = 0; continue; }
    u.vx -= u.x * cs; u.vy -= u.y * cs;
    u.vx *= 0.6; u.vy *= 0.6;
    // Cap a single step so a bad start cannot fling nodes away.
    const sp = Math.hypot(u.vx, u.vy);
    if (sp > 200) { u.vx *= 200 / sp; u.vy *= 200 / sp; }
    u.x += u.vx; u.y += u.vy;
  }
  s.alpha = a * (1 - ALPHA_DECAY);
  return s.alpha;
}

/** Index of the node under world point (x, y) within `slack`, closest first; -1 when none. */
export function hitTest(nodes: GraphNode[], x: number, y: number, slack = 2, sizeMul = 1): number {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dx = n.x - x, dy = n.y - y;
    const r = n.r * sizeMul + slack;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r * r && d2 < bd) { bd = d2; best = i; }
  }
  return best;
}

/** World bounding box of the nodes (null when empty). */
export function bounds(nodes: GraphNode[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) { minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r); minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r); }
  return { minX, minY, maxX, maxY };
}
