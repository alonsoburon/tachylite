// The "bases" view for `.base` files, the `![[x.base]]` embed and the ```base code block.
import { EmbedBase, type EmbedContext } from "../obsidian/embeds";
import type { TFile } from "../obsidian/files";
import { MarkdownRenderChild, type MarkdownPostProcessorContext } from "../obsidian/markdown";
import { TextFileView } from "../obsidian/views";
import type { WorkspaceLeaf } from "../obsidian/workspace";
import { BasesController } from "./host";

export const BASES_VIEW_TYPE = "bases";

export class BasesFileView extends TextFileView {
  controller: BasesController | null = null;
  private sourceMode = false;
  private pendingView: string | null = null;
  private sourceEl: HTMLTextAreaElement | null = null;
  private sourceAction: HTMLElement;
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.icon = "lucide-table";
    this.contentEl.addClass("bases-file-view");
    this.sourceAction = this.addAction("lucide-code-xml", "Edit source", () => this.toggleSource());
  }
  getViewType(): string { return BASES_VIEW_TYPE; }
  getIcon(): string { return "lucide-table"; }
  canAcceptExtension(ext: string): boolean { return ext === "base"; }
  getViewData(): string { return this.sourceMode && this.sourceEl ? this.sourceEl.value : this.data; }
  setViewData(data: string, _clear: boolean): void {
    this.data = data;
    if (this.sourceMode && this.sourceEl) { this.sourceEl.value = data; return; }
    if (this.controller) { this.controller.setSource(data); return; }
    this.mount(data);
  }
  clear(): void {
    if (this.controller) this.removeChild(this.controller);
    this.controller = null;
    this.contentEl.empty();
  }
  private mount(data: string): void {
    this.clear();
    this.controller = new BasesController(this.app, this.contentEl, {
      source: data,
      thisFile: this.file,
      save: (text) => { this.data = text; this.markDirty(); },
      viewName: this.pendingView,
    });
    this.addChild(this.controller);
  }
  getState(): Record<string, unknown> {
    const s = super.getState();
    const v = this.controller?.currentRaw()?.name;
    return v ? { ...s, viewName: v } : s;
  }
  async setState(state: any, result: { history: boolean }): Promise<void> {
    this.pendingView = typeof state?.viewName === "string" ? state.viewName : null;
    await super.setState(state, result);
    const name = this.pendingView;
    if (name && this.controller?.config) this.controller.selectView(this.controller.config.viewIndex(name));
  }
  /** Toggle between the rendered base and its raw YAML. */
  toggleSource(): void {
    if (!this.sourceMode) {
      this.sourceMode = true;
      this.clear();
      this.sourceAction.addClass("is-active");
      const ta = (this.sourceEl = this.contentEl.createEl("textarea", { cls: "bases-source-editor", attr: { spellcheck: "false" } }));
      ta.value = this.data;
      ta.addEventListener("input", () => this.markDirty());
      ta.focus();
    } else {
      const text = this.sourceEl?.value ?? this.data;
      this.sourceMode = false;
      this.sourceEl = null;
      this.sourceAction.removeClass("is-active");
      if (text !== this.data) { this.data = text; this.markDirty(); }
      this.mount(text);
    }
  }
}

/** `![[x.base]]` / `![[x.base#View]]`: `this` is the embedding file; UI changes are written back to the base file. */
export class BaseEmbed extends EmbedBase {
  controller: BasesController | null = null;
  constructor(ctx: EmbedContext, file: TFile | null, subpath: string) { super(ctx, file, subpath); }
  async loadFile(): Promise<void> {
    const f = this.file;
    if (!f) return;
    const text = await this.app.vault.cachedRead(f);
    if (this.controller) { this.controller.setSource(text); return; }
    this.containerEl.addClass("bases-embed");
    const thisFile = (this.ctx.sourcePath ? this.app.vault.getFileByPath(this.ctx.sourcePath) : null) ?? f;
    this.controller = new BasesController(this.app, this.containerEl, {
      source: text, thisFile, baseFile: f, embedded: true,
      viewName: this.subpath.replace(/^#/, "") || null,
      save: (yaml) => this.app.vault.modify(f, yaml),
    });
    this.addChild(this.controller);
  }
  onunload(): void { this.controller = null; }
}

/** ```base code block: an inline base whose `this` is the containing note; toolbar edits stay in memory. */
export function renderBaseCodeBlock(app: any, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
  el.addClass("bases-embed");
  const thisFile = ctx.sourcePath ? app.vault.getFileByPath(ctx.sourcePath) : null;
  const child = new MarkdownRenderChild(el);
  const controller = new BasesController(app, el, { source, thisFile, embedded: true });
  child.addChild(controller);
  ctx.addChild(child);
  if (!child._loaded) child.load(); // the reading view's render component is not itself loaded
}
