// Per-note fold state, in the shape Obsidian keeps it: `app.foldManager` stores `{ folds: [{ from, to }], lines }` in
// localStorage under `<appId>-note-fold-<path>` (checked against Obsidian 1.14.4; see ROADMAP.md). `from` is the 0-based
// line of the heading or list item that is folded. In the editor `to` is the last hidden line; in the reading view it is
// the line after the heading's own block (`from + 1`) or after the list item and its sub-items. Restoring only looks at
// `from`, so either shape works in either mode. A note whose line count changed since the save is not restored.
import { ensureSyntaxTree, foldable, foldedRanges, foldEffect, unfoldEffect } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { ReadingFolds } from "../markdown/types";

export interface FoldInfo { folds: { from: number; to: number }[]; lines: number }

export const foldKey = (path: string): string => `note-fold-${path}`;
export const countLines = (text: string): number => text.split("\n").length;

/** A saved value, if it is well formed and was saved for a note with `lines` lines. */
export function parseFoldInfo(raw: unknown, lines: number): FoldInfo | null {
  const r = raw as { folds?: unknown; lines?: unknown } | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.folds) || r.lines !== lines) return null;
  const folds = r.folds.filter((f): f is { from: number; to: number } => !!f && Number.isInteger(f.from) && Number.isInteger(f.to) && f.from >= 0);
  return { folds, lines };
}

// ------------------------------------------------------------------ editor

export function editorFoldInfo(view: EditorView): FoldInfo {
  const doc = view.state.doc;
  const folds: { from: number; to: number }[] = [];
  foldedRanges(view.state).between(0, doc.length, (from, to) => {
    let end = doc.lineAt(to).number; // the editor leaves blank lines after a block visible; Obsidian's `to` includes them
    while (end < doc.lines && doc.line(end + 1).text.trim() === "") end++;
    folds.push({ from: doc.lineAt(from).number - 1, to: end - 1 });
  });
  folds.sort((a, b) => a.from - b.from || b.to - a.to);
  return { folds, lines: doc.lines };
}

/** Make the editor's folds exactly the ones that start on the lines of `info`. */
export function applyEditorFolds(view: EditorView, info: FoldInfo): void {
  ensureSyntaxTree(view.state, view.state.doc.length, 500); // the fold services read the syntax tree
  const state = view.state;
  const effects = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => { effects.push(unfoldEffect.of({ from, to })); });
  for (const f of info.folds) {
    if (f.from >= state.doc.lines) continue;
    const line = state.doc.line(f.from + 1);
    const r = foldable(state, line.from, line.to);
    if (r) effects.push(foldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
}

/** True for a transaction list that folded or unfolded something. */
export function changesFolds(transactions: readonly { effects: readonly { is(t: unknown): boolean }[] }[]): boolean {
  return transactions.some((t) => t.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
}

// ------------------------------------------------------------------ reading view

/** The reading view's fold state: lines that are folded, and the foldable elements the last render knew about. */
export class ReadingFoldState implements ReadingFolds {
  private folded = new Set<string>();
  private ends = new Map<string, number>();
  constructor(private onChange: () => void) {}
  private key = (kind: string, line: number): string => `${kind}:${line}`;
  has(kind: "heading" | "item", line: number): boolean { return this.folded.has(this.key(kind, line)); }
  known(kind: "heading" | "item", line: number, to: number): void { this.ends.set(this.key(kind, line), to); }
  toggled(kind: "heading" | "item", line: number, to: number, folded: boolean): void {
    this.ends.set(this.key(kind, line), to);
    if (folded) this.folded.add(this.key(kind, line)); else this.folded.delete(this.key(kind, line));
    this.onChange();
  }
  /** Folds from a saved info: every entry whose line is a heading or item start (the next render decides which). */
  load(info: FoldInfo | null): void {
    this.folded.clear();
    if (!info) return;
    for (const f of info.folds) { this.folded.add(this.key("heading", f.from)); this.folded.add(this.key("item", f.from)); }
  }
  /** Forget what the last render knew (a new render re-registers it). */
  resetKnown(): void { this.ends.clear(); }
  info(lines: number): FoldInfo {
    const folds: { from: number; to: number }[] = [];
    for (const k of this.folded) {
      const to = this.ends.get(k);
      if (to === undefined) continue; // not a foldable element in the current text
      folds.push({ from: Number(k.slice(k.indexOf(":") + 1)), to });
    }
    folds.sort((a, b) => a.from - b.from);
    return { folds, lines };
  }
}
