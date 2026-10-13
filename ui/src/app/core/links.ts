// Backlinks and outgoing-links core views, built on metadataCache + vault.
import { TFile, type App, type WorkspaceLeaf } from "../../obsidian";
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
      title.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair search-result-count", text: String(rows.length) });
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
        if (!any) item.hide();
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
        }
      }
    };
    if (this.unlinkedOpen) void load();
    else list.createDiv({ cls: "pane-empty", text: "Expand to search for unlinked mentions." });
  }
}

// ===================================================================== outgoing links
export class OutgoingLinksView extends FollowView {
  private bodyEl!: HTMLElement;
  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return OUTGOING_VIEW; }
  getDisplayText(): string { return "Outgoing links"; }
  getIcon(): string { return "lucide-links-going-out"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("outgoing-link-pane");
    this.bodyEl = this.contentEl.createDiv({ cls: "outgoing-link-body" });
    this.follow(["resolved", "changed"]);
    this.refresh();
  }

  refresh(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const file = this.file;
    if (!file) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No outgoing links found." }); return; }
    const resolved = Object.entries(this.app.metadataCache.resolvedLinks[file.path] ?? {});
    const unresolved = Object.entries(this.app.metadataCache.unresolvedLinks[file.path] ?? {});
    if (!resolved.length && !unresolved.length) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No outgoing links found." }); return; }
    this.group("Links", resolved.map(([p, n]) => ({ label: p, count: n, path: p })), false, file);
    this.group("Unresolved links", unresolved.map(([l, n]) => ({ label: l, count: n, path: l })), true, file);
  }

  private group(title: string, items: { label: string; count: number; path: string }[], unresolved: boolean, source: TFile): void {
    if (!items.length) return;
    const root = this.bodyEl.createDiv({ cls: "tree-item outgoing-link-section" + (unresolved ? " is-unresolved-section" : "") });
    const head = root.createDiv({ cls: "tree-item-self mod-collapsible is-clickable" });
    collapseIcon(head);
    head.createDiv({ cls: "tree-item-inner", text: title });
    head.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(items.length) });
    const kids = root.createDiv({ cls: "tree-item-children" });
    head.addEventListener("click", () => { const c = !root.hasClass("is-collapsed"); root.toggleClass("is-collapsed", c); if (c) kids.hide(); else kids.show(); });
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
        else void this.app.workspace.openLinkText(it.label, source.path, e.ctrlKey || e.metaKey ? "tab" : false);
      });
      if (target) self.addEventListener("contextmenu", (e) => { e.preventDefault(); buildFileMenu(this.app, target, "outgoing-link").showAtMouseEvent(e); });
    }
  }
}

function paneModule(id: string, type: string, make: (leaf: WorkspaceLeaf) => any, commands: [string, string, string][]): CoreModule {
  return {
    id,
    install(app: App) {
      app.viewRegistry.registerView(type, make);
      const stop = whileCoreEnabled(app, id, () => {
        const offs = commands.map(([cid, name, icon]) => addCommand(app, { id: cid, name, icon, callback: () => { void activateView(app, type, "right"); } }));
        return () => { offs.forEach((o) => o()); app.workspace.detachLeavesOfType(type); };
      });
      return () => { stop(); app.viewRegistry.unregisterView(type); };
    },
  };
}

export const backlinks: CoreModule = paneModule("backlink", BACKLINK_VIEW, (l) => new BacklinksView(l), [
  ["backlink:open", "Backlinks: Show backlinks", "lucide-links-coming-in"],
  ["backlink:open-backlinks", "Backlinks: Open backlinks for the current note", "lucide-links-coming-in"],
]);
export const outgoingLinks: CoreModule = paneModule("outgoing-link", OUTGOING_VIEW, (l) => new OutgoingLinksView(l), [
  ["outgoing-link:open", "Outgoing links: Show outgoing links", "lucide-links-going-out"],
  ["outgoing-link:open-for-current", "Outgoing links: Open outgoing links for the current note", "lucide-links-going-out"],
]);
