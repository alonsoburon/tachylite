// View-bound commands of the canvas, bases and graph core plugins: availability (checkCallback), behavior in happy-dom.
// The PNG itself needs a real 2D canvas, so only the export plan, the dialog and the saving path are covered here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootCore, tick, type Core } from "./helpers/core";
import { CanvasView } from "../src/canvas/view";
import { CanvasFileNode, CanvasTextNode } from "../src/canvas/nodes";
import { ExportImageModal, planExport } from "../src/canvas/commands";
import { BasesFileView } from "../src/bases/fileView";
import { BaseGraphView, GraphView, appearTimes, buildGraph, subGraph } from "../src/app/core/graph";

const BOARD = JSON.stringify({
  nodes: [
    { id: "a", type: "text", text: "# Hello\nbody", x: 0, y: 0, width: 200, height: 100, color: "2" },
    { id: "b", type: "text", text: "plain", x: 0, y: 300, width: 200, height: 100 },
    { id: "g", type: "group", label: "Grp", x: 400, y: 0, width: 300, height: 300 },
    { id: "g2", type: "group", label: "Other", x: 1400, y: 1000, width: 300, height: 300 },
  ],
  edges: [{ id: "e", fromNode: "a", toNode: "b" }],
});
const NOGROUPS = JSON.stringify({ nodes: [{ id: "a", type: "text", text: "x", x: 0, y: 0, width: 200, height: 100 }], edges: [] });
const BASE = "views:\n  - type: table\n    name: Table\n    order: [file.name, status]\n  - type: cards\n    name: Cards\n";

let c: Core;
const check = (id: string) => (c.app.commands.findCommand(id) as any).checkCallback(true) === true;
const run = (id: string) => (c.app.commands.findCommand(id) as any).checkCallback(false);
const modal = (sel: string) => document.querySelector<HTMLElement>(sel);

describe("canvas commands", () => {
  beforeEach(async () => {
    c = await bootCore({ "board.canvas": BOARD, "plain.canvas": NOGROUPS, "n.md": "x" });
  });
  afterEach(async () => { await c.dispose(); });
  async function open(p = "board.canvas"): Promise<CanvasView> {
    await c.app.workspace.openLinkText(p, "", false);
    const v = c.app.workspace.getActiveViewOfType(CanvasView)!;
    v.canvas.setViewport(0, 0, 0);
    return v;
  }

  it("are unavailable outside a canvas and gated by the selection and the groups inside one", async () => {
    await c.app.workspace.openLinkText("n.md", "", false);
    for (const id of ["canvas:convert-to-file", "canvas:export-as-image", "canvas:jump-to-group"]) expect(check(id)).toBe(false);
    const v = await open();
    expect(check("canvas:convert-to-file")).toBe(false); // nothing selected
    expect(check("canvas:export-as-image")).toBe(true);
    expect(check("canvas:jump-to-group")).toBe(true);
    v.canvas.selectOnly(v.canvas.nodes.get("a")!);
    expect(check("canvas:convert-to-file")).toBe(true);
    v.canvas.select(v.canvas.nodes.get("b")!);
    expect(check("canvas:convert-to-file")).toBe(false); // two cards
    v.canvas.selectOnly(v.canvas.nodes.get("g")!);
    expect(check("canvas:convert-to-file")).toBe(false); // not a text card
    const w = await open("plain.canvas");
    expect(w).toBeTruthy();
    expect(check("canvas:jump-to-group")).toBe(false);
  });

  it("converts the selected text card to a note and rewires its edges", async () => {
    const v = await open();
    v.canvas.selectOnly(v.canvas.nodes.get("a")!);
    run("canvas:convert-to-file");
    const ta = await vi.waitFor(() => { const t = modal(".modal.mod-file-rename .rename-textarea") as HTMLTextAreaElement; expect(t).toBeTruthy(); return t; });
    expect(ta.value).toBe("Untitled");
    ta.value = "Conv";
    modal(".mod-file-rename .mod-cta")!.click();
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("Conv.md")).toBeTruthy());
    expect(await c.app.vault.read(c.app.vault.getFileByPath("Conv.md")!)).toBe("# Hello\nbody");
    await vi.waitFor(() => expect([...v.canvas.nodes.values()].some((n) => n instanceof CanvasFileNode)).toBe(true));
    const data = v.canvas.getData();
    expect(data.nodes.find((n) => n.id === "a")).toBeUndefined();
    const f = data.nodes.find((n) => n.type === "file")!;
    expect(f).toMatchObject({ file: "Conv.md", x: 0, y: 0, width: 200, height: 100 });
    expect((f as any).color).toBeUndefined();
    expect(data.edges[0]).toMatchObject({ fromNode: f.id, fromSide: "bottom", toNode: "b", toSide: "top" });
    expect([...v.canvas.selection].map((n) => n.id)).toEqual([f.id]);
    expect(v.canvas.nodes.get("b")).toBeInstanceOf(CanvasTextNode);
  });

  it("cancelling the file name leaves the card alone", async () => {
    const v = await open();
    v.canvas.selectOnly(v.canvas.nodes.get("a")!);
    run("canvas:convert-to-file");
    await vi.waitFor(() => expect(modal(".mod-file-rename")).toBeTruthy());
    modal(".mod-file-rename .mod-cancel")!.click();
    await tick(20);
    expect(v.canvas.nodes.get("a")).toBeInstanceOf(CanvasTextNode);
    expect(c.app.vault.getFileByPath("Untitled.md")).toBeNull();
  });

  it("jump to group lists the groups and pans to the chosen one", async () => {
    const v = await open();
    run("canvas:jump-to-group");
    await vi.waitFor(() => expect(modal(".prompt-input")).toBeTruthy());
    expect((modal(".prompt-input") as HTMLInputElement).placeholder).toBe("Jump to group");
    await vi.waitFor(() => expect([...document.querySelectorAll(".prompt-results .suggestion-item")].map((e) => e.textContent)).toEqual(["Grp", "Other"]));
    document.querySelectorAll<HTMLElement>(".prompt-results .suggestion-item")[1].click();
    await vi.waitFor(() => expect(v.canvas.x).toBeCloseTo(1550));
    expect(v.canvas.y).toBeGreaterThan(1000);
    expect(v.canvas.selection.size).toBe(0);
  });

  it("plans the export: padded content, selection, viewport, zoom", async () => {
    const v = await open("plain.canvas");
    const s = { viewport: "full" as const, zoom: 0, privacy: false };
    const p = planExport(v.canvas, s);
    expect([p.width, p.height]).toEqual([400, 300]); // 200x100 plus 100 around
    expect([planExport(v.canvas, { ...s, zoom: 1 }).width]).toEqual([800]);
    expect(planExport(v.canvas, { ...s, viewport: "viewport" }).width).toBe(800); // happy-dom viewport
    const w = await open();
    w.canvas.selectOnly(w.canvas.nodes.get("b")!);
    expect(planExport(w.canvas, s).data.nodes.map((n) => n.id)).toEqual(["b"]);
    w.canvas.deselectAll();
    expect(planExport(w.canvas, s).height).toBe(1300 + 200 - 0); // y 0..1300 plus padding
  });

  it("export dialog shows the estimate and saves the rendered PNG next to the canvas", async () => {
    const v = await open("plain.canvas");
    run("canvas:export-as-image");
    await vi.waitFor(() => expect(modal(".modal.mod-narrow")).toBeTruthy());
    expect(modal(".modal-title")!.textContent).toBe("Export as image");
    expect(document.body.textContent).toContain("Estimated image dimensions: 400px x 300px");
    expect(document.body.textContent).toContain("Privacy mode");
    // drive the modal object itself with a stub renderer
    const m = new ExportImageModal(c.app, v);
    m.render = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
    const path = await m.save();
    expect(path).toBe("plain.png");
    expect(c.app.vault.getFileByPath("plain.png")).toBeTruthy();
  });
});

describe("bases commands", () => {
  beforeEach(async () => {
    c = await bootCore({ "B.base": BASE, "a.md": "---\nstatus: x\n---\n", "n.md": "x" });
  });
  afterEach(async () => { await c.dispose(); });

  it("are only available in a base and drive it", async () => {
    await c.app.workspace.openLinkText("n.md", "", false);
    for (const id of ["bases:add-item", "bases:change-view", "bases:copy-table"]) expect(check(id)).toBe(false);
    await c.app.workspace.openLinkText("B.base", "", false);
    const v = c.app.workspace.getActiveViewOfType(BasesFileView)!;
    await vi.waitFor(() => expect(v.controller?.view).toBeTruthy());
    for (const id of ["bases:add-item", "bases:change-view", "bases:copy-table"]) expect(check(id)).toBe(true);

    run("bases:change-view");
    await vi.waitFor(() => expect([...document.querySelectorAll(".prompt-results .suggestion-item")].map((e) => e.textContent)).toEqual(["TableActive", "Cards"]));
    document.querySelectorAll<HTMLElement>(".prompt-results .suggestion-item")[1].click();
    await vi.waitFor(() => expect(v.controller!.currentRaw()!.name).toBe("Cards"));

    v.controller!.selectView(0);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { copied = t; } } });
    run("bases:copy-table");
    await vi.waitFor(() => expect(copied).toContain("file name\tstatus"));
    expect(copied).toContain("a\tx");

    run("bases:add-item");
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("Untitled.md")).toBeTruthy());
  });
});

describe("graph animate", () => {
  beforeEach(async () => {
    c = await bootCore({ "A.md": "[[B]] [[Gone]]", "B.md": "[[C]]", "C.md": "", "D.md": "" });
  });
  afterEach(async () => { vi.useRealTimers(); await c.dispose(); });

  it("computes appearance times and sub graphs", () => {
    const g = buildGraph({ resolved: { "a.md": { "b.md": 1 } }, unresolved: { "a.md": { Ghost: 1 } }, files: ["a.md", "b.md"] });
    const t = appearTimes(g, (id) => ({ "a.md": 5, "b.md": 9 } as Record<string, number>)[id]);
    expect(g.nodes.map((n, i) => [n.id, t[i]])).toEqual([["a.md", 5], ["b.md", 9], ["?Ghost", 5]]);
    const sub = subGraph(g, (i) => t[i] <= 5);
    expect(sub.nodes.map((n) => n.id)).toEqual(["a.md", "?Ghost"]);
    expect(sub.links).toHaveLength(1);
    expect(sub.nodes[0].degree).toBe(1);
  });

  it("is only available in a graph view; replays the growth and ends with the full graph", async () => {
    expect(check("graph:animate")).toBe(false);
    c.app.commands.executeCommandById("graph:open");
    await vi.waitFor(() => expect(c.app.workspace.getLeavesOfType("graph")).toHaveLength(1));
    const v = c.app.workspace.getLeavesOfType("graph")[0].view as GraphView;
    await vi.waitFor(() => expect(v.sim.nodes.length).toBe(5)); // A B C D + unresolved Gone
    expect(check("graph:animate")).toBe(true);
    const t0 = Date.now();
    for (const [i, n] of ["A", "B", "C", "D"].entries()) c.app.vault.getFileByPath(`${n}.md`)!.stat.ctime = t0 - 100000 + i * 1000;
    vi.useFakeTimers();
    run("graph:animate");
    expect(v).toBeInstanceOf(BaseGraphView);
    expect(v.isAnimating).toBe(true);
    expect(v.sim.nodes.map((n) => n.id).sort()).toEqual(["?Gone", "A.md"]);
    await vi.advanceTimersByTimeAsync(3000);
    const mid = v.sim.nodes.length;
    expect(mid).toBeGreaterThan(2);
    expect(mid).toBeLessThan(5);
    await vi.advanceTimersByTimeAsync(4000);
    expect(v.isAnimating).toBe(false);
    expect(v.sim.nodes).toHaveLength(5);
  });
});
