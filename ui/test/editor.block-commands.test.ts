import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import {
  deleteParagraph, insertCallout, insertCodeBlock, insertEmbed, insertHorizontalRule, insertTag, insertWikilink, setHeading,
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
