// Pure helpers of the Templates / Daily notes / Note composer / Word count core plugins.
import moment from "moment";
import { describe, expect, it } from "vitest";
import { expandVariables, frontmatterBlock, mergeProperties, splitFrontmatter } from "../src/app/core/options";
import { applyEdits, cleanTitle, headingRange, joinNoteText, relink } from "../src/app/core/noteComposer";
import { countWords, stripFrontmatter } from "../src/app/core/wordCount";
import { dateFormatProblem } from "../src/app/core/dailyNotes";
import "../src/obsidian/index";

const at = moment("2024-03-05 14:07", "YYYY-MM-DD HH:mm");

describe("template variables", () => {
  it("expands keys case-insensitively, {{date}}/{{time}} with defaults, settings and per-use formats", () => {
    expect(expandVariables("# {{title}} {{TITLE}} {{date}} {{time}}", { title: "Note" }, {}, at)).toBe("# Note Note 2024-03-05 14:07");
    expect(expandVariables("{{date}}|{{time}}", {}, { dateFormat: "DD/MM", timeFormat: "h A" }, at)).toBe("05/03|2 PM");
    expect(expandVariables("{{date:YYYY [week] W}} {{time:ss}} {{Date:dddd}}", {}, {}, at)).toBe("2024 week 10 00 Tuesday");
    expect(expandVariables("{{ title }} {{content}}", { content: "$& body" }, {}, at)).toBe("{{ title }} $& body"); // no inner spaces; no $-patterns
  });
});

describe("properties merge", () => {
  it("splits, merges lists/objects like the docs describe and serialises", () => {
    expect(splitFrontmatter("---\na: 1\n---\nbody")).toEqual({ props: { a: 1 }, body: "body", exists: true });
    expect(splitFrontmatter("no fm").exists).toBe(false);
    expect(() => splitFrontmatter("---\n- x\n---\n")).toThrow();
    const m = mergeProperties({ tags: ["a"], title: "keep?", empty: null, nested: { x: 1 } }, { tags: ["a", "b"], title: "tpl", empty: "set", nested: { y: 2 }, nu: null, fresh: 3 });
    expect(m).toEqual({ tags: ["a", "b"], title: "tpl", empty: "set", nested: { x: 1, y: 2 }, nu: null, fresh: 3 });
    expect(mergeProperties({ a: "x" }, { a: null })).toEqual({ a: "x" });
    expect(frontmatterBlock({})).toBe("");
    expect(frontmatterBlock({ a: 1, t: ["x"] })).toBe("---\na: 1\nt:\n  - x\n---\n");
  });
});

describe("note composer helpers", () => {
  it("joins with one blank line, prepends, and merges both property blocks", () => {
    expect(joinNoteText("one", "two", "append")).toBe("one\n\ntwo");
    expect(joinNoteText("one\n", "two", "append")).toBe("one\n\ntwo");
    expect(joinNoteText("one\n\n", "two", "append")).toBe("one\n\ntwo");
    expect(joinNoteText("one", "two", "prepend")).toBe("two\n\none");
    expect(joinNoteText("", "two", "append")).toBe("two");
    expect(joinNoteText("---\ntags: [a]\n---\nbody", "---\ntags: [b]\nx: 1\n---\nnew", "append")).toBe("---\ntags:\n  - a\n  - b\nx: 1\n---\nbody\n\nnew");
  });
  it("re-targets wiki and markdown links keeping embed, alias and display text", () => {
    expect(relink({ original: "[[Old]]" }, "New")).toBe("[[New]]");
    expect(relink({ original: "![[Old#H|alias]]" }, "dir/New#H")).toBe("![[dir/New#H|alias]]");
    expect(relink({ original: "[text](Old.md)" }, "New Note.md")).toBe("[text](New%20Note.md)");
    expect(relink({ original: "[t](<Old.md>)" }, "New Note.md#H")).toBe("[t](<New Note.md#H>)");
    expect(applyEdits("abcdef", [{ start: 0, end: 1, text: "X" }, { start: 4, end: 6, text: "" }])).toBe("Xbcd");
  });
  it("finds a heading's section and cleans titles", () => {
    const text = "# A\nx\n## B\ny\n### C\nz\n## D\nw\n";
    const pos = (line: number) => { const off = text.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0); return { line, col: 0, offset: off }; };
    const headings = [["A", 1, 0], ["B", 2, 2], ["C", 3, 4], ["D", 2, 6]].map(([heading, level, line]) => ({ heading: heading as string, level: level as number, position: { start: pos(line as number), end: pos(line as number) } }));
    const r = headingRange({ headings }, 2, text)!;
    expect(text.slice(r.start, r.end)).toBe("## B\ny\n### C\nz");
    expect(text.slice(headingRange({ headings }, 6, text)!.start, headingRange({ headings }, 6, text)!.end)).toBe("## D\nw");
    expect(headingRange({ headings }, 1, text)).toBeNull();
    expect(cleanTitle("## My [[Link|Topic]]: part/2")).toBe("My Topic part 2");
    expect(cleanTitle("- [ ] task one")).toBe("task one");
  });
});

describe("word count rules", () => {
  it("counts words, numbers with separators and each CJK character; characters after properties", () => {
    expect(countWords("Hello world")).toBe(2);
    expect(countWords("don't stop-me now - ok")).toBe(4);
    expect(countWords("1,000.50 apples")).toBe(2);
    expect(countWords("日本語のテキスト")).toBe(8);
    expect(countWords("中文 and English")).toBe(4);
    expect(countWords("한국어 문장 입니다")).toBe(3);
    expect(countWords("café naïve — # ! **bold**")).toBe(3);
    expect(stripFrontmatter("---\na: 1\n---\nbody")).toBe("body");
  });
  it("validates daily note formats", () => {
    expect(dateFormatProblem("YYYY-MM-DD")).toBe("");
    expect(dateFormatProblem("YYYY/MM/YYYY-MM-DD")).toBe("");
    expect(dateFormatProblem("/YYYY")).not.toBe("");
    expect(dateFormatProblem("HH:mm")).not.toBe("");
  });
});
