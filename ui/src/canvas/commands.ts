// Canvas commands that act on the open canvas: convert a text card to a note, jump to a group, export as an image.
import { FuzzySuggestModal, Modal, Notice, Setting, TFile, type App } from "../obsidian";
import { joinPath, uniqueName } from "../app/files";
import type { Canvas } from "./canvas";
import { CanvasGroupNode, CanvasTextNode } from "./nodes";
import {
  arrowPoints, autoSides, cssColor, edgeGeometry, padBBox, randomId, rectBBox, sidePoint, unionBBox,
  type AllCanvasNodeData, type BBox, type CanvasData, type NodeSide, type Rect,
} from "./model";
import type { CanvasView } from "./view";

// ------------------------------------------------------------------ convert to file

/** The one selected text card, if the selection is exactly that. */
export function selectedTextCard(canvas: Canvas): CanvasTextNode | null {
  if (canvas.selection.size !== 1) return null;
  const n = [...canvas.selection][0];
  return n instanceof CanvasTextNode ? n : null;
}

/** Ask for a file name in a small modal (a textarea, like renaming a file). Resolves null when cancelled. */
function askFileName(app: App, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const m = new Modal(app);
    m.modalEl.addClass("mod-file-rename");
    m.setTitle("File name");
    let done = false;
    const finish = (v: string | null) => { if (done) return; done = true; resolve(v); m.close(); };
    const ta = m.contentEl.createEl("textarea", { cls: "rename-textarea", attr: { rows: "1", spellcheck: "false" } });
    ta.value = value;
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(ta.value); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    });
    const bar = m.contentEl.createDiv({ cls: "modal-button-container" });
    bar.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", () => finish(ta.value));
    bar.createEl("button", { cls: "mod-cancel", text: "Cancel" }).addEventListener("click", () => finish(null));
    m.setCloseCallback(() => finish(null));
    m.open();
    setTimeout(() => { ta.focus(); ta.select(); }, 0);
  });
}

/**
 * Turn the selected text card into a note: ask for a name, create the note with the card's text, and replace the card
 * with a file card at the same place (new id, no colour); edges follow the card and get explicit sides.
 */
export async function convertToFile(app: App, canvas: Canvas): Promise<TFile | null> {
  const node = selectedTextCard(canvas);
  if (!node) return null;
  const raw = await askFileName(app, "Untitled");
  if (raw === null) return null;
  const name = raw.replace(/[\\/:*?"<>|#^[\]]/g, "").trim().replace(/\.md$/i, "") || "Untitled";
  const folder = app.fileManager.getNewFileParent(canvas.sourcePath);
  if (!canvas.nodes.has(node.id)) return null; // the card was deleted while the dialog was open
  const file = await app.vault.create(joinPath(folder, uniqueName(app, folder, name, "md")), node.getText());
  const data = canvas.getData();
  const old = data.nodes.find((n) => n.id === node.id);
  if (!old) return file;
  const id = randomId();
  const rect = (n: AllCanvasNodeData): Rect => ({ x: n.x, y: n.y, width: n.width, height: n.height });
  const fileNode: AllCanvasNodeData = { id, x: old.x, y: old.y, width: old.width, height: old.height, type: "file", file: file.path };
  const before = new Map(data.nodes.map((n) => [n.id, n]));
  data.nodes = data.nodes.map((n) => (n.id === node.id ? fileNode : n));
  data.edges = data.edges.map((e) => {
    if (e.fromNode !== node.id && e.toNode !== node.id) return e;
    const a = before.get(e.fromNode), b = before.get(e.toNode);
    const auto = a && b ? autoSides(rect(a), rect(b)) : (["right", "left"] as NodeSide[]);
    const o = { ...e, fromNode: e.fromNode === node.id ? id : e.fromNode, toNode: e.toNode === node.id ? id : e.toNode, fromSide: e.fromSide ?? auto[0], toSide: e.toSide ?? auto[1] };
    // key order like a hand-written canvas edge
    return { id: o.id, fromNode: o.fromNode, fromSide: o.fromSide, ...(o.fromEnd ? { fromEnd: o.fromEnd } : {}), toNode: o.toNode, toSide: o.toSide, ...(o.toEnd ? { toEnd: o.toEnd } : {}), ...(o.color ? { color: o.color } : {}), ...(o.label ? { label: o.label } : {}) };
  });
  canvas.pushHistory();
  canvas.setData(data);
  const made = canvas.nodes.get(id);
  if (made) canvas.selectOnly(made);
  canvas.requestSave();
  return file;
}

// ------------------------------------------------------------------ jump to group

export const groupName = (g: CanvasGroupNode): string => g.label || "Untitled";

export function canvasGroups(canvas: Canvas): CanvasGroupNode[] {
  return [...canvas.nodes.values()].filter((n): n is CanvasGroupNode => n instanceof CanvasGroupNode);
}

export function jumpToGroup(canvas: Canvas, g: CanvasGroupNode): void {
  canvas.deselectAll();
  canvas.zoomToBbox(g.getBBox());
}

class GroupSuggestModal extends FuzzySuggestModal<CanvasGroupNode> {
  constructor(app: App, private canvas: Canvas) {
    super(app);
    this.setPlaceholder("Jump to group");
    this.setInstructions([{ command: "↑↓", purpose: "to navigate" }, { command: "↵", purpose: "to navigate to group" }, { command: "esc", purpose: "to dismiss" }]);
  }
  getItems(): CanvasGroupNode[] { return canvasGroups(this.canvas); }
  getItemText(g: CanvasGroupNode): string { return groupName(g); }
  onChooseItem(g: CanvasGroupNode): void { jumpToGroup(this.canvas, g); }
}
export function openGroupPicker(app: App, canvas: Canvas): void { new GroupSuggestModal(app, canvas).open(); }

// ------------------------------------------------------------------ export as image

export interface ExportSettings { viewport: "full" | "viewport"; zoom: number; privacy: boolean }
export interface ExportPlan { bbox: BBox; width: number; height: number; scale: number; data: CanvasData }

const EXPORT_PADDING = 100;

/** What an export would contain: the selection (or the whole canvas) padded, or the visible viewport. */
export function planExport(canvas: Canvas, s: ExportSettings): ExportPlan {
  const scale = Math.pow(2, s.zoom);
  let data: CanvasData;
  let bbox: BBox;
  if (s.viewport === "viewport") {
    bbox = canvas.getViewportBBox();
    data = canvas.getData();
  } else {
    data = canvas.selection.size ? canvas.getSelectionData() : canvas.getData();
    const b = unionBBox(data.nodes.map((n) => rectBBox(n)));
    bbox = b ? padBBox(b, EXPORT_PADDING) : { minX: 0, minY: 0, maxX: 2 * EXPORT_PADDING, maxY: 2 * EXPORT_PADDING };
  }
  return { bbox, scale, data, width: Math.max(1, Math.round((bbox.maxX - bbox.minX) * scale)), height: Math.max(1, Math.round((bbox.maxY - bbox.minY) * scale)) };
}

function themeColor(name: string, fallback: string): string {
  const v = typeof getComputedStyle === "function" ? getComputedStyle(document.body).getPropertyValue(name).trim() : "";
  return v || fallback;
}
function resolveColor(c: string | undefined, fallback: string): string {
  const css = cssColor(c);
  if (!css) return fallback;
  const m = /^var\((--[\w-]+)\)$/.exec(css);
  return m ? themeColor(m[1], fallback) : css;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (line && ctx.measureText(line + word).width > maxWidth) { out.push(line.trimEnd()); line = word.trimStart(); } else line += word;
    }
    out.push(line);
  }
  return out;
}

/** Draw the plan onto a 2D context (the canvas is `plan.width` x `plan.height` pixels). Pure drawing, no DOM reads but the theme. */
export function drawExport(ctx: CanvasRenderingContext2D, plan: ExportPlan, s: ExportSettings): void {
  const { bbox, scale, data } = plan;
  const bg = themeColor("--canvas-background", themeColor("--background-primary", "#ffffff"));
  const fg = themeColor("--text-normal", "#222222");
  const border = themeColor("--background-modifier-border", "#999999");
  const muted = themeColor("--text-muted", "#666666");
  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.scale(scale, scale);
  ctx.translate(-bbox.minX, -bbox.minY);
  ctx.textBaseline = "top";
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const rr = (r: Rect, radius: number) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(r.x, r.y, r.width, r.height, radius) : ctx.rect(r.x, r.y, r.width, r.height); };
  // groups first (they sit behind), then edges, then cards
  const ordered = [...data.nodes.filter((n) => n.type === "group"), ...data.nodes.filter((n) => n.type !== "group")];
  for (const n of ordered.filter((n) => n.type === "group")) {
    const col = resolveColor(n.color, border);
    rr(n, 12); ctx.globalAlpha = 0.08; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
    if (n.type === "group" && n.label) {
      ctx.font = "14px sans-serif"; ctx.fillStyle = s.privacy ? muted : fg;
      ctx.fillText(s.privacy ? "█".repeat(Math.min(12, n.label.length)) : n.label, n.x, n.y - 20);
    }
  }
  for (const e of data.edges) {
    const a = byId.get(e.fromNode), b = byId.get(e.toNode);
    if (!a || !b) continue;
    const auto = autoSides(a, b);
    const fs = e.fromSide ?? auto[0], ts = e.toSide ?? auto[1];
    const g = edgeGeometry(sidePoint(a, fs), fs, sidePoint(b, ts), ts);
    const col = resolveColor(e.color, muted);
    ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.stroke(new Path2D(g.path));
    if ((e.toEnd ?? "arrow") === "arrow") { ctx.fillStyle = col; ctx.fill(new Path2D(`M${arrowPoints(g.to, ts).replace(/ /g, " L")}Z`)); }
  }
  for (const n of ordered.filter((n) => n.type !== "group")) {
    const col = resolveColor(n.color, border);
    rr(n, 8); ctx.fillStyle = bg; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
    const text = n.type === "text" ? n.text : n.type === "file" ? n.file.slice(n.file.lastIndexOf("/") + 1).replace(/\.md$/i, "") : n.type === "link" ? n.url : "";
    ctx.save();
    rr(n, 8); ctx.clip();
    ctx.font = "14px sans-serif"; ctx.fillStyle = fg;
    const lines = wrapText(ctx, text, n.width - 24);
    lines.slice(0, Math.max(1, Math.floor((n.height - 20) / 20))).forEach((l, i) => {
      const y = n.y + 12 + i * 20;
      if (s.privacy) { ctx.fillStyle = muted; ctx.globalAlpha = 0.5; ctx.fillRect(n.x + 12, y + 3, Math.min(n.width - 24, ctx.measureText(l).width), 12); ctx.globalAlpha = 1; }
      else ctx.fillText(l, n.x + 12, y);
    });
    ctx.restore();
  }
  ctx.restore();
}

/** Render the plan to a PNG blob (needs a real canvas element: not available in happy-dom). */
export function renderPng(plan: ExportPlan, s: ExportSettings): Promise<Blob> {
  const c = document.createElement("canvas");
  c.width = plan.width; c.height = plan.height;
  const ctx = c.getContext("2d");
  if (!ctx) return Promise.reject(new Error("Canvas 2D is not available"));
  drawExport(ctx, plan, s);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode the image"))), "image/png"));
}

/** Save the PNG next to the canvas (there is no save dialog); returns its path. */
export async function savePng(app: App, view: CanvasView, blob: Blob): Promise<string> {
  const file = view.file;
  const folder = file?.parent ?? app.vault.getRoot();
  const path = joinPath(folder, uniqueName(app, folder, file?.basename ?? "Canvas", "png"));
  await app.vault.createBinary(path, await blob.arrayBuffer());
  return path;
}

export class ExportImageModal extends Modal {
  settings: ExportSettings = { viewport: "full", zoom: 0, privacy: false };
  private info!: HTMLElement;
  private valueEl!: HTMLElement;
  /** Rendering and saving, replaceable in tests. */
  render = renderPng;
  constructor(app: App, private view: CanvasView) { super(app); }
  estimate(): ExportPlan { return planExport(this.view.canvas, this.settings); }
  private update(): void {
    const p = this.estimate();
    this.info.setText(`Estimated image dimensions: ${p.width}px x ${p.height}px`);
    this.valueEl.setText(this.settings.zoom === 0 ? "1.00" : Math.pow(2, this.settings.zoom).toFixed(2));
  }
  async save(): Promise<string> {
    const plan = this.estimate();
    const blob = await this.render(plan, this.settings);
    const path = await savePng(this.app, this.view, blob);
    new Notice(`Image saved to ${path}`);
    this.close();
    return path;
  }
  onOpen(): void {
    this.modalEl.addClass("mod-narrow");
    this.setTitle("Export as image");
    const { contentEl } = this;
    contentEl.createEl("p", { cls: "u-muted", text: `Export “${this.view.file?.basename ?? "Canvas"}” as a PNG file with the settings below.` });
    new Setting(contentEl).setName("Viewport").setDesc("Choose to render the entire canvas or just the current visible viewport.")
      .addDropdown((d) => d.addOption("full", "Full canvas").addOption("viewport", "Viewport only").setValue("full").onChange((v) => { this.settings.viewport = v as ExportSettings["viewport"]; this.update(); }));
    const zoom = new Setting(contentEl).setName("Zoom").setDesc("");
    this.info = zoom.descEl;
    zoom.addSlider((sl) => sl.setLimits(-1, 1, "any").setValue(0).onChange((v) => { this.settings.zoom = v; this.update(); }));
    this.valueEl = zoom.controlEl.createSpan({ cls: "slider-value" });
    zoom.controlEl.prepend(this.valueEl);
    new Setting(contentEl).setName("Privacy mode").setDesc("This will obscure any text on your canvas.")
      .addToggle((t) => t.setValue(false).onChange((v) => { this.settings.privacy = v; this.update(); }));
    const bar = contentEl.createDiv({ cls: "modal-button-container" });
    bar.createEl("button", { cls: "mod-cta", text: "Save" }).addEventListener("click", () => { void this.save().catch((e) => new Notice(`Could not export: ${e?.message ?? e}`)); });
    this.update();
  }
}
