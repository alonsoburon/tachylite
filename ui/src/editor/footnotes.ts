// Inline footnotes `^[text]` in the editor: the lezer inline parser, Live Preview's superscript marker, and the
// footnote numbering it shows (document order, shared with `[^id]` references that have a definition, the way the
// reading view and markdown-it-footnote number them).
import { WidgetType } from "@codemirror/view";
import type { EditorState, Text } from "@codemirror/state";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { fullTree } from "./util";

/** `^[` ... `]` with balanced brackets (so `^[see [[Note]]]` works); `\]` is literal. */
export const inlineFootnoteSyntax: MarkdownConfig = {
  defineNodes: ["InlineFootnote", "InlineFootnoteMark"],
  parseInline: [{
    name: "InlineFootnote",
    before: "Link",
    parse(cx: InlineContext, next: number, pos: number) {
      if (next !== 94 || cx.char(pos + 1) !== 91) return -1;
      let depth = 0;
      for (let i = pos + 1; i < cx.end; i++) {
        const c = cx.char(i);
        if (c === 92) {
          i++;
          continue;
        }
        if (c === 91) depth++;
        else if (c === 93 && --depth === 0) {
          if (i === pos + 2) return -1;
          return cx.addElement(cx.elt("InlineFootnote", pos, i + 1, [cx.elt("InlineFootnoteMark", pos, pos + 2), cx.elt("InlineFootnoteMark", i, i + 1)]));
        }
      }
      return -1;
    },
  }],
};

const numbering = new WeakMap<Text, Map<number, number>>();

/** Footnote number of the inline footnote starting at `pos` (1-based), cached per document version. */
export function footnoteNumber(state: EditorState, pos: number): number {
  let map = numbering.get(state.doc);
  if (!map) {
    map = new Map();
    const doc = state.doc;
    const defs = new Set<string>();
    for (const m of doc.toString().matchAll(/^ {0,3}\[\^([^\]\s]+)\]:/gm)) defs.add(m[1].toLowerCase());
    const seen = new Set<string>();
    let n = 0;
    const out = map;
    fullTree(state).iterate({
      enter: (node) => {
        if (node.name === "InlineFootnote") {
          out.set(node.from, ++n);
          return false;
        }
        if (node.name === "FootnoteRef") {
          const id = doc.sliceString(node.from + 2, node.to - 1).toLowerCase();
          const isLabel = doc.sliceString(node.to, node.to + 1) === ":" && /^ {0,3}$/.test(doc.sliceString(doc.lineAt(node.from).from, node.from));
          if (!isLabel && defs.has(id) && !seen.has(id)) {
            seen.add(id);
            n++;
          }
          return false;
        }
        return node.name !== "FencedCode" && node.name !== "CodeBlock" && node.name !== "InlineCode";
      },
    });
    numbering.set(doc, map);
  }
  return map.get(pos) ?? 0;
}

export class InlineFootnoteWidget extends WidgetType {
  constructor(readonly n: number, readonly text: string) {
    super();
  }
  eq(o: InlineFootnoteWidget): boolean {
    return o.n === this.n && o.text === this.text;
  }
  toDOM(): HTMLElement {
    const sup = document.createElement("sup");
    sup.className = "footnote-ref cm-inline-footnote-widget";
    sup.title = this.text;
    const a = sup.appendChild(document.createElement("span"));
    a.className = "footnote-link";
    a.textContent = `[${this.n || "*"}]`;
    return sup;
  }
  ignoreEvent(): boolean {
    return false;
  }
}
