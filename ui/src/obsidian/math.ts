// KaTeX-backed math rendering (loaded lazily).
import katex from "katex";

let pending: Promise<unknown>[] = [];
export const renderMarkdownMath = {
  renderMath(source: string, display: boolean): HTMLElement {
    const el = document.createElement("span");
    el.className = display ? "math math-block" : "math math-inline";
    try {
      el.innerHTML = katex.renderToString(source, { displayMode: display, throwOnError: false });
    } catch {
      el.textContent = source;
    }
    return el;
  },
  async finishRenderMath(): Promise<void> { const p = pending; pending = []; await Promise.all(p); },
  async loadMathJax(): Promise<void> {},
};
