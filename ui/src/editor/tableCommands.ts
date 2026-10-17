// The `editor:table-*` commands: edit the Markdown table under the cursor (add, delete, duplicate and move rows and columns,
// set column alignment). They work on the source text, so they behave the same in source mode, Live Preview and the table widget.
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { deleteColumn, deleteRow, insertColumn, insertRow, parseTableModel, serializeTable, setAlign, splitRow, type Align, type TableModel } from "./table";

export type TableOp =
  | "row-before" | "row-after" | "row-delete" | "row-copy" | "row-up" | "row-down"
  | "col-before" | "col-after" | "col-delete" | "col-copy" | "col-left" | "col-right"
  | "align-left" | "align-center" | "align-right";

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

interface Found { from: number; to: number; model: TableModel; row: number; col: number }

/** The table around `pos`: its range, model, and the cell (row 0 is the header; the delimiter line counts as the header) the cursor is in. */
export function tableAt(state: EditorState, pos: number): Found | null {
  const doc = state.doc;
  const at = doc.lineAt(pos).number;
  const isRow = (n: number) => n >= 1 && n <= doc.lines && doc.line(n).text.trim() !== "" && doc.line(n).text.includes("|");
  if (!isRow(at)) return null;
  let first = at, last = at;
  while (isRow(first - 1)) first--;
  while (isRow(last + 1)) last++;
  if (last - first < 1 || !DELIMITER.test(doc.line(first + 1).text) || !doc.line(first + 1).text.includes("-")) return null;
  const from = doc.line(first).from, to = doc.line(last).to;
  const model = parseTableModel(doc.sliceString(from, to));
  if (!model) return null;
  const idx = at - first;
  const row = idx <= 1 ? 0 : idx - 1;
  const line = doc.line(at);
  const col = (() => {
    if (idx === 1) return 0;
    const cells = splitRow(line.text);
    const ch = pos - line.from;
    let c = 0;
    cells.forEach((cell, i) => { if (ch >= cell.offset) c = i; });
    return Math.min(c, Math.max(0, model.align.length - 1));
  })();
  return { from, to, model, row, col };
}

const swap = <T,>(a: T[], i: number, j: number) => { [a[i], a[j]] = [a[j], a[i]]; };

/** The edited model and the cell the cursor should land in, or null when the operation does not apply here. */
function apply(m: TableModel, op: TableOp, row: number, col: number): { model: TableModel; row: number; col: number } | null {
  const body = row >= 1;
  const cols = m.align.length;
  const copy = (): TableModel => ({ cells: m.cells.map((r) => r.slice()), align: m.align.slice() });
  switch (op) {
    case "row-before": return body ? { model: insertRow(m, row), row, col } : null;
    case "row-after": return { model: insertRow(m, row + 1), row: row + 1, col };
    case "row-delete": return body ? { model: deleteRow(m, row), row: Math.min(row, m.cells.length - 2) || 0, col } : null;
    case "row-copy": { if (!body) return null; const out = copy(); out.cells.splice(row + 1, 0, m.cells[row].slice()); return { model: out, row: row + 1, col }; }
    case "row-up": { if (row < 2) return null; const out = copy(); swap(out.cells, row, row - 1); return { model: out, row: row - 1, col }; }
    case "row-down": { if (!body || row >= m.cells.length - 1) return null; const out = copy(); swap(out.cells, row, row + 1); return { model: out, row: row + 1, col }; }
    case "col-before": return { model: insertColumn(m, col), row, col };
    case "col-after": return { model: insertColumn(m, col + 1), row, col: col + 1 };
    case "col-delete": { if (cols <= 1) return null; return { model: deleteColumn(m, col), row, col: Math.min(col, cols - 2) }; }
    case "col-copy": {
      const out = insertColumn(m, col + 1, m.align[col] ?? null);
      out.cells.forEach((r, i) => { r[col + 1] = m.cells[i]?.[col] ?? ""; });
      return { model: out, row, col: col + 1 };
    }
    case "col-left": { if (col < 1) return null; const out = copy(); for (const r of out.cells) { while (r.length < cols) r.push(""); swap(r, col, col - 1); } swap(out.align, col, col - 1); return { model: out, row, col: col - 1 }; }
    case "col-right": { if (col >= cols - 1) return null; const out = copy(); for (const r of out.cells) { while (r.length < cols) r.push(""); swap(r, col, col + 1); } swap(out.align, col, col + 1); return { model: out, row, col: col + 1 }; }
    case "align-left": case "align-center": case "align-right": {
      const align: Align = op === "align-left" ? "left" : op === "align-center" ? "center" : "right";
      return { model: setAlign(m, col, align), row, col };
    }
  }
}

/** A transaction applying `op` to the table under the cursor (selection moved to the same cell), or null when there is none or it does not apply. */
export function tableTransaction(state: EditorState, op: TableOp): TransactionSpec | null {
  const found = tableAt(state, state.selection.main.head);
  if (!found) return null;
  const r = apply(found.model, op, found.row, found.col);
  if (!r) return null;
  const text = serializeTable(r.model);
  const lines = text.split("\n");
  const lineIndex = r.row === 0 ? 0 : r.row + 1;
  const cells = splitRow(lines[Math.min(lineIndex, lines.length - 1)] ?? "");
  let offset = 0;
  for (let i = 0; i < Math.min(lineIndex, lines.length - 1); i++) offset += lines[i].length + 1;
  const cell = cells[Math.min(r.col, cells.length - 1)];
  const anchor = found.from + offset + (cell?.offset ?? 2);
  return { changes: { from: found.from, to: found.to, insert: text }, selection: { anchor }, userEvent: "input.table", scrollIntoView: true };
}

/** Command ids and names exactly as Obsidian 1.14.4 lists them (compat/obsidian-reference.json). */
export const TABLE_COMMANDS: { id: string; name: string; op: TableOp }[] = [
  { id: "editor:table-row-before", name: "Table: Add row before", op: "row-before" },
  { id: "editor:table-row-after", name: "Table: Add row after", op: "row-after" },
  { id: "editor:table-row-delete", name: "Table: Delete row", op: "row-delete" },
  { id: "editor:table-row-copy", name: "Table: Duplicate row", op: "row-copy" },
  { id: "editor:table-row-up", name: "Table: Move row up", op: "row-up" },
  { id: "editor:table-row-down", name: "Table: Move row down", op: "row-down" },
  { id: "editor:table-col-before", name: "Table: Add column before", op: "col-before" },
  { id: "editor:table-col-after", name: "Table: Add column after", op: "col-after" },
  { id: "editor:table-col-delete", name: "Table: Delete column", op: "col-delete" },
  { id: "editor:table-col-copy", name: "Table: Duplicate column", op: "col-copy" },
  { id: "editor:table-col-left", name: "Table: Move column left", op: "col-left" },
  { id: "editor:table-col-right", name: "Table: Move column right", op: "col-right" },
  { id: "editor:table-col-align-left", name: "Table: Align left", op: "align-left" },
  { id: "editor:table-col-align-center", name: "Table: Align centre", op: "align-center" },
  { id: "editor:table-col-align-right", name: "Table: Align right", op: "align-right" },
];
