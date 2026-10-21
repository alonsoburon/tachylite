// The markdown view as users see it: header (nav, breadcrumb, mode toggle, menu), inline title,
// Live Preview / Source / Reading modes. Subclasses the model's MarkdownView so plugins' instanceof checks hold.
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { StateField, type Extension } from "@codemirror/state";
import { FRONTMATTER_RE, Menu, MarkdownView, Notice, type App, type WorkspaceLeaf } from "../obsidian";
import { editorInfoField, setLivePreview } from "../obsidian/editor";
import { setIcon } from "../obsidian/icons";
import { editorHandles, openExternal } from "./bridge";
import { buildFileMenu, copyText, renameTo } from "./files";
import { metadataEditorIn } from "./properties/embed";
import { addBacklinksMenuItem, applyBacklinksState, backlinksState, placeBacklinks } from "./linked/backlinksInDocument";

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
    this.registerDomEvent(this.sourceEl, "contextmenu", (e: MouseEvent) => this.showEditorMenu(e));
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
  /** The Properties table of the visible mode (Live Preview or reading view), if shown. */
  get metadataEditor() { return metadataEditorIn(this.contentEl); }

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
    placeBacklinks(this);
    this.app.workspace.trigger("layout-change");
    if (mode === "source" && this.leaf === this.app.workspace.activeLeaf) setTimeout(() => this.editor.focus(), 0);
  }
  /** The editor's right-click menu: clipboard, formatting, paragraph and insert actions, then whatever plugins add on `editor-menu`. */
  private showEditorMenu(e: MouseEvent): void {
    const target = e.target as HTMLElement | null;
    // The properties table, inline title, embedded widgets and tables keep their own handling.
    if (!target?.closest(".cm-content") || target.closest(".metadata-container, .inline-title, .cm-embed-block, .cm-table-widget, input, textarea")) return;
    e.preventDefault();
    const app = this.app, ed = this.editor, menu = new Menu();
    const run = (id: string) => () => { ed.focus(); app.commands.executeCommandById(id); };
    const link = target.closest<HTMLElement>(".cm-hmd-internal-link[data-href]");
    if (link && this.file) {
      app.workspace.handleLinkContextMenu(menu, link.getAttribute("data-href") ?? "", this.file.path, this.leaf);
      menu.addSeparator();
    }
    const ext = target.closest<HTMLElement>(".cm-link[data-url]");
    if (ext) {
      const url = ext.getAttribute("data-url") ?? "";
      menu.addItem((i) => i.setSection("url").setTitle("Open link").setIcon("lucide-external-link").onClick(() => openExternal(url, app)));
      menu.addItem((i) => i.setSection("url").setTitle("Copy URL").setIcon("lucide-copy").onClick(() => copyText(url)));
      app.workspace.trigger("url-menu", menu, url);
      menu.addSeparator();
    }
    const hasSel = ed.somethingSelected();
    // Entries and their order are those of Obsidian 1.14.4 (compat/obsidian-reference.json).
    menu.addItem((i) => i.setSection("link").setTitle("Add link").setIcon("lucide-link").onClick(run("editor:insert-wikilink")));
    menu.addItem((i) => i.setSection("link").setTitle("Add external link").setIcon("lucide-link-2").onClick(run("editor:insert-link")));
    const sub = (title: string, icon: string, items: [string, string][]) => menu.addItem((i) => {
      i.setSection("format").setTitle(title).setIcon(icon);
      const m = i.setSubmenu();
      for (const [name, id] of items) m.addItem((j) => j.setTitle(name).onClick(run(id)));
    });
    sub("Format", "lucide-bold", [["Bold", "editor:toggle-bold"], ["Italic", "editor:toggle-italics"], ["Strikethrough", "editor:toggle-strikethrough"], ["Highlight", "editor:toggle-highlight"], ["Code", "editor:toggle-code"]]);
    sub("Paragraph", "lucide-pilcrow", [
      ["Bullet list", "editor:toggle-bullet-list"], ["Numbered list", "editor:toggle-numbered-list"], ["Task list", "editor:toggle-checklist-status"], ["Quote", "editor:toggle-blockquote"],
      ...[1, 2, 3, 4, 5, 6].map((n): [string, string] => [`Heading ${n}`, `editor:set-heading-${n}`]), ["Remove heading", "editor:set-heading-0"],
    ]);
    sub("Insert", "lucide-plus", [["Callout", "editor:insert-callout"], ["Code block", "editor:insert-codeblock"], ["Horizontal rule", "editor:insert-horizontal-rule"], ["Table", "editor:insert-table"], ["Math block", "editor:insert-mathblock"], ["Embed", "editor:insert-embed"], ["Tag", "editor:insert-tag"]]);
    menu.addItem((i) => i.setSection("clipboard").setTitle("Cut").setIcon("lucide-scissors").setDisabled(!hasSel).onClick(() => { ed.focus(); document.execCommand("cut"); }));
    menu.addItem((i) => i.setSection("clipboard").setTitle("Copy").setIcon("lucide-copy").setDisabled(!hasSel).onClick(() => { ed.focus(); document.execCommand("copy"); }));
    const pastePlain = () => {
      navigator.clipboard?.readText().then((t) => { if (t) { ed.focus(); ed.replaceSelection(t); } }).catch(() => new Notice("Paste is not available here; use the keyboard shortcut."));
    };
    menu.addItem((i) => i.setSection("clipboard").setTitle("Paste").setIcon("lucide-clipboard-paste").onClick(pastePlain));
    menu.addItem((i) => i.setSection("clipboard").setTitle("Paste as plain text").setIcon("lucide-clipboard-type").onClick(pastePlain));
    menu.addItem((i) => i.setSection("clipboard").setTitle("Select all").setIcon("lucide-text-select").onClick(() => { ed.focus(); ed.setSelection({ line: 0, ch: 0 }, { line: ed.lastLine(), ch: ed.getLine(ed.lastLine()).length }); }));
    app.workspace.trigger("editor-menu", menu, ed, this);
    menu.showAtMouseEvent(e);
  }

  private updateModeAction(): void {
    const reading = this.getMode() === "preview";
    if (!this.modeActionEl) return;
    setIcon(this.modeActionEl, reading ? "lucide-edit-3" : "lucide-book-open");
    this.modeActionEl.setAttribute("aria-label", reading ? "Current view: reading\nClick to edit" : `Current view: ${this.editMode.sourceMode ? "source" : "live preview"}\nClick to read`);
  }

  getState(): Record<string, unknown> { return { ...super.getState(), source: this.editMode.sourceMode, ...backlinksState(this) }; }
  async setState(state: any, result: { history: boolean }): Promise<void> {
    if (typeof state?.source === "boolean") this.setSourceMode(state.source);
    if (!this.modeInitialised) {
      this.modeInitialised = true;
      if (state?.mode === undefined && this.app.vault.getConfig("defaultViewMode") === "preview") this.setMode("preview");
    }
    await super.setState(state, result);
    applyBacklinksState(this, state);
    this.updateModeAction();
  }
  async onLoadFile(file: any): Promise<void> {
    editorHandles.get(this.cm)?.setSourcePath(file.path);
    await super.onLoadFile(file);
    placeBacklinks(this);
    // A fresh note opens with the caret after the properties block so Live Preview shows them as a table, not raw YAML.
    const fm = FRONTMATTER_RE.exec(this.data);
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
    queueMicrotask(() => { void this.previewMode.whenRendered().then(() => placeBacklinks(this)); });
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
    // Entries and order follow Obsidian 1.14.4's menu (compat/obsidian-reference.json); the file entries come from buildFileMenu.
    this.addModeItems(menu);
    menu.addItem((i) => i.setSection("pane").setTitle("Split right").setIcon("lucide-separator-vertical").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "vertical"); }));
    menu.addItem((i) => i.setSection("pane").setTitle("Split down").setIcon("lucide-separator-horizontal").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "split", "horizontal"); }));
    menu.addItem((i) => i.setSection("pane").setTitle("Open in new window").setIcon("lucide-app-window").onClick(() => { void this.app.workspace.duplicateLeaf(this.leaf, "window"); }));
    void reading;
    if (this.file) buildFileMenu(this.app, this.file, "more-options", menu);
    this.onPaneMenu(menu, "more-options");
    menu.showAtMouseEvent(evt);
  }

  /** "Reading view" (or "Editing view") and "Source mode" entries, shared by the tab header and More options menus. */
  addModeItems(menu: Menu): void {
    const reading = this.getMode() === "preview";
    addBacklinksMenuItem(menu, this);
    menu.addItem((i) => i.setSection("view").setTitle(reading ? "Editing view" : "Reading view").setIcon(reading ? "lucide-edit-3" : "lucide-book-open").onClick(() => this.toggleReading()));
    if (!reading) menu.addItem((i) => i.setSection("view").setTitle("Source mode").setIcon("lucide-code-2").setChecked(this.editMode.sourceMode).onClick(() => this.toggleSource()));
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
