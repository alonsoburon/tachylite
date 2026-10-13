// The markdown view as users see it: header (nav, breadcrumb, mode toggle, menu), inline title,
// Live Preview / Source / Reading modes. Subclasses the model's MarkdownView so plugins' instanceof checks hold.
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type Extension } from "@codemirror/state";
import { Menu, MarkdownView, Notice, type App, type WorkspaceLeaf } from "../obsidian";
import { editorInfoField, setLivePreview } from "../obsidian/editor";
import { setIcon } from "../obsidian/icons";
import { editorHandles } from "./bridge";
import { buildFileMenu, renameTo } from "./files";

function titleEl(view: TachyMarkdownView): HTMLElement {
  const el = createDiv({ cls: "inline-title", attr: { contenteditable: "true", spellcheck: "false", "data-placeholder": "Untitled" } });
  el.textContent = view.file?.basename ?? "";
  const commit = async () => {
    const f = view.file;
    if (!f) return;
    const name = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!name || name === f.basename) { el.textContent = f.basename; return; }
    try { await renameTo(view.app, f, name); }
    catch (e) { new Notice((e as Error).message); el.textContent = f.basename; }
  };
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); el.blur(); view.editor.focus(); }
    else if (e.key === "Escape") { el.textContent = view.file?.basename ?? ""; el.blur(); }
  });
  el.addEventListener("blur", () => { void commit(); });
  el.addEventListener("paste", (e) => { e.preventDefault(); el.ownerDocument.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") ?? "").replace(/\n/g, " ")); });
  return el;
}

class InlineTitleWidget extends WidgetType {
  eq(): boolean { return true; }
  toDOM(cm: EditorView): HTMLElement {
    // Embedded editors (canvas cards, note embeds) share the workspace extensions but have no inline title.
    const view = cm.state.field(editorInfoField, false) as TachyMarkdownView | null | undefined;
    if (!(view instanceof TachyMarkdownView)) return createDiv();
    const el = titleEl(view);
    (view.inlineTitleEls ??= new Set()).add(el);
    return el;
  }
  ignoreEvent(): boolean { return true; }
}

/** Editor extension rendering the inline title as a block widget above the document. */
export function inlineTitleExtension(): Extension {
  return StateField.define({
    create: () => Decoration.set([Decoration.widget({ widget: new InlineTitleWidget(), block: true, side: -1 }).range(0)]),
    update: (v) => v,
    provide: (f) => EditorView.decorations.from(f),
  });
}

export class TachyMarkdownView extends MarkdownView {
  /** Created lazily: the editor (and its title widget) is built inside the base-class constructor. */
  declare inlineTitleEls: Set<HTMLElement>;
  titleParentEl: HTMLElement;
  modeActionEl: HTMLElement;
  backEl: HTMLElement;
  forwardEl: HTMLElement;
  private modeInitialised = false;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.editMode.sourceMode = this.app.vault.getConfig("livePreview") === false;
    this.sourceEl.toggleClass("is-live-preview", !this.editMode.sourceMode);
    this.cm.dispatch({ effects: setLivePreview.of(!this.editMode.sourceMode) });
    const left = this.headerEl.querySelector<HTMLElement>(".view-header-left")!;
    const nav = left.createDiv({ cls: "view-header-nav-buttons" });
    this.backEl = nav.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Navigate back" } });
    this.forwardEl = nav.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Navigate forward" } });
    setIcon(this.backEl, "lucide-arrow-left");
    setIcon(this.forwardEl, "lucide-arrow-right");
    this.backEl.addEventListener("click", () => { this.app.commands.executeCommandById("app:go-back"); });
    this.forwardEl.addEventListener("click", () => { this.app.commands.executeCommandById("app:go-forward"); });
    this.titleParentEl = this.titleContainerEl.createDiv({ cls: "view-header-title-parent" });
    this.titleContainerEl.insertBefore(this.titleParentEl, this.titleEl);
    this.addAction("lucide-more-vertical", "More options", (e) => this.showMoreMenu(e));
    this.modeActionEl = this.addAction("lucide-book-open", "Current view: editing", () => this.toggleReading());
    this.updateModeAction();
  }

  getIcon(): string { return "lucide-file"; }

  // ---- modes
  get isSourceMode(): boolean { return this.editMode.sourceMode; }
  setSourceMode(source: boolean): void {
    this.editMode.sourceMode = source;
    editorHandles.get(this.cm)?.setMode(source ? "source" : "live-preview");
    this.cm.dispatch({ effects: setLivePreview.of(!source) });
    this.sourceEl.toggleClass("is-live-preview", !source);
    this.updateModeAction();
    this.app.workspace.trigger("layout-change");
  }
  toggleSource(): void { this.setSourceMode(!this.editMode.sourceMode); }
  toggleReading(): void { this.setMode(this.getMode() === "preview" ? "source" : "preview"); }
  setMode(mode: "source" | "preview"): void {
    super.setMode(mode);
    this.updateModeAction();
    this.app.workspace.trigger("layout-change");
    if (mode === "source" && this.leaf === this.app.workspace.activeLeaf) setTimeout(() => this.editor.focus(), 0);
  }
  private updateModeAction(): void {
    const reading = this.getMode() === "preview";
    if (!this.modeActionEl) return;
    setIcon(this.modeActionEl, reading ? "lucide-edit-3" : "lucide-book-open");
    this.modeActionEl.setAttribute("aria-label", reading ? "Current view: reading\nClick to edit" : `Current view: ${this.editMode.sourceMode ? "source" : "live preview"}\nClick to read`);
  }

  getState(): Record<string, unknown> { return { ...super.getState(), source: this.editMode.sourceMode }; }
  async setState(state: any, result: { history: boolean }): Promise<void> {
    if (typeof state?.source === "boolean") this.setSourceMode(state.source);
    if (!this.modeInitialised) {
      this.modeInitialised = true;
      if (state?.mode === undefined && this.app.vault.getConfig("defaultViewMode") === "preview") this.setMode("preview");
    }
    await super.setState(state, result);
    this.updateModeAction();
  }
  async onLoadFile(file: any): Promise<void> {
    editorHandles.get(this.cm)?.setSourcePath(file.path);
    await super.onLoadFile(file);
    // A fresh note opens with the caret after the properties block so Live Preview shows them as a table, not raw YAML.
    const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(this.data);
    if (fm && !this.editMode.sourceMode && this.cm.state.selection.main.head < fm[0].length) {
      this.cm.dispatch({ selection: { anchor: Math.min(fm[0].length, this.cm.state.doc.length) } });
    }
  }
  async onRename(file: any): Promise<void> { editorHandles.get(this.cm)?.setSourcePath(file.path); }

  // ---- header
  updateHeader(): void {
    const f = this.file;
    this.titleEl.setText(f ? f.basename : "No file");
    const parent = f?.parent && !f.parent.isRoot() ? f.parent.path : "";
    this.titleParentEl.setText(parent ? parent + " /" : "");
    this.titleParentEl.toggle(!!parent);
    const els = (this.inlineTitleEls ??= new Set());
    for (const el of [...els]) if (!el.isConnected) els.delete(el);
    for (const el of els) if (el.isConnected && el.ownerDocument.activeElement !== el) el.textContent = f?.basename ?? "";
    this.updateModeAction();
  }
  setNavState(canBack: boolean, canForward: boolean): void {
    this.backEl.toggleClass("is-disabled", !canBack);
    this.forwardEl.toggleClass("is-disabled", !canForward);
  }

  /** Called by the preview renderer before rendering: adds the inline title at the top of the page. */
  decoratePreview(sizer: HTMLElement): void {
    const el = titleEl(this);
    (this.inlineTitleEls ??= new Set()).add(el);
    sizer.appendChild(el);
  }

  focusInlineTitle(): void {
    const els = [...(this.inlineTitleEls ??= new Set())].filter((e) => e.isConnected);
    const el = this.getMode() === "preview" ? els.find((e) => this.previewEl.contains(e)) : els.find((e) => this.sourceEl.contains(e));
    if (!el) return;
    el.focus();
    const sel = el.ownerDocument.getSelection();
    if (sel) { const r = el.ownerDocument.createRange(); r.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(r); }
  }

  private showMoreMenu(evt: MouseEvent): void {
    const menu = new Menu();
    const reading = this.getMode() === "preview";
    menu.addItem((i) => i.setSection("view").setTitle(reading ? "Editing view" : "Reading view").setIcon(reading ? "lucide-edit-3" : "lucide-book-open").onClick(() => this.toggleReading()));
    if (!reading) menu.addItem((i) => i.setSection("view").setTitle("Source mode").setIcon("lucide-code-2").setChecked(this.editMode.sourceMode).onClick(() => this.toggleSource()));
    menu.addItem((i) => i.setSection("pane").setTitle("Split right").setIcon("lucide-separator-vertical").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "vertical"); }));
    menu.addItem((i) => i.setSection("pane").setTitle("Split down").setIcon("lucide-separator-horizontal").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "horizontal"); }));
    menu.addItem((i) => i.setSection("pane").setTitle(this.leaf.pinned ? "Unpin" : "Pin").setIcon("lucide-pin").onClick(() => this.leaf.togglePinned()));
    if (this.file) buildFileMenu(this.app, this.file, "more-options", menu);
    this.onPaneMenu(menu, "more-options");
    menu.showAtMouseEvent(evt);
  }
}

export function installMarkdownView(app: App): () => void {
  const prev = app.viewRegistry.viewByType["markdown"];
  app.viewRegistry.viewByType["markdown"] = (leaf) => new TachyMarkdownView(leaf);
  const ext = inlineTitleExtension();
  app.workspace.editorExtensions.push(ext);
  return () => {
    if (prev) app.viewRegistry.viewByType["markdown"] = prev;
    const i = app.workspace.editorExtensions.indexOf(ext);
    if (i >= 0) app.workspace.editorExtensions.splice(i, 1);
  };
}
