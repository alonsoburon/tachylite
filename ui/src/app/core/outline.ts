// Outline core view ("outline"): nested headings of the active note; click scrolls the note there.
import { MarkdownView, type App, type WorkspaceLeaf } from "../../obsidian";
import { activateView, addCommand, whileCoreEnabled, type CoreModule } from "./util";
import { collapseIcon, FollowView, navButton, navHeader } from "./panel";

export const OUTLINE_VIEW = "outline";

export interface HeadingNode { text: string; level: number; line: number; key: string; children: HeadingNode[] }

/** Strip link / emphasis / code markup from a raw heading so the outline shows readable text. */
export function cleanHeading(raw: string): string {
  return raw
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, t: string, a?: string) => a ?? t)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|==|\*|`)/g, "")
    .trim();
}

/** Nest a flat heading list by level (a level-3 under a level-1 stays a child of the level-1). */
export function buildOutline(headings: { heading: string; level: number; position: { start: { line: number } } }[]): HeadingNode[] {
  const roots: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  const seen = new Map<string, number>();
  for (const h of headings) {
    const text = cleanHeading(h.heading);
    const base = `${h.level}:${text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const node: HeadingNode = { text, level: h.level, line: h.position.start.line, key: `${base}#${n}`, children: [] };
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}

export class OutlineView extends FollowView {
  collapsed = new Set<string>();
  filterText = "";
  showFilter = false;
  private bodyEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private flat: HeadingNode[] = [];

  constructor(leaf: WorkspaceLeaf) { super(leaf); this.navigation = false; }
  getViewType(): string { return OUTLINE_VIEW; }
  getDisplayText(): string { return "Outline"; }
  getIcon(): string { return "lucide-list"; }
  getState(): Record<string, unknown> { return { collapsed: [...this.collapsed], showSearch: this.showFilter, searchQuery: this.filterText }; }
  async setState(s: any): Promise<void> {
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.collapsed)) this.collapsed = new Set(s.collapsed.filter((x: unknown) => typeof x === "string"));
    this.showFilter = !!s.showSearch;
    this.filterText = typeof s.searchQuery === "string" ? s.searchQuery : "";
    if (this.bodyEl) { this.syncFilter(); this.refresh(); }
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("outline");
    const bar = navHeader(this.contentEl);
    navButton(bar, "lucide-chevrons-down-up", "Collapse all", () => this.toggleCollapseAll());
    navButton(bar, "lucide-search", "Show search filter", () => { this.showFilter = !this.showFilter; this.syncFilter(); if (this.showFilter) this.filterEl.focus(); this.app.workspace.requestSaveLayout(); });
    const box = this.contentEl.createDiv({ cls: "search-input-container outline-filter" });
    this.filterEl = box.createEl("input", { type: "search", attr: { placeholder: "Filter...", spellcheck: "false" } });
    this.registerDomEvent(this.filterEl, "input", () => { this.filterText = this.filterEl.value; this.refresh(); });
    this.bodyEl = this.contentEl.createDiv({ cls: "outline-body" });
    this.syncFilter();
    this.follow(["changed", "resolved"]);
    this.refresh();
  }
  private syncFilter(): void { this.filterEl.value = this.filterText; this.filterEl.parentElement!.style.display = this.showFilter ? "" : "none"; }

  toggleCollapseAll(): void {
    const parents = this.flat.filter((n) => n.children.length).map((n) => n.key);
    if (parents.some((k) => !this.collapsed.has(k))) this.collapsed = new Set(parents); else this.collapsed.clear();
    this.refresh();
    this.app.workspace.requestSaveLayout();
  }

  refresh(): void {
    if (!this.bodyEl) return;
    this.bodyEl.empty();
    const f = this.file;
    const cache = f && f.extension === "md" ? this.app.metadataCache.getFileCache(f) : null;
    const tree = buildOutline(cache?.headings ?? []);
    this.flat = [];
    const collect = (l: HeadingNode[]) => l.forEach((n) => { this.flat.push(n); collect(n.children); });
    collect(tree);
    if (!this.flat.length) { this.bodyEl.createDiv({ cls: "pane-empty", text: "No headings found." }); return; }
    const q = this.filterText.trim().toLowerCase();
    const active = this.activeHeading();
    const render = (n: HeadingNode, into: HTMLElement): boolean => {
      const kids = n.children;
      const selfMatch = !q || n.text.toLowerCase().includes(q);
      const open = !!q || !this.collapsed.has(n.key);
      const item = createDiv({ cls: "tree-item" + (kids.length && !open ? " is-collapsed" : "") });
      const self = item.createDiv({ cls: "tree-item-self is-clickable outline-heading" + (kids.length ? " mod-collapsible" : "") + (active === n.key ? " is-active" : ""), attr: { "data-level": String(n.level), "data-line": String(n.line) } });
      self.style.setProperty("--outline-level", String(n.level));
      if (kids.length) collapseIcon(self);
      self.createDiv({ cls: "tree-item-inner", text: n.text });
      let any = selfMatch;
      if (kids.length) {
        const box = item.createDiv({ cls: "tree-item-children" });
        let childMatch = false;
        if (open) for (const c of kids) childMatch = render(c, box) || childMatch;
        any = any || childMatch;
      }
      self.addEventListener("click", (e) => {
        if (kids.length && (e.target as HTMLElement).closest(".collapse-icon")) {
          if (this.collapsed.has(n.key)) this.collapsed.delete(n.key); else this.collapsed.add(n.key);
          this.refresh();
          this.app.workspace.requestSaveLayout();
        } else this.goTo(n);
      });
      if (any) into.appendChild(item);
      return any;
    };
    for (const n of tree) render(n, this.bodyEl);
    if (q && !this.bodyEl.firstChild) this.bodyEl.createDiv({ cls: "pane-empty", text: "No headings found." });
  }

  /** Markdown leaf currently showing the outlined file (prefers the most recently used one). */
  private targetLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown").filter((l) => (l.view as MarkdownView).file === this.file);
    const recent = this.app.workspace.getMostRecentLeaf();
    return leaves.find((l) => l === recent) ?? leaves[0] ?? null;
  }

  /** Key of the last heading at or above the cursor of the target editor. */
  private activeHeading(): string | null {
    const view = this.targetLeaf()?.view as MarkdownView | undefined;
    if (!view || view.getMode() === "preview") return null;
    let line = 0;
    try { line = view.editor.getCursor().line; } catch { return null; }
    let cur: string | null = null;
    for (const n of this.flat) if (n.line <= line) cur = n.key; else break;
    return cur;
  }

  /** Scroll the note to `node`: cursor jump in the editor, DOM scroll in reading view. */
  goTo(node: HeadingNode): void {
    const leaf = this.targetLeaf();
    if (!leaf) return;
    const view = leaf.view as MarkdownView;
    if (view.getMode() === "preview") {
      const heads = Array.from(view.previewMode.containerEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
      const hit = heads.filter((h) => h.tagName === `H${node.level}` && cleanHeading(h.textContent ?? "") === node.text);
      const idx = Number(node.key.slice(node.key.lastIndexOf("#") + 1));
      (hit[idx] ?? hit[0])?.scrollIntoView?.({ block: "start" });
    } else {
      view.setEphemeralState({ line: node.line, focus: false });
    }
    this.bodyEl.querySelectorAll(".is-active").forEach((el) => el.removeClass("is-active"));
    this.bodyEl.querySelector(`[data-line="${node.line}"]`)?.addClass("is-active");
  }
}

export const outline: CoreModule = {
  id: "outline",
  install(app: App) {
    app.viewRegistry.registerView(OUTLINE_VIEW, (leaf) => new OutlineView(leaf));
    const stop = whileCoreEnabled(app, "outline", () => {
      const offs = [
        addCommand(app, { id: "outline:open", name: "Outline: Show outline", icon: "lucide-list", callback: () => { void activateView(app, OUTLINE_VIEW, "right"); } }),
        addCommand(app, { id: "outline:open-for-current", name: "Outline: Open outline of the current file", icon: "lucide-list", callback: () => { void activateView(app, OUTLINE_VIEW, "right"); } }),
      ];
      return () => { offs.forEach((o) => o()); app.workspace.detachLeavesOfType(OUTLINE_VIEW); };
    });
    return () => { stop(); app.viewRegistry.unregisterView(OUTLINE_VIEW); };
  },
};
