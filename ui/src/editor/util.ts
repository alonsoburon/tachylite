import type { EditorState } from "@codemirror/state";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";

/** Does any selection range touch [from, to] (inclusive)? */
export function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) return true;
  }
  return false;
}

/** Does any selection range touch the lines spanned by [from, to]? */
export function selectionTouchesLines(state: EditorState, from: number, to: number): boolean {
  const a = state.doc.lineAt(from).from;
  const b = state.doc.lineAt(to).to;
  return selectionTouches(state, a, b);
}

export function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}

export function isChecked(ch: string): boolean {
  return ch !== " ";
}

export function splitLink(target: string): { path: string; subpath: string } {
  const i = target.indexOf("#");
  return i < 0 ? { path: target, subpath: "" } : { path: target.slice(0, i), subpath: target.slice(i) };
}

export function fileExt(p: string): string {
  const b = p.split("/").pop() ?? p;
  const i = b.lastIndexOf(".");
  return i < 0 ? "" : b.slice(i + 1).toLowerCase();
}
