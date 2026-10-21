// "Backlinks in document": the backlinks panel at the bottom of a note, in editing and reading view.
// Per-note state lives in the view state (`backlinks`, `backlinkOpts`), like Obsidian; it is off by default.
import { Component, type App, type Menu, type MarkdownView } from "../../obsidian";
import { BacklinksView } from "../core/links";
import { coreEnabled } from "../core/util";

export const BACKLINKS_COMMAND = "backlink:toggle-backlinks-in-document";

interface Slot { on: boolean | undefined; opts: Record<string, unknown> | null; embed: Embedded | null }
const slots = new WeakMap<MarkdownView, Slot>();
const slotOf = (v: MarkdownView): Slot => { let s = slots.get(v); if (!s) slots.set(v, (s = { on: undefined, opts: null, embed: null })); return s; };

class Embedded extends Component {
  el: HTMLElement;
  bl: BacklinksView;
  constructor(private view: MarkdownView, opts: Record<string, unknown> | null) {
    super();
    this.el = createDiv({ cls: "embedded-backlinks" });
    this.bl = new BacklinksView(view.leaf);
    this.bl.contentEl = this.el;
    this.bl.fileSource = () => view.file;
    this.addChild(this.bl);
    if (opts) void this.bl.setState(opts);
    this.place();
    void this.bl._open().then(() => this.place());
  }
  /** Put the panel at the end of the current mode's page. */
  place(): void {
    const v = this.view;
    if (v.getMode() === "preview") {
      const sizer = v.previewEl.querySelector<HTMLElement>(".markdown-preview-sizer");
      if (!sizer) return;
      const footer = sizer.querySelector<HTMLElement>(":scope > .mod-footer") ?? sizer.createDiv({ cls: "mod-footer mod-ui" });
      footer.appendChild(this.el);
    } else {
      v.cm.dom.querySelector(".cm-scroller")?.appendChild(this.el);
    }
  }
  onunload(): void { this.el.detach(); }
}

export function backlinksEnabled(view: MarkdownView): boolean { return !!slotOf(view).on; }

export function setBacklinksInDocument(view: MarkdownView, on: boolean): void {
  const s = slotOf(view);
  if (s.on === on && !!s.embed === on) return;
  s.on = on;
  if (on && !s.embed) { s.embed = new Embedded(view, s.opts); view.addChild(s.embed); }
  if (!on && s.embed) { s.opts = null; view.removeChild(s.embed); s.embed = null; }
  view.app.workspace.requestSaveLayout();
}

export function toggleBacklinksInDocument(view: MarkdownView): void { setBacklinksInDocument(view, !backlinksEnabled(view)); }

/** Entries to merge into the view's getState(). */
export function backlinksState(view: MarkdownView): Record<string, unknown> {
  const s = slotOf(view);
  if (s.on === undefined) return {};
  if (!s.on) return { backlinks: false };
  const b = s.embed?.bl.getState() ?? s.opts ?? {};
  return { backlinks: true, backlinkOpts: { collapseAll: false, extraContext: false, sortOrder: "alphabetical", showSearch: false, searchQuery: "", backlinkCollapsed: false, ...b } };
}

/** Called from the view's setState. */
export function applyBacklinksState(view: MarkdownView, state: any): void {
  if (typeof state?.backlinks !== "boolean") return;
  const s = slotOf(view);
  if (state.backlinkOpts && typeof state.backlinkOpts === "object") s.opts = state.backlinkOpts;
  setBacklinksInDocument(view, state.backlinks);
}

/** Re-attach after the view re-rendered or changed mode, and follow the view's file. */
export function placeBacklinks(view: MarkdownView): void {
  const e = slots.get(view)?.embed;
  if (!e) return;
  e.place();
  e.bl.syncFile();
}

/** The "Backlinks in document" menu entry (tab header and More options menus). */
export function addBacklinksMenuItem(menu: Menu, view: MarkdownView): void {
  menu.addItem((i) => i.setSection("pane").setTitle("Backlinks in document").setIcon("lucide-links-coming-in").setChecked(backlinksEnabled(view)).onClick(() => toggleBacklinksInDocument(view)));
}

export function installBacklinksCommand(app: App, MarkdownViewClass: typeof MarkdownView): () => void {
  const cmd = { id: BACKLINKS_COMMAND, name: "Backlinks: Toggle backlinks in document", checkCallback: (checking: boolean) => {
    const v = app.workspace.getActiveViewOfType(MarkdownViewClass);
    if (!v || !coreEnabled(app, "backlink")) return false;
    if (!checking) toggleBacklinksInDocument(v);
    return true;
  } };
  app.commands.addCommand(cmd);
  return () => app.commands.removeCommand(cmd.id);
}
