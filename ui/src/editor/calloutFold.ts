// Live Preview callout folding. A foldable callout (`> [!type]-` collapsed, `> [!type]+` expanded) gets a chevron
// after its title; while collapsed (and the selection is outside the callout) its body lines are hidden. Clicking the
// chevron toggles; like Obsidian, the fold state lives in the editor only and is never written to the file. Consistent
// with the reading view (ui/src/markdown/callouts.ts): same `callout-fold` / `is-collapsed` classes and chevron icon.
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { chevronIcon } from "../markdown/icons";
import { selectionTouches } from "./util";

/** Toggle the callout whose blockquote starts at `pos`; `collapsed` is the new state. */
export const setCalloutFold = StateEffect.define<{ pos: number; collapsed: boolean }>({
  map: (v, ch) => ({ pos: ch.mapPos(v.pos), collapsed: v.collapsed }),
});

class FoldWidget extends WidgetType {
  constructor(readonly pos: number, readonly collapsed: boolean) {
    super();
  }
  eq(o: FoldWidget): boolean {
    return o.pos === this.pos && o.collapsed === this.collapsed;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-callout-fold callout-fold" + (this.collapsed ? " is-collapsed" : "");
    el.setAttribute("aria-label", this.collapsed ? "Expand" : "Collapse");
    el.appendChild(chevronIcon());
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ effects: setCalloutFold.of({ pos: this.pos, collapsed: !this.collapsed }) });
    });
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function depthOf(node: SyntaxNode): number {
  let d = 0;
  for (let p: SyntaxNode | null = node; p; p = p.parent) if (p.name === "Blockquote") d++;
  return d;
}

interface FoldState {
  /** Fold state the user chose, by blockquote start (mapped through edits); absent = the `+`/`-` default. */
  overrides: { pos: number; collapsed: boolean }[];
  decos: DecorationSet;
}

function build(state: EditorState, overrides: FoldState["overrides"]): DecorationSet {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name !== "Blockquote") return n.name === "Document" || n.name === "BulletList" || n.name === "OrderedList" || n.name === "ListItem";
      const title = doc.lineAt(n.from);
      const re = new RegExp(`^\\s*(?:>\\s*){${depthOf(n.node)}}\\[![^\\]\\s]+\\]([+-])`);
      const m = re.exec(title.text);
      if (!m || selectionTouches(state, n.from, n.to)) return true;
      const collapsed = overrides.find((o) => o.pos === n.from)?.collapsed ?? m[1] === "-";
      out.push(Decoration.widget({ widget: new FoldWidget(n.from, collapsed), side: 1 }).range(title.to));
      const last = doc.lineAt(n.to);
      if (collapsed && last.number > title.number) {
        out.push(Decoration.line({ class: "is-collapsed cm-callout-last" }).range(title.from));
        out.push(Decoration.replace({}).range(title.to, last.to));
        return false;
      }
      return true;
    },
  });
  return Decoration.set(out, true);
}

export const calloutFoldField = StateField.define<FoldState>({
  create: (state) => ({ overrides: [], decos: build(state, []) }),
  update(value, tr) {
    let overrides = value.overrides;
    if (tr.docChanged) overrides = overrides.map((o) => ({ pos: tr.changes.mapPos(o.pos, 1), collapsed: o.collapsed }));
    let changed = overrides !== value.overrides;
    for (const e of tr.effects) {
      if (!e.is(setCalloutFold)) continue;
      overrides = [...overrides.filter((o) => o.pos !== e.value.pos), e.value];
      changed = true;
    }
    if (changed || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return { overrides, decos: build(tr.state, overrides) };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});
