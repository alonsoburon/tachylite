// Core plugin "Word count": words and characters of the active note (or of the selection) in the status bar.
// Counting: a word is a run of letters/marks/digits (' ’ - may join two parts of a word), numbers keep their , and . separators
// ("1,000.5" is one word); every Han, Hiragana and Katakana character is a word of its own (CJK text has no spaces;
// Hangul is space-separated so it forms runs). Characters are UTF-16 code units of the text after the properties.
import { MarkdownView, TextFileView, debounce, getFrontMatterInfo, type App } from "../../obsidian";
import { whileCoreEnabled, type CoreModule } from "./util";

const ID = "word-count";
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const W = `(?:(?![${CJK}])[\\p{L}\\p{M}\\p{N}_])`;
const WORD = new RegExp(`\\p{N}+(?:[.,]\\p{N}+)+|${W}(?:${W}|['’-](?=${W}))*|[${CJK}]`, "gu");

export function countWords(text: string): number {
  WORD.lastIndex = 0;
  return text.match(WORD)?.length ?? 0;
}

/** Note text without its properties block. */
export function stripFrontmatter(text: string): string {
  const fm = getFrontMatterInfo(text);
  return fm.exists ? text.slice(fm.contentStart) : text;
}

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? "" : "s"}`;

export const wordCount: CoreModule = {
  id: ID,
  install(app: App) {
    return whileCoreEnabled(app, ID, () => {
      const item = app.statusBarEl.createDiv({ cls: "status-bar-item plugin-word-count" });
      const wordEl = item.createSpan({ cls: "status-bar-item-segment" });
      const charEl = item.createSpan({ cls: "status-bar-item-segment" });
      item.hide();
      const show = (text: string) => {
        wordEl.setText(plural(countWords(text), "word"));
        charEl.setText(plural(text.length, "character"));
      };
      const render = () => {
        const v = app.workspace.getActiveViewOfType(TextFileView);
        const f = v?.file;
        const md = !!f && f.extension === "md";
        item.toggle(!!v && (md || !!(v as any).isPlaintext));
        if (!v || !f) return;
        const sel = v instanceof MarkdownView && v.getMode() !== "preview" ? v.editor?.getSelection() : "";
        show(sel ? sel : md ? stripFrontmatter(v.getViewData()) : v.getViewData());
      };
      const update = debounce(render, 200, true);
      const ws = app.workspace;
      const refs = [ws.on("file-open", update), ws.on("active-leaf-change", update), ws.on("editor-change", update), ws.on("editor-selection-change", update), ws.on("layout-change", update)];
      render();
      return () => { refs.forEach((r) => ws.offref(r)); update.cancel(); item.detach(); };
    });
  },
};
