// The editor:table-* commands, on plain editor state (the same transaction the commands dispatch).
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { TABLE_COMMANDS, tableAt, tableTransaction, type TableOp } from "../src/editor/tableCommands";

const DOC = "intro\n\n| a | b | c |\n| --- | :-: | --: |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nafter | not a table";

function run(op: TableOp, at: number, doc = DOC): { doc: string; head: number } | null {
  const state = EditorState.create({ doc, selection: EditorSelection.single(at) });
  const spec = tableTransaction(state, op);
  if (!spec) return null;
  const next = state.update(spec).state;
  return { doc: next.doc.toString(), head: next.selection.main.head };
}
const cellOf = (doc: string, op: TableOp, needle: string) => run(op, doc.indexOf(needle));

describe("table commands", () => {
  it("finds the table, its row and column, and ignores text outside it", () => {
    const state = (pos: number) => EditorState.create({ doc: DOC, selection: EditorSelection.single(pos) });
    const found = tableAt(state(DOC.indexOf("5")), DOC.indexOf("5"))!;
    expect([found.row, found.col, found.model.cells.length]).toEqual([2, 1, 3]);
    expect(tableAt(state(0), 0)).toBeNull();
    expect(tableAt(state(DOC.indexOf("after")), DOC.indexOf("after"))).toBeNull();
    expect(tableAt(state(DOC.indexOf("--: ")), DOC.indexOf("--: "))!.row).toBe(0); // the delimiter line counts as the header
  });

  it("adds, duplicates and deletes rows, keeping the cursor in the same column", () => {
    expect(cellOf(DOC, "row-after", "1 |")!.doc).toContain("| 1   |  2  |   3 |\n|     |     |     |\n| 4   |  5  |   6 |");
    expect(cellOf(DOC, "row-before", "4 |")!.doc).toContain("| 1   |  2  |   3 |\n|     |     |     |\n| 4   |  5  |   6 |");
    expect(cellOf(DOC, "row-copy", "1 |")!.doc).toContain("| 1   |  2  |   3 |\n| 1   |  2  |   3 |\n| 4   |  5  |   6 |");
    const deleted = cellOf(DOC, "row-delete", "1 |")!;
    expect(deleted.doc).toContain("| a   |  b  |   c |\n| --- | :-: | --: |\n| 4   |  5  |   6 |");
    expect(deleted.doc).not.toContain("| 1 ");
  });

  it("does not apply row operations that make no sense on the header, and refuses to delete the header", () => {
    expect(cellOf(DOC, "row-before", "a |")).toBeNull();
    expect(cellOf(DOC, "row-delete", "a |")).toBeNull();
    expect(cellOf(DOC, "row-up", "a |")).toBeNull();
    expect(cellOf(DOC, "row-up", "1 |")).toBeNull(); // first body row has nothing above it
    expect(cellOf(DOC, "row-down", "4 |")).toBeNull(); // last row has nothing below it
    expect(cellOf(DOC, "row-after", "a |")!.doc).toContain("| a   |  b  |   c |\n| --- | :-: | --: |\n|     |     |     |\n| 1   |  2  |   3 |");
  });

  it("moves rows", () => {
    expect(cellOf(DOC, "row-down", "1 |")!.doc).toContain("| 4   |  5  |   6 |\n| 1   |  2  |   3 |");
    expect(cellOf(DOC, "row-up", "4 |")!.doc).toContain("| 4   |  5  |   6 |\n| 1   |  2  |   3 |");
  });

  it("adds, duplicates, moves and deletes columns, carrying alignment", () => {
    expect(cellOf(DOC, "col-after", "2 |")!.doc).toContain("| a   |  b  |     |   c |");
    expect(cellOf(DOC, "col-before", "1 |")!.doc).toContain("|     | a   |  b  |   c |");
    const copy = cellOf(DOC, "col-copy", "2 |")!.doc;
    expect(copy).toContain("| a   |  b  |  b  |   c |");
    expect(copy).toContain("| --- | :-: | :-: | --: |");
    const left = cellOf(DOC, "col-left", "2 |")!.doc;
    expect(left).toContain("|  b  | a   |   c |");
    expect(left).toContain("| :-: | --- | --: |");
    expect(cellOf(DOC, "col-right", "2 |")!.doc).toContain("| a   |   c |  b  |");
    expect(cellOf(DOC, "col-left", "1 |")).toBeNull();
    expect(cellOf(DOC, "col-right", "3 |")).toBeNull();
    const del = cellOf(DOC, "col-delete", "2 |")!.doc;
    expect(del).toContain("| a   |   c |");
    expect(del).not.toContain("| 2 ");
  });

  it("will not delete the only column", () => {
    expect(run("col-delete", 12, "x\n\n| a |\n| --- |\n| 1 |")).toBeNull();
  });

  it("sets column alignment", () => {
    expect(cellOf(DOC, "align-left", "2 |")!.doc).toContain("| --- | :-- | --: |");
    expect(cellOf(DOC, "align-center", "1 |")!.doc).toContain("| :-: | :-: | --: |");
    expect(cellOf(DOC, "align-right", "1 |")!.doc).toContain("| --: | :-: | --: |");
  });

  it("puts the cursor in the same cell afterwards", () => {
    const r = cellOf(DOC, "row-after", "1 |")!;
    const line = r.doc.slice(0, r.head).split("\n").pop()!;
    expect(r.doc.slice(r.head - line.length).split("\n")[0]).toMatch(/^\|\s+\|/); // the new, empty row's first cell
    const c = cellOf(DOC, "col-after", "2 |")!;
    expect(c.doc.slice(0, c.head).split("\n").pop()).toMatch(/^\| 1   \|  2  \|\s*$/); // the new third column on the same row
  });

  it("only touches the table: the surrounding text is unchanged", () => {
    const r = cellOf(DOC, "row-after", "1 |")!.doc;
    expect(r.startsWith("intro\n\n")).toBe(true);
    expect(r.endsWith("\n\nafter | not a table")).toBe(true);
  });

  it("lists exactly Obsidian's command ids and names", () => {
    expect(TABLE_COMMANDS.map((t) => `${t.id}=${t.name}`).sort()).toEqual([
      "editor:table-col-after=Table: Add column after", "editor:table-col-align-center=Table: Align centre", "editor:table-col-align-left=Table: Align left",
      "editor:table-col-align-right=Table: Align right", "editor:table-col-before=Table: Add column before", "editor:table-col-copy=Table: Duplicate column",
      "editor:table-col-delete=Table: Delete column", "editor:table-col-left=Table: Move column left", "editor:table-col-right=Table: Move column right",
      "editor:table-row-after=Table: Add row after", "editor:table-row-before=Table: Add row before", "editor:table-row-copy=Table: Duplicate row",
      "editor:table-row-delete=Table: Delete row", "editor:table-row-down=Table: Move row down", "editor:table-row-up=Table: Move row up",
    ]);
  });
});
