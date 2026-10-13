// Live Preview tables: the markdown table model (parse -> edit ops -> serialize) and the editable widget DOM.
import { describe, it, expect } from "vitest";
import { undo } from "@codemirror/commands";
import {
  createEditor, parseTableModel, serializeTable, escapeCell, displayWidth, setCell, insertRow, deleteRow, insertColumn,
  deleteColumn, setAlign, columnCount, type EditorHost, type TableMenuItem,
} from "../src/editor";

const ser = (t: string) => serializeTable(parseTableModel(t)!);

describe("table model", () => {
  it("parses header, alignment, body and keeps raw cell markdown", () => {
    const m = parseTableModel("| a | b \\| c | [[x|y]] |\n|:--|--:|:-:|\n| 1 | `p|q` | 3 |")!;
    expect(m.cells).toEqual([["a", "b \\| c", "[[x|y]]"], ["1", "`p|q`", "3"]]);
    expect(m.align).toEqual(["left", "right", "center"]);
    expect(columnCount(m)).toBe(3);
  });

  it("serializes with padded columns, alignment colons and escaped pipes kept", () => {
    expect(ser("|a|b \\| c|\n|:-:|--:|\n|long cell|2|")).toBe(
      "|     a     | b \\| c |\n" +
      "| :-------: | -----: |\n" +
      "| long cell |      2 |",
    );
    expect(ser("a | b\n--- | ---\n1 | 2")).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |");
  });

  it("round-trips an already formatted table unchanged", () => {
    const t = "| Name  | Qty |\n| :---- | --: |\n| apple |   3 |\n| [[A\\|alias]] |  12 |";
    const once = ser(t);
    expect(ser(once)).toBe(once);
    expect(once).toContain("[[A\\|alias]]");
  });

  it("uneven rows: short rows are padded, extra cells kept verbatim", () => {
    const m = parseTableModel("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |")!;
    expect(serializeTable(m)).toBe("| a   | b   |\n| --- | --- |\n| 1   |     |\n| 1   | 2   | 3 |");
  });

  it("unicode: CJK and emoji count as two columns, combining marks as zero", () => {
    expect(displayWidth("日本")).toBe(4);
    expect(displayWidth("👍🏽")).toBe(2);
    expect(displayWidth("é")).toBe(1);
    expect(ser("| 日本 | x |\n|---|---|\n| a | 👍 |")).toBe("| 日本 | x   |\n| ---- | --- |\n| a    | 👍  |");
  });

  it("escapes typed pipes outside wikilinks/code and turns newlines into <br>", () => {
    expect(escapeCell("a|b")).toBe("a\\|b");
    expect(escapeCell("a\\|b")).toBe("a\\|b");
    expect(escapeCell("[[x|y]] `c|d`")).toBe("[[x|y]] `c|d`");
    expect(escapeCell(" one\ntwo ")).toBe("one<br>two");
  });

  it("row/column/alignment operations", () => {
    const m = parseTableModel("| a | b |\n|:--|---|\n| 1 | 2 |")!;
    expect(setCell(m, 1, 1, "x").cells[1]).toEqual(["1", "x"]);
    expect(m.cells[1]).toEqual(["1", "2"]); // pure
    expect(insertRow(m, 1).cells).toEqual([["a", "b"], ["", ""], ["1", "2"]]);
    expect(insertRow(m, 0).cells[1]).toEqual(["", ""]); // never above the header
    expect(insertRow(m, 2).cells[2]).toEqual(["", ""]);
    expect(deleteRow(m, 1).cells).toEqual([["a", "b"]]);
    expect(deleteRow(m, 0)).toBe(m); // header can't be deleted
    const c = insertColumn(m, 1, "right");
    expect(c.cells).toEqual([["a", "", "b"], ["1", "", "2"]]);
    expect(c.align).toEqual(["left", "right", null]);
    expect(deleteColumn(m, 0).cells).toEqual([["b"], ["2"]]);
    expect(deleteColumn(deleteColumn(m, 0), 0).cells).toEqual([["b"], ["2"]]); // keeps the last column
    expect(serializeTable(setAlign(m, 1, "center"))).toBe("| a   |  b  |\n| :-- | :-: |\n| 1   |  2  |");
    expect(serializeTable(setAlign(m, 0, null))).toContain("| --- | --- |");
  });
});

describe("table widget (DOM)", () => {
  function mount(doc: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const menus: TableMenuItem[][] = [];
    const host: EditorHost = {
      resolveLink: (p) => (p === "A" ? "A.md" : null), listLinkTargets: () => [], listTags: () => [],
      getResourceUrl: (p) => p, openLink: () => {}, readFile: async () => "",
      showMenu: (_e, items) => { menus.push(items); },
    };
    const h = createEditor(parent, { doc, host, sourcePath: "N.md", mode: "live-preview" });
    h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
    return { parent, h, menus };
  }
  const cell = (p: HTMLElement, r: number, c: number) => p.querySelector<HTMLElement>(`.cm-table-widget [data-row="${r}"][data-col="${c}"]`)!;
  const key = (el: HTMLElement, k: string, shift = false) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
  const down = (el: HTMLElement, button = 0) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button }));
  const DOC = "intro\n\n| a | [[A\\|al]] |\n|---|:-:|\n| 1 | **b** |\n\nend";

  it("renders inline markdown in cells, edits a cell in place and Tab moves on", () => {
    const { parent, h } = mount(DOC);
    expect(cell(parent, 0, 1).querySelector("a.internal-link")?.textContent).toBe("al");
    expect(cell(parent, 1, 1).querySelector("strong")?.textContent).toBe("b");
    down(cell(parent, 1, 0));
    const ed = cell(parent, 1, 0);
    expect(ed.classList.contains("is-editing")).toBe(true);
    expect(ed.getAttribute("contenteditable")).toBeTruthy();
    expect(document.activeElement).toBe(ed);
    ed.textContent = "one|two";
    key(ed, "Tab");
    expect(h.getValue()).toBe("intro\n\n| a        | [[A\\|al]] |\n| -------- | :-------: |\n| one\\|two |   **b**   |\n\nend");
    // the rewritten widget edits the next cell, showing its raw markdown
    const next = cell(parent, 1, 1);
    expect(next.classList.contains("is-editing")).toBe(true);
    expect(next.textContent).toBe("**b**");
    expect(cell(parent, 1, 0).textContent).toBe("one|two"); // rendered again (escape removed for display)
    // Tab in the last cell adds a row and moves into it; Shift-Tab goes back
    key(next, "Tab");
    expect(h.getValue().split("\n").length).toBe(8);
    expect(cell(parent, 2, 0).classList.contains("is-editing")).toBe(true);
    key(cell(parent, 2, 0), "Tab", true);
    expect(cell(parent, 1, 1).classList.contains("is-editing")).toBe(true);
    // Escape commits and leaves; the table source is not revealed
    cell(parent, 1, 1).textContent = "B";
    key(cell(parent, 1, 1), "Escape");
    expect(parent.querySelector(".is-editing")).toBeNull();
    expect(parent.querySelector(".cm-table-widget")).toBeTruthy();
    expect(h.getValue()).toContain("|     B     |");
    // a single undo restores the previous table text
    undo(h.view);
    expect(h.getValue()).toContain("|   **b**   |");
    h.destroy();
  });

  it("Enter moves to the cell below and adds a row at the end; blur commits", () => {
    const { parent, h } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\nend");
    down(cell(parent, 0, 1));
    key(cell(parent, 0, 1), "Enter");
    expect(cell(parent, 1, 1).classList.contains("is-editing")).toBe(true);
    expect(h.getValue()).toBe("| a | b |\n|---|---|\n| 1 | 2 |\n\nend"); // nothing changed: untouched formatting
    key(cell(parent, 1, 1), "Enter");
    expect(h.getValue()).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n|     |     |\n\nend");
    const c = cell(parent, 2, 1);
    expect(c.classList.contains("is-editing")).toBe(true);
    c.textContent = "日本";
    c.dispatchEvent(new FocusEvent("blur"));
    expect(h.getValue()).toBe("| a   | b    |\n| --- | ---- |\n| 1   | 2    |\n|     | 日本 |\n\nend");
    expect(parent.querySelector(".is-editing")).toBeNull();
    h.destroy();
  });

  it("context menu adds/deletes rows and columns and sets alignment", () => {
    const { parent, h, menus } = mount("| a | b |\n|---|---|\n| 1 | 2 |\n\nend");
    const open = (r: number, c: number) => {
      cell(parent, r, c).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      return menus[menus.length - 1];
    };
    const pick = (items: TableMenuItem[], title: string) => items.find((i) => i.title === title)!;
    let items = open(0, 0);
    expect(pick(items, "Add row above").disabled).toBe(true);
    expect(pick(items, "Delete row").disabled).toBe(true);
    expect(pick(items, "No alignment").checked).toBe(true);
    pick(items, "Add column right").onClick();
    expect(h.getValue()).toBe("| a   |     | b   |\n| --- | --- | --- |\n| 1   |     | 2   |\n\nend");
    pick(open(1, 2), "Align right").onClick();
    expect(h.getValue()).toBe("| a   |     |   b |\n| --- | --- | --: |\n| 1   |     |   2 |\n\nend");
    pick(open(1, 1), "Delete column").onClick();
    pick(open(1, 0), "Add row below").onClick();
    pick(open(1, 0), "Add row above").onClick();
    expect(h.getValue()).toBe("| a   |   b |\n| --- | --: |\n|     |     |\n| 1   |   2 |\n|     |     |\n\nend");
    pick(open(2, 0), "Delete row").onClick();
    pick(open(0, 1), "Align center").onClick();
    expect(h.getValue()).toBe("| a   |  b  |\n| --- | :-: |\n|     |     |\n|     |     |\n\nend");
    // a pending cell edit is committed before the menu acts
    down(cell(parent, 1, 0));
    cell(parent, 1, 0).textContent = "x";
    pick(open(1, 0), "Add column left").onClick();
    expect(h.getValue()).toBe("|     | a   |  b  |\n| --- | --- | :-: |\n|     | x   |     |\n|     |     |     |\n\nend");
    h.destroy();
  });

  it("keyboard cursor entering the table still reveals the raw markdown", () => {
    const { parent, h } = mount(DOC);
    h.view.dispatch({ selection: { anchor: DOC.indexOf("| 1") + 2 } });
    expect(parent.querySelector(".cm-table-widget")).toBeNull();
    expect(parent.querySelector(".HyperMD-table-row")).toBeTruthy();
    h.destroy();
  });
});
