// Status bar item: the editor mode (word count lives in core/wordCount.ts, the backlink count in core/links.ts).
import { MarkdownView, type App } from "../obsidian";
import { debounce } from "../obsidian";

export function installStatusBar(app: App): () => void {
  const bar = app.statusBarEl;
  const mode = bar.createDiv({ cls: "status-bar-item plugin-editor-status" });
  const render = () => {
    const v = app.workspace.getActiveViewOfType(MarkdownView);
    const f = v?.file;
    mode.toggle(!!f);
    if (!v || !f) return;
    mode.setText(v.getMode() === "preview" ? "Reading" : (v as any).isSourceMode ? "Source" : "Live Preview");
  };
  const update = debounce(render, 250, true);
  const ws = app.workspace;
  const refs = [ws.on("active-leaf-change", update), ws.on("file-open", update), ws.on("editor-change", update), ws.on("layout-change", update)];
  const mref = app.metadataCache.on("resolved", update);
  render();
  return () => { refs.forEach((r) => ws.offref(r)); app.metadataCache.offref(mref); mode.detach(); update.cancel(); };
}
