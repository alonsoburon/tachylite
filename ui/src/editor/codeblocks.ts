// Live Preview widget for fenced blocks whose language a plugin claims (`registerMarkdownCodeBlockProcessor`).
import { WidgetType, type EditorView } from "@codemirror/view";
import type { CodeBlockRenderInfo } from "./types";
import type { WidgetEnv } from "./widgets";

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/;

/** Split a fenced block (```lang ... ```) into its language and body, the way reading view hands it to processors. */
export function splitFence(block: string): { lang: string; source: string } {
  const lines = block.split("\n");
  const m = FENCE_OPEN.exec(lines[0] ?? "");
  const fence = m?.[1] ?? "```";
  const last = lines.length > 1 ? lines[lines.length - 1] : null;
  const closed = last !== null && new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(last);
  return { lang: m?.[2] ?? "", source: lines.slice(1, closed ? -1 : undefined).join("\n") };
}

interface Rendered { unload?(): void }
/** Per-DOM render state: the plugin component is unloaded when CM destroys the widget, even mid-render. */
const live = new WeakMap<HTMLElement, { handle: Rendered | void; dead: boolean }>();

export class CodeBlockWidget extends WidgetType {
  readonly sourcePath: string;
  /** `from`: document offset of the fence when the widget was built (section info before the DOM is attached). */
  constructor(readonly source: string, readonly lang: string, readonly env: WidgetEnv, readonly from = -1) {
    super();
    this.sourcePath = env.getSourcePath();
  }
  eq(o: CodeBlockWidget): boolean {
    return o.source === this.source && o.lang === this.lang && o.sourcePath === this.sourcePath;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-preview-code-block cm-embed-block markdown-rendered cm-lang-${this.lang} cm-code-block-widget block-language-wrapper`;
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
    const state = { handle: undefined as Rendered | void, dead: false };
    live.set(el, state);
    const info: CodeBlockRenderInfo = {
      // Line numbers are 0-based and refer to the whole note (`text`), like Obsidian's section info.
      getSectionInfo: () => {
        let pos = this.from;
        if (el.isConnected) try { pos = view.posAtDOM(el); } catch { /* keep the build-time offset */ }
        const doc = view.state.doc;
        if (pos < 0 || pos > doc.length) return null;
        const first = doc.lineAt(pos).number - 1;
        return { text: doc.toString(), lineStart: first, lineEnd: first + this.source.split("\n").length - 1 };
      },
    };
    const keep = (h: Rendered | void) => {
      if (state.dead) { try { h?.unload?.(); } catch { /* ignore */ } return; }
      state.handle = h;
      view.requestMeasure();
    };
    try {
      const r = this.env.host.renderCodeBlock?.(body, this.source, this.sourcePath, info);
      if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<Rendered | void>).then(keep, (e) => { body.textContent = String(e); });
      else keep(r as Rendered | void);
    } catch (e) {
      body.textContent = String(e);
    }
    return el;
  }
  destroy(dom: HTMLElement): void {
    const state = live.get(dom);
    if (!state) return;
    state.dead = true;
    try { state.handle?.unload?.(); } catch { /* ignore */ }
    state.handle = undefined;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
