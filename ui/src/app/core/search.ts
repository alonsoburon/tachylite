// Global search core view ("global-search"): results of `ipc.vaultSearch`, grouped by file.
import { Menu, Notice, type TFile, type App, type WorkspaceLeaf } from "../../obsidian";
import { ipc } from "../../ipc";
import { activateView, addCommand, openFile, PanelView, whileCoreEnabled, type CoreModule } from "./util";
import { collapseIcon, fileLabel, highlightText, naturalCompare, navButton, navHeader } from "./panel";

export const SEARCH_VIEW = "search";
type SortKey = "alphabetical" | "alphabeticalReverse" | "byModifiedTime" | "byModifiedTimeReverse" | "byCreatedTime" | "byCreatedTimeReverse";
const SORTS: [SortKey, string][] = [
  ["alphabetical", "File name (A to Z)"], ["alphabeticalReverse", "File name (Z to A)"],
  ["byModifiedTime", "Modified time (new to old)"], ["byModifiedTimeReverse", "Modified time (old to new)"],
  ["byCreatedTime", "Created time (new to old)"], ["byCreatedTimeReverse", "Created time (old to new)"],
];
interface Hit { path: string; lines: [number, string][] }
const MAX_FILES = 200;
const SNIPPET = 220;

/** Operators whose argument is text to highlight; the others (file, path, tag, property) match metadata, not lines. */
const TEXT_OPS = new Set(["content", "line", "block", "section", "task", "task-todo", "task-done", "match-case", "ignore-case"]);

/** Words/phrases of a query that should be highlighted in match lines (metadata operators, negations, regexes and OR are dropped). */
export function highlightTerms(query: string): string[] {
  const out: string[] = [];
  // Negated groups and [property:value] filters never produce match lines; /regex/ terms are left unhighlighted.
  const q = query.replace(/-\([^()]*\)/g, " ").replace(/(?:property:)?\[[^\]]*\]/g, " ").replace(/(?:^|\s|\()(?:\w[\w-]*:)?\/(?:\\.|[^/\\])+\//g, " ");
  const re = /(-?)(?:(\w[\w-]*):)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    const [, neg, op, quoted, bare] = m;
    if (neg) continue;
    const v = (quoted ?? bare ?? "").replace(/^\(+|\)+$/g, "");
    if (!v || (!op && v === "OR")) continue;
    if (op && !TEXT_OPS.has(op.toLowerCase())) {
      // Unknown "word:" prefixes are ordinary text ("note: hello"); known metadata operators are not.
      if (["file", "path", "tag", "property"].includes(op.toLowerCase())) continue;
      out.push(`${op}:${v}`);
      continue;
    }
    out.push(v);
  }
  return out;
}

function snippet(text: string, terms: string[]): string {
  const t = text.trim();
  if (t.length <= SNIPPET) return t;
  const low = t.toLowerCase();
  let at = -1;
  for (const term of terms) { const i = low.indexOf(term.toLowerCase()); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at - 60);
  return (start > 0 ? "…" : "") + t.slice(start, start + SNIPPET) + (start + SNIPPET < t.length ? "…" : "");
}

export class SearchView extends PanelView {
  query = "";
  collapseAll = false;
  extraContext = false;
  sortOrder: SortKey = "alphabetical";
  inputEl!: HTMLInputElement;
  clearEl!: HTMLElement;
  countEl!: HTMLElement;
  resultsEl!: HTMLElement;
  hits: Hit[] = [];
  collapsed = new Set<string>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shown = MAX_FILES;
  private btns: Record<string, HTMLElement> = {};

  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return SEARCH_VIEW; }
  getDisplayText(): string { return "Search"; }
  getIcon(): string { return "lucide-search"; }
  getState(): Record<string, unknown> { return { query: this.query, sortOrder: this.sortOrder, collapseAll: this.collapseAll, extraContext: this.extraContext }; }
  async setState(state: any): Promise<void> {
    if (!state || typeof state !== "object") return;
    if (SORTS.some(([k]) => k === state.sortOrder)) this.sortOrder = state.sortOrder;
    if (typeof state.collapseAll === "boolean") this.collapseAll = state.collapseAll;
    if (typeof state.extraContext === "boolean") this.extraContext = state.extraContext;
    this.syncButtons();
    if (typeof state.query === "string") this.setQuery(state.query);
  }

  async onOpen(): Promise<void> {
    const el = this.contentEl;
    el.addClass("search-view");
    const header = el.createDiv({ cls: "search-header" });
    const bar = navHeader(header);
    this.btns.collapse = navButton(bar, "lucide-chevrons-down-up", "Collapse results", () => this.setCollapseAll(!this.collapseAll));
    this.btns.context = navButton(bar, "lucide-align-justify", "Show more context", () => { this.extraContext = !this.extraContext; this.syncButtons(); this.renderResults(); this.saveLayout(); });
    this.btns.sort = navButton(bar, "lucide-arrow-up-narrow-wide", "Change sort order", (e) => this.sortMenu().showAtMouseEvent(e));
    const row = header.createDiv({ cls: "search-row" });
    const box = row.createDiv({ cls: "search-input-container" });
    this.inputEl = box.createEl("input", { type: "search", attr: { enterkeyhint: "search", spellcheck: "false", placeholder: "Search..." } });
    this.clearEl = box.createDiv({ cls: "search-input-clear-button", attr: { "aria-label": "Clear search" } });
    this.clearEl.hide?.();
    this.registerDomEvent(this.inputEl, "input", () => { this.query = this.inputEl.value; this.syncClear(); this.schedule(250); });
    this.registerDomEvent(this.inputEl, "keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); this.run(); }
      else if (e.key === "Escape" && this.query) { e.preventDefault(); this.setQuery(""); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.resultsEl.querySelector<HTMLElement>(".search-result-file-title")?.focus(); }
    });
    this.registerDomEvent(this.clearEl, "click", () => { this.setQuery(""); this.inputEl.focus(); });
    this.countEl = el.createDiv({ cls: "search-results-info" }).createDiv({ cls: "search-results-result-count" });
    this.resultsEl = el.createDiv({ cls: "search-result-container" });
    this.inputEl.value = this.query;
    this.syncClear();
    this.syncButtons();
    if (this.query) this.run();
    this.registerEvent(this.app.vault.on("modify", () => { if (this.query) this.schedule(1500); }));
  }
  async onClose(): Promise<void> { if (this.timer) clearTimeout(this.timer); this.seq++; }
  refresh(): void { this.renderResults(); }
  focusInput(select = true): void { this.inputEl?.focus(); if (select) this.inputEl?.select(); }

  /** Replace the query and search right away (used by tag clicks and the open command). */
  setQuery(q: string): void {
    this.query = q;
    if (this.inputEl) { this.inputEl.value = q; this.syncClear(); this.run(); }
  }
  private syncClear(): void { this.clearEl?.toggleClass("is-visible", !!this.query); if (this.clearEl) this.clearEl.style.display = this.query ? "" : "none"; }
  private syncButtons(): void {
    this.btns.collapse?.toggleClass("is-active", this.collapseAll);
    this.btns.collapse?.setAttribute("aria-label", this.collapseAll ? "Expand results" : "Collapse results");
    this.btns.context?.toggleClass("is-active", this.extraContext);
  }
  private saveLayout(): void { this.app.workspace.requestSaveLayout(); }
  private setCollapseAll(on: boolean): void {
    this.collapseAll = on;
    this.collapsed = new Set(on ? this.hits.map((h) => h.path) : []);
    this.syncButtons(); this.renderResults(); this.saveLayout();
  }
  setSortOrder(k: SortKey): void { this.sortOrder = k; this.renderResults(); this.saveLayout(); }
  sortMenu(): Menu {
    const m = new Menu();
    SORTS.forEach(([k, label]) => m.addItem((i) => i.setTitle(label).setChecked(this.sortOrder === k).onClick(() => this.setSortOrder(k))));
    return m;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.run(); }, ms);
  }

  /** Execute the current query against the backend and render the outcome. */
  async run(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const q = this.query.trim();
    const seq = ++this.seq;
    this.saveLayout();
    if (!q) { this.hits = []; this.renderResults(); return; }
    try {
      const res = (await ipc.vaultSearch(q)) as unknown as Hit[];
      if (seq !== this.seq) return;
      this.hits = Array.isArray(res) ? res.filter((h) => h && typeof h.path === "string") : [];
      this.collapsed = new Set(this.collapseAll ? this.hits.map((h) => h.path) : []);
      this.shown = MAX_FILES;
      this.renderResults();
    } catch (e) {
      if (seq !== this.seq) return;
      this.hits = [];
      this.renderResults((e as Error).message ?? String(e));
    }
  }

  private sorted(): Hit[] {
    const file = (h: Hit) => this.app.vault.getFileByPath(h.path);
    const name = (h: Hit) => { const f = file(h); return f ? fileLabel(f) : h.path; };
    const key = this.sortOrder.startsWith("byModified") ? "mtime" : "ctime";
    const arr = this.hits.slice();
    arr.sort((a, b) => {
      let r: number;
      if (this.sortOrder.startsWith("alphabetical")) r = naturalCompare(name(a), name(b));
      else r = ((file(b)?.stat[key] ?? 0) - (file(a)?.stat[key] ?? 0)) || naturalCompare(name(a), name(b));
      return this.sortOrder.endsWith("Reverse") ? -r : r;
    });
    return arr;
  }

  renderResults(error?: string): void {
    if (!this.resultsEl) return;
    const top = this.resultsEl.scrollTop;
    this.resultsEl.empty();
    const q = this.query.trim();
    if (error) { this.countEl.setText(""); this.resultsEl.createDiv({ cls: "search-empty-state", text: `Search failed: ${error}` }); return; }
    if (!q) { this.countEl.setText(""); return; }
    const total = this.hits.reduce((n, h) => n + h.lines.length, 0);
    this.countEl.setText(this.hits.length ? `${total} ${total === 1 ? "result" : "results"} in ${this.hits.length} ${this.hits.length === 1 ? "file" : "files"}` : "");
    if (!this.hits.length) { this.resultsEl.createDiv({ cls: "search-empty-state", text: "No matches found." }); return; }
    const terms = highlightTerms(q);
    const list = this.resultsEl.createDiv({ cls: "search-results-children" });
    for (const hit of this.sorted().slice(0, this.shown)) this.renderHit(list, hit, terms);
    if (this.hits.length > this.shown) {
      const more = list.createDiv({ cls: "search-result-show-more", text: `Show more results (${this.hits.length - this.shown} more files)` });
      more.addEventListener("click", () => { this.shown += MAX_FILES; this.renderResults(); });
    }
    this.resultsEl.scrollTop = top;
  }

  private renderHit(into: HTMLElement, hit: Hit, terms: string[]): void {
    const file = this.app.vault.getFileByPath(hit.path);
    const open = !this.collapsed.has(hit.path);
    const item = into.createDiv({ cls: "tree-item search-result" + (open ? "" : " is-collapsed") });
    const title = item.createDiv({ cls: "tree-item-self search-result-file-title is-clickable", attr: { tabindex: "0", "data-path": hit.path } });
    collapseIcon(title);
    title.createDiv({ cls: "tree-item-inner", text: file ? fileLabel(file) : hit.path });
    title.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair search-result-count", text: String(hit.lines.length) });
    const matches = item.createDiv({ cls: "search-result-file-matches" });
    if (!open) matches.hide?.();
    const icon = title.querySelector<HTMLElement>(".collapse-icon")!;
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowOpen = this.collapsed.has(hit.path);
      if (nowOpen) this.collapsed.delete(hit.path); else this.collapsed.add(hit.path);
      item.toggleClass("is-collapsed", !nowOpen);
      matches.style.display = nowOpen ? "" : "none";
    });
    title.addEventListener("click", (e) => { if (file) void openFile(this.app, file, e); });
    title.addEventListener("keydown", (e) => { if (e.key === "Enter" && file) void openFile(this.app, file, e); });
    for (const [line, text] of hit.lines) {
      const row = matches.createDiv({ cls: "tree-item-self search-result-file-match tappable", attr: { "data-line": String(line) } });
      const body = row.createDiv({ cls: "search-result-file-match-text" });
      highlightText(body, snippet(text, terms), terms);
      row.addEventListener("click", (e) => { if (file) void openFile(this.app, file, e, { line, startLoc: { line, col: Math.max(0, text.toLowerCase().indexOf((terms[0] ?? "").toLowerCase())), offset: 0 } }); });
      if (this.extraContext && file) void this.addContext(row, body, file, line);
    }
  }

  /** Show one line of context above and below a match (read through the vault cache). */
  private async addContext(row: HTMLElement, body: HTMLElement, file: TFile, line: number): Promise<void> {
    let lines: string[];
    try { lines = (await this.app.vault.cachedRead(file)).split("\n"); } catch { return; }
    if (!row.isConnected && !this.resultsEl.contains(row)) return;
    const mk = (n: number, where: "before" | "after") => {
      const t = lines[n]?.trim();
      if (!t) return null;
      const d = createDiv({ cls: `search-result-file-match-context is-${where}`, text: t.length > SNIPPET ? t.slice(0, SNIPPET) + "…" : t });
      return d;
    };
    const before = mk(line - 1, "before"), after = mk(line + 1, "after");
    if (before) row.insertBefore(before, body);
    if (after) row.appendChild(after);
  }
}

export const search: CoreModule = {
  id: "global-search",
  install(app: App) {
    app.viewRegistry.registerView(SEARCH_VIEW, (leaf) => new SearchView(leaf));
    const stop = whileCoreEnabled(app, "global-search", () => {
      const off = addCommand(app, {
        id: "global-search:open", name: "Search: Search in all files", icon: "lucide-search", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "f" }],
        callback: () => {
          const sel: string = (app.workspace.activeEditor as any)?.editor?.getSelection?.() ?? "";
          void activateView(app, SEARCH_VIEW, "left").then((leaf) => {
            const v = leaf.view as SearchView;
            if (sel && !sel.includes("\n")) v.setQuery(sel);
            v.focusInput();
          }).catch((e) => new Notice(String(e.message ?? e)));
        },
      });
      return () => { off(); app.workspace.detachLeavesOfType(SEARCH_VIEW); };
    });
    return () => { stop(); app.viewRegistry.unregisterView(SEARCH_VIEW); };
  },
};
