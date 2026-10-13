// Live canvas items: nodes (text, file, link, group) and edges. Their shape (`canvas.nodes` Map values with `nodeEl`,
// `containerEl`, `child`, `getData()`, `setData()`, `moveTo()`, ...) follows what community plugins read on Obsidian's
// internal canvas objects; the implementation is our own.
import { Component, TFile, setIcon, MarkdownRenderer } from "../obsidian";
import { EmbeddedEditView } from "../obsidian/embeds";
import { editorInfoField } from "../obsidian/editor";
import { resolveSubpath } from "../obsidian/util";
import {
  arrowPoints, autoSides, cssColor, edgeGeometry, rectBBox, sideNormal, sidePoint, SIDES,
  type AllCanvasNodeData, type BBox, type CanvasColor, type CanvasEdgeData, type EdgeEnd, type EdgeGeometry, type NodeSide, type Point,
} from "./model";
import type { Canvas } from "./canvas";

const SVG = "http://www.w3.org/2000/svg";
export const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, parent?: Element, cls?: string): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag);
  if (cls) el.setAttribute("class", cls);
  parent?.appendChild(el);
  return el;
};

/** Apply a canvas colour to an element: presets get `mod-canvas-color-N`, custom colours set `--canvas-color`. */
export function applyColor(el: Element, color: CanvasColor | undefined): void {
  for (let i = 1; i <= 6; i++) el.classList.remove(`mod-canvas-color-${i}`);
  const css = cssColor(color);
  el.classList.toggle("is-themed", !!css);
  const style = (el as HTMLElement).style;
  if (color && /^[1-6]$/.test(color)) { el.classList.add(`mod-canvas-color-${color}`); style.removeProperty("--canvas-color"); }
  else if (css) style.setProperty("--canvas-color", css);
  else style.removeProperty("--canvas-color");
}

const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]);
const AUDIO = new Set(["mp3", "wav", "m4a", "ogg", "3gp", "flac", "opus"]);
const VIDEO = new Set(["mp4", "webm", "ogv", "mov", "mkv"]);

/** Card editor: plugins' editor extensions find a MarkdownFileInfo-like owner in editorInfoField, as in note editors. */
class CardEditView extends EmbeddedEditView {
  buildLocalExtensions() {
    const child = this.owner as NodeMarkdownChild;
    const info = { get app() { return child.app; }, get file() { return child.file ?? child.node.canvas.app.vault.getFileByPath(child.node.canvas.sourcePath); }, get editor() { return child.editMode?.editor; }, hoverPopover: null };
    return [editorInfoField.init(() => info), ...super.buildLocalExtensions()];
  }
}

/**
 * Markdown shown inside a card: rendered preview, or an embedded editor while editing.
 * `editor` is the embedded edit view (Excalidraw reads `child.editor.containerEl`).
 */
export class NodeMarkdownChild extends Component {
  editMode: EmbeddedEditView | null = null;
  text = "";
  private gen = 0;
  constructor(public node: CanvasNode, public containerEl: HTMLElement, private io: { read(): Promise<string> | string; write?(text: string): void; sourcePath(): string }) { super(); }
  get editor(): EmbeddedEditView | null { return this.editMode; }
  get app() { return this.node.canvas.app; }
  onload(): void { void this.showPreview(); }
  onunload(): void { this.closeEditor(); }
  async showPreview(): Promise<void> {
    const gen = ++this.gen;
    this.closeEditor();
    this.text = await this.io.read();
    if (gen !== this.gen) return;
    this.containerEl.empty();
    const el = this.containerEl.createDiv({ cls: "markdown-preview-view markdown-rendered node-insert-event" });
    const sizer = el.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    await MarkdownRenderer.render(this.app, this.text, sizer, this.io.sourcePath(), this).catch((e) => console.error(e));
  }
  /** Swap the preview for an editor; resolves once the editor exists. */
  async showEditor(): Promise<void> {
    if (this.editMode || !this.io.write) return;
    ++this.gen;
    this.text = await this.io.read();
    this.containerEl.empty();
    const host = this.containerEl.createDiv({ cls: "markdown-source-view cm-s-obsidian mod-cm6 is-live-preview" });
    const view = (this.editMode = new CardEditView(this.app, host, this));
    view.load();
    view.set(this.text, true);
    view.changeListener = () => { const t = view.get(); if (t !== this.text) { this.text = t; this.io.write!(t); } };
    view.focus();
  }
  private closeEditor(): void {
    if (!this.editMode) return;
    this.editMode.unload();
    this.editMode = null;
  }
  get file(): TFile | null { return this.node instanceof CanvasFileNode ? this.node.file : null; }
}

export type CanvasNodeType = AllCanvasNodeData["type"];

export abstract class CanvasNode {
  abstract readonly type: CanvasNodeType;
  id: string;
  x = 0; y = 0; width = 250; height = 60;
  color = "";
  /** The node's JSON as loaded: unknown keys and key order survive a save. */
  protected raw: Record<string, any>;
  nodeEl: HTMLElement;
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  contentBlockerEl: HTMLElement;
  isEditing = false;
  child: Component | null = null;
  private resizerEl: HTMLElement;
  private rendered = false;

  constructor(public canvas: Canvas, data: Partial<AllCanvasNodeData> & { id: string }) {
    this.id = data.id;
    this.raw = { ...data };
    this.nodeEl = createDiv({ cls: "canvas-node", attr: { "data-node-id": this.id } });
    this.containerEl = this.nodeEl.createDiv({ cls: "canvas-node-container" });
    this.contentEl = this.containerEl.createDiv({ cls: "canvas-node-content" });
    this.contentBlockerEl = this.containerEl.createDiv({ cls: "canvas-node-content-blocker" });
    this.resizerEl = this.nodeEl.createDiv({ cls: "canvas-node-resizer" });
    for (const dir of ["n", "e", "s", "w", "ne", "se", "sw", "nw"]) this.resizerEl.createDiv({ cls: `canvas-node-resizer-handle mod-${dir}`, attr: { "data-resize": dir } });
    for (const side of SIDES) this.nodeEl.createDiv({ cls: `canvas-node-connection-point mod-${side}`, attr: { "data-side": side } });
    this.applyData(data);
  }

  /** Copy the standard fields (and the per-type ones) from `d`. */
  protected applyData(d: Partial<AllCanvasNodeData>): void {
    if (typeof d.x === "number") this.x = d.x;
    if (typeof d.y === "number") this.y = d.y;
    if (typeof d.width === "number") this.width = d.width;
    if (typeof d.height === "number") this.height = d.height;
    this.color = typeof d.color === "string" ? d.color : "";
  }
  getData(): AllCanvasNodeData {
    const o: Record<string, any> = { ...this.raw, id: this.id, type: this.type };
    this.writeTypeData(o);
    Object.assign(o, { x: this.x, y: this.y, width: this.width, height: this.height });
    if (this.color) o.color = this.color; else delete o.color;
    return o as AllCanvasNodeData;
  }
  protected abstract writeTypeData(o: Record<string, any>): void;
  /** Replace the node's data (keeps id); re-renders. */
  setData(d: Partial<AllCanvasNodeData>, addHistory = false): void {
    if (addHistory) this.canvas.pushHistory();
    this.raw = { ...this.raw, ...d, id: this.id };
    this.applyData({ ...this.getData(), ...d } as AllCanvasNodeData);
    this.render();
    this.canvas.onNodeChanged(this);
  }

  getBBox(): BBox { return rectBBox(this); }
  get bbox(): BBox { return this.getBBox(); }
  moveTo(p: Point): void { this.x = p.x; this.y = p.y; this.updatePosition(); this.canvas.onNodeChanged(this); }
  resize(s: { width: number; height: number }): void { this.width = s.width; this.height = s.height; this.updatePosition(); this.canvas.onNodeChanged(this); }
  moveAndResize(r: { x: number; y: number; width: number; height: number }): void { Object.assign(this, { x: r.x, y: r.y, width: r.width, height: r.height }); this.updatePosition(); this.canvas.onNodeChanged(this); }
  setColor(color: CanvasColor, addHistory = true): void { if (addHistory) this.canvas.pushHistory(); this.color = color || ""; applyColor(this.nodeEl, this.color); this.canvas.onNodeChanged(this); this.canvas.requestSave(); }
  updatePosition(): void {
    const s = this.nodeEl.style;
    s.transform = `translate(${this.x}px, ${this.y}px)`;
    s.width = `${this.width}px`;
    s.height = `${this.height}px`;
  }

  /** (Re)build the content. Called when the node is added and after data changes. */
  render(): void {
    this.updatePosition();
    applyColor(this.nodeEl, this.color);
    this.nodeEl.toggleClass("is-editing", this.isEditing);
    this.rendered = true;
    this.renderContent();
  }
  protected abstract renderContent(): void;
  get isRendered(): boolean { return this.rendered; }
  isEditable(): boolean { return false; }
  startEditing(): void {}
  stopEditing(): void {}
  /** Remove the DOM and unload the content; the canvas calls this from removeNode. */
  detach(): void { this.unloadChild(); this.nodeEl.detach(); }
  destroy(): void { this.detach(); }
  focus(): void { this.nodeEl.addClass("is-focused"); }
  blur(): void { this.nodeEl.removeClass("is-focused"); if (this.isEditing) this.stopEditing(); }
  protected setChild(c: Component | null): void { this.unloadChild(); this.child = c; c?.load(); }
  protected unloadChild(): void { const c = this.child; this.child = null; c?.unload(); }
}

export class CanvasTextNode extends CanvasNode {
  readonly type = "text" as const;
  // Subclass fields are `declare`d: the base constructor assigns them through applyData() before initialisers would run.
  declare text: string;
  declare child: NodeMarkdownChild | null;
  protected applyData(d: Partial<AllCanvasNodeData>): void { super.applyData(d); this.text = typeof (d as any).text === "string" ? (d as any).text : this.text ?? ""; }
  protected writeTypeData(o: Record<string, any>): void { o.text = this.text; }
  setText(text: string): void { this.text = text; if (!this.isEditing) this.renderContent(); this.canvas.onNodeChanged(this); this.canvas.requestSave(); }
  getText(): string { return this.text; }
  protected renderContent(): void {
    this.nodeEl.addClass("canvas-node-text");
    if (this.child && this.isEditing) return;
    this.contentEl.empty();
    const holder = this.contentEl;
    this.setChild(new NodeMarkdownChild(this, holder, {
      read: () => this.text,
      write: (t) => { this.text = t; this.canvas.onNodeChanged(this); this.canvas.requestSave(); },
      sourcePath: () => this.canvas.sourcePath,
    }));
  }
  isEditable(): boolean { return !this.canvas.readonly; }
  private before = "";
  startEditing(): void {
    if (!this.isEditable() || this.isEditing) return;
    this.before = this.text;
    this.canvas.pushHistory();
    this.isEditing = true;
    this.nodeEl.addClass("is-editing");
    void this.child?.showEditor();
  }
  stopEditing(): void {
    if (!this.isEditing) return;
    this.isEditing = false;
    this.nodeEl.removeClass("is-editing");
    if (this.text === this.before) this.canvas.dropHistory();
    void this.child?.showPreview();
  }
}

export class CanvasFileNode extends CanvasNode {
  readonly type = "file" as const;
  declare filePath: string;
  declare subpath: string;
  declare child: Component | null;
  private labelEl: HTMLElement;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(canvas: Canvas, data: Partial<AllCanvasNodeData> & { id: string }) {
    super(canvas, data);
    this.labelEl = this.nodeEl.createDiv({ cls: "canvas-node-label" });
    this.labelEl.addEventListener("dblclick", (e) => { e.stopPropagation(); const f = this.file; if (f) void canvas.app.workspace.getLeaf("tab").openFile(f, { active: true, ...(this.subpath ? { eState: { subpath: this.subpath } } : {}) }); });
  }
  get file(): TFile | null { return this.canvas.app.vault.getFileByPath(this.filePath); }
  protected applyData(d: Partial<AllCanvasNodeData>): void {
    super.applyData(d);
    const a = d as any;
    this.filePath = typeof a.file === "string" ? a.file : this.filePath ?? "";
    if ("subpath" in a || "file" in a || this.subpath === undefined) this.subpath = typeof a.subpath === "string" ? a.subpath : "";
  }
  protected writeTypeData(o: Record<string, any>): void { o.file = this.filePath; if (this.subpath) o.subpath = this.subpath; else delete o.subpath; }
  setFile(file: TFile, subpath?: string): void { this.setFilePath(file.path, subpath ?? ""); }
  setFilePath(path: string, subpath = ""): void {
    this.filePath = path;
    this.subpath = subpath && !subpath.startsWith("#") ? "#" + subpath : subpath;
    if (this.isRendered) this.renderContent();
    this.canvas.onNodeChanged(this);
    this.canvas.requestSave();
  }
  private async readMarkdown(file: TFile): Promise<string> {
    let text = await this.canvas.app.vault.cachedRead(file);
    if (this.subpath) {
      const cache = this.canvas.app.metadataCache.getFileCache(file);
      const r = cache ? resolveSubpath(cache, this.subpath) : null;
      if (r) text = text.slice(r.start.offset, r.end ? r.end.offset : undefined);
    }
    return text;
  }
  protected renderContent(): void {
    if (this.isEditing && this.child) return;
    this.nodeEl.addClass("canvas-node-file");
    const file = this.file;
    this.labelEl.setText(file ? (file.extension === "md" ? file.basename : file.name) + this.subpath : this.filePath);
    this.unloadChild();
    const c = this.contentEl;
    c.empty();
    for (const k of ["is-image", "is-media", "is-pdf", "is-markdown", "is-unresolved"]) this.nodeEl.removeClass(k);
    if (!file) {
      this.nodeEl.addClass("is-unresolved");
      c.createDiv({ cls: "canvas-node-placeholder", text: `"${this.filePath}" could not be found.` });
      return;
    }
    const ext = file.extension.toLowerCase();
    const src = this.canvas.app.vault.getResourcePath(file);
    if (ext === "md") {
      this.nodeEl.addClass("is-markdown");
      const holder = c.createDiv({ cls: "markdown-embed" });
      this.setChild(new NodeMarkdownChild(this, holder, {
        read: () => this.readMarkdown(file),
        // Editing a heading/block section would need splicing it back into the note: only whole notes are editable.
        write: this.subpath ? undefined : (t) => {
          if (this.writeTimer) clearTimeout(this.writeTimer);
          this.writeTimer = setTimeout(() => { this.writeTimer = null; void this.canvas.app.vault.modify(file, t); }, 500);
        },
        sourcePath: () => file.path,
      }));
    } else if (IMAGE.has(ext)) {
      this.nodeEl.addClass("is-image");
      c.createEl("img", { attr: { src, alt: file.name, draggable: "false" } });
    } else if (AUDIO.has(ext) || VIDEO.has(ext)) {
      this.nodeEl.addClass("is-media");
      c.createEl(AUDIO.has(ext) ? "audio" : "video", { attr: { src, controls: "" } });
    } else if (ext === "pdf") {
      this.nodeEl.addClass("is-pdf");
      c.createEl("iframe", { attr: { src: src + (/page=(\d+)/.exec(this.subpath) ? `#page=${/page=(\d+)/.exec(this.subpath)![1]}` : "") } });
    } else {
      const ph = c.createDiv({ cls: "canvas-node-placeholder" });
      setIcon(ph.createDiv({ cls: "canvas-icon-placeholder" }), ext === "canvas" ? "lucide-layout-dashboard" : "lucide-file");
      ph.createDiv({ text: file.name });
    }
  }
  /** Re-render when the shown file changed on disk (not while it is being edited here). */
  onFileModified(): void { if (!this.isEditing && this.isRendered) this.renderContent(); }
  isEditable(): boolean { const f = this.file; return !this.canvas.readonly && !!f && f.extension === "md" && !this.subpath; }
  startEditing(): void {
    if (!this.isEditable() || this.isEditing) return;
    this.isEditing = true;
    this.nodeEl.addClass("is-editing");
    void (this.child as NodeMarkdownChild | null)?.showEditor();
  }
  stopEditing(): void {
    if (!this.isEditing) return;
    this.isEditing = false;
    this.nodeEl.removeClass("is-editing");
    void (this.child as NodeMarkdownChild | null)?.showPreview();
  }
  detach(): void { if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; } super.detach(); }
}

/**
 * Only public web pages are framed (sandboxed; `allow-same-origin` only grants the page its own remote origin, never the
 * app's); local hosts, private addresses and other schemes render as a title card.
 */
export function isFrameableUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith("[")) return false;
  return true;
}

export class CanvasLinkNode extends CanvasNode {
  readonly type = "link" as const;
  declare url: string;
  protected applyData(d: Partial<AllCanvasNodeData>): void { super.applyData(d); this.url = typeof (d as any).url === "string" ? (d as any).url : this.url ?? ""; }
  protected writeTypeData(o: Record<string, any>): void { o.url = this.url; }
  setUrl(url: string): void { this.url = url; if (this.isRendered) this.renderContent(); this.canvas.onNodeChanged(this); this.canvas.requestSave(); }
  protected renderContent(): void {
    this.nodeEl.addClass("canvas-node-link");
    const c = this.contentEl;
    c.empty();
    const frame = this.canvas.options.linkFrames && isFrameableUrl(this.url);
    this.nodeEl.toggleClass("is-framed", frame);
    if (frame) {
      c.createEl("iframe", { cls: "canvas-link-frame", attr: { src: this.url, sandbox: "allow-scripts allow-same-origin allow-forms allow-popups", referrerpolicy: "no-referrer" } }); // no loading="lazy": WebKit never loads lazy frames inside the transformed canvas
      return;
    }
    const card = c.createDiv({ cls: "canvas-link-card" });
    let host = this.url;
    try { host = new URL(this.url).hostname || this.url; } catch { /* keep the raw text */ }
    setIcon(card.createDiv({ cls: "canvas-link-card-icon" }), "lucide-globe");
    card.createDiv({ cls: "canvas-link-card-title", text: host });
    const a = card.createEl("a", { cls: "external-link canvas-link-card-url", text: this.url, attr: { href: this.url, target: "_blank", rel: "noopener nofollow" } });
    a.addEventListener("click", (e) => { e.preventDefault(); this.canvas.openUrl(this.url); });
  }
}

export class CanvasGroupNode extends CanvasNode {
  readonly type = "group" as const;
  declare label: string;
  declare background: string;
  declare backgroundStyle: string;
  labelEl: HTMLElement;
  constructor(canvas: Canvas, data: Partial<AllCanvasNodeData> & { id: string }) {
    super(canvas, data);
    this.labelEl = this.nodeEl.createDiv({ cls: "canvas-group-label" });
  }
  protected applyData(d: Partial<AllCanvasNodeData>): void {
    super.applyData(d);
    const a = d as any;
    const str = (k: "label" | "background" | "backgroundStyle") => { if (k in a || this[k] === undefined) this[k] = typeof a[k] === "string" ? a[k] : ""; };
    str("label"); str("background"); str("backgroundStyle");
  }
  protected writeTypeData(o: Record<string, any>): void {
    for (const [k, v] of [["label", this.label], ["background", this.background], ["backgroundStyle", this.backgroundStyle]] as const) { if (v) o[k] = v; else delete o[k]; }
  }
  setLabel(label: string): void { this.label = label; if (this.isRendered) this.renderContent(); this.canvas.onNodeChanged(this); this.canvas.requestSave(); }
  protected renderContent(): void {
    this.nodeEl.addClass("canvas-node-group");
    this.labelEl.setText(this.label);
    this.labelEl.toggle(!!this.label);
    const s = this.contentEl.style;
    const f = this.background ? this.canvas.app.vault.getFileByPath(this.background) : null;
    if (f) {
      s.backgroundImage = `url("${this.canvas.app.vault.getResourcePath(f).replace(/"/g, "%22")}")`;
      s.backgroundSize = this.backgroundStyle === "ratio" ? "contain" : this.backgroundStyle === "repeat" ? "auto" : "cover";
      s.backgroundRepeat = this.backgroundStyle === "repeat" ? "repeat" : "no-repeat";
      s.backgroundPosition = "center";
    } else s.backgroundImage = "";
  }
}

export interface EdgeEndpoint { node: CanvasNode; side?: NodeSide; end: EdgeEnd }

export class CanvasEdge {
  id: string;
  from: EdgeEndpoint;
  to: EdgeEndpoint;
  label = "";
  color = "";
  /** Sides as stored (undefined: chosen automatically each render). */
  private raw: Record<string, any>;
  lineGroupEl: SVGGElement;
  path: { display: SVGPathElement; interaction: SVGPathElement };
  lineEndGroupEl: SVGGElement;
  fromLineEnd: SVGPolygonElement;
  toLineEnd: SVGPolygonElement;
  labelElement: { wrapperEl: HTMLElement; textareaEl: HTMLElement } | null = null;
  geometry: EdgeGeometry | null = null;

  constructor(public canvas: Canvas, data: CanvasEdgeData, from: CanvasNode, to: CanvasNode) {
    this.id = data.id;
    this.raw = { ...data };
    this.from = { node: from, side: data.fromSide, end: data.fromEnd === "arrow" ? "arrow" : "none" };
    this.to = { node: to, side: data.toSide, end: data.toEnd === "none" ? "none" : "arrow" };
    this.label = typeof data.label === "string" ? data.label : "";
    this.color = typeof data.color === "string" ? data.color : "";
    this.lineGroupEl = svgEl("g", undefined, "canvas-edge");
    this.lineGroupEl.setAttribute("data-edge-id", this.id);
    const display = svgEl("path", this.lineGroupEl, "canvas-display-path");
    const interaction = svgEl("path", this.lineGroupEl, "canvas-interaction-path");
    interaction.setAttribute("data-edge-id", this.id);
    this.path = { display, interaction };
    this.lineEndGroupEl = svgEl("g", this.lineGroupEl, "canvas-path-ends");
    this.fromLineEnd = svgEl("polygon", this.lineEndGroupEl, "canvas-path-end mod-from");
    this.toLineEnd = svgEl("polygon", this.lineEndGroupEl, "canvas-path-end mod-to");
  }
  getData(): CanvasEdgeData {
    const o: Record<string, any> = { ...this.raw, id: this.id, fromNode: this.from.node.id };
    if (this.from.side) o.fromSide = this.from.side; else delete o.fromSide;
    if (this.from.end === "arrow") o.fromEnd = "arrow"; else if (o.fromEnd !== undefined) o.fromEnd = "none";
    o.toNode = this.to.node.id;
    if (this.to.side) o.toSide = this.to.side; else delete o.toSide;
    if (this.to.end === "none") o.toEnd = "none"; else if (o.toEnd !== undefined) o.toEnd = "arrow";
    if (this.color) o.color = this.color; else delete o.color;
    if (this.label) o.label = this.label; else delete o.label;
    // Keys we just (re)assigned land at the end for new edges; reorder to the conventional order when they were absent.
    const order = ["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"];
    const known = Object.keys(this.raw);
    const rest = Object.keys(o).filter((k) => !order.includes(k) && !known.includes(k));
    const keys = [...known.filter((k) => k in o), ...order.filter((k) => k in o && !known.includes(k)), ...rest];
    return Object.fromEntries(keys.map((k) => [k, o[k]])) as CanvasEdgeData;
  }
  setData(d: Partial<CanvasEdgeData>, addHistory = false): void {
    if (addHistory) this.canvas.pushHistory();
    this.raw = { ...this.raw, ...d, id: this.id };
    const nodes = this.canvas.nodes;
    if (d.fromNode && nodes.get(d.fromNode)) this.from.node = nodes.get(d.fromNode)!;
    if (d.toNode && nodes.get(d.toNode)) this.to.node = nodes.get(d.toNode)!;
    if ("fromSide" in d) this.from.side = d.fromSide;
    if ("toSide" in d) this.to.side = d.toSide;
    if ("fromEnd" in d) this.from.end = d.fromEnd === "arrow" ? "arrow" : "none";
    if ("toEnd" in d) this.to.end = d.toEnd === "none" ? "none" : "arrow";
    if ("label" in d) this.label = d.label ?? "";
    if ("color" in d) this.color = d.color ?? "";
    this.render();
    this.canvas.requestSave();
  }
  setLabel(label: string): void { this.label = label; this.render(); this.canvas.requestSave(); }
  setColor(color: CanvasColor, addHistory = true): void { if (addHistory) this.canvas.pushHistory(); this.color = color || ""; this.render(); this.canvas.requestSave(); }
  /** Sides actually used for drawing. */
  sides(): [NodeSide, NodeSide] {
    const auto = autoSides(this.from.node, this.to.node);
    return [this.from.side ?? auto[0], this.to.side ?? auto[1]];
  }
  getBBox(): BBox {
    const g = this.geometry ?? this.compute();
    const xs = [g.from.x, g.to.x, g.c1.x, g.c2.x], ys = [g.from.y, g.to.y, g.c1.y, g.c2.y];
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  }
  private compute(): EdgeGeometry {
    const [fs, ts] = this.sides();
    const a = sidePoint(this.from.node, fs), b = sidePoint(this.to.node, ts);
    // Lines stop at the arrow's base so they don't poke through the head.
    const back = (p: Point, s: NodeSide, on: boolean) => { const n = sideNormal(s); return on ? { x: p.x + n.x * 10, y: p.y + n.y * 10 } : p; };
    return edgeGeometry(back(a, fs, this.from.end === "arrow"), fs, back(b, ts, this.to.end === "arrow"), ts);
  }
  render(): void {
    const [fs, ts] = this.sides();
    const g = (this.geometry = this.compute());
    this.path.display.setAttribute("d", g.path);
    this.path.interaction.setAttribute("d", g.path);
    const tip = (s: NodeSide, n: CanvasNode) => sidePoint(n, s);
    this.fromLineEnd.setAttribute("points", arrowPoints(tip(fs, this.from.node), fs));
    this.toLineEnd.setAttribute("points", arrowPoints(tip(ts, this.to.node), ts));
    this.fromLineEnd.style.display = this.from.end === "arrow" ? "" : "none";
    this.toLineEnd.style.display = this.to.end === "arrow" ? "" : "none";
    applyColor(this.lineGroupEl, this.color);
    if (this.label) {
      if (!this.labelElement) {
        const wrapperEl = createDiv({ cls: "canvas-path-label-wrapper", attr: { "data-edge-id": this.id } });
        const textareaEl = wrapperEl.createDiv({ cls: "canvas-path-label" });
        this.labelElement = { wrapperEl, textareaEl };
        this.canvas.edgeLabelLayerEl.appendChild(wrapperEl);
      }
      const { wrapperEl, textareaEl } = this.labelElement;
      textareaEl.setText(this.label);
      wrapperEl.style.transform = `translate(${g.mid.x}px, ${g.mid.y}px) translate(-50%, -50%)`;
      applyColor(wrapperEl, this.color);
    } else if (this.labelElement) { this.labelElement.wrapperEl.remove(); this.labelElement = null; }
  }
  /** Re-render after a connected node moved. */
  update(): void { this.render(); }
  detach(): void { this.lineGroupEl.remove(); this.labelElement?.wrapperEl.remove(); this.labelElement = null; }
}
