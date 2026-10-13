// Graph core plugin: graph data (filters, tags, local neighbourhoods), slider mapping and graph.json normalisation,
// the Barnes-Hut layout (including a 5k-note graph), and the global/local views with their settings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootCore, type Core } from "./helpers/core";
import { readJson } from "./helpers/settings";
import {
  DEFAULT_OPTIONS, GraphView, LocalGraphView, QueryCache, applyGroups, buildGraph, createSimulation, forcesFrom, hitTest, isSettled,
  normalizeOptions, sliderToStrength, stepSimulation, strengthToSlider, type GraphSource, type LinkMap,
} from "../src/app/core/graph";

const resolved: LinkMap = { "a.md": { "b.md": 1, "c.md": 2 }, "b.md": { "a.md": 1 }, "c.md": {}, "d.md": {}, "e.md": { "img.png": 1 } };
const unresolved: LinkMap = { "a.md": { Ghost: 1 } };
const src = (extra: Partial<GraphSource> = {}): GraphSource => ({ resolved, unresolved, files: ["a.md", "b.md", "c.md", "d.md", "e.md", "img.png"], ...extra });
const ids = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort();
const forces = forcesFrom(DEFAULT_OPTIONS);

describe("graph data", () => {
  it("builds directed unique edges, unresolved nodes, degree-sized nodes and applies the filters", () => {
    const g = buildGraph(src());
    expect(ids(g)).toEqual(["?Ghost", "a.md", "b.md", "c.md", "d.md", "e.md"]);
    expect(g.links).toHaveLength(4); // a->b, b->a, a->c, a->ghost
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    expect(by["a.md"].degree).toBe(4); expect(by["a.md"].r).toBeGreaterThan(by["c.md"].r);
    expect(by["?Ghost"].kind).toBe("unresolved"); expect(by["?Ghost"].label).toBe("Ghost"); expect(by["b.md"].label).toBe("b");
    expect(ids(buildGraph(src(), { hideUnresolved: true }))).not.toContain("?Ghost");
    expect(ids(buildGraph(src(), { showOrphans: false }))).toEqual(["?Ghost", "a.md", "b.md", "c.md"]);
    const att = buildGraph(src(), { showAttachments: true });
    expect(att.nodes.find((n) => n.id === "img.png")!.kind).toBe("attachment");
    expect(att.nodes.find((n) => n.id === "e.md")!.degree).toBe(1);
    // search filter: only matching files, and unresolved/tag nodes left without a neighbour go too
    expect(ids(buildGraph(src(), { match: new Set(["b.md", "c.md"]) }))).toEqual(["b.md", "c.md"]);
    expect(ids(buildGraph(src(), { match: new Set(["a.md"]) }))).toEqual(["?Ghost", "a.md"]);
  });

  it("adds tag nodes linked to the notes that carry them", () => {
    const g = buildGraph(src({ tagsOf: (p) => (p === "a.md" ? ["#x", "y"] : p === "d.md" ? ["#x"] : []) }), { showTags: true });
    const x = g.nodes.findIndex((n) => n.id === "#x");
    expect(g.nodes[x].kind).toBe("tag");
    expect(g.links.filter((l) => l.target === x)).toHaveLength(2);
    expect(ids(g)).toContain("#y");
    expect(ids(buildGraph(src({ tagsOf: () => ["#x"] })))).not.toContain("#x");
  });

  it("local graph: depth, incoming/outgoing toggles and neighbour links", () => {
    // chain p -> q -> r -> s, plus q -> x and x -> r (a link between two neighbours of q)
    const r: LinkMap = { "p.md": { "q.md": 1 }, "q.md": { "r.md": 1, "x.md": 1 }, "r.md": { "s.md": 1 }, "x.md": { "r.md": 1 }, "lone.md": {} };
    const s: GraphSource = { resolved: r, unresolved: {}, files: Object.keys(r).concat("s.md") };
    const local = (o: Partial<{ localJumps: number; localBacklinks: boolean; localForelinks: boolean; localInterlinks: boolean }>) =>
      buildGraph(s, { local: { center: "q.md", localJumps: 1, localBacklinks: true, localForelinks: true, localInterlinks: false, ...o } });
    const g1 = local({});
    expect(ids(g1)).toEqual(["p.md", "q.md", "r.md", "x.md"]);
    expect(g1.nodes.find((n) => n.id === "q.md")!.depth).toBe(0);
    expect(g1.links).toHaveLength(3); // x -> r is between two depth-1 nodes: hidden without neighbour links
    expect(local({ localInterlinks: true }).links).toHaveLength(4);
    expect(ids(local({ localJumps: 2 }))).toEqual(["p.md", "q.md", "r.md", "s.md", "x.md"]);
    expect(ids(local({ localBacklinks: false }))).toEqual(["q.md", "r.md", "x.md"]);
    expect(ids(local({ localForelinks: false }))).toEqual(["p.md", "q.md"]);
    expect(ids(buildGraph(s, { local: { center: "lone.md", localJumps: 3, localBacklinks: true, localForelinks: true, localInterlinks: false }, showOrphans: false }))).toEqual(["lone.md"]);
  });

  it("colours nodes by the first matching group", () => {
    const g = buildGraph(src());
    applyGroups(g.nodes, [{ color: 0xff0000, files: new Set(["a.md"]) }, { color: 0x00ff00, files: new Set(["a.md", "b.md"]) }, { color: 1, files: null }]);
    const by = Object.fromEntries(g.nodes.map((n) => [n.id, n.color]));
    expect(by).toMatchObject({ "a.md": 0xff0000, "b.md": 0x00ff00, "c.md": -1, "?Ghost": -1 });
  });

  it("maps sliders on the log curve and normalises graph.json", () => {
    expect(sliderToStrength(0)).toBeCloseTo(0); expect(sliderToStrength(1)).toBeCloseTo(1);
    expect(sliderToStrength(strengthToSlider(0.1))).toBeCloseTo(0.1);
    expect(DEFAULT_OPTIONS.centerStrength).toBeCloseTo(0.5188, 3);
    const o = normalizeOptions({ showTags: true, repelStrength: 99, linkDistance: "x", colorGroups: [{ query: "tag:#a", color: { a: 1, rgb: 255 } }, null], unknown: 1 });
    expect(o).toMatchObject({ showTags: true, repelStrength: 20, linkDistance: 250, colorGroups: [{ query: "tag:#a", color: { a: 1, rgb: 255 } }] });
    expect(Object.keys(o).sort()).toEqual(Object.keys(DEFAULT_OPTIONS).sort());
  });
});

describe("graph layout", () => {
  it("is deterministic, cools down, pulls linked nodes together and respects fixed nodes", () => {
    const run = () => {
      const s = createSimulation(buildGraph(src()), forces);
      let i = 0;
      while (!isSettled(s) && i++ < 3000) stepSimulation(s);
      return { s, i };
    };
    const { s, i } = run();
    expect(i).toBeLessThan(3000);
    expect(s.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(run().s.nodes.map((n) => [n.x, n.y])).toEqual(s.nodes.map((n) => [n.x, n.y]));
    const pos = (id: string) => s.nodes.find((n) => n.id === id)!;
    const d = (a: string, b: string) => Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y);
    expect(d("a.md", "b.md")).toBeLessThan(d("a.md", "d.md"));
    const fixed = createSimulation(buildGraph(src()), forces);
    fixed.nodes[0].fixed = true;
    const [x, y] = [fixed.nodes[0].x, fixed.nodes[0].y];
    for (let k = 0; k < 20; k++) stepSimulation(fixed);
    expect([fixed.nodes[0].x, fixed.nodes[0].y]).toEqual([x, y]);
    expect(s.nodes[hitTest(s.nodes, pos("a.md").x, pos("a.md").y)].id).toBe("a.md");
    expect(hitTest(s.nodes, 1e6, 1e6)).toBe(-1);
  });

  it("handles coincident nodes and stays finite", () => {
    const s = createSimulation(buildGraph({ resolved: {}, unresolved: {}, files: ["a.md", "b.md", "c.md"] }), forces);
    for (const n of s.nodes) { n.x = 5; n.y = 5; }
    for (let i = 0; i < 50; i++) stepSimulation(s);
    expect(s.nodes.every((n) => Number.isFinite(n.x))).toBe(true);
    expect(new Set(s.nodes.map((n) => `${n.x.toFixed(3)},${n.y.toFixed(3)}`)).size).toBe(3);
  });

  it("a generated 5k-note vault builds and ticks fast enough to stay interactive", () => {
    const N = 5000;
    const r: LinkMap = {};
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < N; i++) {
      const out: Record<string, number> = {};
      for (let j = 0; j < 3; j++) out[`n${Math.floor(rnd() * N)}.md`] = 1;
      r[`n${i}.md`] = out;
    }
    const t0 = performance.now();
    const g = buildGraph({ resolved: r, unresolved: {}, files: Object.keys(r) });
    const tBuild = performance.now() - t0;
    expect(g.nodes).toHaveLength(N);
    const s = createSimulation(g, forces);
    stepSimulation(s); // warm-up (JIT, tree allocation)
    const t1 = performance.now();
    const ticks = 20;
    for (let i = 0; i < ticks; i++) stepSimulation(s);
    const perTick = (performance.now() - t1) / ticks;
    console.log(`[graph perf] 5k nodes / ${g.links.length} links: build ${tBuild.toFixed(1)} ms, tick ${perTick.toFixed(1)} ms`);
    expect(tBuild).toBeLessThan(1000);
    expect(perTick).toBeLessThan(60); // one tick per frame; the webview is faster than the test VM
    expect(s.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    const t2 = performance.now();
    for (let i = 0; i < 200; i++) hitTest(s.nodes, 0, 0);
    expect((performance.now() - t2) / 200).toBeLessThan(5);
  });
});

describe("query cache", () => {
  it("answers once the backend has, then from cache until cleared", async () => {
    let calls = 0, notified = 0;
    const q = new QueryCache(() => notified++, async (s) => { calls++; return s === "x" ? [{ path: "a.md" }] : []; });
    expect(q.get("")).toBeNull();
    expect(q.get("x")).toBeUndefined();
    expect(q.get("x")).toBeUndefined();
    await vi.waitFor(() => expect(notified).toBe(1));
    expect([...q.get("x")!]).toEqual(["a.md"]);
    expect(calls).toBe(1);
    q.clear();
    expect(q.get("x")).toBeUndefined();
  });
});

describe("graph views", () => {
  let c: Core;
  const files = { "A.md": "# A\n[[B]] [[C]] [[Gone]] #topic", "B.md": "[[A]]", "C.md": "no links", "dir/D.md": "[[A]]", "pic.png": "x" };
  const searches: string[] = [];
  beforeEach(async () => {
    searches.length = 0;
    c = await bootCore(files, { vault_search: (a) => { searches.push(a.query); return a.query === "path:dir" ? [{ path: "dir/D.md", lines: [] }] : a.query === "B" ? [{ path: "B.md", lines: [] }] : []; } });
  });
  afterEach(async () => { await c.dispose(); });
  const graphView = async () => {
    c.app.commands.executeCommand(c.app.commands.findCommand("graph:open")!);
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("graph")).toHaveLength(1));
    const v = c.app.workspace.getLeavesOfType("graph")[0].view as GraphView;
    await vi.waitFor(() => expect(v.sim.nodes.length).toBeGreaterThan(0));
    return v;
  };
  const toggleRow = (v: GraphView | LocalGraphView, name: string) => {
    const row = [...v.controlsEl.querySelectorAll<HTMLElement>(".setting-item")].find((s) => s.querySelector(".setting-item-name")?.textContent === name)!;
    row.querySelector<HTMLElement>(".checkbox-container")!.click();
  };
  const slide = (v: GraphView | LocalGraphView, name: string, value: number) => {
    const row = [...v.controlsEl.querySelectorAll<HTMLElement>(".setting-item")].find((s) => s.querySelector(".setting-item-name")?.textContent === name)!;
    const input = row.querySelector<HTMLInputElement>("input[type=range]")!;
    input.value = String(value);
    input.dispatchEvent(new Event("input"));
  };

  it("global graph: builds from the cache, sections and toggles, persists graph.json with Obsidian's keys", async () => {
    const v = await graphView();
    expect(v.getDisplayText()).toBe("Graph view");
    expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["?Gone", "A.md", "B.md", "C.md", "dir/D.md"]);
    expect([...v.controlsEl.querySelectorAll(".graph-control-section")].map((s) => s.className.match(/mod-([\w-]+)/)![1])).toEqual(["filter", "color-groups", "display", "forces"]);
    toggleRow(v, "Existing files only");
    expect(v.options.hideUnresolved).toBe(true);
    expect(v.sim.nodes.some((n) => n.kind === "unresolved")).toBe(false);
    toggleRow(v, "Tags");
    expect(v.sim.nodes.some((n) => n.id === "#topic")).toBe(true);
    toggleRow(v, "Attachments");
    toggleRow(v, "Arrows");
    slide(v, "Repel force", 15);
    slide(v, "Node size", 2);
    expect(v.sim.forces.repel).toBe(15);
    await vi.waitFor(() => expect(readJson(c.v, ".obsidian/graph.json")).toMatchObject({ hideUnresolved: true, showTags: true, showAttachments: true, showArrow: true, repelStrength: 15, nodeSizeMultiplier: 2, linkDistance: 250, colorGroups: [] }), { timeout: 3000 });
    // collapsing a section and closing the panel persist too
    (v.controlsEl.querySelector(".graph-control-section.mod-forces .tree-item-self") as HTMLElement).click();
    (v.controlsEl.querySelector(".graph-controls-button.mod-open") as HTMLElement).click();
    await vi.waitFor(() => expect(readJson(c.v, ".obsidian/graph.json")).toMatchObject({ "collapse-forces": false, close: false }), { timeout: 3000 });
    v.openNode("dir/D.md", "note");
    await vi.waitFor(() => expect(c.app.workspace.getActiveFile()?.path).toBe("dir/D.md"));
    await c.app.vault.create("New.md", "[[A]]");
    await vi.waitFor(() => expect(v.sim.nodes.some((n) => n.id === "New.md")).toBe(true), { timeout: 2000 });
  });

  it("reads graph.json on open; search filter and colour groups go through the search backend", async () => {
    c.v.backend("config_write", { name: "graph.json", value: { showOrphans: false, colorGroups: [{ query: "path:dir", color: { a: 1, rgb: 0x112233 } }] } });
    await c.app.vault.create("Lone.md", "");
    const v = await graphView();
    expect(v.options.showOrphans).toBe(false);
    expect(v.sim.nodes.some((n) => n.id === "C.md")).toBe(true);
    expect(v.sim.nodes.some((n) => n.id === "Lone.md")).toBe(false);
    await vi.waitFor(() => expect(v.sim.nodes.find((n) => n.id === "dir/D.md")!.color).toBe(0x112233));
    expect(searches).toContain("path:dir");
    toggleRow(v, "Orphans"); // a lone search hit has no edges left
    const search = v.controlsEl.querySelector<HTMLInputElement>(".graph-control-search input")!;
    search.value = "B"; search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(v.sim.nodes.map((n) => n.id)).toEqual(["B.md"]), { timeout: 2000 });
    // a new group gets a colour; its query applies once typed
    (([...v.controlsEl.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "New group"))!).click();
    expect(v.options.colorGroups).toHaveLength(2);
    expect(v.options.colorGroups[1].color.rgb).toBeGreaterThan(0);
  });

  it("local graph follows the active file, has depth/direction controls and keeps its options in the view state", async () => {
    const open = async (p: string) => { const l = c.app.workspace.getLeaf(false); await l.openFile(c.app.vault.getFileByPath(p)!, { active: true }); return l; };
    const md = await open("B.md");
    c.app.commands.executeCommand(c.app.commands.findCommand("graph:open-local")!);
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("localgraph")).toHaveLength(1));
    const leaf = c.app.workspace.getLeavesOfType("localgraph")[0];
    const v = leaf.view as LocalGraphView;
    await vi.waitFor(() => expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["A.md", "B.md"]));
    expect(v.getDisplayText()).toBe("Graph of B");
    slide(v, "Depth", 2);
    expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["?Gone", "A.md", "B.md", "C.md", "dir/D.md"]);
    toggleRow(v, "Outgoing links");
    expect(v.local.localForelinks).toBe(false);
    expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["A.md", "B.md", "dir/D.md"]);
    // follows the active file
    c.app.workspace.setActiveLeaf(md);
    await md.openFile(c.app.vault.getFileByPath("C.md")!, { active: true });
    await vi.waitFor(() => expect(v.file).toBe("C.md"));
    expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["A.md", "B.md", "C.md", "dir/D.md"]); // depth 2 through incoming links
    expect(v.getState()).toMatchObject({ file: "C.md", options: { localJumps: 2, localForelinks: false, localBacklinks: true, showOrphans: true } });
    // the state restores into a new leaf
    const l2 = c.app.workspace.getLeaf("tab");
    await l2.setViewState({ type: "localgraph", state: v.getState() });
    const v2 = l2.view as LocalGraphView;
    expect(v2.local.localJumps).toBe(2);
    await vi.waitFor(() => expect(v2.sim.nodes.length).toBe(4));
    await c.app.internalPlugins.plugins["graph"].disable();
    expect(c.app.workspace.getLeavesOfType("localgraph")).toHaveLength(0);
    expect(c.app.commands.findCommand("graph:open-local")).toBeUndefined();
  });
});
