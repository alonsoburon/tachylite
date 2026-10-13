// app.embedRegistry: embed components used for ![[...]] (markdown, images, audio, video, pdf).
import { Component } from "./events";
import type { TFile } from "./files";
import { MarkdownRenderer } from "./markdown";
import { resolveSubpath } from "./util";
import type { Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { CMEditor, editorEditorField, editorInfoField, editorLivePreviewField, getEditorFactory, setEditorView } from "./editor";
import type { App } from "./app";

export interface EmbedContext { app: App; containerEl: HTMLElement; linktext?: string; sourcePath?: string; depth?: number }
export type EmbedCreator = (ctx: EmbedContext, file: TFile | null, subpath: string) => Component & { loadFile?: () => Promise<void> };

export class EmbedRegistry {
  embedByExtension: Record<string, EmbedCreator> = {};
  registerExtension(ext: string, creator: EmbedCreator): void { this.embedByExtension[ext] = creator; }
  registerExtensions(exts: string[], creator: EmbedCreator): void { for (const e of exts) this.registerExtension(e, creator); }
  unregisterExtension(ext: string): void { delete this.embedByExtension[ext]; }
  unregisterExtensions(exts: string[]): void { for (const e of exts) this.unregisterExtension(e); }
  isExtensionRegistered(ext: string): boolean { return ext in this.embedByExtension; }
  getEmbedCreator(file: TFile): EmbedCreator | null { return this.embedByExtension[file.extension.toLowerCase()] ?? null; }
}

export class EmbedBase extends Component {
  app: App;
  containerEl: HTMLElement;
  /** Embeds own the popovers of links inside them (HoverParent). */
  hoverPopover: any = null;
  constructor(public ctx: EmbedContext, public file: TFile | null, public subpath: string) {
    super();
    this.app = ctx.app;
    this.containerEl = ctx.containerEl;
  }
  onload(): void { void this.loadFile(); }
  async loadFile(): Promise<void> {}
}

/** Base of the embedded editors (what plugins like Kanban subclass to host their own CM6 editor). */
export class MarkdownBaseView extends Component {
  hoverPopover: any = null;
  constructor(public app: App, public containerEl: HTMLElement, public owner: any) { super(); }
  get file(): TFile | null { return this.owner?.file ?? null; }
  get(): string { return ""; }
  set(_data: string, _clear: boolean): void {}
  clear(): void { this.set("", true); }
  getScroll(): number { return 0; }
  applyScroll(_n: number): void {}
}

export class MarkdownScrollableEditView extends MarkdownBaseView {
  private _cm: EditorView | null = null;
  private _editor: CMEditor | null = null;
  /** Extensions for this editor; subclasses override and call super. */
  buildLocalExtensions(): Extension[] {
    return [
      // Every Obsidian editor carries these fields; plugin extensions read them (Dataview, Tasks, Kanban...).
      editorInfoField.init(() => this.owner ?? this), editorEditorField, editorLivePreviewField,
      ...this.app.workspace.editorExtensions,
      EditorView.updateListener.of((u) => { if (u.docChanged || u.selectionSet) this.onUpdate(u, u.docChanged); }),
    ];
  }
  onUpdate(_update: ViewUpdate, _changed: boolean): void {}
  get cm(): EditorView {
    if (!this._cm) {
      this._cm = getEditorFactory().create({ parent: this.containerEl, doc: "", extensions: this.buildLocalExtensions() });
      this._cm.dispatch({ effects: setEditorView.of(this._cm) });
      this._editor = new CMEditor(this._cm);
      (this._editor as any).cm = this._cm;
    }
    return this._cm;
  }
  get editor(): CMEditor { void this.cm; return this._editor!; }
  onload(): void { void this.cm; }
  onunload(): void { this._cm?.destroy(); this._cm = null; this._editor = null; }
  get(): string { return this.cm.state.doc.toString(); }
  set(data: string, _clear: boolean): void { const cm = this.cm; if (cm.state.doc.toString() !== data) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: data } }); }
  getSelection(): string { const m = this.cm.state.selection.main; return this.cm.state.sliceDoc(m.from, m.to); }
  focus(): void { this.cm.focus(); }
  getScroll(): number { return this.cm.scrollDOM.scrollTop; }
  applyScroll(n: number): void { this.cm.scrollDOM.scrollTop = n; }
}
export class EmbeddedEditView extends MarkdownScrollableEditView {
  changeListener: (() => void) | null = null;
  onUpdate(update: ViewUpdate, changed: boolean): void { if (changed) this.changeListener?.(); }
}

export class MarkdownEmbed extends EmbedBase {
  editable = false;
  editMode: EmbeddedEditView | null = null;
  previewMode: { rerender(): void } | null = null;
  private text = "";
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  async loadFile(): Promise<void> {
    if (!this.file) return;
    let text = await this.app.vault.cachedRead(this.file);
    if (this.subpath) {
      const cache = this.app.metadataCache.getFileCache(this.file);
      const r = cache ? resolveSubpath(cache, this.subpath) : null;
      if (r) text = text.slice(r.start.offset, r.end ? r.end.offset : undefined);
    }
    this.text = text;
    if (this.editable) this.showEditor(); else this.showPreview();
  }
  showPreview(): void {
    this.editMode?.unload();
    this.editMode = null;
    this.containerEl.empty();
    void MarkdownRenderer.render(this.app, this.text, this.containerEl, this.file?.path ?? "", this);
    this.previewMode = { rerender: () => this.showPreview() };
  }
  showEditor(): void {
    if (this.editMode) return;
    this.containerEl.empty();
    const view = (this.editMode = new EmbeddedEditView(this.app, this.containerEl, this));
    const f = this.file;
    if (f) {
      view.changeListener = () => {
        if (view.get() === this.text) return;
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => { void this.app.vault.modify(f, view.get()); }, 1000);
      };
    }
    this.addChild(view);
    view.set(this.text, true);
  }
}
class MediaEmbed extends EmbedBase {
  constructor(ctx: EmbedContext, file: TFile | null, subpath: string, private tag: "img" | "audio" | "video" | "iframe") { super(ctx, file, subpath); }
  async loadFile(): Promise<void> {
    if (!this.file) return;
    const src = this.app.vault.getResourcePath(this.file);
    this.containerEl.empty();
    const el = this.containerEl.createEl(this.tag as "img", { attr: { src } });
    if (this.tag === "audio" || this.tag === "video") el.setAttribute("controls", "");
    if (this.tag === "img") el.setAttribute("alt", this.file.name);
  }
}

export function registerDefaultEmbeds(reg: EmbedRegistry): void {
  reg.registerExtension("md", (c, f, s) => new MarkdownEmbed(c, f, s));
  reg.registerExtensions(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"], (c, f, s) => new MediaEmbed(c, f, s, "img"));
  reg.registerExtensions(["mp3", "wav", "m4a", "ogg", "3gp", "flac", "opus"], (c, f, s) => new MediaEmbed(c, f, s, "audio"));
  reg.registerExtensions(["mp4", "webm", "ogv", "mov", "mkv"], (c, f, s) => new MediaEmbed(c, f, s, "video"));
  reg.registerExtension("pdf", (c, f, s) => new MediaEmbed(c, f, s, "iframe"));
}
