// Status bar items: backlink count, word/character count and editor mode.
import { MarkdownView, type App } from "../obsidian";
import { debounce } from "../obsidian";

export function installStatusBar(app: App): () => void {
  const bar = app.statusBarEl;
  const backlinks = bar.createDiv({ cls: "status-bar-item plugin-backlink" });
  const mode = bar.createDiv({ cls: "status-bar-item plugin-editor-status" });
  const words = bar.createDiv({ cls: "status-bar-item plugin-word-count" });
  const render = () => {
    const v = app.workspace.getActiveViewOfType(MarkdownView);
    const f = v?.file;
    backlinks.toggle(!!f);
    mode.toggle(!!f);
    words.toggle(!!f);
    if (!v || !f) return;
    const n = Object.values(app.metadataCache.resolvedLinks).filter((t) => t[f.path]).length;
    backlinks.setText(`${n} backlink${n === 1 ? "" : "s"}`);
    mode.setText(v.getMode() === "preview" ? "Reading" : (v as any).isSourceMode ? "Source" : "Live Preview");
    const text = v.getViewData().replace(/^---\n[\s\S]*?\n---\n?/, "");
    const w = (text.match(/[\p{L}\p{N}_'’-]+/gu) ?? []).length;
    words.setText(`${w} word${w === 1 ? "" : "s"}  ${text.length} character${text.length === 1 ? "" : "s"}`);
  };
  const update = debounce(render, 250, true);
  const ws = app.workspace;
  const refs = [ws.on("active-leaf-change", update), ws.on("file-open", update), ws.on("editor-change", update), ws.on("layout-change", update)];
  const mref = app.metadataCache.on("resolved", update);
  render();
  return () => { refs.forEach((r) => ws.offref(r)); app.metadataCache.offref(mref); backlinks.detach(); mode.detach(); words.detach(); update.cancel(); };
}
