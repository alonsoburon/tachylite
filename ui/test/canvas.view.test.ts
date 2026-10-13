// Canvas core plugin against the fake backend: opening .canvas files, rendering every node type, editing through
// real DOM events (create, move, resize, connect, label, colour, delete, undo), saving, embeds, links and renames.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootCore, tick, type Core } from "./helpers/core";
import { FileView, TextFileView, WorkspaceLeaf, WorkspaceSplit, MarkdownRenderer, Component } from "../src/obsidian";
import { installBridge } from "../src/app/bridge";
import { CanvasView } from "../src/canvas/view";
import { CanvasEdge, CanvasFileNode, CanvasGroupNode, CanvasLinkNode, CanvasTextNode, isFrameableUrl } from "../src/canvas/nodes";
import { parseCanvas } from "../src/canvas/model";

const BOARD = `{
\t"nodes":[
\t\t{"id":"g1","type":"group","x":-40,"y":-60,"width":760,"height":520,"label":"Ideas","color":"4"},
\t\t{"id":"t1","type":"text","text":"**bold** [[Note]]","x":0,"y":0,"width":250,"height":60,"color":"1","x-custom":true},
\t\t{"id":"f1","type":"file","file":"Note.md","x":300,"y":0,"width":400,"height":400},
\t\t{"id":"i1","type":"file","file":"pic.png","x":0,"y":120,"width":200,"height":200},
\t\t{"id":"l1","type":"link","url":"http://localhost:8080/x","x":0,"y":600,"width":300,"height":200}
\t],
\t"edges":[
\t\t{"id":"e1","fromNode":"t1","fromSide":"right","toNode":"f1","toSide":"left","label":"see","color":"#00ff00"}
\t],
\t"x-top":{"keep":1}
}`;

let c: Core;
const disk = (p: string) => fs.readFileSync(path.join(c.v.root, p), "utf8");
async function open(p = "board.canvas"): Promise<CanvasView> {
  await c.app.workspace.openLinkText(p, "", false);
  const v = c.app.workspace.getActiveViewOfType(CanvasView)!;
  expect(v).toBeInstanceOf(CanvasView);
  v.canvas.setViewport(0, 0, 0); // client (400 + x, 300 + y) == canvas (x, y): no layout in happy-dom, the viewport is 800x600
  return v;
}
const at = (x: number, y: number) => ({ clientX: 400 + x, clientY: 300 + y });
function pointer(el: Element | Document, type: string, x: number, y: number, extra: PointerEventInit = {}): void {
  el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...at(x, y), ...extra }));
}
/** Press on `el` at (x, y), move to (x2, y2), release. */
function dragFrom(el: Element | Document, x: number, y: number, x2: number, y2: number, extra: PointerEventInit = {}): void {
  pointer(el, "pointerdown", x, y, extra);
  pointer(document, "pointermove", (x + x2) / 2, (y + y2) / 2, extra);
  pointer(document, "pointermove", x2, y2, extra);
  pointer(document, "pointerup", x2, y2, extra);
}
async function saved(v: CanvasView) { await v.save(); return parseCanvas(disk(v.file!.path)); }

beforeEach(async () => {
  c = await bootCore({ "board.canvas": BOARD, "Note.md": "# Note\nhello from note", "pic.png": "x", "Other.md": "x", "Host.md": "before\n\n![[board.canvas]]\n" });
});
afterEach(async () => { await tick(20); await c.app.metadataCache.flush(); await c.dispose(); });

describe("canvas view", () => {
  it("opens .canvas files from links and the switcher's file list as a TextFileView of type canvas", async () => {
    const v = await open();
    expect(v.getViewType()).toBe("canvas");
    expect(v).toBeInstanceOf(TextFileView);
    expect(v).toBeInstanceOf(FileView);
    expect(c.app.viewRegistry.getTypeByExtension("canvas")).toBe("canvas");
    expect(v.getDisplayText()).toBe("board");
    const sw = new (c.app.internalPlugins.getPluginById("switcher")!.instance as any).QuickSwitcherModal(c.app);
    expect(sw.getSuggestions("board").map((s: any) => s.file.path)).toContain("board.canvas");
  });

  it("renders text, file (note + image), link and group nodes and labelled, coloured edges", async () => {
    const v = await open();
    const cv = v.canvas, w = cv.wrapperEl;
    expect(cv.nodes.size).toBe(5);
    expect(cv.nodes.get("t1")).toBeInstanceOf(CanvasTextNode);
    await vi.waitFor(() => expect(w.querySelector('[data-node-id="t1"] .markdown-rendered')?.textContent).toContain("bold"));
    await vi.waitFor(() => expect(w.querySelector('[data-node-id="f1"] .markdown-rendered')?.textContent).toContain("hello from note"));
    expect(w.querySelector('[data-node-id="f1"] .canvas-node-label')?.textContent).toBe("Note");
    expect(w.querySelector<HTMLImageElement>('[data-node-id="i1"] img')?.getAttribute("src")).toBeTruthy();
    // A local URL is never framed: it renders as a title card.
    expect(w.querySelector('[data-node-id="l1"] iframe')).toBeNull();
    expect(w.querySelector('[data-node-id="l1"] .canvas-link-card-title')?.textContent).toBe("localhost");
    expect(isFrameableUrl("https://example.com/page")).toBe(true);
    expect(isFrameableUrl("http://192.168.1.2/")).toBe(false);
    expect(isFrameableUrl("file:///etc/passwd")).toBe(false);
    const g = w.querySelector<HTMLElement>('[data-node-id="g1"]')!;
    expect(g.classList.contains("canvas-node-group")).toBe(true);
    expect(g.querySelector(".canvas-group-label")?.textContent).toBe("Ideas");
    expect(g.classList.contains("mod-canvas-color-4")).toBe(true);
    expect(w.querySelector('[data-node-id="t1"]')!.classList.contains("mod-canvas-color-1")).toBe(true);
    const e = w.querySelector<SVGGElement>('g.canvas-edge[data-edge-id="e1"]')!;
    expect(e.querySelector(".canvas-display-path")!.getAttribute("d")).toMatch(/^M\d/);
    expect((e as unknown as HTMLElement).style.getPropertyValue("--canvas-color")).toBe("#00ff00");
    expect((e.querySelector(".canvas-path-end.mod-to") as unknown as HTMLElement).style.display).toBe("");
    expect((e.querySelector(".canvas-path-end.mod-from") as unknown as HTMLElement).style.display).toBe("none");
    expect(w.querySelector(".canvas-path-label")?.textContent).toBe("see");
    // Groups sit below cards.
    expect(Number(g.style.zIndex)).toBeLessThan(Number(w.querySelector<HTMLElement>('[data-node-id="t1"]')!.style.zIndex));
  });

  it("does not rewrite an untouched file and preserves unknown keys after edits", async () => {
    const v = await open();
    expect(v.getViewData()).toBe(BOARD);
    await v.save();
    expect(disk("board.canvas")).toBe(BOARD);
    v.canvas.nodes.get("t1")!.moveTo({ x: 20, y: 0 });
    v.canvas.requestSave();
    const d = await saved(v);
    expect(d["x-top"]).toEqual({ keep: 1 });
    expect(d.nodes.find((n) => n.id === "t1")).toEqual({ id: "t1", type: "text", text: "**bold** [[Note]]", x: 20, y: 0, width: 250, height: 60, color: "1", "x-custom": true });
    expect(disk("board.canvas").split("\n")[2]).toBe('\t\t{"id":"g1","type":"group","x":-40,"y":-60,"width":760,"height":520,"label":"Ideas","color":"4"},');
  });

  it("creates a text card on background double-click, edits it, and saves it", async () => {
    const v = await open();
    const w = v.canvas.wrapperEl;
    w.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, ...at(100, 1000) }));
    const n = [...v.canvas.nodes.values()].pop() as CanvasTextNode;
    expect(n).toBeInstanceOf(CanvasTextNode);
    expect(n.isEditing).toBe(true);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: -20, y: 980, width: 250, height: 60 }); // centred, snapped to the 20px grid
    await vi.waitFor(() => expect((n.child as any)?.editMode).toBeTruthy());
    const ed = (n.child as any).editMode;
    ed.cm.dispatch({ changes: { from: 0, insert: "Hello *canvas*" } });
    expect(n.text).toBe("Hello *canvas*");
    n.stopEditing();
    await vi.waitFor(() => expect(n.nodeEl.querySelector(".markdown-rendered")?.textContent).toContain("Hello"));
    const d = await saved(v);
    expect(d.nodes.at(-1)).toMatchObject({ type: "text", text: "Hello *canvas*", x: -20, y: 980 });
    expect(Object.keys(d.nodes.at(-1)!)).toEqual(["id", "type", "text", "x", "y", "width", "height"]);
  });

  it("card editors coexist with the note editor's extensions (inline title) and expose editorInfoField", async () => {
    const { installMarkdownView } = await import("../src/app/markdownView");
    const { editorInfoField } = await import("../src/obsidian/editor");
    const undo = installMarkdownView(c.app);
    try {
      const v = await open();
      const t1 = v.canvas.nodes.get("t1") as CanvasTextNode;
      t1.startEditing();
      await vi.waitFor(() => expect((t1.child as any)?.editMode).toBeTruthy());
      const cm = (t1.child as any).editMode.cm;
      expect(t1.nodeEl.querySelector(".inline-title")).toBeNull();
      const info = cm.state.field(editorInfoField);
      expect(info.file.path).toBe("board.canvas");
      expect(info.editor.getValue()).toBe("**bold** [[Note]]");
      t1.stopEditing();
    } finally { undo(); }
  });

  it("drags a card (snapping to the grid); dragging a group moves the cards inside it", async () => {
    const v = await open();
    const t1 = v.canvas.nodes.get("t1")!, f1 = v.canvas.nodes.get("f1")!, l1 = v.canvas.nodes.get("l1")!;
    dragFrom(t1.contentBlockerEl, 10, 10, 53, 10);
    expect([t1.x, t1.y]).toEqual([40, 0]);
    expect(v.canvas.selection.has(t1)).toBe(true);
    const g = v.canvas.nodes.get("g1")!;
    dragFrom(g.contentBlockerEl, -30, 400, -30, 500);
    expect([g.y, t1.y, f1.y]).toEqual([40, 100, 100]);
    expect(l1.y).toBe(600); // outside the group
    const d = await saved(v);
    expect(d.nodes.find((n) => n.id === "f1")).toMatchObject({ x: 300, y: 100 });
    // Undo restores both moves in order.
    v.canvas.undo();
    expect(v.canvas.nodes.get("f1")!.y).toBe(0);
    v.canvas.undo();
    expect(v.canvas.nodes.get("t1")!.x).toBe(0);
    v.canvas.redo();
    expect(v.canvas.nodes.get("t1")!.x).toBe(40);
  });

  it("resizes from a handle", async () => {
    const v = await open();
    const f1 = v.canvas.nodes.get("f1")!;
    v.canvas.selectOnly(f1);
    dragFrom(f1.nodeEl.querySelector(".mod-se")!, 700, 400, 761, 300);
    expect([f1.x, f1.y, f1.width, f1.height]).toEqual([300, 0, 460, 300]);
    dragFrom(f1.nodeEl.querySelector(".mod-w")!, 300, 100, 760, 100);
    expect(f1.width).toBe(40); // minimum size
    expect((await saved(v)).nodes.find((n) => n.id === "f1")).toMatchObject({ x: 720, width: 40, height: 300 });
  });

  it("connects two cards by dragging from a side handle; dropping on empty space adds a connected card", async () => {
    const v = await open();
    const cv = v.canvas;
    const i1 = cv.nodes.get("i1")!, l1 = cv.nodes.get("l1")!;
    dragFrom(i1.nodeEl.querySelector(".canvas-node-connection-point.mod-bottom")!, 100, 320, 150, 610);
    const e = [...cv.edges.values()].find((x) => x.from.node === i1)!;
    expect(e).toBeInstanceOf(CanvasEdge);
    expect([e.to.node, e.from.side, e.to.side]).toEqual([l1, "bottom", "top"]);
    expect(cv.selection.has(e)).toBe(true);
    dragFrom(l1.nodeEl.querySelector(".canvas-node-connection-point.mod-right")!, 300, 700, 700, 700);
    const card = [...cv.nodes.values()].pop()!;
    expect(card).toBeInstanceOf(CanvasTextNode);
    expect([card.x, card.y]).toEqual([700, 680]);
    const d = await saved(v);
    expect(d.edges.find((x) => x.fromNode === "i1")).toEqual({ id: e.id, fromNode: "i1", fromSide: "bottom", toNode: "l1", toSide: "top" });
    expect(d.edges.find((x) => x.fromNode === "l1")).toMatchObject({ fromSide: "right", toNode: card.id, toSide: "left" });
  });

  it("selects with click, shift-click and the rubber band; deletes with the keyboard; undo brings it back", async () => {
    const v = await open();
    const cv = v.canvas, t1 = cv.nodes.get("t1")!, i1 = cv.nodes.get("i1")!;
    pointer(t1.contentBlockerEl, "pointerdown", 5, 5); pointer(document, "pointerup", 5, 5);
    pointer(i1.contentBlockerEl, "pointerdown", 5, 150, { shiftKey: true }); pointer(document, "pointerup", 5, 150, { shiftKey: true });
    expect([...cv.selection]).toEqual([t1, i1]);
    dragFrom(cv.wrapperEl, -100, 550, 350, 850); // band around the link card only
    expect([...cv.selection].map((i) => i.id)).toEqual(["l1"]);
    cv.wrapperEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(cv.nodes.has("l1")).toBe(false);
    cv.selectOnly(cv.nodes.get("t1")!);
    cv.wrapperEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(cv.nodes.has("t1")).toBe(false);
    expect(cv.edges.has("e1")).toBe(false); // edges go with their node
    cv.wrapperEl.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(cv.nodes.has("t1") && cv.edges.has("e1")).toBe(true);
    const d = await saved(v);
    expect(d.nodes.map((n) => n.id)).toEqual(["g1", "t1", "f1", "i1"]);
  });

  it("colours nodes and edges from the selection toolbar's picker, and edits edge labels inline", async () => {
    const v = await open();
    const cv = v.canvas, f1 = cv.nodes.get("f1")!;
    cv.selectOnly(f1);
    const menu = cv.wrapperEl.querySelector(".canvas-menu")!;
    (menu.querySelector('[aria-label="Set color"]') as HTMLElement).click();
    (cv.wrapperEl.querySelector('.canvas-color-picker-item[data-color="5"]') as HTMLElement).click();
    expect(f1.color).toBe("5");
    expect(f1.nodeEl.classList.contains("mod-canvas-color-5")).toBe(true);
    const e1 = cv.edges.get("e1")!;
    cv.selectOnly(e1);
    (cv.wrapperEl.querySelector('.canvas-menu [aria-label="Set color"]') as HTMLElement).click();
    const custom = cv.wrapperEl.querySelector<HTMLInputElement>(".canvas-color-picker-custom")!;
    custom.value = "#123456";
    custom.dispatchEvent(new Event("change"));
    expect(e1.color).toBe("#123456");
    // Double-click the edge to edit its label.
    e1.path.interaction.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, ...at(275, 30) }));
    const input = cv.wrapperEl.querySelector<HTMLInputElement>(".canvas-path-label-editor")!;
    expect(input.value).toBe("see");
    input.value = "depends on";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(e1.label).toBe("depends on");
    const d = await saved(v);
    expect(d.nodes.find((n) => n.id === "f1")!.color).toBe("5");
    expect(d.edges[0]).toMatchObject({ color: "#123456", label: "depends on" });
  });

  it("adds file cards from the picker and from explorer drops", async () => {
    const v = await open();
    const cv = v.canvas;
    const m = v.pickFile({ x: 0, y: 1000 });
    expect(m.getItems().map((f) => f.path)).not.toContain("board.canvas");
    m.onChooseItem(c.app.vault.getFileByPath("Other.md")!);
    m.close();
    const n = [...cv.nodes.values()].pop() as CanvasFileNode;
    expect(n).toBeInstanceOf(CanvasFileNode);
    expect([n.filePath, n.width, n.height]).toEqual(["Other.md", 400, 400]);
    const ev = new Event("drop", { bubbles: true, cancelable: true }) as any;
    Object.assign(ev, at(0, 1500), { dataTransfer: { getData: (t: string) => (t === "text/plain" ? "pic.png" : ""), dropEffect: "" } });
    cv.wrapperEl.dispatchEvent(ev);
    const dropped = [...cv.nodes.values()].pop() as CanvasFileNode;
    expect(dropped.filePath).toBe("pic.png");
    const d = await saved(v);
    expect(d.nodes.slice(-2).map((x: any) => x.file)).toEqual(["Other.md", "pic.png"]);
  });

  it("follows renames of shown files, in open and in closed canvases; counts card references as links", async () => {
    await c.app.metadataCache.flush();
    await c.app.metadataCache.refreshLinks();
    expect(c.app.metadataCache.resolvedLinks["board.canvas"]).toMatchObject({ "Note.md": 2, "pic.png": 1 });
    fs.writeFileSync(path.join(c.v.root, "closed.canvas"), '{"nodes":[{"id":"a","type":"file","file":"Other.md","x":0,"y":0,"width":400,"height":400}],"edges":[]}');
    c.v.emit({ kind: "create", path: "closed.canvas" });
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("closed.canvas")).toBeTruthy());
    const v = await open();
    await c.app.fileManager.renameFile(c.app.vault.getFileByPath("Note.md")!, "dir/Renamed.md");
    await c.app.fileManager.renameFile(c.app.vault.getFileByPath("Other.md")!, "Other2.md");
    expect((v.canvas.nodes.get("f1") as CanvasFileNode).filePath).toBe("dir/Renamed.md");
    expect((await saved(v)).nodes.find((n) => n.id === "f1")).toMatchObject({ file: "dir/Renamed.md" });
    await vi.waitFor(() => expect(JSON.parse(disk("closed.canvas")).nodes[0].file).toBe("Other2.md"));
  });

  it("lists canvases in the backlinks pane of the notes their cards show", async () => {
    await c.app.metadataCache.refreshLinks();
    await c.app.workspace.openLinkText("Note", "", false);
    const leaf = await c.app.workspace.ensureSideLeaf("backlink", "right", { active: false });
    await vi.waitFor(() => expect(leaf.view.containerEl.querySelector('.backlink-linked [data-path="board.canvas"]')).not.toBeNull());
    const item = leaf.view.containerEl.querySelector<HTMLElement>('.backlink-linked [data-path="board.canvas"]')!;
    await tick(20);
    expect(item.style.display).not.toBe("none");
    expect(item.querySelector(".search-result-count")?.textContent).toBe("2");
    expect(c.app.vault.getAbstractFileByPathInsensitive("BOARD.canvas")?.path).toBe("board.canvas");
  });

  it("supports the internal API plugins use (headless canvas, createFileNode, removeNode, selection, requestSave)", async () => {
    const wrapper = c.app.internalPlugins.plugins.canvas as any;
    await wrapper.load();
    // Excalidraw's markdown-embed factory builds a canvas on a detached leaf.
    const split = new WorkspaceSplit(c.app.workspace as any, "vertical");
    const leaf = new WorkspaceLeaf(c.app);
    split.insertChild(0, leaf);
    const headless = wrapper.views.canvas(leaf).canvas;
    const node = headless.createFileNode({ pos: { x: 0, y: 0 }, file: c.app.vault.getFileByPath("Note.md")!, subpath: "", save: false });
    node.setFilePath("Note.md", "");
    node.render();
    node.containerEl.querySelector(".canvas-node-content-blocker")?.remove();
    const host = document.body.createDiv();
    host.appendChild(node.containerEl);
    await vi.waitFor(() => expect(host.textContent).toContain("hello from note"));
    expect(node.isEditable()).toBe(true);
    node.startEditing();
    await vi.waitFor(() => expect(node.child.editor?.containerEl).toBeTruthy());
    node.child.showPreview();
    headless.removeNode(node);
    node.detach();
    expect(headless.nodes.size).toBe(0);
    // QuickAdd reads the selection of the open canvas and saves through requestSave.
    const v = await open();
    v.canvas.selectOnly(v.canvas.nodes.get("t1")!);
    const sel = Array.from(v.canvas.selection) as CanvasTextNode[];
    expect(sel).toHaveLength(1);
    sel[0].setText("changed by a plugin");
    v.canvas.requestSave();
    expect((await saved(v)).nodes.find((n) => n.id === "t1")!.text).toBe("changed by a plugin");
    expect(v.canvas.getData().nodes).toHaveLength(5);
    v.canvas.setData({ nodes: [], edges: [] });
    expect(v.canvas.nodes.size).toBe(0);
    v.canvas.zoomToBbox({ minX: 0, minY: 0, maxX: 1600, maxY: 1200 });
    expect(v.canvas.scale).toBeCloseTo((600 - 80 - 24) / 1200); // the height of the 800x600 viewport limits: 40px padding, 24px for labels
  });

  it("creates Untitled.canvas from the command, ribbon and folder menu", async () => {
    c.app.commands.executeCommandById("canvas:new-file");
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("Untitled.canvas")).toBeTruthy());
    await vi.waitFor(() => expect(c.app.workspace.getActiveViewOfType(CanvasView)?.file?.path).toBe("Untitled.canvas"));
    const ribbon = c.app.workspace.leftRibbon.items.find((i: any) => i.title === "Create new canvas") as any;
    expect(ribbon.icon).toBe("lucide-layout-dashboard");
    const { Menu } = await import("../src/obsidian");
    const m = new Menu();
    await c.app.vault.createFolder("sub");
    c.app.workspace.trigger("file-menu", m, c.app.vault.getFolderByPath("sub"), "file-explorer");
    const item = m.items.find((i: any) => i.titleEl?.textContent === "New canvas") as any;
    item.dom.click();
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("sub/Untitled.canvas")).toBeTruthy());
    c.app.commands.executeCommandById("canvas:new-file");
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("Untitled 1.canvas")).toBeTruthy());
    // A new canvas starts empty; the first edit writes valid JSON Canvas.
    const v = c.app.workspace.getActiveViewOfType(CanvasView)!;
    await vi.waitFor(() => expect(v.file?.path).toBe("Untitled 1.canvas"));
    expect(disk("Untitled 1.canvas")).toBe("");
    v.canvas.createTextNode({ pos: { x: 0, y: 0 }, text: "first" });
    await v.save();
    expect(parseCanvas(disk("Untitled 1.canvas")).nodes[0]).toMatchObject({ type: "text", text: "first", x: -120, y: -20 });
  });

  it("does not overwrite a canvas it cannot parse", async () => {
    fs.writeFileSync(path.join(c.v.root, "bad.canvas"), "{ not json");
    c.v.emit({ kind: "create", path: "bad.canvas" });
    await vi.waitFor(() => expect(c.app.vault.getFileByPath("bad.canvas")).toBeTruthy());
    const v = await open("bad.canvas");
    expect(v.contentEl.querySelector(".canvas-placeholder-message")?.textContent).toContain("could not be read");
    expect(v.canvas.readonly).toBe(true);
    await v.save();
    expect(disk("bad.canvas")).toBe("{ not json");
  });
});

describe("canvas embeds", () => {
  it("renders ![[x.canvas]] in reading view as a read-only canvas", async () => {
    const undo = installBridge(c.app);
    try {
      const el = document.body.createDiv();
      const comp = new Component();
      comp.load();
      await MarkdownRenderer.render(c.app, "![[board.canvas]]", el, "Host.md", comp);
      const embed = el.querySelector<HTMLElement>(".internal-embed.canvas-embed")!;
      expect(embed).toBeTruthy();
      await vi.waitFor(() => expect(embed.querySelectorAll(".canvas-node")).toHaveLength(5));
      expect(embed.querySelector(".canvas-wrapper")!.classList.contains("mod-readonly")).toBe(true);
      expect(embed.querySelectorAll("g.canvas-edge")).toHaveLength(1);
      // Edits on disk show up in the embed.
      await c.app.vault.modify(c.app.vault.getFileByPath("board.canvas")!, '{"nodes":[{"id":"z","type":"text","text":"only","x":0,"y":0,"width":100,"height":50}],"edges":[]}');
      await vi.waitFor(() => expect(embed.querySelectorAll(".canvas-node")).toHaveLength(1));
      comp.unload();
      await tick();
    } finally { undo(); }
  });

  it("is unregistered with the core plugin", async () => {
    expect(c.app.embedRegistry.isExtensionRegistered("canvas")).toBe(true);
    await c.app.internalPlugins.getPluginById("canvas")!.disable();
    expect(c.app.embedRegistry.isExtensionRegistered("canvas")).toBe(false);
    expect(c.app.viewRegistry.getTypeByExtension("canvas")).toBeUndefined();
    expect(c.app.commands.commands["canvas:new-file"]).toBeUndefined();
    await c.app.internalPlugins.getPluginById("canvas")!.enable();
    expect(c.app.commands.commands["canvas:new-file"]).toBeTruthy();
  });
});

void CanvasGroupNode; void CanvasLinkNode;
