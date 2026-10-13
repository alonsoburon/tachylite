// Core plugin "Page preview": hovering an internal link shows the target note in a floating popover.
//
// Two halves, as in the plugin API: surfaces *emit* the workspace event `hover-link` ({ event, source, hoverParent,
// targetEl, linktext, sourcePath, state }); this plugin *listens* and decides, per source, whether the Mod key is required
// (`.obsidian/page-preview.json` maps source id -> boolean). Our own surfaces (reading view, Live Preview, file explorer,
// search/backlinks, tab headers, properties, bases) emit through one delegated `mouseover` listener per document.
import { EditorView } from "@codemirror/view";
import {
  HoverPopover, Keymap, MarkdownEmbed, Platform, PopoverState, Setting, TFile, parseLinktext,
  type App, type HoverParent, type WorkspaceLeaf,
} from "../../obsidian";
import { editorInfoField } from "../../obsidian/editor";
import { CoreOptionsTab, coreOptions, whileCoreTab } from "./options";
import { whileCoreEnabled, type CoreModule } from "./util";

export const PAGE_PREVIEW = "page-preview";

export interface HoverLinkEvent {
  event: MouseEvent;
  source: string;
  hoverParent: HoverParent;
  targetEl: HTMLElement | null;
  linktext: string;
  sourcePath?: string;
  state?: Record<string, unknown>;
}

/** Sources our own surfaces emit, with whether they need the Mod key by default (reading view does not). */
export const BUILTIN_SOURCES: Record<string, { display: string; defaultMod: boolean }> = {
  preview: { display: "Reading view", defaultMod: false },
  editor: { display: "Editing view", defaultMod: true },
  "file-explorer": { display: "Files", defaultMod: true },
  search: { display: "Search, backlinks and outgoing links", defaultMod: true },
  "tab-header": { display: "Tab headers", defaultMod: true },
  graph: { display: "Graph view", defaultMod: true },
  properties: { display: "Properties", defaultMod: true },
  bases: { display: "Bases", defaultMod: true },
};

const modName = () => (Platform.isMacOS ? "Cmd" : "Ctrl");

/** Popover element -> what links inside it resolve against and which object owns their nested popovers. */
const popoverContext = new WeakMap<HTMLElement, { parent: HoverParent; sourcePath: string }>();
const fallbackParents = new WeakMap<object, HoverParent>();
function parentFor(key: object): HoverParent {
  let p = fallbackParents.get(key);
  if (!p) fallbackParents.set(key, (p = { hoverPopover: null }));
  return p;
}

/** The instance behind `app.internalPlugins.getPluginById("page-preview").instance` (a class, so plugins can patch its prototype). */
export class PagePreviewPlugin {
  id = PAGE_PREVIEW;
  name = "Page preview";
  options: Record<string, any> = {};
  /** Delay before a popover appears, in ms. */
  waitTime = 300;
  private seen = new WeakSet<Event>();
  private cancelPending: (() => void) | null = null;
  constructor(public app: App) {}

  /** Whether `source` requires the Mod key: the saved choice, else the source's declared default (unknown sources: yes). */
  requiresMod(source: string): boolean {
    if (Object.prototype.hasOwnProperty.call(this.options, source)) return !!this.options[source];
    const s = this.app.workspace.hoverLinkSources[source];
    return s ? !!s.defaultMod : true;
  }

  /** Handler of the workspace `hover-link` event. */
  onHoverLink(e: HoverLinkEvent): void {
    if (!e || !e.event || !e.hoverParent || typeof e.linktext !== "string") return;
    const { event, source, hoverParent, targetEl, linktext, sourcePath = "", state } = e;
    // One preview per pointer movement: a plugin emitting on its element wins over our delegated document listener.
    if (this.seen.has(event)) return;
    this.seen.add(event);
    this.cancelPending?.();
    if (this.requiresMod(source) && !Keymap.isModifier(event, "Mod")) {
      if (targetEl) this.waitForMod(hoverParent, targetEl, linktext, sourcePath, state);
      return;
    }
    void this.onLinkHover(hoverParent, targetEl, linktext, sourcePath, state);
  }

  /** The pointer rests on a link that needs Mod: pressing Mod before moving away (or clicking/typing) opens the preview. */
  private waitForMod(parent: HoverParent, targetEl: HTMLElement, linktext: string, sourcePath: string, state?: Record<string, unknown>): void {
    const doc = targetEl.ownerDocument;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (idle) clearTimeout(idle);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("mouseover", onOver, true);
      doc.removeEventListener("mousemove", onMove, true);
      doc.removeEventListener("mousedown", stop, true);
      if (this.cancelPending === stop) this.cancelPending = null;
    };
    const onKey = (k: KeyboardEvent) => {
      if (Keymap.isModifier(k, "Mod") && (k.key === "Control" || k.key === "Meta") && targetEl.isConnected) { stop(); void this.onLinkHover(parent, targetEl, linktext, sourcePath, state); }
      else if (k.key !== "Shift" && k.key !== "Alt") stop();
    };
    const onOver = (m: MouseEvent) => { const t = m.target as Node | null; if (!t || !(t === targetEl || targetEl.contains(t))) stop(); };
    const onMove = () => { if (idle) clearTimeout(idle); idle = setTimeout(stop, 2000); };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("mouseover", onOver, true);
    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("mousedown", stop, true);
    onMove();
    this.cancelPending = stop;
  }

  /** Show the preview of `linktext` for `parent` (no-op when that parent already previews the same element). */
  async onLinkHover(parent: HoverParent, targetEl: HTMLElement | null, linktext: string, sourcePath: string, _state?: Record<string, unknown>): Promise<HoverPopover | null> {
    const cur = parent.hoverPopover;
    if (cur && cur.state !== PopoverState.Hidden && targetEl && cur.targetEl === targetEl) return null;
    const { path, subpath } = parseLinktext(linktext.replace(/\|.*$/, ""));
    const file = path ? this.app.metadataCache.getFirstLinkpathDest(path, sourcePath) : this.app.vault.getFileByPath(sourcePath);
    if (!(file instanceof TFile)) return null;
    const creator = this.app.embedRegistry.getEmbedCreator(file);
    if (!creator) return null;
    const popover = new HoverPopover(parent, targetEl, this.waitTime);
    renderPreview(this.app, popover, file, subpath, linktext, sourcePath);
    return popover;
  }
}

/** Fill a popover with the rendered note (or heading/block section), or the file's own embed (image, canvas, base...). */
export function renderPreview(app: App, popover: HoverPopover, file: TFile, subpath: string, linktext: string, sourcePath: string): void {
  const el = popover.hoverEl;
  el.empty();
  const embedEl = el.createDiv({ cls: "markdown-embed is-loaded" });
  const contentEl = embedEl.createDiv({ cls: "markdown-embed-content" });
  let child: any;
  if (file.extension === "md") {
    el.addClass("is-loaded");
    const view = contentEl.createDiv({ cls: "markdown-preview-view markdown-rendered" });
    const sizer = view.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    child = new MarkdownEmbed({ app, containerEl: sizer, linktext, sourcePath, depth: 0 }, file, subpath);
  } else {
    const creator = app.embedRegistry.getEmbedCreator(file)!;
    child = creator({ app, containerEl: contentEl, linktext, sourcePath, depth: 0 }, file, subpath);
  }
  if (!("hoverPopover" in child)) child.hoverPopover = null;
  popoverContext.set(el, { parent: child as HoverParent, sourcePath: file.path });
  popover.addChild(child);
}

// ---------------------------------------------------------------- emitting hover-link from our surfaces

interface HoverHit { source: string; targetEl: HTMLElement; linktext: string; hoverParent: HoverParent; sourcePath: string }

function leafOf(app: App, el: HTMLElement): WorkspaceLeaf | null {
  const leafEl = el.closest(".workspace-leaf");
  if (!leafEl) return null;
  return app.workspace.allLeaves().find((l) => l.containerEl === leafEl) ?? null;
}

/** Owner (HoverParent) and source path for a link inside `el`: a popover, a leaf's view, or nothing. */
function contextOf(app: App, el: HTMLElement): { parent: HoverParent; sourcePath: string } {
  const pop = el.closest<HTMLElement>(".hover-popover");
  if (pop) return popoverContext.get(pop) ?? { parent: parentFor(pop), sourcePath: "" };
  const leaf = leafOf(app, el);
  if (!leaf) return { parent: parentFor(el.ownerDocument), sourcePath: "" };
  const view = leaf.view as any;
  const parent: HoverParent = view && "hoverPopover" in view ? view : leaf;
  let sourcePath: string = view?.file?.path ?? "";
  // Links inside an embedded note resolve from that note.
  const embed = el.closest<HTMLElement>(".markdown-embed[src]");
  if (embed) {
    const { path } = parseLinktext(embed.getAttribute("src") ?? "");
    const f = path ? app.metadataCache.getFirstLinkpathDest(path, sourcePath) : null;
    if (f) sourcePath = f.path;
  }
  return { parent, sourcePath };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Work out which link (if any) the pointer entered, and as which source. */
export function findHoverTarget(app: App, t: HTMLElement): HoverHit | null {
  // Live Preview / source editor links
  const cmLink = t.closest<HTMLElement>(".cm-hmd-internal-link[data-href], .cm-link[data-url]");
  const cmEditor = cmLink?.closest<HTMLElement>(".cm-editor");
  if (cmLink && cmEditor) {
    let linktext = cmLink.getAttribute("data-href");
    if (linktext === null) {
      const url = cmLink.getAttribute("data-url") ?? "";
      if (!url || SCHEME.test(url)) return null;
      try { linktext = decodeURI(url); } catch { linktext = url; }
    }
    const view = EditorView.findFromDOM(cmEditor);
    const info = view?.state.field(editorInfoField, false) as any;
    const ctx = contextOf(app, cmEditor);
    const parent: HoverParent = info && "hoverPopover" in info ? info : ctx.parent;
    return { source: "editor", targetEl: cmLink, linktext, hoverParent: parent, sourcePath: info?.file?.path ?? ctx.sourcePath };
  }
  // Rendered links (reading view, embeds, popovers, widgets)
  const a = t.closest<HTMLElement>("a.internal-link");
  if (a) {
    const linktext = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
    if (!linktext) return null;
    const ctx = contextOf(app, a);
    const source = a.closest(".metadata-container, .metadata-property") ? "properties"
      : a.closest(".bases-view, .bases-embed, [class^='bases-'], [class*=' bases-']") ? "bases"
      : a.closest(".markdown-source-view") && !a.closest(".hover-popover") ? "editor" : "preview";
    return { source, targetEl: a, linktext, hoverParent: ctx.parent, sourcePath: ctx.sourcePath };
  }
  // File explorer
  const nav = t.closest<HTMLElement>(".nav-file-title[data-path]");
  if (nav) {
    const ctx = contextOf(app, nav);
    return { source: "file-explorer", targetEl: nav, linktext: nav.getAttribute("data-path")!, hoverParent: ctx.parent, sourcePath: "" };
  }
  // Search, backlinks and outgoing links: the file title rows
  const row = t.closest<HTMLElement>(".search-result-file-title, .tree-item-self[data-path]");
  if (row && !row.classList.contains("is-unresolved") && !row.classList.contains("nav-folder-title")) {
    const path = row.getAttribute("data-path") ?? row.closest<HTMLElement>("[data-path]")?.getAttribute("data-path");
    if (path && app.vault.getFileByPath(path)) {
      const ctx = contextOf(app, row);
      return { source: "search", targetEl: row, linktext: path, hoverParent: ctx.parent, sourcePath: "" };
    }
  }
  // Tab headers
  const tab = t.closest<HTMLElement>(".workspace-tab-header");
  if (tab) {
    const leaf = app.workspace.allLeaves().find((l) => l.tabHeaderEl === tab);
    const file = (leaf?.view as any)?.file as TFile | undefined;
    if (leaf && file) return { source: "tab-header", targetEl: tab, linktext: file.path, hoverParent: leaf, sourcePath: "" };
  }
  return null;
}

/** Install the delegated emitter on a document; returns its remover. */
export function installHoverLinkEmitter(app: App, doc: Document): () => void {
  const onOver = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t || typeof t.closest !== "function") return;
    const hit = findHoverTarget(app, t);
    if (!hit) return;
    // Only when entering the link, not when moving between its children.
    const rel = e.relatedTarget as Node | null;
    if (rel && (rel === hit.targetEl || hit.targetEl.contains(rel))) return;
    app.workspace.trigger("hover-link", { event: e, source: hit.source, hoverParent: hit.hoverParent, targetEl: hit.targetEl, linktext: hit.linktext, sourcePath: hit.sourcePath });
  };
  doc.addEventListener("mouseover", onOver);
  return () => doc.removeEventListener("mouseover", onOver);
}

// ---------------------------------------------------------------- settings

class PagePreviewTab extends CoreOptionsTab {
  constructor(app: App) { super(app, PAGE_PREVIEW, "Page preview", "lucide-scan-eye"); }
  render(el: HTMLElement): void {
    const o = this.options;
    el.createEl("p", { cls: "setting-item-description", text: `Choose where hovering a link needs ${modName()} held down to show a preview.` });
    const sources = this.app.workspace.hoverLinkSources;
    for (const [id, info] of Object.entries(sources)) {
      const value = Object.prototype.hasOwnProperty.call(o, id) ? !!o[id] : !!info.defaultMod;
      new Setting(el).setName(info.display || id).setDesc(`Require ${modName()} to preview`).addToggle((t) =>
        t.setValue(value).onChange((v) => { o[id] = v; void this.save(); }));
    }
  }
}

export const pagePreview: CoreModule = {
  id: PAGE_PREVIEW,
  install(app) {
    // The plugin object other plugins reach through app.internalPlugins (Hover Editor patches its prototype).
    const wrapper = app.internalPlugins.getPluginById(PAGE_PREVIEW);
    const plugin = new PagePreviewPlugin(app);
    if (wrapper) {
      plugin.options = coreOptions(app, PAGE_PREVIEW);
      wrapper.instance = plugin as any;
    }
    for (const [id, info] of Object.entries(BUILTIN_SOURCES)) app.workspace.registerHoverLinkSource(id, info);
    const tab = new PagePreviewTab(app);
    const rerender = app.workspace.on("hover-link-sources-changed", () => { if (app.setting.activeTab === tab) tab.display(); });
    const offTab = whileCoreTab(app, tab);
    // Emitters run whether or not the plugin is on (plugins may listen to hover-link themselves).
    const emitters = new Map<Document, () => void>([[document, installHoverLinkEmitter(app, document)]]);
    const onWin = app.workspace.on("window-open", (win: any) => { const d: Document | undefined = win?.doc; if (d && !emitters.has(d)) emitters.set(d, installHoverLinkEmitter(app, d)); });
    const onWinClose = app.workspace.on("window-close", (win: any) => { const d: Document | undefined = win?.doc; if (d && d !== document) { emitters.get(d)?.(); emitters.delete(d); } });
    const off = whileCoreEnabled(app, PAGE_PREVIEW, () => {
      const ref = app.workspace.on("hover-link", (e: HoverLinkEvent) => (wrapper?.instance as any as PagePreviewPlugin ?? plugin).onHoverLink(e));
      return () => { app.workspace.offref(ref); for (const p of HoverPopover.getActive()) p.hide(); };
    });
    return () => {
      off(); offTab();
      app.workspace.offref(rerender); app.workspace.offref(onWin); app.workspace.offref(onWinClose);
      for (const r of emitters.values()) r();
      for (const id of Object.keys(BUILTIN_SOURCES)) app.workspace.unregisterHoverLinkSource(id);
    };
  },
};
