import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownConfig, BlockContext, Line, InlineContext } from "@lezer/markdown";
import { LanguageDescription } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { hypermdCompat } from "./tokens";

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
const TAG_RE = /^#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/u;

function readAhead(cx: BlockContext, from: number, max = 60000): string {
  const input = (cx as any).input as { length: number; read(a: number, b: number): string } | undefined;
  if (!input) return "";
  return input.read(from, Math.min(input.length, from + max));
}

function wikilink(kind: "Wikilink" | "Embed"): (cx: InlineContext, next: number, pos: number) => number {
  const open = kind === "Embed" ? 3 : 2;
  return (cx, next, pos) => {
    if (kind === "Embed") {
      if (next !== 33 || cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
    } else if (next !== 91 || cx.char(pos + 1) !== 91) return -1;
    let end = -1;
    for (let i = pos + open; i < cx.end - 1; i++) {
      const c = cx.char(i);
      if (c === 93 && cx.char(i + 1) === 93) {
        end = i;
        break;
      }
      if (c === 91 || c === 10) return -1;
    }
    if (end < 0 || end === pos + open) return -1;
    const kids = [cx.elt("WikiLinkMark", pos, pos + open)];
    let pipe = -1;
    for (let i = pos + open; i < end; i++) {
      if (cx.char(i) === 124) {
        pipe = i;
        break;
      }
    }
    if (pipe < 0) kids.push(cx.elt("WikiLinkTarget", pos + open, end));
    else {
      const pipeFrom = cx.char(pipe - 1) === 92 ? pipe - 1 : pipe;
      kids.push(cx.elt("WikiLinkTarget", pos + open, pipeFrom));
      kids.push(cx.elt("WikiLinkPipe", pipeFrom, pipe + 1));
      kids.push(cx.elt("WikiLinkAlias", pipe + 1, end));
    }
    kids.push(cx.elt("WikiLinkMark", end, end + 2));
    return cx.addElement(cx.elt(kind, pos, end + 2, kids));
  };
}

export const obsidianSyntax: MarkdownConfig = {
  defineNodes: [
    "Wikilink", "Embed", "WikiLinkMark", "WikiLinkTarget", "WikiLinkPipe", "WikiLinkAlias",
    "Tag", "TagMark", "Highlight", "HighlightMark", "ObsComment", "ObsCommentMark",
    "MathInline", "MathMark", "FootnoteRef",
    { name: "Frontmatter", block: true },
    { name: "MathBlock", block: true },
    { name: "ObsCommentBlock", block: true },
  ],
  parseInline: [
    { name: "Wikilink", parse: wikilink("Wikilink"), before: "Link" },
    { name: "Embed", parse: wikilink("Embed"), before: "Image" },
    {
      name: "FootnoteRef",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
        const m = /^\[\^[^\]\s]+\]/.exec(cx.slice(pos, Math.min(cx.end, pos + 80)));
        return m ? cx.addElement(cx.elt("FootnoteRef", pos, pos + m[0].length)) : -1;
      },
    },
    {
      name: "Tag",
      parse(cx, next, pos) {
        if (next !== 35) return -1;
        if (pos > cx.offset && /[\p{L}\p{N}/&#\\]/u.test(cx.slice(pos - 1, pos))) return -1;
        const m = TAG_RE.exec(cx.slice(pos, Math.min(cx.end, pos + 200)));
        if (!m) return -1;
        return cx.addElement(cx.elt("Tag", pos, pos + m[0].length, [cx.elt("TagMark", pos, pos + 1)]));
      },
    },
    {
      name: "Highlight",
      after: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = pos > cx.offset ? cx.slice(pos - 1, pos) : "";
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter, !sBefore);
      },
    },
    {
      name: "ObsComment",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) {
          if (cx.char(i) === 37 && cx.char(i + 1) === 37) {
            return cx.addElement(
              cx.elt("ObsComment", pos, i + 2, [cx.elt("ObsCommentMark", pos, pos + 2), cx.elt("ObsCommentMark", i, i + 2)]),
            );
          }
        }
        return -1;
      },
    },
    {
      name: "MathInline",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const display = cx.char(pos + 1) === 36;
        const open = display ? 2 : 1;
        const first = cx.slice(pos + open, pos + open + 1);
        if (!first || (!display && (/\s/.test(first) || first === "$"))) return -1;
        for (let i = pos + open; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 92) {
            i++;
            continue;
          }
          if (c !== 36) continue;
          if (display) {
            if (cx.char(i + 1) !== 36) continue;
          } else {
            if (/\s/.test(cx.slice(i - 1, i))) return -1;
            if (/\d/.test(cx.slice(i + 1, i + 2))) return -1;
          }
          if (i === pos + open) return -1;
          return cx.addElement(
            cx.elt("MathInline", pos, i + open, [cx.elt("MathMark", pos, pos + open), cx.elt("MathMark", i, i + open)]),
          );
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: "Frontmatter",
      before: "HorizontalRule",
      parse(cx: BlockContext, line: Line) {
        if (cx.lineStart !== 0 || !/^---[ \t]*$/.test(line.text)) return false;
        const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.exec(readAhead(cx, 0));
        if (!m) return false;
        const end = m[0].length;
        while (cx.nextLine() && cx.lineStart < end) {
          /* consume */
        }
        cx.addElement(cx.elt("Frontmatter", 0, end));
        return true;
      },
    },
    {
      name: "MathBlock",
      before: "ATXHeading",
      parse(cx: BlockContext, line: Line) {
        const t = line.text.slice(line.pos);
        if (!t.startsWith("$$")) return false;
        const from = cx.lineStart + line.pos;
        if (t.length >= 4 && t.trimEnd().endsWith("$$")) {
          const to = cx.lineStart + line.text.length;
          cx.nextLine();
          cx.addElement(cx.elt("MathBlock", from, to));
          return true;
        }
        const ahead = readAhead(cx, cx.lineStart + line.text.length);
        const m = /\n[^\n]*?\$\$[ \t]*(?=\r?\n|$)/.exec(ahead);
        if (!m) return false;
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          if (/\$\$\s*$/.test(line.text)) {
            to = cx.lineStart + line.text.length;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("MathBlock", from, to));
        return true;
      },
    },
    {
      name: "ObsCommentBlock",
      before: "ATXHeading",
      parse(cx: BlockContext, line: Line) {
        const t = line.text.slice(line.pos);
        if (!t.startsWith("%%") || t.indexOf("%%", 2) >= 0) return false;
        const ahead = readAhead(cx, cx.lineStart + line.text.length);
        if (!/%%/.test(ahead)) return false;
        const from = cx.lineStart + line.pos;
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          if (line.text.includes("%%")) {
            to = cx.lineStart + line.text.length;
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("ObsCommentBlock", from, to));
        return true;
      },
    },
  ],
};

// lang-markdown already bundles lang-html (and with it the CSS and JavaScript parsers), so these load statically:
// a dynamic import() of a module that is also imported statically does not split it out of the bundle.
const jsLang = LanguageDescription.of({
  name: "javascript",
  alias: ["js", "jsx", "ts", "tsx", "typescript", "json", "mjs", "cjs"],
  support: javascript({ jsx: true, typescript: true }),
});
const cssLang = LanguageDescription.of({ name: "css", alias: ["scss", "less"], support: css() });
const htmlLang = LanguageDescription.of({ name: "html", alias: ["xml", "svg", "vue"], support: html() });

/** The markdown language with Obsidian syntax extensions (wikilinks, tags, ==hl==, %%c%%, math, callout-aware). */
export function obsidianMarkdown() {
  return markdown({
    base: markdownLanguage,
    extensions: [obsidianSyntax, hypermdCompat],
    codeLanguages: [jsLang, cssLang, htmlLang],
    addKeymap: false,
  });
}
