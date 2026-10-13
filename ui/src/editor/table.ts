// Live Preview tables: a markdown table model (parse -> edit ops -> serialize) and the editable table widget.
//
// Formatting rule for tables the user edits through the widget (tables that are never edited are left untouched):
// every row gets leading and trailing pipes and one space of padding, and each column is padded to the display width
// of its widest cell (minimum 3, so the delimiter row always has `---`), like the Advanced Tables plugin. Cells are
// padded according to the column alignment (right: spaces before, center: split, otherwise spaces after), the
// delimiter row keeps the alignment colons. Display width counts East Asian wide characters and emoji as 2 columns
// and combining marks as 0, so CJK tables line up in a monospace font.
import { WidgetType, type EditorView } from "@codemirror/view";
import type { WidgetEnv } from "./widgets";
import { makeRenderContext } from "./widgets";
import { renderInline } from "../markdown";

export type Align = "left" | "center" | "right" | null;

export interface ParsedTable {
  /** Cells with their offset relative to the table start; rows[0] is the header (the delimiter row is not included). */
  rows: { text: string; offset: number }[][];
  align: Align[];
}

/** Editable model: `cells[0]` is the header row, the rest the body. Cell text is raw markdown (`\|` kept escaped). */
export interface TableModel {
  cells: string[][];
  align: Align[];
}

/** Split one table line into cells with offsets (relative to the line start). Pipes inside `[[...]]`, code or escaped do not split. */
export function splitRow(line: string): { text: string; offset: number }[] {
  const cells: { text: string; offset: number }[] = [];
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i++;
  if (line[i] === "|") i++;
  let start = i;
  let wiki = 0;
  let code = false;
  const push = (end: number) => {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(line[s])) s++;
    while (e > s && /\s/.test(line[e - 1])) e--;
    cells.push({ text: line.slice(s, e), offset: s });
  };
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") code = !code;
    else if (c === "[" && line[i + 1] === "[") wiki++;
    else if (c === "]" && line[i + 1] === "]" && wiki > 0) wiki--;
    else if (c === "|" && !code && wiki === 0) {
      push(i);
      start = i + 1;
    }
  }
  if (line.slice(start).trim() !== "") push(line.length);
  return cells;
}

function alignOf(cell: string): Align {
  const t = cell.trim();
  const left = t.startsWith(":");
  const right = t.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

export function parseTable(text: string): ParsedTable | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  const rows: ParsedTable["rows"] = [];
  let pos = 0;
  const align: Align[] = [];
  lines.forEach((l, idx) => {
    const cells = splitRow(l).map((c) => ({ text: c.text, offset: pos + c.offset }));
    if (idx === 1) for (const c of cells) align.push(alignOf(c.text));
    else rows.push(cells);
    pos += l.length + 1;
  });
  return { rows, align };
}

/** Number of columns: the header's cell count (GFM); extra body cells are kept verbatim but not rendered. */
export function columnCount(m: TableModel): number {
  return Math.max(1, m.cells[0]?.length ?? 0);
}

export function parseTableModel(text: string): TableModel | null {
  const p = parseTable(text.replace(/\r/g, ""));
  if (!p || !p.rows.length) return null;
  const cells = p.rows.map((r) => r.map((c) => c.text));
  const n = Math.max(1, cells[0].length);
  if (!cells[0].length) cells[0] = [""];
  const align = Array.from({ length: n }, (_, i) => p.align[i] ?? null);
  return { cells, align };
}

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3FFFD}]/u;
const PICTO = /\p{Extended_Pictographic}/u;
const ZERO = /^[\p{M}​-‏︀-️]+$/u;
let segmenter: Intl.Segmenter | null | undefined;

/** Monospace display width of a string (grapheme based; wide CJK and emoji = 2, combining marks = 0). */
export function displayWidth(s: string): number {
  if (segmenter === undefined) segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : null;
  const parts = segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
  let w = 0;
  for (const g of parts) {
    if (ZERO.test(g)) continue;
    w += PICTO.test(g) || WIDE.test(g) ? 2 : 1;
  }
  return w;
}

/** Normalise text typed into a cell: escape bare pipes (outside `[[...]]` and code, like splitRow), newlines -> `<br>`. */
export function escapeCell(text: string): string {
  const s = text.replace(/\r?\n/g, "<br>").trim();
  let out = "";
  let wiki = 0;
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      out += c + (s[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "`") code = !code;
    else if (c === "[" && s[i + 1] === "[") wiki++;
    else if (c === "]" && s[i + 1] === "]" && wiki > 0) wiki--;
    else if (c === "|" && !code && wiki === 0) {
      out += "\\|";
      continue;
    }
    out += c;
  }
  return out;
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - displayWidth(text));
  if (align === "right") return " ".repeat(gap) + text;
  if (align === "center") return " ".repeat(gap >> 1) + text + " ".repeat(gap - (gap >> 1));
  return text + " ".repeat(gap);
}

function delimiter(width: number, align: Align): string {
  if (align === "center") return ":" + "-".repeat(width - 2) + ":";
  if (align === "left") return ":" + "-".repeat(width - 1);
  if (align === "right") return "-".repeat(width - 1) + ":";
  return "-".repeat(width);
}

/** Serialize with the padding rule documented at the top of this file. */
export function serializeTable(m: TableModel): string {
  const n = columnCount(m);
  const widths = Array.from({ length: n }, (_, c) => Math.max(3, ...m.cells.map((r) => displayWidth(r[c] ?? ""))));
  const line = (cells: string[]) => "| " + cells.join(" | ") + " |";
  const row = (r: string[]) => line([...widths.map((w, c) => pad(r[c] ?? "", w, m.align[c] ?? null)), ...r.slice(n)]);
  const out = [row(m.cells[0]), line(widths.map((w, c) => delimiter(w, m.align[c] ?? null)))];
  for (const r of m.cells.slice(1)) out.push(row(r));
  return out.join("\n");
}

// ---- edit operations (pure: return a new model). Row indices count the header as row 0.

const clone = (m: TableModel): TableModel => ({ cells: m.cells.map((r) => r.slice()), align: m.align.slice() });

export function setCell(m: TableModel, row: number, col: number, text: string): TableModel {
  const out = clone(m);
  const r = out.cells[row];
  if (!r) return out;
  while (r.length <= col) r.push("");
  r[col] = text;
  return out;
}

/** Insert an empty body row so that it becomes row `at` (1 = first body row). */
export function insertRow(m: TableModel, at: number): TableModel {
  const out = clone(m);
  out.cells.splice(Math.max(1, Math.min(at, out.cells.length)), 0, Array(columnCount(m)).fill(""));
  return out;
}

export function deleteRow(m: TableModel, row: number): TableModel {
  if (row < 1 || row >= m.cells.length) return m;
  const out = clone(m);
  out.cells.splice(row, 1);
  return out;
}

/** Insert an empty column so that it becomes column `at`. */
export function insertColumn(m: TableModel, at: number, align: Align = null): TableModel {
  const out = clone(m);
  const c = Math.max(0, Math.min(at, columnCount(m)));
  for (const r of out.cells) {
    while (r.length < c) r.push("");
    r.splice(c, 0, "");
  }
  out.align.splice(c, 0, align);
  return out;
}

export function deleteColumn(m: TableModel, col: number): TableModel {
  if (columnCount(m) <= 1 || col < 0 || col >= columnCount(m)) return m;
  const out = clone(m);
  for (const r of out.cells) if (r.length > col) r.splice(col, 1);
  out.align.splice(col, 1);
  return out;
}

export function setAlign(m: TableModel, col: number, align: Align): TableModel {
  const out = clone(m);
  if (col >= 0 && col < out.align.length) out.align[col] = align;
  return out;
}

// ---------------------------------------------------------------- widget

/** One context-menu entry; the host turns these into a real `Menu` (EditorHost.showMenu). */
export interface TableMenuItem {
  title: string;
  icon: string;
  section: string;
  checked?: boolean;
  disabled?: boolean;
  onClick(): void;
}

interface Session {
  wrap: HTMLElement;
  cell: HTMLElement;
  row: number;
  col: number;
  active: boolean;
}

const sessions = new WeakMap<EditorView, Session>();
const widgetOf = new WeakMap<HTMLElement, TableWidget>();

/** The table widget's doc range (from its DOM position), or null if the doc no longer holds this exact source there. */
function rangeOf(view: EditorView, wrap: HTMLElement, w: TableWidget): { from: number; to: number } | null {
  if (!wrap.isConnected) return null;
  const from = view.posAtDOM(wrap);
  const to = from + w.source.length;
  return view.state.sliceDoc(from, to) === w.source ? { from, to } : null;
}

function findWrap(view: EditorView, from: number): HTMLElement | null {
  for (const el of Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget"))) {
    if (widgetOf.has(el) && view.posAtDOM(el) === from) return el;
  }
  return null;
}

function cellAt(wrap: HTMLElement, row: number, col: number): HTMLElement | null {
  return wrap.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly env: WidgetEnv) {
    super();
  }
  eq(o: TableWidget): boolean {
    return o.source === this.source && o.env.getSourcePath() === this.env.getSourcePath();
  }
  get model(): TableModel | null {
    return parseTableModel(this.source);
  }

  private renderCell(el: HTMLElement, text: string): void {
    el.innerHTML = renderInline(text.replace(/\\\|/g, "|"), makeRenderContext(this.env.host, this.env.getSourcePath()));
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-widget";
    const model = this.model;
    const parsed = parseTable(this.source);
    if (!model || !parsed) {
      wrap.textContent = this.source;
      return wrap;
    }
    widgetOf.set(wrap, this);
    const n = columnCount(model);
    const table = document.createElement("table");
    const mk = (tag: "th" | "td", row: number, col: number) => {
      const el = document.createElement(tag);
      this.renderCell(el, model.cells[row]?.[col] ?? "");
      const a = model.align[col];
      if (a) el.style.textAlign = a;
      el.setAttribute("data-row", String(row));
      el.setAttribute("data-col", String(col));
      const off = parsed.rows[row]?.[col]?.offset;
      if (off !== undefined) el.setAttribute("data-offset", String(off));
      return el;
    };
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (let c = 0; c < n; c++) htr.appendChild(mk("th", 0, c));
    thead.appendChild(htr);
    const tbody = document.createElement("tbody");
    for (let r = 1; r < model.cells.length; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < n; c++) tr.appendChild(mk("td", r, c));
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    wrap.appendChild(table);

    wrap.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.closest(".is-editing")) return; // let the browser place the caret inside the cell being edited
      if (e.button !== 0) return;
      const link = t.closest("a.internal-link, a.external-link");
      if (link) {
        e.preventDefault();
        if (link.classList.contains("internal-link")) this.env.host.openLink(link.getAttribute("data-href") ?? "", this.env.getSourcePath(), e.ctrlKey || e.metaKey);
        else this.env.host.openExternal?.(link.getAttribute("href") ?? "");
        return;
      }
      const cell = t.closest<HTMLElement>("th, td");
      e.preventDefault();
      if (cell && !view.state.readOnly) {
        this.edit(view, wrap, Number(cell.dataset.row), Number(cell.dataset.col));
        return;
      }
      // outside any cell: reveal the source like before
      const base = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: Math.min(base, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    });
    wrap.addEventListener("contextmenu", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
      if (!cell || view.state.readOnly || !this.env.host.showMenu) return;
      e.preventDefault();
      e.stopPropagation();
      const row = Number(cell.dataset.row);
      const col = Number(cell.dataset.col);
      // commit a pending cell edit first; the widget may have been replaced by the new table
      const from = this.finish(view, null);
      const target = from === null ? wrap : findWrap(view, from);
      if (!target) return;
      this.env.host.showMenu(e, (widgetOf.get(target) ?? this).menuItems(view, target, row, col));
    });
    return wrap;
  }

  /** Context-menu entries for cell (row, col); exported for tests through TableWidget. */
  menuItems(view: EditorView, wrap: HTMLElement, row: number, col: number): TableMenuItem[] {
    const m = this.model!;
    const n = columnCount(m);
    const apply = (next: TableModel, focus: { row: number; col: number } | null = null) => () => this.write(view, wrap, next, focus);
    const items: TableMenuItem[] = [
      { section: "row", icon: "lucide-arrow-up", title: "Add row above", disabled: row === 0, onClick: apply(insertRow(m, row)) },
      { section: "row", icon: "lucide-arrow-down", title: "Add row below", onClick: apply(insertRow(m, row + 1)) },
      { section: "row", icon: "lucide-trash-2", title: "Delete row", disabled: row === 0, onClick: apply(deleteRow(m, row)) },
      { section: "column", icon: "lucide-arrow-left", title: "Add column left", onClick: apply(insertColumn(m, col)) },
      { section: "column", icon: "lucide-arrow-right", title: "Add column right", onClick: apply(insertColumn(m, col + 1)) },
      { section: "column", icon: "lucide-trash-2", title: "Delete column", disabled: n <= 1, onClick: apply(deleteColumn(m, col)) },
    ];
    const aligns: [Align, string, string][] = [["left", "Align left", "lucide-align-left"], ["center", "Align center", "lucide-align-center"], ["right", "Align right", "lucide-align-right"], [null, "No alignment", "lucide-align-justify"]];
    for (const [a, title, icon] of aligns) items.push({ section: "align", icon, title, checked: (m.align[col] ?? null) === a, onClick: apply(setAlign(m, col, a)) });
    return items;
  }

  /** Replace the table's range with `next` (one transaction, so undo restores it); then optionally edit a cell of the new widget. */
  write(view: EditorView, wrap: HTMLElement, next: TableModel, focus: { row: number; col: number } | null): void {
    const r = rangeOf(view, wrap, this);
    if (!r) return;
    const text = serializeTable(next);
    if (text !== this.source) view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, userEvent: "input.table" });
    if (!focus) return;
    const target = text === this.source ? wrap : findWrap(view, r.from);
    const w = target && widgetOf.get(target);
    if (target && w) w.edit(view, target, focus.row, focus.col);
  }

  /** Start editing cell (row, col): the cell shows its raw markdown and becomes editable in place. */
  edit(view: EditorView, wrap: HTMLElement, row: number, col: number): void {
    const prev = sessions.get(view);
    if (prev?.active) {
      if (prev.wrap === wrap && prev.row === row && prev.col === col) return;
      // committing the previous cell may rewrite (and so replace) this very table: continue in the new widget
      const from = this.finish(view, null);
      if (from !== null && prev.wrap === wrap) {
        const target = findWrap(view, from);
        const w = target && widgetOf.get(target);
        if (target && w) w.edit(view, target, row, col);
        return;
      }
      if (!wrap.isConnected) return;
    }
    const cell = cellAt(wrap, row, col);
    const model = this.model;
    if (!cell || !model) return;
    const s: Session = { wrap, cell, row, col, active: true };
    sessions.set(view, s);
    cell.textContent = model.cells[row]?.[col] ?? "";
    cell.classList.add("is-editing");
    cell.setAttribute("contenteditable", "plaintext-only");
    if (cell.contentEditable !== "plaintext-only") cell.setAttribute("contenteditable", "true");
    cell.spellcheck = false;
    cell.focus();
    const sel = cell.ownerDocument.getSelection();
    if (sel) {
      const rg = cell.ownerDocument.createRange();
      rg.selectNodeContents(cell);
      rg.collapse(false);
      sel.removeAllRanges();
      sel.addRange(rg);
    }
    view.requestMeasure();
    const onKey = (e: KeyboardEvent) => {
      if (!s.active || e.isComposing) return;
      const m = this.model!;
      const n = columnCount(m);
      const last = m.cells.length - 1;
      let to: { row: number; col: number; add?: boolean } | null | undefined;
      if (e.key === "Tab" && !e.shiftKey) to = col < n - 1 ? { row, col: col + 1 } : row < last ? { row: row + 1, col: 0 } : { row: row + 1, col: 0, add: true };
      else if (e.key === "Tab") to = col > 0 ? { row, col: col - 1 } : row > 0 ? { row: row - 1, col: n - 1 } : { row, col };
      else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        document.execCommand("insertText", false, "<br>");
        return;
      } else if (e.key === "Enter") to = row < last ? { row: row + 1, col } : { row: row + 1, col, add: true };
      else if (e.key === "Escape") to = null;
      else return;
      e.preventDefault();
      e.stopPropagation();
      const from = this.finish(view, to?.add ? row + 1 : undefined);
      if (to === null) {
        view.focus();
        return;
      }
      const target = from === null ? wrap : findWrap(view, from);
      const w = target && widgetOf.get(target);
      if (target && w) w.edit(view, target, to.row, to.col);
    };
    cell.addEventListener("keydown", onKey);
    cell.addEventListener("input", () => view.requestMeasure());
    cell.addEventListener("paste", (e) => {
      const t = e.clipboardData?.getData("text/plain");
      if (t === undefined) return;
      e.preventDefault();
      document.execCommand("insertText", false, t.replace(/\r?\n/g, "<br>"));
    });
    cell.addEventListener("blur", () => { if (s.active) this.finish(view, undefined); });
    (s as any).detach = () => cell.removeEventListener("keydown", onKey);
  }

  /**
   * End the current cell edit: write the cell (and, with `addRowAt`, a new empty row) back to the doc.
   * Returns the table's start position when the doc was rewritten (the widget DOM is then replaced), else null.
   */
  finish(view: EditorView, addRowAt: number | null | undefined): number | null {
    const s = sessions.get(view);
    if (!s || !s.active) return null;
    s.active = false;
    sessions.delete(view);
    (s as any).detach?.();
    const w = widgetOf.get(s.wrap) ?? this;
    const m = w.model;
    const r = rangeOf(view, s.wrap, w);
    const typed = escapeCell(s.cell.textContent ?? "");
    const restore = () => {
      s.cell.classList.remove("is-editing");
      s.cell.removeAttribute("contenteditable");
      w.renderCell(s.cell, m?.cells[s.row]?.[s.col] ?? "");
      view.requestMeasure();
    };
    if (!m || !r) { restore(); return null; }
    let next = m;
    if (typed !== (m.cells[s.row]?.[s.col] ?? "")) next = setCell(next, s.row, s.col, typed);
    if (typeof addRowAt === "number") next = insertRow(next, addRowAt);
    if (next === m) { restore(); return null; }
    const text = serializeTable(next);
    view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, userEvent: "input.table" });
    return r.from;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
