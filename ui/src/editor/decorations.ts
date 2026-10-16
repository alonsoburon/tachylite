import {
  Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate,
} from "@codemirror/view";
import { EditorState, Facet, StateEffect, StateField, type Range, type Text } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  BulletWidget, CalloutIconWidget, CheckboxWidget, CodeBlockWidget, EmbedWidget, FrontmatterWidget, HrWidget, ImageWidget,
  MathWidget, TableWidget, type WidgetEnv,
} from "./widgets";
import { fileExt, fullTree, selectionTouches, selectionTouchesLines, splitLink } from "./util";
import { InlineFootnoteWidget, footnoteNumber } from "./footnotes";
import { splitFrontmatter } from "../markdown";

/** Environment (host + source path) shared by decorations, widgets, autocomplete. */
export const envFacet = Facet.define<WidgetEnv, WidgetEnv>({
  combine: (v) => v[0],
});

interface LineAcc {
  classes: Set<string>;
  attrs: Record<string, string>;
  style: string[];
}

const SAFE_URL = /^(https?|data|blob|file|app|asset|tauri|capacitor):/i;

function listDepth(node: SyntaxNode): number {
  let d = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") d++;
  return d;
}
function quoteDepth(node: SyntaxNode): number {
  let d = 1;
  for (let p = node.parent; p; p = p.parent) if (p.name === "Blockquote") d++;
  return d;
}

interface CalloutInfo {
  type: string;
  fold: string;
  title: string;
}

function calloutOf(doc: Text, node: SyntaxNode): CalloutInfo | null {
  const first = doc.lineAt(node.from);
  const depth = quoteDepth(node);
  const re = new RegExp(`^\\s*(?:>\\s*){${depth}}\\[!([^\\]\\s]+)\\]([+-])?[ \\t]*(.*)$`);
  const m = re.exec(first.text);
  return m ? { type: m[1].toLowerCase(), fold: m[2] ?? "", title: m[3] ?? "" } : null;
}

export function buildInline(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
  live: boolean,
  env: WidgetEnv,
): DecorationSet {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const lines = new Map<number, LineAcc>();
  const codeLines = new Set<number>();
  const tabSize = state.tabSize;

  const addLine = (pos: number, cls: string, attrs?: Record<string, string>, style?: string) => {
    let a = lines.get(pos);
    if (!a) lines.set(pos, (a = { classes: new Set(), attrs: {}, style: [] }));
    for (const c of cls.split(" ")) if (c) a.classes.add(c);
    if (attrs) Object.assign(a.attrs, attrs);
    if (style) a.style.push(style);
  };
  const forLines = (from: number, to: number, cb: (l: { from: number; to: number; text: string; number: number }, i: number) => void) => {
    let l = doc.lineAt(from);
    let i = 0;
    for (;;) {
      cb(l, i++);
      if (l.to >= to || l.number >= doc.lines) break;
      l = doc.line(l.number + 1);
    }
  };
  const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>) => {
    if (to > from) out.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to));
  };
  // A plugin's replace decoration may not cover a line break, so a hidden range that spans lines is hidden line by line.
  const hide = (from: number, to: number) => {
    if (to <= from) return;
    for (let pos = from; pos < to;) {
      const line = doc.lineAt(pos);
      const end = Math.min(to, line.to);
      if (end > pos) out.push(Decoration.replace({}).range(pos, end));
      pos = line.to + 1;
    }
  };
  const touches = (f: number, t: number) => selectionTouches(state, f, t);
  const lineActive = (f: number, t: number) => selectionTouchesLines(state, f, t);
  const sourcePath = env.getSourcePath();
  const calloutCache = new Map<number, CalloutInfo | null>();
  const calloutFor = (n: SyntaxNode) => {
    if (!calloutCache.has(n.from)) calloutCache.set(n.from, calloutOf(doc, n));
    return calloutCache.get(n.from)!;
  };

  for (const r of state.selection.ranges) forLines(r.from, r.to, (l) => addLine(l.from, "cm-active"));

  const tree = syntaxTree(state);
  for (const vr of ranges) {
    tree.iterate({
      from: vr.from,
      to: vr.to,
      enter: (ref) => {
        const name = ref.name;
        const from = ref.from;
        const to = ref.to;
        const node = ref.node;

        switch (name) {
          case "Frontmatter": {
            if (live && !touches(from, to)) return false;
            forLines(from, to, (l) => addLine(l.from, "cm-hmd-frontmatter HyperMD-frontmatter cm-frontmatter"));
            return false;
          }
          case "Table": {
            if (live && node.parent?.name === "Document" && !touches(doc.lineAt(from).from, doc.lineAt(to).to)) return false;
            forLines(from, to, (l, i) => addLine(l.from, `HyperMD-table-row HyperMD-table-row-${i === 0 ? 0 : i === 1 ? 0 : i - 1}${i === 0 ? " HyperMD-table-header" : ""}`));
            return true;
          }
          case "TableDelimiter":
            mark(from, to, "cm-formatting cm-formatting-table cm-table-sep");
            return false;
          case "MathBlock": {
            const f = doc.lineAt(from).from;
            const t = doc.lineAt(to).to;
            if (live && node.parent?.name === "Document" && !touches(f, t)) return false;
            forLines(from, to, (l) => addLine(l.from, "HyperMD-math cm-math"));
            return false;
          }
          case "ObsCommentBlock": {
            forLines(from, to, (l) => addLine(l.from, "cm-comment-block"));
            mark(from, to, "cm-comment");
            if (live && !touches(from, to)) {
              hide(from, from + 2);
              hide(to - 2, to);
            }
            return false;
          }
          case "ATXHeading1": case "ATXHeading2": case "ATXHeading3":
          case "ATXHeading4": case "ATXHeading5": case "ATXHeading6":
          case "SetextHeading1": case "SetextHeading2": {
            const lvl = Number(name.slice(-1));
            forLines(from, to, (l) => addLine(l.from, `HyperMD-header HyperMD-header-${lvl}`));
            if (name.startsWith("ATX")) {
              const marks = node.getChildren("HeaderMark");
              if (marks.length) {
                const first = marks[0];
                const last = marks.length > 1 ? marks[marks.length - 1] : null;
                const cf = first.to + (doc.sliceString(first.to, first.to + 1) === " " ? 1 : 0);
                mark(cf, last ? last.from : to, `cm-header cm-header-${lvl}`);
                const cls = `cm-formatting cm-formatting-header cm-formatting-header-${lvl} cm-header cm-header-${lvl}`;
                if (live && !lineActive(from, to)) hide(first.from, cf);
                else mark(first.from, cf, cls);
                if (last) mark(last.from, last.to, cls);
              }
              return true;
            }
            // the whole text (all lines above the underline), not just the first inline child
            const under = node.getChildren("HeaderMark").pop();
            mark(from, under ? Math.max(from, doc.lineAt(under.from).from - 1) : to, `cm-header cm-header-${lvl}`);
            for (const m of node.getChildren("HeaderMark")) mark(m.from, m.to, `cm-formatting cm-formatting-header cm-header cm-header-${lvl}`);
            return true;
          }
          case "Paragraph": {
            const l = doc.lineAt(from);
            if (/^\[\^[^\]\s]+\]:/.test(l.text)) addLine(l.from, "HyperMD-footnote");
            return true;
          }
          case "Blockquote": {
            const depth = quoteDepth(node);
            const callout = calloutFor(node);
            const lineCount = doc.lineAt(to).number - doc.lineAt(from).number;
            forLines(from, to, (l, i) => {
              addLine(l.from, `HyperMD-quote HyperMD-quote-${depth}`);
              if (callout) {
                addLine(l.from, `HyperMD-callout ${i === 0 ? "cm-callout-title" : "cm-callout-content"}${i === lineCount ? " cm-callout-last" : ""}`, {
                  "data-callout": callout.type,
                  "data-callout-fold": callout.fold,
                });
                if (i === 0 && !callout.title) addLine(l.from, "cm-callout-title-empty", { "data-callout-title": callout.type.charAt(0).toUpperCase() + callout.type.slice(1) });
              }
            });
            if (callout && live && !touches(from, to)) {
              const l = doc.lineAt(from);
              const idx = l.text.indexOf("[!");
              if (idx >= 0) {
                const end = l.from + idx + 2 + callout.type.length + 1 + callout.fold.length;
                out.push(Decoration.replace({ widget: new CalloutIconWidget(callout.type) }).range(l.from + idx, end));
              }
            }
            return true;
          }
          case "QuoteMark": {
            const bq = node.parent;
            const callout = bq ? calloutFor(bq) : null;
            const end = to + (doc.sliceString(to, to + 1) === " " ? 1 : 0);
            const active = callout && bq ? touches(bq.from, bq.to) : lineActive(from, to);
            if (live && !active) hide(from, end);
            else mark(from, to, "cm-formatting cm-formatting-quote cm-quote");
            return false;
          }
          case "ListItem": {
            const d = listDepth(node);
            const l = doc.lineAt(from);
            const lm = node.getChild("ListMark");
            let style: string | undefined;
            if (lm) {
              const pre = doc.sliceString(l.from, lm.from);
              let cols = 0;
              for (const ch of pre) cols += ch === "\t" ? tabSize : 1;
              const total = cols + (lm.to - lm.from) + 1;
              style = `--list-hang: ${total}ch`;
            }
            addLine(l.from, `HyperMD-list-line HyperMD-list-line-${d}`, undefined, style);
            return true;
          }
          case "Task": {
            const tm = node.getChild("TaskMarker");
            const l = doc.lineAt(from);
            const ch = tm ? doc.sliceString(tm.from + 1, tm.from + 2) : " ";
            addLine(l.from, "HyperMD-task-line", { "data-task": ch });
            return true;
          }
          case "ListMark": {
            if (node.parent?.name !== "ListItem") return false;
            const text = doc.sliceString(from, to);
            const d = listDepth(node);
            const ul = /^[-*+]$/.test(text);
            // Task items show only the checkbox in place of the bullet (ordered ones keep their number).
            const taskMark = node.parent?.getChild("Task")?.getChild("TaskMarker");
            if (ul && live && taskMark && !touches(from, taskMark.to)) {
              out.push(Decoration.replace({}).range(from, taskMark.from));
            } else if (ul && live && !touches(from, to)) {
              out.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
            } else {
              mark(from, to, `cm-formatting cm-formatting-list ${ul ? "cm-formatting-list-ul" : "cm-formatting-list-ol"} cm-list-${d}`);
            }
            return false;
          }
          case "TaskMarker": {
            const ch = doc.sliceString(from + 1, from + 2);
            const listMark = node.parent?.parent?.getChild("ListMark");
            const hidesBullet = !!listMark && /^[-*+]$/.test(doc.sliceString(listMark.from, listMark.to));
            if (live && !touches(hidesBullet ? listMark!.from : from, to)) out.push(Decoration.replace({ widget: new CheckboxWidget(ch) }).range(from, to));
            else mark(from, to, "cm-formatting cm-formatting-task cm-meta");
            return false;
          }
          case "FencedCode": {
            const first = doc.lineAt(from);
            const lastLine = doc.lineAt(to);
            const marks = node.getChildren("CodeMark");
            const closed = marks.length >= 2 && marks[marks.length - 1].from >= lastLine.from && lastLine.number > first.number;
            const info = node.getChild("CodeInfo");
            const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : "";
            const hidden = live && !touches(from, to);
            forLines(from, to, (l) => {
              addLine(l.from, "HyperMD-codeblock HyperMD-codeblock-bg cm-hmd-codeblock");
              codeLines.add(l.from);
              if (l.number === first.number) addLine(l.from, "HyperMD-codeblock-begin", { "data-lang": lang });
              if (closed && l.number === lastLine.number) addLine(l.from, "HyperMD-codeblock-end");
            });
            if (hidden) {
              hide(first.from, first.to);
              if (closed) hide(lastLine.from, lastLine.to);
            } else {
              for (const m of marks) mark(m.from, m.to, "cm-formatting cm-formatting-code-block cm-comment");
              if (info) mark(info.from, info.to, "cm-codeblock-lang cm-hmd-codeblock");
            }
            return false;
          }
          case "CodeBlock": {
            forLines(from, to, (l) => {
              addLine(l.from, "HyperMD-codeblock HyperMD-codeblock-bg");
              codeLines.add(l.from);
            });
            return false;
          }
          case "InlineCode": {
            const marks = node.getChildren("CodeMark");
            if (marks.length < 2) return false;
            mark(marks[0].to, marks[marks.length - 1].from, "cm-inline-code");
            const hidden = live && !touches(from, to);
            for (const m of [marks[0], marks[marks.length - 1]]) {
              if (hidden) hide(m.from, m.to);
              else mark(m.from, m.to, "cm-formatting cm-formatting-code cm-inline-code");
            }
            return false;
          }
          case "Emphasis": case "StrongEmphasis": case "Strikethrough": case "Highlight": {
            const spec =
              name === "Emphasis" ? ["cm-em", "cm-formatting-em", "EmphasisMark"]
              : name === "StrongEmphasis" ? ["cm-strong", "cm-formatting-strong", "EmphasisMark"]
              : name === "Strikethrough" ? ["cm-strikethrough", "cm-formatting-strikethrough", "StrikethroughMark"]
              : ["cm-highlight", "cm-formatting-highlight", "HighlightMark"];
            const marks = node.getChildren(spec[2]);
            if (marks.length < 2) return true;
            const a = marks[0];
            const b = marks[marks.length - 1];
            mark(a.to, b.from, spec[0]);
            const hidden = live && !touches(from, to);
            for (const m of [a, b]) {
              if (hidden) hide(m.from, m.to);
              else mark(m.from, m.to, `cm-formatting ${spec[1]} ${spec[0]}`);
            }
            return true;
          }
          case "Link": {
            const marks = node.getChildren("LinkMark");
            const url = node.getChild("URL");
            if (marks.length >= 4 && url) {
              const raw = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
              const hidden = live && !touches(from, to);
              mark(marks[0].to, marks[1].from, "cm-link", { "data-url": raw });
              if (hidden) {
                hide(marks[0].from, marks[0].to);
                hide(marks[1].from, to);
              } else {
                for (const m of marks) mark(m.from, m.to, "cm-formatting cm-formatting-link cm-link");
                mark(url.from, url.to, "cm-url");
                const title = node.getChild("LinkTitle");
                if (title) mark(title.from, title.to, "cm-string");
              }
              // keep walking into the label only
              return true;
            }
            mark(from, to, "cm-link");
            return true;
          }
          case "LinkMark": case "LinkTitle": case "LinkLabel":
            return false;
          case "URL":
            if (node.parent?.name !== "Link" && node.parent?.name !== "Image") mark(from, to, "cm-url");
            return false;
          case "Autolink":
            mark(from, to, "cm-url cm-link");
            return false;
          case "Image": {
            const marks = node.getChildren("LinkMark");
            const url = node.getChild("URL");
            if (marks.length >= 4 && url) {
              if (live && !touches(from, to) && doc.lineAt(from).to >= to) {
                const alt0 = doc.sliceString(marks[0].to, marks[1].from);
                const m = /\|(\d+)(?:x(\d+))?\s*$/.exec(alt0);
                const alt = m ? alt0.slice(0, m.index) : alt0;
                let src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
                if (!SAFE_URL.test(src)) {
                  let p = src;
                  try { p = decodeURIComponent(src); } catch { /* keep */ }
                  const resolved = env.host.resolveLink(p, sourcePath);
                  if (resolved !== null) src = env.host.getResourceUrl(resolved);
                }
                out.push(Decoration.replace({ widget: new ImageWidget(src, alt, m ? m[1] : null, m && m[2] ? m[2] : null) }).range(from, to));
                return false;
              }
              for (const m of marks) mark(m.from, m.to, "cm-formatting cm-formatting-image cm-image-marker");
              mark(url.from, url.to, "cm-url");
            }
            return false;
          }
          case "Wikilink": case "Embed": {
            const marks = node.getChildren("WikiLinkMark");
            const target = node.getChild("WikiLinkTarget");
            if (marks.length < 2 || !target) return false;
            const pipe = node.getChild("WikiLinkPipe");
            const alias = node.getChild("WikiLinkAlias");
            const linktext = doc.sliceString(target.from, target.to).trim();
            const aliasText = alias ? doc.sliceString(alias.from, alias.to) : "";
            const isEmbed = name === "Embed";
            if (isEmbed && live && !touches(from, to)) {
              out.push(Decoration.replace({ widget: new EmbedWidget(linktext, aliasText, env) }).range(from, to));
              return false;
            }
            const { path } = splitLink(linktext);
            const resolved = path ? env.host.resolveLink(path, sourcePath) !== null : true;
            const cls = `cm-hmd-internal-link cm-link${resolved ? "" : " is-unresolved"}`;
            const attrs: Record<string, string> = { "data-href": linktext };
            const open = marks[0];
            const close = marks[1];
            if (live && !touches(from, to)) {
              attrs["data-lp"] = "1";
              hide(open.from, open.to);
              if (alias && pipe) {
                hide(target.from, pipe.to);
                mark(alias.from, alias.to, cls + " cm-link-alias", attrs);
              } else mark(target.from, target.to, cls, attrs);
              hide(close.from, close.to);
            } else {
              const fmt = `cm-formatting cm-formatting-link ${isEmbed ? "cm-formatting-embed " : ""}`;
              mark(open.from, open.to, fmt + "cm-formatting-link-start");
              mark(target.from, target.to, cls + (alias ? " cm-link-has-alias" : ""), attrs);
              if (pipe) mark(pipe.from, pipe.to, "cm-formatting cm-formatting-link-pipe");
              if (alias) mark(alias.from, alias.to, cls + " cm-link-alias", attrs);
              mark(close.from, close.to, fmt + "cm-formatting-link-end");
            }
            return false;
          }
          case "Tag": {
            const text = doc.sliceString(from + 1, to);
            mark(from, from + 1, "cm-formatting cm-formatting-hashtag cm-hashtag cm-hashtag-begin cm-meta", { "data-tag": text });
            mark(from + 1, to, "cm-hashtag cm-hashtag-end", { "data-tag": text });
            return false;
          }
          case "ObsComment": {
            const marks = node.getChildren("ObsCommentMark");
            if (marks.length < 2) return false;
            mark(marks[0].to, marks[1].from, "cm-comment");
            const hidden = live && !touches(from, to);
            for (const m of marks) {
              if (hidden) hide(m.from, m.to);
              else mark(m.from, m.to, "cm-formatting cm-formatting-comment cm-comment");
            }
            return false;
          }
          case "MathInline": {
            const marks = node.getChildren("MathMark");
            if (marks.length < 2) return false;
            const tex = doc.sliceString(marks[0].to, marks[1].from);
            // A plugin decoration can't replace a line break, so `$$` math that spans lines inside a paragraph stays source.
            if (live && !touches(from, to) && !tex.includes("\n")) {
              out.push(Decoration.replace({ widget: new MathWidget(tex, marks[0].to - marks[0].from === 2) }).range(from, to));
            } else {
              mark(marks[0].to, marks[1].from, "cm-math");
              for (const m of marks) mark(m.from, m.to, "cm-formatting cm-formatting-math cm-math");
            }
            return false;
          }
          case "FootnoteRef":
            mark(from, to, "cm-footref cm-hmd-footnote");
            return false;
          case "InlineFootnote": {
            const fm = node.getChildren("InlineFootnoteMark");
            if (fm.length < 2) return false;
            if (live && !touches(from, to) && doc.lineAt(from).to >= to) {
              out.push(Decoration.replace({ widget: new InlineFootnoteWidget(footnoteNumber(state, from), doc.sliceString(fm[0].to, fm[1].from)) }).range(from, to));
              return false;
            }
            mark(fm[0].to, fm[1].from, "cm-inline-footnote");
            for (const m of fm) mark(m.from, m.to, "cm-formatting cm-formatting-inline-footnote cm-inline-footnote");
            return false;
          }
          case "HorizontalRule": {
            const l = doc.lineAt(from);
            addLine(l.from, "HyperMD-hr");
            if (live && !lineActive(from, to) && node.parent?.name === "Document") out.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
            else mark(from, to, "cm-hr");
            return false;
          }
          default:
            return true;
        }
      },
    });

    // block ids (outside fenced code)
    let l = doc.lineAt(vr.from);
    for (;;) {
      if (!codeLines.has(l.from)) {
        const m = /(?:^|\s)(\^[A-Za-z0-9-]+)\s*$/.exec(l.text);
        if (m) {
          const s = l.from + m.index + m[0].indexOf("^");
          mark(s, s + m[1].length, "cm-blockid cm-hmd-blockid");
        }
      }
      if (l.to >= vr.to || l.number >= doc.lines) break;
      l = doc.line(l.number + 1);
    }
  }

  for (const [pos, a] of lines) {
    const attrs: Record<string, string> = { ...a.attrs };
    if (a.style.length) attrs.style = a.style.join(";");
    out.push(Decoration.line({ class: [...a.classes].join(" "), attributes: attrs }).range(pos));
  }
  return Decoration.set(out, true);
}

export function inlinePlugin(live: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInline(view.state, view.visibleRanges, live, view.state.facet(envFacet));
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.state) !== syntaxTree(u.startState)) {
          this.decorations = buildInline(u.state, u.view.visibleRanges, live, u.state.facet(envFacet));
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

// ------------------------------------------------------------------ block widgets (StateField)

export function buildBlocks(state: EditorState, env: WidgetEnv): DecorationSet {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  fullTreeIterate(state, (name, from, to, node) => {
    if (name !== "Table" && name !== "MathBlock" && name !== "Frontmatter" && name !== "FencedCode") return true;
    if (node.parent?.name !== "Document") return false;
    const f = doc.lineAt(from).from;
    const t = doc.lineAt(to).to;
    let lang = "";
    if (name === "FencedCode") {
      lang = /^\s*(?:`{3,}|~{3,})\s*([\w+-]+)/.exec(doc.lineAt(from).text)?.[1] ?? "";
      if (!lang || !env.host.renderCodeBlock || !env.host.codeBlockLanguages?.().includes(lang)) return false;
    }
    const text = doc.sliceString(f, t);
    if (name === "Frontmatter") {
      const mode = env.host.propertiesInDocument?.() ?? "visible";
      if (mode === "source") return false;
      if (mode === "hidden") { out.push(Decoration.replace({ block: true }).range(f, t)); return false; }
      // The editable table stays in place while the caret is elsewhere in the note; raw YAML only when it does not parse.
      const table = !!env.host.renderProperties && splitFrontmatter(text + "\n").frontmatter !== null;
      if (!table && selectionTouches(state, f, t)) return false;
      out.push(Decoration.replace({ widget: new FrontmatterWidget(text, env), block: true }).range(f, t));
      return false;
    }
    if (selectionTouches(state, f, t)) return false;
    let widget;
    if (name === "FencedCode") widget = new CodeBlockWidget(text, lang, env, f);
    else if (name === "Table") widget = new TableWidget(text, env);
    else widget = new MathWidget(text.trim().replace(/^\$\$/, "").replace(/\$\$$/, "").trim(), true);
    out.push(Decoration.replace({ widget, block: true }).range(f, t));
    return false;
  });
  return Decoration.set(out, true);
}

function fullTreeIterate(state: EditorState, cb: (name: string, from: number, to: number, node: SyntaxNode) => boolean | void) {
  fullTree(state).iterate({
    enter: (ref) => cb(ref.name, ref.from, ref.to, ref.node),
  });
}

/** Rebuild the block widgets (e.g. after `propertiesInDocument` changed). */
export const refreshBlocks = StateEffect.define<null>();

export const blockField = StateField.define<DecorationSet>({
  create: (state) => buildBlocks(state, state.facet(envFacet)),
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState) || tr.effects.some((e) => e.is(refreshBlocks))) {
      return buildBlocks(tr.state, tr.state.facet(envFacet));
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export { fileExt };
