// Editor (the Obsidian abstraction) implemented over a CodeMirror 6 EditorView.
import { Compartment, EditorSelection as CMSelection, EditorState, Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { cursorCharLeft, cursorCharRight, cursorDocEnd, cursorDocStart, cursorGroupLeft, cursorGroupRight, cursorLineDown, cursorLineUp, defaultKeymap, deleteLine, history, historyKeymap, indentLess, indentMore, insertNewlineAndIndent, moveLineDown, moveLineUp, redo, undo } from "@codemirror/commands";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import { addWindowMigrationHook } from "./dom";

// A CodeMirror editor moved to another window (popout) must re-root: its styles mount per document and its
// selection/resize listeners belong to the owning window.
addWindowMigrationHook((root) => {
  const els = [...(root.matches(".cm-editor") ? [root] : []), ...root.querySelectorAll(".cm-editor")];
  for (const el of els) {
    const v = EditorView.findFromDOM(el as HTMLElement);
    if (!v) continue;
    const r = v.root as Document | ShadowRoot;
    if ((r.nodeType === 9 ? r : r.ownerDocument) !== el.ownerDocument) v.setRoot(el.ownerDocument);
  }
});

export interface EditorPosition { line: number; ch: number }
export interface EditorRange { from: EditorPosition; to: EditorPosition }
export interface EditorRangeOrCaret { from: EditorPosition; to?: EditorPosition }
export interface EditorSelectionT { anchor: EditorPosition; head: EditorPosition }
export interface EditorSelectionOrCaret { anchor: EditorPosition; head?: EditorPosition }
export interface EditorChange extends EditorRangeOrCaret { text: string }
export interface EditorTransaction { replaceSelection?: string; changes?: EditorChange[]; selections?: EditorRangeOrCaret[]; selection?: EditorRangeOrCaret }
export type EditorCommandName = "goUp" | "goDown" | "goLeft" | "goRight" | "goStart" | "goEnd" | "goWordLeft" | "goWordRight" | "indentMore" | "indentLess" | "newlineAndIndent" | "swapLineUp" | "swapLineDown" | "deleteLine" | "toggleFold" | "foldAll" | "unfoldAll";

export abstract class Editor {
  getDoc(): this { return this; }
  abstract refresh(): void;
  abstract getValue(): string;
  abstract setValue(content: string): void;
  abstract getLine(line: number): string;
  setLine(n: number, text: string): void {
    this.replaceRange(text, { line: n, ch: 0 }, { line: n, ch: this.getLine(n).length });
  }
  abstract lineCount(): number;
  abstract lastLine(): number;
  abstract getSelection(): string;
  somethingSelected(): boolean { return this.listSelections().some((s) => s.anchor.line !== s.head.line || s.anchor.ch !== s.head.ch); }
  abstract getRange(from: EditorPosition, to: EditorPosition): string;
  abstract replaceSelection(replacement: string, origin?: string): void;
  abstract replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void;
  abstract getCursor(side?: "from" | "to" | "head" | "anchor"): EditorPosition;
  abstract listSelections(): EditorSelectionT[];
  setCursor(pos: EditorPosition | number, ch?: number): void {
    const p = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
    this.setSelection(p, p);
  }
  abstract setSelection(anchor: EditorPosition, head?: EditorPosition): void;
  abstract setSelections(ranges: EditorSelectionOrCaret[], main?: number): void;
  abstract focus(): void;
  abstract blur(): void;
  abstract hasFocus(): boolean;
  abstract getScrollInfo(): { top: number; left: number };
  abstract scrollTo(x?: number | null, y?: number | null): void;
  abstract scrollIntoView(range: EditorRange, center?: boolean): void;
  abstract undo(): void;
  abstract redo(): void;
  abstract exec(command: EditorCommandName): void;
  abstract transaction(tx: EditorTransaction, origin?: string): void;
  abstract wordAt(pos: EditorPosition): EditorRange | null;
  abstract posToOffset(pos: EditorPosition): number;
  abstract offsetToPos(offset: number): EditorPosition;
  processLines<T>(read: (line: number, lineText: string) => T | null, write: (line: number, lineText: string, value: T | null) => EditorChange | void, ignoreEmpty = true): void {
    const lines = new Set<number>();
    for (const s of this.listSelections()) {
      const a = Math.min(s.anchor.line, s.head.line), b = Math.max(s.anchor.line, s.head.line);
      for (let l = a; l <= b; l++) lines.add(l);
    }
    const changes: EditorChange[] = [];
    for (const l of [...lines].sort((x, y) => x - y)) {
      const text = this.getLine(l);
      if (ignoreEmpty && !text.length) continue;
      const v = read(l, text);
      if (v === null) continue;
      const c = write(l, text, v);
      if (c) changes.push(c);
    }
    if (changes.length) this.transaction({ changes });
  }
}

const COMMANDS: Record<EditorCommandName, (v: EditorView) => boolean> = {
  goUp: cursorLineUp, goDown: cursorLineDown, goLeft: cursorCharLeft, goRight: cursorCharRight,
  goStart: cursorDocStart, goEnd: cursorDocEnd, goWordLeft: cursorGroupLeft, goWordRight: cursorGroupRight,
  indentMore, indentLess, newlineAndIndent: insertNewlineAndIndent, swapLineUp: moveLineUp, swapLineDown: moveLineDown,
  deleteLine, toggleFold, foldAll, unfoldAll,
};

export class CMEditor extends Editor {
  constructor(public cm: EditorView) { super(); }
  get doc() { return this.cm.state.doc; }
  refresh(): void { this.cm.requestMeasure(); }
  getValue(): string { return this.doc.toString(); }
  setValue(content: string): void {
    this.cm.dispatch({ changes: { from: 0, to: this.doc.length, insert: content }, annotations: Transaction.userEvent.of("set") });
  }
  getLine(line: number): string {
    if (line < 0 || line >= this.doc.lines) return "";
    return this.doc.line(line + 1).text;
  }
  lineCount(): number { return this.doc.lines; }
  lastLine(): number { return this.doc.lines - 1; }
  getSelection(): string { const m = this.cm.state.selection.main; return this.cm.state.sliceDoc(m.from, m.to); }
  somethingSelected(): boolean { return this.cm.state.selection.ranges.some((r) => !r.empty); }
  getRange(from: EditorPosition, to: EditorPosition): string { return this.cm.state.sliceDoc(this.posToOffset(from), this.posToOffset(to)); }
  replaceSelection(replacement: string, origin?: string): void {
    this.cm.dispatch(this.cm.state.replaceSelection(replacement), origin ? { userEvent: origin } : {});
  }
  replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string): void {
    const f = this.posToOffset(from), t = to ? this.posToOffset(to) : f;
    this.cm.dispatch({ changes: { from: Math.min(f, t), to: Math.max(f, t), insert: replacement }, ...(origin ? { userEvent: origin } : {}) });
  }
  getCursor(side: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
    const m = this.cm.state.selection.main;
    const off = side === "from" ? m.from : side === "to" ? m.to : side === "anchor" ? m.anchor : m.head;
    return this.offsetToPos(off);
  }
  listSelections(): EditorSelectionT[] {
    return this.cm.state.selection.ranges.map((r) => ({ anchor: this.offsetToPos(r.anchor), head: this.offsetToPos(r.head) }));
  }
  setSelection(anchor: EditorPosition, head?: EditorPosition): void {
    this.cm.dispatch({ selection: { anchor: this.posToOffset(anchor), head: this.posToOffset(head ?? anchor) } });
  }
  setSelections(ranges: EditorSelectionOrCaret[], main = 0): void {
    if (!ranges.length) return;
    this.cm.dispatch({ selection: CMSelection.create(ranges.map((r) => CMSelection.range(this.posToOffset(r.anchor), this.posToOffset(r.head ?? r.anchor))), Math.min(main, ranges.length - 1)) });
  }
  focus(): void { this.cm.focus(); }
  blur(): void { this.cm.contentDOM.blur(); }
  hasFocus(): boolean { return this.cm.hasFocus; }
  getScrollInfo(): { top: number; left: number } { return { top: this.cm.scrollDOM.scrollTop, left: this.cm.scrollDOM.scrollLeft }; }
  scrollTo(x?: number | null, y?: number | null): void {
    if (x !== null && x !== undefined) this.cm.scrollDOM.scrollLeft = x;
    if (y !== null && y !== undefined) this.cm.scrollDOM.scrollTop = y;
  }
  scrollIntoView(range: EditorRange, center = false): void {
    this.cm.dispatch({ effects: EditorView.scrollIntoView(this.posToOffset(range.from), { y: center ? "center" : "nearest" }) });
  }
  undo(): void { undo(this.cm); }
  redo(): void { redo(this.cm); }
  exec(command: EditorCommandName): void {
    const c = COMMANDS[command];
    if (!c) throw new Error(`Unknown editor command: ${command}`);
    c(this.cm);
  }
  transaction(tx: EditorTransaction, origin?: string): void {
    const spec: any = {};
    if (tx.changes) {
      spec.changes = tx.changes.map((c) => {
        const f = this.posToOffset(c.from), t = c.to ? this.posToOffset(c.to) : f;
        return { from: Math.min(f, t), to: Math.max(f, t), insert: c.text };
      });
    }
    if (tx.replaceSelection !== undefined) {
      const rs = this.cm.state.replaceSelection(tx.replaceSelection);
      spec.changes = [...(spec.changes ?? []), ...(Array.isArray(rs.changes) ? rs.changes : [rs.changes])];
      if (!tx.selection && !tx.selections) spec.selection = rs.selection;
    }
    const sels = tx.selections ?? (tx.selection ? [tx.selection] : null);
    if (sels?.length) {
      const doc = spec.changes ? this.cm.state.update({ changes: spec.changes }).state.doc : this.doc;
      const clamp = (p: EditorPosition) => { const ln = Math.max(1, Math.min(doc.lines, p.line + 1)); const l = doc.line(ln); return l.from + Math.max(0, Math.min(l.length, p.ch)); };
      spec.selection = CMSelection.create(sels.map((s) => CMSelection.range(clamp(s.from), clamp(s.to ?? s.from))));
    }
    if (origin) spec.userEvent = origin;
    this.cm.dispatch(spec);
  }
  wordAt(pos: EditorPosition): EditorRange | null {
    const r = this.cm.state.wordAt(this.posToOffset(pos));
    return r ? { from: this.offsetToPos(r.from), to: this.offsetToPos(r.to) } : null;
  }
  posToOffset(pos: EditorPosition): number {
    const n = this.doc.lines;
    if (pos.line < 0) return 0;
    if (pos.line >= n) return this.doc.length;
    const l = this.doc.line(pos.line + 1);
    return l.from + Math.max(0, Math.min(pos.ch, l.length));
  }
  offsetToPos(offset: number): EditorPosition {
    const o = Math.max(0, Math.min(offset, this.doc.length));
    const l = this.doc.lineAt(o);
    return { line: l.number - 1, ch: o - l.from };
  }
}

// ---------------------------------------------------------------- state fields plugins read

/** Set once a view owns the editor; `editor.cm.state.field(editorInfoField)` yields the MarkdownView. */
export const setEditorInfo = StateEffect.define<any>();
export const editorInfoField = StateField.define<any>({
  create: () => null,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setEditorInfo)) return e.value; return v; },
});
export const setEditorView = StateEffect.define<EditorView>();
export const editorEditorField = StateField.define<EditorView | null>({
  create: () => null,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setEditorView)) return e.value; return v; },
}) as unknown as StateField<EditorView>;
export const editorViewField = editorInfoField;
/** Dispatched by the markdown view when it switches between Live Preview (true) and Source mode (false). */
export const setLivePreview = StateEffect.define<boolean>();
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setLivePreview)) return e.value; return v; },
});
export const livePreviewState = ViewPlugin.define(() => ({ mousedown: false }));

// ---------------------------------------------------------------- factory

export interface EditorFactoryOptions {
  parent: HTMLElement;
  doc: string;
  /** Extensions every Obsidian editor needs (state fields, listeners, plugin extensions). */
  extensions: Extension[];
}
export interface EditorFactory { create(opts: EditorFactoryOptions): EditorView }

export const defaultEditorFactory: EditorFactory = {
  create: ({ parent, doc, extensions }) =>
    new EditorView({ parent, doc, extensions: [history(), EditorState.allowMultipleSelections.of(true), keymap.of([...defaultKeymap, ...historyKeymap]), EditorView.lineWrapping, ...extensions] }),
};

let factory: EditorFactory = defaultEditorFactory;
export function setEditorFactory(f: EditorFactory | null): void { factory = f ?? defaultEditorFactory; }
export function getEditorFactory(): EditorFactory { return factory; }

export { Compartment };
