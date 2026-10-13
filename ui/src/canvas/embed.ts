// `![[board.canvas]]`: a read-only, pannable preview of a canvas inside a note (app.embedRegistry creator for "canvas").
import { setIcon, type TFile } from "../obsidian";
import { EmbedBase, type EmbedContext } from "../obsidian/embeds";
import { Canvas } from "./canvas";
import { parseCanvas } from "./model";

export class CanvasEmbed extends EmbedBase {
  canvas: Canvas | null = null;
  private gen = 0;
  constructor(ctx: EmbedContext, file: TFile | null, subpath: string) { super(ctx, file, subpath); }
  onload(): void {
    super.onload();
    this.registerEvent(this.app.vault.on("modify", (f: any) => { if (f === this.file) void this.loadFile(); }));
  }
  onunload(): void { this.canvas?.destroy(); this.canvas = null; }
  async loadFile(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const gen = ++this.gen;
    let text: string;
    try { text = await this.app.vault.cachedRead(file); } catch { text = ""; }
    if (gen !== this.gen) return;
    const el = this.containerEl;
    el.addClass("canvas-embed", "is-loaded");
    this.canvas?.destroy();
    el.empty();
    let data;
    try { data = parseCanvas(text); }
    catch (e) { el.createDiv({ cls: "canvas-placeholder-message", text: `Unable to read ${file.name}: ${(e as Error).message}` }); return; }
    const box = el.createDiv({ cls: "canvas-embed-container" });
    const c = (this.canvas = new Canvas(this.app, { sourcePath: () => file.path, requestSave: () => {} }, box));
    c.options.linkFrames = false; // previews stay light: link cards render as title cards
    c.setReadonly(true);
    c.setData(data);
    const open = box.createDiv({ cls: "markdown-embed-link", attr: { "aria-label": "Open canvas" } });
    setIcon(open, "lucide-arrow-up-right");
    open.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void this.app.workspace.openLinkText(file.path, this.ctx.sourcePath ?? "", e.ctrlKey || e.metaKey); });
    const fit = () => { if (this.canvas === c) c.zoomToFit(); };
    fit();
    // The embed is often laid out after rendering; fit again once it has a size.
    requestAnimationFrame?.(fit);
    if (typeof ResizeObserver !== "undefined") {
      let first = true;
      const ro = new ResizeObserver(() => { if (first && box.clientWidth) { first = false; fit(); } else c.onResize(); });
      ro.observe(box);
      this.register(() => ro.disconnect());
    }
  }
}
