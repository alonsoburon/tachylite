// Backlinks and outgoing-links core views, built on metadataCache + vault.
import { Keymap, TFile, getFrontMatterInfo, type App, type WorkspaceLeaf } from "../../obsidian";
import { buildFileMenu } from "../files";
import { activateView, addCommand, openFile, whileCoreEnabled, type CoreModule } from "./util";
import { collapseIcon, fileLabel, FollowView, highlightText, naturalCompare, navButton, navHeader } from "./panel";

export const BACKLINK_VIEW = "backlink";
export const OUTGOING_VIEW = "outgoing-link";
const MAX_UNLINKED_FILES = 60;
const LINE_MAX = 200;

export interface Mention { line: number; start: number; end: number }

/** Plain-text occurrences of `names` in `text` that are not inside a wikilink or markdown link. */
export function findUnlinkedMentions(text: string, names: string[]): Mention[] {
  const wanted = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return [];
  const out: Mention[] = [];
  const lines = text.split("\n");
  let inFence = false;
  lines.forEach((raw, line) => {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; return; }
    if (inFence) return;
    // Blank out existing links so their text can't match.
    const masked = raw.replace(/\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)/g, (m) => " ".repeat(m.length)).toLowerCase();
    for (const n of wanted) {
      let i = 0;
      while ((i = masked.indexOf(n, i)) >= 0) {
        const before = masked[i - 1], after = masked[i + n.length];
        const word = /[\p{L}\p{N}_]/u;
        if (!(before && word.test(before)) && !(after && word.test(after))) out.push({ line, start: i, end: i + n.length });
        i += n.length;
      }
    }
  });
  return out;
}

function clip(text: string, at: number): { text: string; shift: number } {
  const t = text.replace(/^\s+/, "");
  const lead = text.length - t.length;
  if (t.length <= LINE_MAX) return { text: t, shift: lead };
  const start = Math.max(0, at - lead - 50);
  return { text: (start ? "…" : "") + t.slice(start, start + LINE_MAX) + "…", shift: lead + start - (start ? 1 : 0) };
}

/**
 * Turn the plain-text mention at `m` in `source` into a link to `target` (an alias link when the text differs from the
 * note name). Edits the open editor when there is one, so unsaved changes are kept; returns false if the text moved.
 */
export async function linkMention(app: App, source: TFile, m: Mention, target: TFile, expected?: string): Promise<boolean> {
  const make = (text: string) => app.fileManager.generateMarkdownLink(target, source.path, undefined, text === target.basename ? undefined : text);
  /** The mention's range in `line`: `m` when it still holds the expected text, else the first unlinked occurrence. */
  const locate = (line: string): [number, number] | null => {
    const text = line.slice(m.start, m.end);
    if (text && (!expected || text.toLowerCase() === expected.toLowerCase())) return [m.start, m.end];
    const alt = expected ? findUnlinkedMentions(line, [expected])[0] : undefined;
    return alt ? [alt.start, alt.end] : null;
  };
  const view = app.workspace.getLeavesOfType("markdown").map((l) => l.view as any).find((v) => v?.file?.path === source.path && v.editor);
  if (view) {
    const line: string = view.editor.getLine(m.line) ?? "";
    const r = locate(line);
    if (!r) return false;
    view.editor.replaceRange(make(line.slice(r[0], r[1])), { line: m.line, ch: r[0] }, { line: m.line, ch: r[1] });
    await view.save?.();
    return true;
  }
  let ok = false;
  await app.vault.process(source, (data) => {
    const lines = data.split("\n"), line = lines[m.line] ?? "", r = locate(line);
    if (!r) return data;
    lines[m.line] = line.slice(0, r[0]) + make(line.slice(r[0], r[1])) + line.slice(r[1]);
    ok = true;
    return lines.join("\n");
  });
  return ok;
}

/** "Link" button shown on hover of an unlinked mention row. */
function linkButton(row: HTMLElement, onClick: () => Promise<boolean>): void {
  const b = row.createEl("button", { cls: "search-result-file-match-replace-button", text: "Link", attr: { "aria-label": "Link this mention" } });
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    b.disabled = true;
    if (!(await onClick())) b.disabled = false;
  });
}

// ===================================================================== backlinks
interface Row { line: number; ranges: [number, number][] }

export class BacklinksView extends FollowView {
  collapseAll = false;
  filterText = "";
  showFilter = false;
  private filterEl!: HTMLInputElement;
  private bodyEl!: HTMLElement;
  private seq = 0;
  private unlinkedOpen = false;
  private collapsed = new Set<string>();

  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return BACKLINK_VIEW; }
  getDisplayText(): string { return "Backlinks"; }
  getIcon(): string { return "lucide-links-coming-in"; }
  getState(): Record<string, unknown> { return { collapseAll: this.collapseAll, showSearch: this.showFilter, searchQuery: this.filterText, unlinkedCollapsed: !this.unlinkedOpen }; }
  async setState(s: any): Promise<void> {
    if (!s || typeof s !== "object") return;
    this.collapseAll = !!s.collapseAll;
    this.showFilter = !!s.showSearch;
    this.filterText = typeof s.searchQuery === "string" ? s.searchQuery : "";
    this.unlinkedOpen = s.unlinkedCollapsed === false;
    if (this.bodyEl) this.refresh();
  }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.addClass("backlink-pane");
    const bar = navHeader(el);
    navButton(bar, "lucide-chevrons-down-up", "Collapse results", () => { this.collapseAll = !this.collapseAll; this.collapsed.clear(); this.refresh(); this.app.workspace.requestSaveLayout(); }, "backlink-collapse");
    navButton(bar, "lucide-search", "Show search filter", () => { this.showFilter = !this.showFilter; this.syncFilter(); if (this.showFilter) this.filterEl.focus(); this.app.workspace.requestSaveLayout(); }, "backlink-filter-toggle");
    const box = el.createDiv({ cls: "search-input-container backlink-filter" });
    this.filterEl = box.createEl("input", { type: "search", attr: { placeholder: "Search...", spellcheck: "false" } });
    this.registerDomEvent(this.filterEl, "input", () => { this.filterText = this.filterEl.value; this.requestRefresh(120); });
    this.bodyEl = el.createDiv({ cls: "backlink-body" });
    this.syncFilter();
    this.follow(["resolved", "changed"]);
    this.refresh();
  }
  private syncFilter(): void { this.filterEl.value = this.filterText; this.filterEl.parentElement!.style.display = this.showFilter ? "" : "none"; }

  refresh(): void {
    if (!this.bodyEl) return;
    const seq = ++this.seq;
    this.bodyEl.empty();
    const file = this.file;
    if (!file) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No backlinks found." }); return; }
    this.renderLinked(file, seq);
    this.renderUnlinked(file, seq);
  }

  private section(title: string, count: number | null, open: boolean, onToggle: (open: boolean) => void): { root: HTMLElement; children: HTMLElement; flair: HTMLElement } {
    const root = this.bodyEl.createDiv({ cls: "tree-item backlink-section" + (open ? "" : " is-collapsed") });
    const self = root.createDiv({ cls: "tree-item-self is-clickable mod-collapsible" });
    collapseIcon(self);
    self.createDiv({ cls: "tree-item-inner", text: title });
    const flair = self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: count === null ? "" : String(count) });
    const children = root.createDiv({ cls: "tree-item-children" });
    if (!open) children.hide();
    self.addEventListener("click", () => {
      const now = root.hasClass("is-collapsed");
      root.toggleClass("is-collapsed", !now);
      if (now) children.show(); else children.hide();
      onToggle(now);
    });
    return { root, children, flair };
  }

  private renderLinked(file: TFile, seq: number): void {
    const refs = this.app.metadataCache.getBacklinksForFile(file);
    const sources = refs.keys().sort((a, b) => naturalCompare(a, b));
    const q = this.filterText.trim().toLowerCase();
    const sec = this.section("Linked mentions", null, true, () => {});
    sec.root.addClass("backlink-linked");
    const list = sec.children.createDiv({ cls: "search-result-container" });
    if (!sources.length) list.createDiv({ cls: "pane-empty", text: "No backlinks found." });
    for (const src of sources) {
      const sf = this.app.vault.getFileByPath(src);
      if (!sf) continue;
      const byLine = new Map<number, Row>();
      for (const r of refs.get(src) ?? []) {
        const line = r.position?.start?.line ?? 0;
        const row = byLine.get(line) ?? byLine.set(line, { line, ranges: [] }).get(line)!;
        if (r.position?.start && r.position.end && r.position.start.line === r.position.end.line) row.ranges.push([r.position.start.col, r.position.end.col]);
      }
      const rows = [...byLine.values()].sort((a, b) => a.line - b.line);
      const nameMatch = !q || fileLabel(sf).toLowerCase().includes(q);
      const item = list.createDiv({ cls: "tree-item search-result backlink-item" + (this.collapseAll || this.collapsed.has(src) ? " is-collapsed" : ""), attr: { "data-path": src } });
      const title = item.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
      collapseIcon(title);
      title.createDiv({ cls: "tree-item-inner", text: fileLabel(sf) });
      title.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair search-result-count", text: String(rows.length || (this.app.metadataCache.resolvedLinks[src]?.[file.path] ?? 0)) });
      const matches = item.createDiv({ cls: "search-result-file-matches" });
      if (item.hasClass("is-collapsed")) matches.hide();
      title.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".collapse-icon")) {
          const closed = !item.hasClass("is-collapsed");
          item.toggleClass("is-collapsed", closed);
          if (closed) { matches.hide(); this.collapsed.add(src); } else { matches.show(); this.collapsed.delete(src); }
        } else void openFile(this.app, sf, e);
      });
      title.addEventListener("contextmenu", (e) => { e.preventDefault(); buildFileMenu(this.app, sf, "backlink").showAtMouseEvent(e); });
      const rowEls = rows.map((r) => {
        const el = matches.createDiv({ cls: "tree-item-self search-result-file-match tappable", attr: { "data-line": String(r.line) } });
        el.addEventListener("click", (e) => { void openFile(this.app, sf, e, { line: r.line }); });
        return el;
      });
      // Fill the context lines once the note has been read.
      void this.app.vault.cachedRead(sf).then((text) => {
        if (seq !== this.seq) return;
        const lines = text.split("\n");
        let any = false;
        rows.forEach((r, i) => {
          const raw = lines[r.line] ?? "";
          const hit = !q || nameMatch || raw.toLowerCase().includes(q);
          if (!hit) { rowEls[i].hide(); return; }
          any = true;
          const first = r.ranges[0]?.[0] ?? 0;
          const { text: t } = clip(raw, first);
          const body = rowEls[i].createDiv({ cls: "search-result-file-match-text" });
          const marks = r.ranges.map(([s, e2]) => raw.slice(s, e2)).filter(Boolean);
          highlightText(body, t, marks.length ? [...new Set(marks.map((m) => m.trim()))] : [], "search-result-file-matched-text");
        });
        // Canvases link through their cards: no lines to show, the file entry alone is the mention.
        if (!any && (rows.length || !nameMatch)) item.hide();
        this.updateCount(sec.flair, list);
      });
    }
    sec.flair.setText(String(sources.length));
  }
  private updateCount(flair: HTMLElement, list: HTMLElement): void {
    const n = Array.from(list.querySelectorAll<HTMLElement>(".backlink-item")).filter((el) => el.style.display !== "none").length;
    flair.setText(String(n));
  }

  private renderUnlinked(file: TFile, seq: number): void {
    const sec = this.section("Unlinked mentions", null, this.unlinkedOpen, (open) => { this.unlinkedOpen = open; if (open) void load(); this.app.workspace.requestSaveLayout(); });
    sec.root.addClass("backlink-unlinked");
    const list = sec.children.createDiv({ cls: "search-result-container" });
    let loaded = false;
    const load = async () => {
      if (loaded) return;
      loaded = true;
      list.empty();
      list.createDiv({ cls: "pane-empty", text: "Searching..." });
      const names = [file.basename];
      const aliases = this.app.metadataCache.getFileCache(file)?.frontmatter?.aliases;
      if (Array.isArray(aliases)) { for (const a of aliases) if (typeof a === "string") names.push(a); }
      else if (typeof aliases === "string") names.push(aliases);
      const linking = this.app.metadataCache.resolvedLinks;
      const candidates = this.app.vault.getMarkdownFiles().filter((f) => f !== file && !linking[f.path]?.[file.path]);
      const found: { f: TFile; ms: Mention[]; lines: string[] }[] = [];
      for (let i = 0; i < candidates.length && found.length < MAX_UNLINKED_FILES; i += 24) {
        const batch = candidates.slice(i, i + 24);
        const texts = await Promise.all(batch.map((f) => this.app.vault.cachedRead(f).catch(() => "")));
        if (seq !== this.seq) return;
        batch.forEach((f, j) => { const ms = findUnlinkedMentions(texts[j], names); if (ms.length) found.push({ f, ms, lines: texts[j].split("\n") }); });
      }
      list.empty();
      sec.flair.setText(String(found.length));
      if (!found.length) { list.createDiv({ cls: "pane-empty", text: "No unlinked mentions found." }); return; }
      found.sort((a, b) => naturalCompare(a.f.path, b.f.path));
      for (const { f, ms, lines } of found.slice(0, MAX_UNLINKED_FILES)) {
        const item = list.createDiv({ cls: "tree-item search-result backlink-item" });
        const title = item.createDiv({ cls: "tree-item-self search-result-file-title is-clickable" });
        collapseIcon(title);
        title.createDiv({ cls: "tree-item-inner", text: fileLabel(f) });
        title.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair search-result-count", text: String(ms.length) });
        const matches = item.createDiv({ cls: "search-result-file-matches" });
        title.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".collapse-icon")) { const c = !item.hasClass("is-collapsed"); item.toggleClass("is-collapsed", c); if (c) matches.hide(); else matches.show(); }
          else void openFile(this.app, f, e);
        });
        const seen = new Set<number>();
        for (const m of ms) {
          if (seen.has(m.line)) continue;
          seen.add(m.line);
          const el = matches.createDiv({ cls: "tree-item-self search-result-file-match tappable", attr: { "data-line": String(m.line) } });
          const { text } = clip(lines[m.line] ?? "", m.start);
          highlightText(el.createDiv({ cls: "search-result-file-match-text" }), text, names);
          el.addEventListener("click", (e) => { void openFile(this.app, f, e, { line: m.line }); });
          const said = (lines[m.line] ?? "").slice(m.start, m.end);
          linkButton(el, () => linkMention(this.app, f, m, file, said));
        }
      }
    };
    if (this.unlinkedOpen) void load();
    else list.createDiv({ cls: "pane-empty", text: "Expand to search for unlinked mentions." });
  }
}

// ===================================================================== outgoing links
export class OutgoingLinksView extends FollowView {
  /** Persisted in the view state like Obsidian (`unlinkedCollapsed`). */
  unlinkedCollapsed = true;
  private bodyEl!: HTMLElement;
  private collapsed = new Set<string>();
  private seq = 0;
  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return OUTGOING_VIEW; }
  getDisplayText(): string { return "Outgoing links"; }
  getIcon(): string { return "lucide-links-going-out"; }
  getState(): Record<string, unknown> { return { unlinkedCollapsed: this.unlinkedCollapsed }; }
  async setState(s: any): Promise<void> {
    if (typeof s?.unlinkedCollapsed === "boolean") this.unlinkedCollapsed = s.unlinkedCollapsed;
    if (this.bodyEl) this.refresh();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("outgoing-link-pane");
    this.bodyEl = this.contentEl.createDiv({ cls: "outgoing-link-body" });
    this.follow(["resolved", "changed"]);
    this.refresh();
  }

  refresh(): void {
    if (!this.bodyEl) return;
    const seq = ++this.seq;
    this.bodyEl.empty();
    const file = this.file;
    if (!file) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No outgoing links found." }); return; }
    const resolved = Object.entries(this.app.metadataCache.resolvedLinks[file.path] ?? {});
    const unresolved = Object.entries(this.app.metadataCache.unresolvedLinks[file.path] ?? {});
    const links = this.section("Links", "links", resolved.length + unresolved.length, false);
    if (!resolved.length && !unresolved.length) links.createDiv({ cls: "pane-empty", text: "No outgoing links found." });
    this.items(links, resolved.map(([p, n]) => ({ label: p, count: n, path: p })), false, file);
    this.items(links, unresolved.map(([l, n]) => ({ label: l, count: n, path: l })), true, file);
    if (file.extension === "md") this.renderUnlinked(file, seq);
  }

  private section(title: string, id: string, count: number | null, collapsed: boolean, onToggle?: (collapsed: boolean) => void): HTMLElement {
    const root = this.bodyEl.createDiv({ cls: `tree-item outgoing-link-section mod-${id}` + (collapsed ? " is-collapsed" : "") });
    const head = root.createDiv({ cls: "tree-item-self mod-collapsible is-clickable" });
    collapseIcon(head);
    head.createDiv({ cls: "tree-item-inner", text: title });
    head.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: count === null ? "" : String(count) });
    const kids = root.createDiv({ cls: "tree-item-children" });
    if (collapsed) kids.hide();
    head.addEventListener("click", () => {
      const c = !root.hasClass("is-collapsed");
      root.toggleClass("is-collapsed", c);
      if (c) kids.hide(); else kids.show();
      onToggle?.(c);
    });
    return kids;
  }

  private items(kids: HTMLElement, items: { label: string; count: number; path: string }[], unresolved: boolean, source: TFile): void {
    items.sort((a, b) => naturalCompare(a.label, b.label));
    for (const it of items) {
      const target = unresolved ? null : this.app.vault.getFileByPath(it.path);
      const label = target ? fileLabel(target) : it.label;
      const row = kids.createDiv({ cls: "tree-item outgoing-link-item" + (unresolved ? " is-unresolved" : "") });
      const self = row.createDiv({ cls: "tree-item-self is-clickable" + (unresolved ? " is-unresolved" : ""), attr: { "data-path": it.path } });
      self.createDiv({ cls: "tree-item-inner", text: label });
      const flair = self.createDiv({ cls: "tree-item-flair-outer" });
      if (target && target.extension !== "md") flair.createSpan({ cls: "tree-item-flair", text: target.extension });
      if (it.count > 1) flair.createSpan({ cls: "tree-item-flair", text: String(it.count) });
      self.addEventListener("click", (e) => {
        if (target) void openFile(this.app, target, e);
        else void this.app.workspace.openLinkText(it.label, source.path, Keymap.isModEvent(e));
      });
      if (target) self.addEventListener("contextmenu", (e) => { e.preventDefault(); buildFileMenu(this.app, target, "outgoing-link").showAtMouseEvent(e); });
    }
  }

  /** Other notes whose name (or alias) appears in this note as plain text. */
  private renderUnlinked(file: TFile, seq: number): void {
    const kids = this.section("Unlinked mentions", "unlinked", null, this.unlinkedCollapsed, (c) => {
      this.unlinkedCollapsed = c;
      if (!c) void load();
      this.app.workspace.requestSaveLayout();
    });
    const flair = kids.parentElement!.querySelector<HTMLElement>(":scope > .tree-item-self .tree-item-flair")!;
    let loaded = false;
    const load = async () => {
      if (loaded) return;
      loaded = true;
      const text = await this.app.vault.cachedRead(file).catch(() => "");
      if (seq !== this.seq) return;
      kids.empty();
      const linked = this.app.metadataCache.resolvedLinks[file.path] ?? {};
      const byName = new Map<string, TFile[]>();
      for (const f of this.app.vault.getMarkdownFiles()) {
        if (f === file || linked[f.path]) continue;
        const aliases = this.app.metadataCache.getFileCache(f)?.frontmatter?.aliases;
        const names = [f.basename, ...(Array.isArray(aliases) ? aliases : typeof aliases === "string" ? [aliases] : [])];
        for (const n of names) if (typeof n === "string" && n.trim().length > 1) { const k = n.trim().toLowerCase(); (byName.get(k) ?? byName.set(k, []).get(k)!).push(f); }
      }
      const body = text.slice(getFrontMatterInfo(text).contentStart), offset = text.slice(0, text.length - body.length).split("\n").length - 1;
      const hits = new Map<TFile, Mention[]>();
      // Overlapping names ("Start", "Start here"): keep the longest match.
      const found = findUnlinkedMentions(body, [...byName.keys()]).sort((a, b) => a.line - b.line || a.start - b.start || b.end - a.end);
      const kept: Mention[] = [];
      for (const m of found) { const p = kept[kept.length - 1]; if (!p || p.line !== m.line || m.start >= p.end) kept.push(m); }
      for (const m of kept) {
        const name = body.split("\n")[m.line].slice(m.start, m.end).toLowerCase();
        const target = byName.get(name)?.[0];
        if (target) (hits.get(target) ?? hits.set(target, []).get(target)!).push({ ...m, line: m.line + offset });
      }
      flair.setText(String(hits.size));
      if (!hits.size) { kids.createDiv({ cls: "pane-empty", text: "No unlinked mentions found." }); return; }
      const lines = text.split("\n");
      for (const [target, ms] of [...hits.entries()].sort((a, b) => naturalCompare(a[0].basename, b[0].basename))) {
        const item = kids.createDiv({ cls: "tree-item search-result outgoing-link-item mod-unlinked" + (this.collapsed.has(target.path) ? " is-collapsed" : ""), attr: { "data-path": target.path } });
        const title = item.createDiv({ cls: "tree-item-self search-result-file-title is-clickable", attr: { "aria-label": target.path } });
        collapseIcon(title);
        title.createDiv({ cls: "tree-item-inner", text: fileLabel(target) });
        title.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair search-result-count", text: String(ms.length) });
        const matches = item.createDiv({ cls: "search-result-file-matches" });
        if (item.hasClass("is-collapsed")) matches.hide();
        title.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".collapse-icon")) {
            const c = !item.hasClass("is-collapsed");
            item.toggleClass("is-collapsed", c);
            if (c) { matches.hide(); this.collapsed.add(target.path); } else { matches.show(); this.collapsed.delete(target.path); }
          } else void openFile(this.app, target, e);
        });
        for (const m of ms) {
          const el = matches.createDiv({ cls: "tree-item-self search-result-file-match tappable", attr: { "data-line": String(m.line) } });
          const raw = lines[m.line] ?? "";
          const { text: t } = clip(raw, m.start);
          highlightText(el.createDiv({ cls: "search-result-file-match-text" }), t, [raw.slice(m.start, m.end)]);
          el.addEventListener("click", (e) => { void openFile(this.app, file, e, { line: m.line }); });
          linkButton(el, () => linkMention(this.app, file, m, target, raw.slice(m.start, m.end)));
        }
      }
    };
    if (!this.unlinkedCollapsed) void load();
  }
}

function paneModule(id: string, type: string, make: (leaf: WorkspaceLeaf) => any, commands: [string, string, string][], extra?: (app: App) => () => void): CoreModule {
  return {
    id,
    install(app: App) {
      app.viewRegistry.registerView(type, make);
      const stop = whileCoreEnabled(app, id, () => {
        const offs = commands.map(([cid, name, icon]) => addCommand(app, { id: cid, name, icon, callback: () => { void activateView(app, type, "right"); } }));
        const offExtra = extra?.(app);
        return () => { offs.forEach((o) => o()); offExtra?.(); app.workspace.detachLeavesOfType(type); };
      });
      return () => { stop(); app.viewRegistry.unregisterView(type); };
    },
  };
}

/** Status bar entry "N backlinks" for the active note; clicking it opens the Backlinks view. */
function backlinkStatus(app: App): () => void {
  const item = app.statusBarEl.createDiv({ cls: "status-bar-item plugin-backlink mod-clickable" });
  item.hide();
  const render = () => {
    const file = app.workspace.getActiveFile();
    item.toggle(!!file && file.extension === "md");
    if (!file) return;
    // How many notes link here (a note that links twice counts once).
    const n = app.metadataCache.getBacklinksForFile(file).data.size;
    item.setText(`${n.toLocaleString()} backlink${n === 1 ? "" : "s"}`);
  };
  item.addEventListener("click", () => { void activateView(app, BACKLINK_VIEW, "right"); });
  const ws = app.workspace;
  const refs = [ws.on("file-open", render), ws.on("active-leaf-change", render), ws.on("layout-change", render)];
  const mc = app.metadataCache.on("resolved", render);
  const changed = app.metadataCache.on("changed", render);
  render();
  return () => { refs.forEach((r) => ws.offref(r)); app.metadataCache.offref(mc); app.metadataCache.offref(changed); item.detach(); };
}

export const backlinks: CoreModule = paneModule("backlink", BACKLINK_VIEW, (l) => new BacklinksView(l), [
  ["backlink:open", "Backlinks: Show backlinks", "lucide-links-coming-in"],
  ["backlink:open-backlinks", "Backlinks: Open backlinks for the current note", "lucide-links-coming-in"],
], backlinkStatus);
export const outgoingLinks: CoreModule = paneModule("outgoing-link", OUTGOING_VIEW, (l) => new OutgoingLinksView(l), [
  ["outgoing-links:open", "Outgoing links: Show outgoing links", "lucide-links-going-out"],
  ["outgoing-links:open-for-current", "Outgoing links: Open outgoing links for the current file", "lucide-links-going-out"],
]);
