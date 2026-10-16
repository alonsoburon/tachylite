// Core plugin "Slides": present the active note full screen, one slide per section between horizontal rules.
import { Component, MarkdownRenderer, MarkdownView, Notice, type App } from "../../obsidian";
import { coreRibbon } from "./options";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";

const ID = "slides";

/** Slides of a note: the text between `---` rules (a leading frontmatter block and rules inside code fences don't split). */
export function splitSlides(markdown: string): string[] {
  const text = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const slides: string[][] = [[]];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const f = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (f) fence = fence === null ? f[0] : f[0] === fence[0] ? null : fence;
    if (fence === null && /^---+\s*$/.test(line)) { slides.push([]); continue; }
    slides[slides.length - 1].push(line);
  }
  const out = slides.map((s) => s.join("\n").trim()).filter((s) => s.length > 0);
  return out.length ? out : [""];
}

export interface Presentation { close(): void; goto(i: number): void; readonly index: number; readonly total: number; el: HTMLElement }

/** Show `markdown` as a presentation (source path resolves relative links and embeds). */
export function present(app: App, markdown: string, sourcePath: string): Presentation {
  const slides = splitSlides(markdown);
  const doc = document;
  const el = doc.body.createDiv({ cls: "slides-presentation" });
  const stage = el.createDiv({ cls: "slides-stage" });
  const counter = el.createDiv({ cls: "slides-counter" });
  const closeEl = el.createDiv({ cls: "slides-close", attr: { "aria-label": "Close presentation (Esc)" }, text: "×" });
  const component = new Component();
  component.load();
  let index = 0;
  const show = async (i: number) => {
    index = Math.max(0, Math.min(slides.length - 1, i));
    stage.empty();
    const slide = stage.createDiv({ cls: "slides-slide markdown-rendered markdown-preview-view" });
    await MarkdownRenderer.render(app, slides[index], slide, sourcePath, component);
    counter.setText(`${index + 1} / ${slides.length}`);
  };
  const close = () => { doc.removeEventListener("keydown", onKey, true); component.unload(); el.remove(); };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    const next = k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Enter";
    const prev = k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace";
    if (!(next || prev || k === "Home" || k === "End" || k === "Escape")) return;
    e.preventDefault(); e.stopPropagation(); // the presentation owns the keyboard (no editor or app hotkeys behind it)
    if (k === "Escape") close(); else if (k === "Home") void show(0); else if (k === "End") void show(slides.length - 1); else void show(index + (next ? 1 : -1));
  };
  doc.addEventListener("keydown", onKey, true);
  closeEl.addEventListener("click", (e) => { e.stopPropagation(); close(); });
  el.addEventListener("click", (e) => { void show(index + ((e as MouseEvent).clientX < el.clientWidth / 3 ? -1 : 1)); });
  void show(0);
  return { close, goto: (i) => void show(i), get index() { return index; }, get total() { return slides.length; }, el };
}

async function startPresentation(app: App): Promise<Presentation | null> {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view?.file) { new Notice("Open a note to start a presentation."); return null; }
  return present(app, view.editor.getValue(), view.file.path);
}

export const slides: CoreModule = {
  id: ID,
  install(app) {
    return whileCoreEnabled(app, ID, () => {
      const offs = [
        coreRibbon(app, ID, "lucide-presentation", "Start presentation", () => { void startPresentation(app); }),
        addCommand(app, { id: "slides:start", name: "Slides: Start presentation", icon: "lucide-presentation", checkCallback: (checking) => {
          if (!app.workspace.getActiveViewOfType(MarkdownView)?.file) return false;
          if (!checking) void startPresentation(app);
          return true;
        } }),
      ];
      return () => offs.forEach((f) => f());
    });
  },
};
