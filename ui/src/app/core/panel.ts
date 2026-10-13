// Small DOM helpers shared by the side-panel views.
import { setIcon, type TFile } from "../../obsidian";
import { PanelView } from "./util";

/** Collapse chevron used by every tree-like panel (rotated by CSS when `.is-collapsed`). */
export function collapseIcon(parent: HTMLElement): HTMLElement {
  const el = parent.createDiv({ cls: "tree-item-icon collapse-icon" });
  setIcon(el, "lucide-chevron-down");
  return el;
}

/** Append `text` to `parent`, wrapping every (case-insensitive) occurrence of `terms` in a highlight span. */
export function highlightText(parent: HTMLElement, text: string, terms: string[], cls = "search-result-file-matched-text"): void {
  const ts = terms.filter(Boolean).map((t) => t.toLowerCase());
  if (!ts.length) { parent.appendText(text); return; }
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let best = -1, len = 0;
    for (const t of ts) {
      const at = lower.indexOf(t, i);
      if (at >= 0 && (best < 0 || at < best || (at === best && t.length > len))) { best = at; len = t.length; }
    }
    if (best < 0) break;
    if (best > i) parent.appendText(text.slice(i, best));
    parent.createSpan({ cls, text: text.slice(best, best + len) });
    i = best + len;
  }
  if (i < text.length) parent.appendText(text.slice(i));
}

/** Build a `.nav-header` with action buttons; returns the buttons container. */
export function navHeader(parent: HTMLElement): HTMLElement {
  return parent.createDiv({ cls: "nav-header" }).createDiv({ cls: "nav-buttons-container" });
}

export function navButton(container: HTMLElement, icon: string, label: string, cb: (evt: MouseEvent) => void, extra = ""): HTMLElement {
  const b = container.createDiv({ cls: `clickable-icon nav-action-button ${extra}`.trim(), attr: { "aria-label": label } });
  setIcon(b, icon);
  b.addEventListener("click", cb);
  return b;
}

/** Natural, case-insensitive string comparison (the file-name order used by Obsidian's lists). */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Display name for a vault file: notes drop their .md extension. */
export function fileLabel(f: { basename: string; name: string; extension: string }): string {
  return f.extension === "md" ? f.basename : f.name;
}

/** Panel that follows the active file and refreshes when metadata is (re)resolved. */
export abstract class FollowView extends PanelView {
  file: TFile | null = null;
  /** Subscribe to active-file and metadata events; call once from onOpen, before the first refresh. */
  protected follow(metadataEvents: ("resolved" | "changed" | "deleted")[] = ["resolved", "changed"]): void {
    const { workspace, metadataCache } = this.app;
    this.file = workspace.getActiveFile();
    const sync = () => {
      const f = workspace.getActiveFile();
      if (f !== this.file) { this.file = f; this.requestRefresh(30); }
    };
    this.registerEvent(workspace.on("file-open", sync));
    this.registerEvent(workspace.on("active-leaf-change", sync));
    for (const ev of metadataEvents) this.registerEvent((metadataCache as any).on(ev, () => this.requestRefresh(150)));
  }
}
