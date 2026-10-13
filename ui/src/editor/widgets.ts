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
    getEmbedRenderer: host.getEmbedRenderer ? (ext) => host.getEmbedRenderer!(ext) : undefined,
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

// ------------------------------------------------------------------ tables

export interface ParsedTable {
  rows: { text: string; offset: number }[][];
  align: ("left" | "center" | "right" | null)[];
  /** index in rows of the delimiter row is removed; header is rows[0] */
}

/** Split one table line into cells with offsets (relative to the line start). */
export function splitRow(line: string): { text: string; offset: number }[] {
  const cells: { text: string; offset: number }[] = [];
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i++;
  if (line[i] === "|") i++;
  let start = i;
  let wiki = 0;
  let code = false;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(line[s])) s++;
    while (e > s && /\s/.test(line[e - 1])) e--;
    cells.push({ text: line.slice(s, e), offset: s });
  };
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") code = !code;
    else if (c === "[" && line[i + 1] === "[") wiki++;
    else if (c === "]" && line[i + 1] === "]" && wiki > 0) wiki--;
    else if (c === "|" && !code && wiki === 0) {
      push(i);
      start = i + 1;
    }
  }
  if (line.slice(start).trim() !== "") push(line.length);
  return cells;
}

export function parseTable(text: string): ParsedTable | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  const rows: ParsedTable["rows"] = [];
  let pos = 0;
  const align: ParsedTable["align"] = [];
  lines.forEach((l, idx) => {
    const cells = splitRow(l).map((c) => ({ text: c.text, offset: pos + c.offset }));
    if (idx === 1) {
      for (const c of cells) {
        const t = c.text.trim();
        const left = t.startsWith(":");
        const right = t.endsWith(":");
        align.push(left && right ? "center" : right ? "right" : left ? "left" : null);
      }
    } else rows.push(cells);
    pos += l.length + 1;
  });
  return { rows, align };
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly env: WidgetEnv) {
    super();
  }
  eq(o: TableWidget): boolean {
    return o.source === this.source && o.env.getSourcePath() === this.env.getSourcePath();
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-widget";
    const parsed = parseTable(this.source);
    if (!parsed) {
      wrap.textContent = this.source;
      return wrap;
    }
    const ctx = makeRenderContext(this.env.host, this.env.getSourcePath());
    const table = document.createElement("table");
    const mk = (tag: "th" | "td", cell: { text: string; offset: number }, col: number) => {
      const el = document.createElement(tag);
      el.innerHTML = renderInline(cell.text.replace(/\\\|/g, "|"), ctx);
      const a = parsed.align[col];
      if (a) el.style.textAlign = a;
      el.setAttribute("data-offset", String(cell.offset));
      return el;
    };
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    parsed.rows[0].forEach((c, i) => htr.appendChild(mk("th", c, i)));
    thead.appendChild(htr);
    const tbody = document.createElement("tbody");
    for (const row of parsed.rows.slice(1)) {
      const tr = document.createElement("tr");
      row.forEach((c, i) => tr.appendChild(mk("td", c, i)));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);
    wrap.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      const link = t.closest("a.internal-link");
      if (link && (e.ctrlKey || e.metaKey || e.button === 0)) {
        e.preventDefault();
        this.env.host.openLink(link.getAttribute("data-href") ?? "", this.env.getSourcePath(), e.ctrlKey || e.metaKey);
        return;
      }
      const cell = t.closest("th, td");
      const base = view.posAtDOM(wrap);
      const off = cell ? Number(cell.getAttribute("data-offset")) : 0;
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(base + off, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// ------------------------------------------------------------------ plugin-rendered code blocks

export class CodeBlockWidget extends WidgetType {
  constructor(readonly source: string, readonly lang: string, readonly env: WidgetEnv) {
    super();
  }
  eq(o: CodeBlockWidget): boolean {
    return o.source === this.source && o.lang === this.lang && o.env.getSourcePath() === this.env.getSourcePath();
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-embed-block cm-code-block-widget block-language-wrapper";
    el.setAttribute("data-language", this.lang);
    const body = el.appendChild(document.createElement("div"));
    body.className = "cm-code-block-widget-body";
    const edit = el.appendChild(document.createElement("div"));
    edit.className = "edit-block-button";
    edit.setAttribute("aria-label", "Edit this block");
    edit.textContent = "</>";
    edit.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ selection: { anchor: Math.min(view.posAtDOM(el) + 1, view.state.doc.length) } });
      view.focus();
    });
    const done = () => view.requestMeasure();
    try {
      const r = this.env.host.renderCodeBlock?.(body, this.source, this.env.getSourcePath());
      const keep = (h: { unload(): void } | void) => { (el as any)._handle = h; done(); };
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<{ unload(): void } | void>).then(keep, done);
      else keep(r as { unload(): void } | void);
    } catch (e) {
      body.textContent = String(e);
    }
    return el;
  }
  destroy(dom: HTMLElement): void {
    try { (dom as any)._handle?.unload?.(); } catch { /* ignore */ }
  }
  ignoreEvent(): boolean {
    return true;
  }
}

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
