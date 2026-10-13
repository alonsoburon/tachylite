// Compatibility layer for plugins written against Obsidian's HyperMD-flavoured CM6 markdown mode.
// Obsidian attaches CM5-style token classes (space separated, e.g. "formatting formatting-code inline-code") to every
// syntax node type through `tokenClassNodeProp`, which its build of `@codemirror/language` exports. Plugins read it with
// `node.type.prop(tokenClassNodeProp)`; Dataview's inline-query extension, for instance, looks for a node whose classes
// contain `inline-code` but not `formatting`, i.e. the code *content* between the backticks, and replaces
// `[from - 1, to + 1)` with its widget. Obsidian's node names are those classes joined by `_` (latex-suite tests
// `name.contains("inline-code")`), so the content node is named `inline-code` here as well.
import { NodeProp } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";

/** Token classes (CM5 naming, space separated) of a node type, as in Obsidian's `@codemirror/language`. */
export const tokenClassNodeProp = new NodeProp<string>();

/** Node holding the text between the backticks of an inline code span. */
export const INLINE_CODE_TEXT = "inline-code";

/** Token classes per node type; container nodes carry the class their content gets in Obsidian's mode. */
const TOKEN_CLASSES: Record<string, string> = {
  [INLINE_CODE_TEXT]: "inline-code",
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "strikethrough",
  Highlight: "highlight",
  ObsComment: "comment",
  Tag: "hashtag",
  MathInline: "math",
  Wikilink: "hmd-internal-link",
  URL: "url",
  FootnoteRef: "footref",
};

/** Same rules as the CommonMark inline-code parser, plus a content child between the two `CodeMark`s. */
export const hypermdCompat: MarkdownConfig = {
  defineNodes: [INLINE_CODE_TEXT],
  props: [tokenClassNodeProp.add((type) => TOKEN_CLASSES[type.name])],
  parseInline: [{
    name: "InlineCode",
    parse(cx, next, start) {
      if (next !== 96 || (start && cx.char(start - 1) === 96)) return -1;
      let pos = start + 1;
      while (pos < cx.end && cx.char(pos) === 96) pos++;
      const size = pos - start;
      let run = 0;
      for (; pos < cx.end; pos++) {
        if (cx.char(pos) !== 96) { run = 0; continue; }
        if (++run !== size || cx.char(pos + 1) === 96) continue;
        const open = start + size, close = pos + 1 - size;
        const kids = [cx.elt("CodeMark", start, open)];
        if (close > open) kids.push(cx.elt(INLINE_CODE_TEXT, open, close));
        kids.push(cx.elt("CodeMark", close, pos + 1));
        return cx.addElement(cx.elt("InlineCode", start, pos + 1, kids));
      }
      return -1;
    },
  }],
};
