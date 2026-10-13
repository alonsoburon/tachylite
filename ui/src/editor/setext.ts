// Live Preview setext headings (`Title` + `===` / `---`): the underline line is hidden while the selection is outside
// the heading, so the text line (already styled `HyperMD-header-N` / `cm-header-N` by the inline decorations) reads
// like an ATX heading; moving the cursor onto either line reveals the source. Hiding the underline replaces the line
// break before it, which CodeMirror only allows from a state field (not from a view plugin), hence this separate field.
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { StateField, type EditorState, type Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { selectionTouchesLines } from "./util";

const CONTAINERS = new Set(["Document", "Blockquote", "BulletList", "OrderedList", "ListItem"]);

export function buildSetext(state: EditorState): DecorationSet {
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "SetextHeading1" || n.name === "SetextHeading2") {
        const marks = n.node.getChildren("HeaderMark");
        const mark = marks[marks.length - 1];
        if (!mark) return false;
        const under = doc.lineAt(mark.from);
        if (under.number > 1 && !selectionTouchesLines(state, n.from, n.to)) {
          out.push(Decoration.replace({}).range(under.from - 1, under.to));
        }
        return false;
      }
      return CONTAINERS.has(n.name);
    },
  });
  return Decoration.set(out, true);
}

export const setextField = StateField.define<DecorationSet>({
  create: buildSetext,
  update(value, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return buildSetext(tr.state);
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
