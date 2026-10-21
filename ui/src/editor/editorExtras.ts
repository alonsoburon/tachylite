// Editor commands recorded from Obsidian 1.14.4: coloured highlights, and folding one level more or less.
import { foldable, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import { EditorSelection, type StateCommand } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

/** Obsidian's six highlight colours: the colour is an emoji right after the opening `==`. */
export const HIGHLIGHT_COLORS: Record<string, string> = { red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", blue: "🔵", purple: "🟣" };

/** `==🔴text==` around the selection (the word under the cursor when nothing is selected); on text that already has it, take it off. */
export function coloredHighlight(emoji: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const open = "==" + emoji;
    const tr = state.changeByRange((range) => {
      let { from, to } = range;
      if (range.empty) {
        const w = state.wordAt(from);
        if (w) { from = w.from; to = w.to; }
      }
      // Already highlighted with this colour (the markers inside or around the selection).
      if (state.sliceDoc(from - open.length, from) === open && state.sliceDoc(to, to + 2) === "==") {
        return { changes: [{ from: from - open.length, to: from }, { from: to, to: to + 2 }], range: EditorSelection.range(from - open.length, to - open.length) };
      }
      const text = state.sliceDoc(from, to);
      if (text.startsWith(open) && text.endsWith("==") && text.length > open.length + 2) {
        return { changes: [{ from, to: from + open.length }, { from: to - 2, to }], range: EditorSelection.range(from, to - open.length - 2) };
      }
      if (from === to) return { changes: { from, insert: open + "==" }, range: EditorSelection.cursor(from + open.length) };
      return { changes: [{ from, insert: open }, { from: to, insert: "==" }], range: EditorSelection.range(from + open.length, to + open.length) };
    });
    dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
    return true;
  };
}

/** Foldable ranges that contain the cursor line, innermost first, as `{ from, to }` of the folded text. */
function enclosing(view: EditorView): { from: number; to: number }[] {
  const { state } = view;
  const cursor = state.doc.lineAt(state.selection.main.head);
  const out: { from: number; to: number }[] = [];
  for (let n = cursor.number; n >= 1; n--) {
    const line = state.doc.line(n);
    const r = foldable(state, line.from, line.to);
    if (r && r.to >= cursor.from && !out.some((o) => o.from === r.from)) out.push(r);
  }
  return out;
}

const isFolded = (view: EditorView, from: number) => {
  let hit = false;
  foldedRanges(view.state).between(from, from, (f) => { if (f === from) hit = true; });
  return hit;
};

/** Fold the innermost section around the cursor that is not folded yet; repeated, it folds the enclosing sections. */
export const foldMore = (view: EditorView): boolean => {
  const next = enclosing(view).find((r) => !isFolded(view, r.from));
  if (!next) return false;
  const line = view.state.doc.lineAt(next.from);
  view.dispatch({ effects: foldEffect.of(next), selection: EditorSelection.cursor(line.to), scrollIntoView: true });
  return true;
};

/** Unfold the outermost folded section around the cursor (inner folds stay), one level at a time. */
export const foldLess = (view: EditorView): boolean => {
  const { state } = view;
  const head = state.selection.main.head;
  let outer: { from: number; to: number } | null = null;
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    if (from <= head && head <= to + 1 && (!outer || to - from > outer.to - outer.from)) outer = { from, to };
  });
  if (!outer) return false;
  view.dispatch({ effects: unfoldEffect.of(outer) });
  return true;
};

/**
 * "Fold all headings and lists": every foldable line, nested ones included (CodeMirror's own foldAll skips what lies
 * inside an outer fold, so unfolding the outer one would show everything open; Obsidian keeps the inner folds).
 */
export const foldEverything = (view: EditorView): boolean => {
  const { state } = view;
  const effects = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const r = foldable(state, line.from, line.to);
    if (r && !isFolded(view, r.from)) effects.push(foldEffect.of(r));
  }
  if (!effects.length) return false;
  view.dispatch({ effects });
  return true;
};
