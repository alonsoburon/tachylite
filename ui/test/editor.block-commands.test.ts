import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import {
  clearFormatting, insertFootnote, stripFormatting, deleteParagraph, insertCallout, insertCodeBlock, insertEmbed, insertHorizontalRule, insertTag, insertWikilink, setHeading,
  toggleBlockquote, toggleBulletList, toggleNumberedList,
} from "../src/editor/blockCommands";

function run(cmd: StateCommand, doc: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  const ok = cmd({ state, dispatch: (tr) => (state = tr.state) });
  return { ok, doc: state.doc.toString(), sel: state.selection.main };
}

describe("lists and quotes", () => {
  it("toggles bullets on and off across the selected lines", () => {
    expect(run(toggleBulletList, "a\nb", 0, 3).doc).toBe("- a\n- b");
    expect(run(toggleBulletList, "- a\n- b", 0, 7).doc).toBe("a\nb");
  });
  it("converts a numbered list to bullets and back", () => {
    expect(run(toggleBulletList, "1. a\n2. b", 0, 9).doc).toBe("- a\n- b");
    expect(run(toggleNumberedList, "- a\n- b", 0, 7).doc).toBe("1. a\n2. b");
    expect(run(toggleNumberedList, "1. a\n2. b", 0, 9).doc).toBe("a\nb");
  });
  it("keeps indentation and quote markers in front of the list marker", () => {
    expect(run(toggleBulletList, "  a", 2).doc).toBe("  - a");
    expect(run(toggleBulletList, "> a", 2).doc).toBe("> - a");
  });
  it("toggles blockquotes", () => {
    expect(run(toggleBlockquote, "a\nb", 0, 3).doc).toBe("> a\n> b");
    expect(run(toggleBlockquote, "> a\n> b", 0, 7).doc).toBe("a\nb");
  });
});

describe("headings", () => {
  it("sets, switches, toggles off and clears", () => {
    expect(run(setHeading(2), "title", 0).doc).toBe("## title");
    expect(run(setHeading(3), "## title", 0).doc).toBe("### title");
    expect(run(setHeading(2), "## title", 0).doc).toBe("title");
    expect(run(setHeading(0), "#### title", 0).doc).toBe("title");
  });
});

describe("inserts", () => {
  it("wraps the selection as a link or embed and leaves the cursor inside when empty", () => {
    expect(run(insertWikilink, "see note", 4, 8).doc).toBe("see [[note]]");
    const e = run(insertEmbed, "", 0);
    expect(e.doc).toBe("![[]]");
    expect(e.sel.head).toBe(3);
    expect(run(insertTag, "a ", 2).doc).toBe("a #");
  });
  it("inserts blocks on their own line", () => {
    expect(run(insertHorizontalRule, "text", 4).doc).toBe("text\n---\n");
    const c = run(insertCallout, "", 0);
    expect(c.doc).toBe("> [!note]\n> ");
    expect(c.sel.head).toBe(c.doc.length);
  });
  it("fences the selection as a code block", () => {
    expect(run(insertCodeBlock, "code", 0, 4).doc).toBe("```\ncode\n```");
    const e = run(insertCodeBlock, "", 0);
    expect(e.doc).toBe("```\n\n```");
    expect(e.sel.head).toBe(4);
  });
});

describe("deleteParagraph", () => {
  it("removes the paragraph under the cursor and the blank line after it", () => {
    expect(run(deleteParagraph, "one\ntwo\n\nthree", 1).doc).toBe("three");
    expect(run(deleteParagraph, "one\n\nthree\nfour", 8).doc).toBe("one\n");
  });
  it("does nothing on a blank line", () => {
    expect(run(deleteParagraph, "a\n\nb", 2).ok).toBe(false);
  });
});

describe("clear formatting", () => {
  it("removes emphasis, strikethrough, highlight, inline code and block prefixes", () => {
    expect(stripFormatting("**bold** and *it* and __b2__ and _i2_ and ~~gone~~ and ==hi== and `code`")).toBe("bold and it and b2 and i2 and gone and hi and code");
    expect(stripFormatting("## Heading")).toBe("Heading");
    expect(stripFormatting("> quoted\n- [ ] task\n1. one\n* star")).toBe("quoted\ntask\none\nstar");
  });
  it("leaves identifiers, math and plain text alone", () => {
    expect(stripFormatting("snake_case_name and 2*3*4 and a * b")).toBe("snake_case_name and 2*3*4 and a * b");
    expect(stripFormatting("plain text")).toBe("plain text");
  });
  it("applies to the selection, or to the current line without one", () => {
    expect(run(clearFormatting, "a **b** c\n**d**", 2, 7).doc).toBe("a b c\n**d**");
    expect(run(clearFormatting, "## **Title** here\nnext", 5).doc).toBe("Title here\nnext");
    expect(run(clearFormatting, "nothing here", 3).ok).toBe(false);
  });
});

describe("insert footnote", () => {
  it("adds the next footnote number at the cursor and a definition at the end, with the cursor in the definition", () => {
    const r = run(insertFootnote, "Text here\n", 4);
    expect(r.doc).toBe("Text[^1] here\n\n[^1]: ");
    expect(r.sel.head).toBe(r.doc.length);
    const next = run(insertFootnote, "A[^1] B[^3]\n\n[^1]: one\n[^3]: three\n", 1);
    expect(next.doc.startsWith("A[^4][^1] B[^3]")).toBe(true);
    expect(next.doc.endsWith("[^3]: three\n\n[^4]: ")).toBe(true);
  });
  it("copes with notes that do not end in a newline", () => {
    expect(run(insertFootnote, "abc", 3).doc).toBe("abc[^1]\n\n[^1]: ");
  });
});
