// Coloured highlights and fold more/less, with behavior recorded from Obsidian 1.14.4.
import { describe, expect, it } from "vitest";
import { codeFolding, foldedRanges, ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/editor";
import { headingFoldService } from "../src/editor/folding";
import { coloredHighlight, foldLess, foldMore, HIGHLIGHT_COLORS } from "../src/editor/editorExtras";

function run(doc: string, anchor: number, head = anchor, emoji = "🔴") {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  coloredHighlight(emoji)({ state, dispatch: (tr) => (state = tr.state) });
  const r = state.selection.main;
  return { doc: state.doc.toString(), selected: state.sliceDoc(r.from, r.to), head: r.head };
}

describe("coloured highlights", () => {
  it("has Obsidian's six colours as emoji", () => {
    expect(HIGHLIGHT_COLORS).toEqual({ red: "🔴", orange: "🟠", yellow: "🟡", green: "🟢", blue: "🔵", purple: "🟣" });
  });
  it("wraps the selection as ==🔴text== and keeps the text selected (recorded from Obsidian)", () => {
    expect(run("some word here", 5, 9)).toMatchObject({ doc: "some ==🔴word== here", selected: "word" });
  });
  it("wraps the word under the cursor when nothing is selected", () => {
    expect(run("some word here", 6)).toMatchObject({ doc: "some ==🔴word== here" });
    expect(run("a  b", 2).doc).toBe("a ==🔴== b"); // no word there: an empty highlight
  });
  it("takes the same colour off again, with the markers inside or outside the selection", () => {
    expect(run("some ==🔴word== here", 9, 13).doc).toBe("some word here");
    expect(run("some ==🔴word== here", 5, 15).doc).toBe("some word here");
  });
  it("uses the colour it is given", () => {
    expect(run("x", 0, 1, "🟣").doc).toBe("==🟣x==");
  });
});

function viewOf(doc: string, anchor: number) {
  const make = () => EditorState.create({ doc, selection: EditorSelection.single(anchor), extensions: [obsidianMarkdown(), headingFoldService(), codeFolding()] });
  let state = make();
  for (let i = 0; i < 200 && (ensureSyntaxTree(state, doc.length, 5000), syntaxTree(state).length < doc.length); i++) state = make();
  return new EditorView({ state });
}
const folds = (v: EditorView) => { const out: string[] = []; foldedRanges(v.state).between(0, v.state.doc.length, (f, t) => { out.push(v.state.doc.sliceString(f, t).slice(0, 12).replace(/\n/g, "/")); }); return out; };

describe("fold more and less", () => {
  const doc = "# A\ntext a\n## A1\ntext a1\n### A1a\ntext a1a\n## A2\ntext a2\n# B\ntext b\n";
  it("folds the section around the cursor and unfolds it again (as Obsidian does with the cursor on a heading)", () => {
    const v = viewOf(doc, 0);
    expect(foldMore(v)).toBe(true);
    expect(folds(v)).toHaveLength(1);
    expect(foldMore(v)).toBe(false); // nothing further out to fold
    expect(foldLess(v)).toBe(true);
    expect(folds(v)).toHaveLength(0);
    expect(foldLess(v)).toBe(false);
  });
  it("folds outwards one level at a time from a nested heading, and unfolds the outermost fold first", () => {
    const v = viewOf(doc, doc.indexOf("### A1a"));
    expect(foldMore(v)).toBe(true);
    expect(folds(v)).toHaveLength(1);
    v.dispatch({ selection: EditorSelection.cursor(doc.indexOf("### A1a")) });
    expect(foldMore(v)).toBe(true);
    expect(folds(v)).toHaveLength(2);
    expect(foldLess(v)).toBe(true);
    expect(folds(v)).toHaveLength(1);
  });
});
