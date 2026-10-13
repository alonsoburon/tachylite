// Per-leaf navigation history (Alt+Left / Alt+Right, header arrows, mouse back/forward buttons).
import { FileView, type App, type ViewState, type WorkspaceLeaf } from "../obsidian";
import { TachyMarkdownView } from "./markdownView";

interface Stack { entries: ViewState[]; index: number }

export class History {
  private stacks = new WeakMap<WorkspaceLeaf, Stack>();
  private navigating = false;
  private cleanups: (() => void)[] = [];

  constructor(private app: App) {
    const ws = app.workspace;
    const rec = ws.on("file-open", () => this.record(ws.activeLeaf));
    const lc = ws.on("active-leaf-change", () => this.updateButtons());
    this.cleanups.push(() => { ws.offref(rec); ws.offref(lc); });
    const mouse = (e: MouseEvent) => { if (e.button === 3) { e.preventDefault(); void this.go(-1); } else if (e.button === 4) { e.preventDefault(); void this.go(1); } };
    document.addEventListener("mouseup", mouse);
    this.cleanups.push(() => document.removeEventListener("mouseup", mouse));
  }
  dispose(): void { for (const c of this.cleanups.splice(0)) c(); }

  private record(leaf: WorkspaceLeaf | null): void {
    if (!leaf || this.navigating || !(leaf.view instanceof FileView) || !leaf.view.file) return;
    const st = this.stacks.get(leaf) ?? { entries: [], index: -1 };
    const state = { type: leaf.view.getViewType(), state: { file: leaf.view.file.path } } as ViewState;
    const cur = st.entries[st.index];
    if (cur && (cur.state as any)?.file === (state.state as any).file) return;
    st.entries = st.entries.slice(0, st.index + 1);
    st.entries.push(state);
    if (st.entries.length > 100) st.entries.shift();
    st.index = st.entries.length - 1;
    this.stacks.set(leaf, st);
    this.updateButtons();
  }

  canGo(dir: -1 | 1, leaf = this.app.workspace.activeLeaf): boolean {
    const st = leaf ? this.stacks.get(leaf) : null;
    return !!st && st.index + dir >= 0 && st.index + dir < st.entries.length;
  }

  async go(dir: -1 | 1): Promise<void> {
    const leaf = this.app.workspace.activeLeaf;
    const st = leaf ? this.stacks.get(leaf) : null;
    if (!leaf || !st || !this.canGo(dir, leaf)) return;
    let target = st.index + dir;
    // skip entries whose file no longer exists
    while (target >= 0 && target < st.entries.length && !this.app.vault.getFileByPath(String((st.entries[target].state as any)?.file))) target += dir;
    if (target < 0 || target >= st.entries.length) return;
    st.index = target;
    this.navigating = true;
    try { await leaf.setViewState({ ...st.entries[target], active: true }); } finally { this.navigating = false; }
    this.updateButtons();
  }

  updateButtons(): void {
    for (const leaf of this.app.workspace.allLeaves()) {
      if (leaf.view instanceof TachyMarkdownView) leaf.view.setNavState(this.canGo(-1, leaf), this.canGo(1, leaf));
    }
  }
}
