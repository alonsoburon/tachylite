// Tags core view ("tag-pane"): nested tag tree from metadataCache.getTags().
import { Menu, Notice, type App, type WorkspaceLeaf } from "../../obsidian";
import { promptText } from "../dialogs";
import { renameTag, validateTagName } from "./tagRename";
import { activateView, addCommand, PanelView, whileCoreEnabled, type CoreModule } from "./util";
import { collapseIcon, naturalCompare, navButton, navHeader } from "./panel";
import { copyText } from "../files";

export const TAG_VIEW = "tag";
export type TagSort = "alphabetical" | "frequency";

export interface TagNode { name: string; full: string; own: number; total: number; children: TagNode[] }

/** Build the nested tree (`#a/b/c` becomes a > b > c); counts roll up to ancestors. Tags merge case-insensitively. */
export function buildTagTree(tags: Record<string, number>, sort: TagSort = "alphabetical"): TagNode[] {
  const roots: TagNode[] = [];
  const index = new Map<string, TagNode>();
  for (const [raw, count] of Object.entries(tags)) {
    const parts = raw.replace(/^#/, "").split("/").filter(Boolean);
    let level = roots, path = "";
    parts.forEach((part, i) => {
      path = path ? `${path}/${part}` : part;
      const key = path.toLowerCase();
      let node = index.get(key);
      if (!node) { node = { name: part, full: path, own: 0, total: 0, children: [] }; index.set(key, node); level.push(node); }
      node.total += count;
      if (i === parts.length - 1) node.own += count;
      level = node.children;
    });
  }
  const cmp = (a: TagNode, b: TagNode) => (sort === "frequency" ? b.total - a.total || naturalCompare(a.name, b.name) : naturalCompare(a.name, b.name));
  const sortRec = (list: TagNode[]) => { list.sort(cmp); list.forEach((n) => sortRec(n.children)); };
  sortRec(roots);
  return roots;
}

export class TagView extends PanelView {
  sortOrder: TagSort = "alphabetical";
  expanded = new Set<string>();
  containerEl2!: HTMLElement;
  private sortBtn!: HTMLElement;
  private tree: TagNode[] = [];

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.navigation = false;
    if (this.app.loadLocalStorage("tag-pane-sort") === "frequency") this.sortOrder = "frequency";
  }
  getViewType(): string { return TAG_VIEW; }
  getDisplayText(): string { return "Tags"; }
  getIcon(): string { return "lucide-tags"; }
  getState(): Record<string, unknown> { return { sortOrder: this.sortOrder, expanded: [...this.expanded] }; }
  async setState(s: any): Promise<void> {
    if (s?.sortOrder === "alphabetical" || s?.sortOrder === "frequency") this.sortOrder = s.sortOrder;
    if (Array.isArray(s?.expanded)) this.expanded = new Set(s.expanded.filter((x: unknown) => typeof x === "string"));
    if (this.containerEl2) this.refresh();
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("tag-pane");
    const bar = navHeader(this.contentEl);
    this.sortBtn = navButton(bar, "lucide-arrow-up-narrow-wide", "Change sort order", () => this.toggleSort());
    navButton(bar, "lucide-chevrons-down-up", "Collapse all", () => this.toggleCollapseAll());
    this.containerEl2 = this.contentEl.createDiv({ cls: "tag-container" });
    const mc = this.app.metadataCache;
    for (const ev of ["resolved", "changed", "deleted"]) this.registerEvent((mc as any).on(ev, () => this.requestRefresh(200)));
    this.refresh();
  }

  toggleSort(): void {
    this.sortOrder = this.sortOrder === "alphabetical" ? "frequency" : "alphabetical";
    this.app.saveLocalStorage("tag-pane-sort", this.sortOrder);
    this.app.workspace.requestSaveLayout();
    this.refresh();
  }
  toggleCollapseAll(): void {
    const all = new Set<string>();
    const walk = (l: TagNode[]) => l.forEach((n) => { if (n.children.length) { all.add(n.full.toLowerCase()); walk(n.children); } });
    walk(this.tree);
    if (this.expanded.size) this.expanded.clear(); else this.expanded = all;
    this.app.workspace.requestSaveLayout();
    this.refresh();
  }

  refresh(): void {
    if (!this.containerEl2) return;
    const top = this.containerEl2.scrollTop;
    this.sortBtn.setAttribute("aria-label", this.sortOrder === "alphabetical" ? "Sort by frequency" : "Sort alphabetically");
    this.tree = buildTagTree(this.app.metadataCache.getTags(), this.sortOrder);
    this.containerEl2.empty();
    if (!this.tree.length) { this.containerEl2.createDiv({ cls: "pane-empty", text: "No tags found." }); return; }
    for (const n of this.tree) this.renderNode(n, this.containerEl2);
    this.containerEl2.scrollTop = top;
  }

  private renderNode(n: TagNode, into: HTMLElement): void {
    const key = n.full.toLowerCase();
    const open = this.expanded.has(key);
    const hasKids = n.children.length > 0;
    const item = into.createDiv({ cls: "tree-item" + (hasKids && !open ? " is-collapsed" : "") });
    const self = item.createDiv({ cls: "tree-item-self tag-pane-tag is-clickable" + (hasKids ? " mod-collapsible" : ""), attr: { "data-tag": "#" + n.full } });
    if (hasKids) collapseIcon(self);
    const inner = self.createDiv({ cls: "tree-item-inner" });
    inner.createSpan({ cls: "tag-pane-tag-text", text: "#" + n.name });
    self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair tag-pane-tag-count", text: String(n.total) });
    self.addEventListener("click", (e) => {
      if (hasKids && (e.target as HTMLElement).closest(".collapse-icon")) {
        if (open) this.expanded.delete(key); else this.expanded.add(key);
        this.app.workspace.requestSaveLayout();
        this.refresh();
      } else void this.searchTag(n.full);
    });
    self.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      new Menu()
        .addItem((i) => i.setTitle("New search for #" + n.full).setIcon("lucide-search").onClick(() => { void this.searchTag(n.full); }))
        .addItem((i) => i.setTitle("Require tag in search").setIcon("lucide-plus-circle").onClick(() => { void this.refineSearch("tag:#" + n.full); }))
        .addItem((i) => i.setTitle("Exclude tag from search").setIcon("lucide-minus-circle").onClick(() => { void this.refineSearch("-tag:#" + n.full); }))
        .addItem((i) => i.setTitle("Rename tag...").setIcon("lucide-pencil").onClick(() => { void this.rename(n.full); }))
        .addItem((i) => i.setTitle("Copy tag").setIcon("lucide-copy").onClick(() => copyText("#" + n.full)))
        .showAtMouseEvent(e);
    });
    if (hasKids && open) for (const c of n.children) this.renderNode(c, item.createDiv({ cls: "tree-item-children" }));
  }

  /** Add a term to the search already open (or start one). */
  async refineSearch(term: string): Promise<void> {
    const leaf = await activateView(this.app, "search", "left");
    const view = leaf.view as any;
    view.setQuery?.(`${view.query ?? ""} ${term}`.trim());
  }

  async rename(tag: string): Promise<void> {
    const to = await promptText(this.app, { title: `Rename #${tag}`, value: tag, cta: "Rename", validate: validateTagName });
    if (to === null || to.replace(/^#/, "") === tag) return;
    const n = await renameTag(this.app, tag, to);
    new Notice(`Renamed #${tag} to #${to.replace(/^#/, "")} in ${n} note${n === 1 ? "" : "s"}.`);
    this.refresh();
  }

  async searchTag(tag: string): Promise<void> {
    const leaf = await activateView(this.app, "search", "left");
    (leaf.view as any).setQuery?.("tag:#" + tag.replace(/^#/, ""));
  }
}

export const tags: CoreModule = {
  id: "tag-pane",
  install(app: App) {
    app.viewRegistry.registerView(TAG_VIEW, (leaf) => new TagView(leaf));
    const stop = whileCoreEnabled(app, "tag-pane", () => {
      const off = addCommand(app, { id: "tag-pane:open", name: "Tags view: Show tags", icon: "lucide-tags", callback: () => { void activateView(app, TAG_VIEW, "right"); } });
      return () => { off(); app.workspace.detachLeavesOfType(TAG_VIEW); };
    });
    return () => { stop(); app.viewRegistry.unregisterView(TAG_VIEW); };
  },
};
