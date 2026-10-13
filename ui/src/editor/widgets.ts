import { WidgetType, type EditorView } from "@codemirror/view";
import katex from "katex";
import type { EditorHost } from "./types";
import {
  renderMarkdown, renderInline, renderFrontmatter, splitFrontmatter, calloutIcon, type RenderContext,
} from "../markdown";

export function makeRenderContext(host: EditorHost, sourcePath: string): RenderContext {
  return {
    sourcePath,
    resolveLink: (p, s) => host.resolveLink(p, s),
    readFile: (p) => host.readFile(p),
    getResourceUrl: (p) => host.getResourceUrl(p),
    openLink: (l, s, n) => host.openLink(l, s, n),
    openTag: (t) => host.openTag?.(t),
  };
}

export interface WidgetEnv {
  host: EditorHost;
  getSourcePath(): string;
}

// ------------------------------------------------------------------ bullets, checkbox, hr

export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "list-bullet";
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly char: string) {
    super();
  }
  eq(o: CheckboxWidget): boolean {
    return o.char === this.char;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "task-list-item-checkbox";
    box.checked = this.char !== " ";
    box.setAttribute("data-task", this.char);
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(box);
      const cur = view.state.sliceDoc(pos + 1, pos + 2);
      if (view.state.sliceDoc(pos, pos + 1) !== "[") return;
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: cur === " " ? "x" : " " } });
    });
    box.addEventListener("click", (e) => e.preventDefault());
    return box;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const h = document.createElement("hr");
    h.className = "cm-hr-widget";
    return h;
  }
}

export class CalloutIconWidget extends WidgetType {
  constructor(readonly type: string) {
    super();
  }
  eq(o: CalloutIconWidget): boolean {
    return o.type === this.type;
  }
  toDOM(): HTMLElement {
    const s = document.createElement("span");
    s.className = "cm-callout-icon callout-icon";
    s.appendChild(calloutIcon(this.type));
    return s;
  }
}

// ------------------------------------------------------------------ math

export class MathWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(o: MathWidget): boolean {
    return o.tex === this.tex && o.display === this.display;
  }
  toDOM(): HTMLElement {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = "math " + (this.display ? "math-block" : "math-inline") + " cm-math-widget is-loaded";
    try {
      el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false });
    } catch {
      el.textContent = this.tex;
    }
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// ------------------------------------------------------------------ images / embeds

export class ImageWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string, readonly width: string | null, readonly height: string | null) {
    super();
  }
  eq(o: ImageWidget): boolean {
    return o.url === this.url && o.alt === this.alt && o.width === this.width && o.height === this.height;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "image-embed cm-image-widget is-loaded";
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    if (this.width) img.setAttribute("width", this.width);
    if (this.height) img.setAttribute("height", this.height);
    img.addEventListener("load", () => view.requestMeasure());
    wrap.appendChild(img);
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

export class EmbedWidget extends WidgetType {
  constructor(readonly linktext: string, readonly alias: string, readonly env: WidgetEnv) {
    super();
  }
  eq(o: EmbedWidget): boolean {
    return o.linktext === this.linktext && o.alias === this.alias && o.env.getSourcePath() === this.env.getSourcePath();
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-embed-block cm-embed-widget";
    const src = this.env.getSourcePath();
    const done = () => view.requestMeasure();
    const raw = this.alias ? `${this.linktext}|${this.alias}` : this.linktext;
    try {
      const p = this.env.host.renderEmbed
        ? this.env.host.renderEmbed(el, raw, src)
        : renderMarkdown(`![[${raw}]]`, el, makeRenderContext(this.env.host, src));
      if (p && typeof (p as Promise<void>).then === "function") (p as Promise<void>).then(done, done);
      else done();
    } catch (e) {
      el.textContent = String(e);
    }
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

// ------------------------------------------------------------------ tables (editable widget lives in ./table)

export { TableWidget, parseTable, splitRow, type ParsedTable } from "./table";

// ------------------------------------------------------------------ plugin-rendered code blocks

export { CodeBlockWidget } from "./codeblocks";

// ------------------------------------------------------------------ frontmatter

export class FrontmatterWidget extends WidgetType {
  constructor(readonly source: string, readonly env: WidgetEnv) {
    super();
  }
  eq(o: FrontmatterWidget): boolean {
    return o.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-frontmatter-widget";
    const info = splitFrontmatter(this.source + "\n");
    const ctx = makeRenderContext(this.env.host, this.env.getSourcePath());
    const box = renderFrontmatter(
      { frontmatter: info.frontmatter, raw: info.raw, error: info.error },
      (s) => renderInline(s, ctx),
    );
    wrap.appendChild(box);
    wrap.addEventListener("mousedown", (e) => {
      const head = (e.target as HTMLElement).closest(".metadata-properties-heading");
      if (head) {
        e.preventDefault();
        const collapsed = box.classList.toggle("is-collapsed");
        head.querySelector(".collapse-indicator")?.classList.toggle("is-collapsed", collapsed);
        view.requestMeasure();
        return;
      }
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(view.posAtDOM(wrap) + 4, view.state.doc.length) } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
