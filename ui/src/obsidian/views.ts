// View hierarchy: View, ItemView, FileView, EditableFileView, TextFileView, MarkdownView (+ placeholder views).
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Component } from "./events";
import { TFile } from "./files";
import { setIcon } from "./icons";
import { type Menu } from "./ui";
import { debounce, resolveSubpath, type Debouncer } from "./util";
import { CMEditor, Editor, editorEditorField, editorInfoField, editorLivePreviewField, getEditorFactory, setEditorInfo, setEditorView } from "./editor";
import { installPreviewTaskToggle } from "./previewTasks";
import { MarkdownRenderer } from "./markdown";
import type { App } from "./app";
import type { WorkspaceLeaf } from "./workspace";

export interface ViewStateResult { history: boolean }
export type ViewCreator = (leaf: WorkspaceLeaf) => View;

export abstract class View extends Component {
  app: App;
  icon = "";
  navigation = true;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  scope: any = null;
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = createDiv({ cls: "workspace-leaf-content" });
  }
  protected async onOpen(): Promise<void> {}
  protected async onClose(): Promise<void> {}
  /** Used by WorkspaceLeaf (public wrappers around the protected hooks). */
  async _open(): Promise<void> { await this.onOpen(); }
  async _close(): Promise<void> { await this.onClose(); }
  abstract getViewType(): string;
  getState(): Record<string, unknown> { return {}; }
  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}
  getEphemeralState(): Record<string, unknown> { return {}; }
  setEphemeralState(_state: unknown): void {}
  getIcon(): string { return this.icon || "document"; }
  onResize(): void {}
  abstract getDisplayText(): string;
  onPaneMenu(_menu: Menu, _source: string): void {}
  onHeaderMenu(_menu: Menu): void {}
}

export abstract class ItemView extends View {
  headerEl: HTMLElement;
  titleContainerEl: HTMLElement;
  titleEl: HTMLElement;
  actionsEl: HTMLElement;
  contentEl: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Plugins rely on `containerEl.children[1]` being the content element.
    this.headerEl = this.containerEl.createDiv({ cls: "view-header" });
    this.headerEl.createDiv({ cls: "view-header-left" });
    this.titleContainerEl = this.headerEl.createDiv({ cls: "view-header-title-container mod-at-start" });
    this.titleEl = this.titleContainerEl.createDiv({ cls: "view-header-title" });
    this.actionsEl = this.headerEl.createDiv({ cls: "view-actions" });
    this.contentEl = this.containerEl.createDiv({ cls: "view-content" });
  }
  addAction(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const el = this.actionsEl.createEl("a", { cls: "view-action clickable-icon", attr: { "aria-label": title } });
    setIcon(el, icon);
    el.addEventListener("click", (e) => callback(e));
    this.actionsEl.insertBefore(el, this.actionsEl.firstChild);
    return el;
  }
  updateHeader(): void { this.titleEl.setText(this.getDisplayText()); }
}

export class EmptyView extends ItemView {
  getViewType(): string { return "empty"; }
  getDisplayText(): string { return "New tab"; }
  protected async onOpen(): Promise<void> {
    const ws = this.app.workspace;
    if (!ws) { queueMicrotask(() => { void this.onOpen(); }); return; } // the very first leaf is built inside the Workspace constructor
    if (!ws.layoutReady) this.registerEvent(ws.on("layout-ready", () => { void this.onOpen(); })); // hotkey labels need the commands
    this.contentEl.empty();
    const c = this.contentEl.createDiv({ cls: "empty-state" }).createDiv({ cls: "empty-state-container" });
    c.createDiv({ cls: "empty-state-title", text: "No file is open" });
    const actions = c.createDiv({ cls: "empty-state-action-list" });
    const hot = (id: string) => {
      const h = this.app.hotkeyManager?.getHotkeys(id)[0];
      return h ? [...h.modifiers, h.key.length === 1 ? h.key.toUpperCase() : h.key].join("+").replace("Mod", "Ctrl") : "";
    };
    for (const [id, label] of [["file-explorer:new-file", "Create new note"], ["switcher:open", "Go to file"]] as const) {
      const a = actions.createDiv({ cls: "empty-state-action", text: hot(id) ? `${label} (${hot(id)})` : label });
      a.addEventListener("click", () => { this.app.commands.executeCommandById(id); });
    }
    actions.createDiv({ cls: "empty-state-action", text: "Close" }).addEventListener("click", () => { this.leaf.detach(); });
  }
}

/** Placeholder for a view type nobody has registered (yet): keeps the state, re-opens when registered. */
export class DeferredView extends ItemView {
  state: Record<string, unknown> = {};
  constructor(leaf: WorkspaceLeaf, public type: string) { super(leaf); }
  getViewType(): string { return this.type; }
  getDisplayText(): string { return this.type; }
  getState(): Record<string, unknown> { return this.state; }
  async setState(state: any): Promise<void> {
    this.state = state ?? {};
    this.contentEl.empty();
    this.contentEl.createDiv({ cls: "empty-state" }).createDiv({ cls: "empty-state-container" }).createDiv({ cls: "empty-state-title", text: `The plugin providing "${this.type}" is not loaded.` });
  }
}

export abstract class FileView extends ItemView {
  allowNoFile = false;
  file: TFile | null = null;
  navigation = true;
  onload(): void {
    this.registerEvent(this.app.vault.on("rename", (f: any) => {
      if (f === this.file) { void this.onRename(f); this.updateHeader(); this.leaf.updateHeader(); }
    }));
    this.registerEvent(this.app.vault.on("delete", (f: any) => {
      if (f === this.file && !this.allowNoFile) { this.leaf.detach(); }
    }));
  }
  getDisplayText(): string { return this.file ? this.file.basename : "No file"; }
  getState(): Record<string, unknown> { return { file: this.file?.path }; }
  async setState(state: any, _result: ViewStateResult): Promise<void> {
    const path = state?.file;
    const next = typeof path === "string" ? this.app.vault.getFileByPath(path) : null;
    if (this.file && this.file !== next) {
      const old = this.file;
      await this.onUnloadFile(old);
      this.file = null;
    }
    if (next && this.file !== next) {
      this.file = next;
      await this.onLoadFile(next);
    } else if (!next && typeof path === "string" && !this.allowNoFile) {
      this.contentEl.empty();
      this.contentEl.createDiv({ cls: "empty-state" }).createDiv({ cls: "empty-state-container" }).createDiv({ cls: "empty-state-title", text: `File ${path} not found.` });
    }
    this.updateHeader();
  }
  async onLoadFile(_file: TFile): Promise<void> {}
  async onUnloadFile(_file: TFile): Promise<void> {}
  async onRename(_file: TFile): Promise<void> {}
  canAcceptExtension(_ext: string): boolean { return false; }
  protected async onClose(): Promise<void> {
    if (this.file) await this.onUnloadFile(this.file);
  }
}

export abstract class EditableFileView extends FileView {}

export abstract class TextFileView extends EditableFileView {
  data = "";
  requestSave: Debouncer<[], Promise<void>>;
  private saving = false;
  private dirty = false;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.requestSave = debounce(async () => { await this.save(); }, 2000, true) as Debouncer<[], Promise<void>>;
  }
  markDirty(): void { this.dirty = true; this.requestSave(); }
  onload(): void {
    super.onload();
    this.registerEvent(this.app.vault.on("modify", (f: any) => {
      if (f !== this.file || this.saving || this.dirty) return;
      void this.app.vault.read(f).then((d) => { if (d !== this.data && !this.dirty) { this.data = d; this.setViewData(d, false); } });
    }));
  }
  async onUnloadFile(file: TFile): Promise<void> {
    this.requestSave.cancel();
    if (this.dirty && file) await this.save();
    this.clear();
    this.data = "";
  }
  async onLoadFile(file: TFile): Promise<void> {
    const data = await this.app.vault.read(file);
    this.data = data;
    this.dirty = false;
    this.setViewData(data, true);
  }
  async save(clear = false): Promise<void> {
    this.requestSave.cancel();
    const file = this.file;
    if (!file) return;
    const data = this.getViewData();
    if (this.dirty || data !== this.data) {
      this.saving = true;
      try { await this.app.vault.modify(file, data); this.data = data; this.dirty = false; }
      finally { this.saving = false; }
    }
    if (clear) this.clear();
  }
  protected async onClose(): Promise<void> {
    this.requestSave.cancel();
    if (this.dirty) await this.save();
    await super.onClose();
  }
  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;
}

/** Core viewers for non-markdown files: image, audio, video, pdf; plus a notice for everything else. */
export class MediaFileView extends FileView {
  constructor(leaf: WorkspaceLeaf, public kind: "image" | "audio" | "video" | "pdf" | "unsupported") { super(leaf); this.allowNoFile = false; }
  getViewType(): string { return this.kind === "unsupported" ? "file-unsupported" : this.kind; }
  getIcon(): string { return this.kind === "audio" ? "lucide-file-audio" : this.kind === "video" ? "lucide-file-video" : this.kind === "image" ? "lucide-file-image" : "lucide-file"; }
  canAcceptExtension(): boolean { return true; }
  async onLoadFile(file: TFile): Promise<void> {
    this.contentEl.empty();
    if (this.kind === "unsupported") {
      this.contentEl.createDiv({ cls: "empty-state" }).createDiv({ cls: "empty-state-container" }).createDiv({ cls: "empty-state-title", text: `Cannot open files of type .${file.extension}` });
      return;
    }
    const src = this.app.vault.getResourcePath(file);
    const wrap = this.contentEl.createDiv({ cls: `${this.kind}-container` });
    const tag = this.kind === "image" ? "img" : this.kind === "pdf" ? "iframe" : this.kind;
    const el = wrap.createEl(tag as "img", { attr: { src } });
    if (this.kind === "audio" || this.kind === "video") el.setAttribute("controls", "");
  }
  async onUnloadFile(): Promise<void> { this.contentEl.empty(); }
}

export type MarkdownViewModeType = "source" | "preview";

export class MarkdownEditView {
  type = "source" as const;
  /** true = "Source mode" (raw), false = Live Preview. */
  sourceMode = false;
  app: App;
  hoverPopover: any = null;
  constructor(public view: MarkdownView) { this.app = view.app; }
  get file(): TFile { return this.view.file as TFile; }
  get editor(): Editor { return this.view.editor; }
  get cm(): EditorView { return this.view.cm; }
  clear(): void { this.view.clear(); }
  get(): string { return this.view.editor.getValue(); }
  set(data: string, _clear: boolean): void { this.view.setViewData(data, false); }
  getSelection(): string { return this.view.editor.getSelection(); }
  getScroll(): number { return this.view.editor.getScrollInfo().top; }
  applyScroll(n: number): void { this.view.editor.scrollTo(null, n); }
  getFoldInfo(): { folds: { from: number; to: number }[]; lines: number } | null { return { folds: [], lines: this.view.editor.lineCount() }; }
  applyFoldInfo(_info: unknown): void {}
}

export class MarkdownPreviewView extends MarkdownRenderer {
  type = "preview" as const;
  getFoldInfo(): null { return null; }
  applyFoldInfo(_info: unknown): void {}
  constructor(public view: MarkdownView) {
    super(view.previewEl);
    this.app = view.app;
    installPreviewTaskToggle(view);
  }
  get file(): TFile { return this.view.file as TFile; }
  private text = "";
  private rendering: Promise<void> = Promise.resolve();
  get(): string { return this.text; }
  set(data: string, _clear: boolean): void { this.text = data; if (this.view.getMode() === "preview") this.rerender(); }
  clear(): void { this.text = ""; this.containerEl.empty(); }
  rerender(_full?: boolean): void {
    const el = this.containerEl;
    // Render children that post-processors attached (ctx.addChild) belong to the previous render.
    for (const c of this._children.slice()) this.removeChild(c);
    el.empty();
    const holder = el.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    const sizer = holder.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    (this.view as any).decoratePreview?.(sizer);
    const sourcePath = this.view.file?.path ?? "";
    this.rendering = MarkdownRenderer.render(this.app, this.text, sizer, sourcePath, this).catch((e) => console.error(e));
  }
  /** Resolves when the last render has finished. */
  whenRendered(): Promise<void> { return this.rendering; }
  getScroll(): number { return this.containerEl.scrollTop; }
  applyScroll(scroll: number): void { this.containerEl.scrollTop = scroll; }
}

export class MarkdownView extends TextFileView {
  editor: Editor;
  previewMode: MarkdownPreviewView;
  currentMode: MarkdownEditView | MarkdownPreviewView;
  editMode: MarkdownEditView;
  hoverPopover: any = null;
  sourceEl: HTMLElement;
  previewEl: HTMLElement;
  private mode: MarkdownViewModeType = "source";
  private extCompartment = new Compartment();
  private muted = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-file";
    this.sourceEl = this.contentEl.createDiv({ cls: "markdown-source-view cm-s-obsidian mod-cm6 is-live-preview" });
    this.previewEl = this.contentEl.createDiv({ cls: "markdown-reading-view" });
    this.previewEl.hide();
    const cm = getEditorFactory().create({
      parent: this.sourceEl,
      doc: "",
      extensions: [
        editorInfoField.init(() => this), editorEditorField, editorLivePreviewField,
        this.extCompartment.of(this.app.workspace.editorExtensions),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !this.muted) {
            this.markDirty();
            this.app.workspace.trigger("editor-change", this.editor, this);
            this.app.workspace.trigger("quick-preview", this.file, this.editor.getValue());
          }
          if (u.docChanged || u.selectionSet) this.app.workspace.editorSuggestManager?.update(this);
          if (u.selectionSet && !this.muted) this.app.workspace.trigger("editor-selection-change", this.editor, this);
        }),
      ],
    });
    cm.dispatch({ effects: [setEditorInfo.of(this), setEditorView.of(cm)] });
    this.editor = new CMEditor(cm);
    (this.editor as any).cm = cm;
    // A child of the view, so render children added by post-processors get loaded (and unloaded with the view).
    this.previewMode = this.addChild(new MarkdownPreviewView(this));
    this.editMode = new MarkdownEditView(this);
    this.currentMode = this.mode === "preview" ? this.previewMode : this.editMode;
  }
  get cm(): EditorView { return (this.editor as CMEditor).cm; }
  get editorState(): EditorState { return this.cm.state; }
  getViewType(): string { return "markdown"; }
  getIcon(): string { return "lucide-file"; }
  canAcceptExtension(ext: string): boolean { return ext === "md"; }
  getMode(): MarkdownViewModeType { return this.mode; }
  setMode(mode: MarkdownViewModeType): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.sourceEl.toggle(mode === "source");
    this.previewEl.toggle(mode === "preview");
    this.currentMode = mode === "preview" ? this.previewMode : this.editMode;
    if (mode === "preview") { this.previewMode.set(this.getViewData(), false); this.previewMode.rerender(true); }
  }
  getViewData(): string { return this.editor.getValue(); }
  setViewData(data: string, clear: boolean): void {
    this.muted = true;
    try {
      const cm = this.cm;
      if (cm.state.doc.toString() !== data) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: data }, selection: clear ? { anchor: 0 } : undefined });
    } finally { this.muted = false; }
    this.previewMode.set(data, clear);
  }
  clear(): void { this.setViewData("", true); }
  showSearch(_replace?: boolean): void {}
  /** Re-apply the plugin-provided editor extensions (Workspace.updateOptions). */
  reconfigure(): void { this.cm.dispatch({ effects: this.extCompartment.reconfigure(this.app.workspace.editorExtensions) }); }

  getState(): Record<string, unknown> { return { file: this.file?.path, mode: this.mode, source: this.editMode.sourceMode }; }
  async setState(state: any, result: ViewStateResult): Promise<void> {
    if (state?.mode === "preview" || state?.mode === "source") this.setMode(state.mode);
    await super.setState(state, result);
    if (state?.mode === "preview") this.previewMode.rerender(true);
  }
  getEphemeralState(): Record<string, unknown> {
    const m = this.cm.state.selection.main;
    return { cursor: { from: this.editor.offsetToPos(m.anchor), to: this.editor.offsetToPos(m.head) }, scroll: this.cm.scrollDOM.scrollTop };
  }
  setEphemeralState(state: any): void {
    if (!state) return;
    const ed = this.editor;
    if (state.cursor) ed.setSelection(state.cursor.from, state.cursor.to);
    if (typeof state.line === "number") {
      const pos = { line: state.line, ch: typeof state.startLoc?.col === "number" ? state.startLoc.col : 0 };
      ed.setCursor(pos);
      ed.scrollIntoView({ from: pos, to: pos }, true);
    }
    if (typeof state.subpath === "string" && state.subpath && this.file) {
      const cache = this.app.metadataCache.getFileCache(this.file);
      const r = cache ? resolveSubpath(cache, state.subpath) : null;
      if (r) {
        const pos = { line: r.start.line, ch: 0 };
        ed.setCursor(pos);
        ed.scrollIntoView({ from: pos, to: pos }, true);
      }
    }
    if (typeof state.scroll === "number") ed.scrollTo(null, state.scroll);
    if (state.focus) ed.focus();
  }
  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    this.app.workspace.trigger("quick-preview", file, this.data);
  }
  onunload(): void {
    this.cm.destroy();
    super.onunload();
  }
}
