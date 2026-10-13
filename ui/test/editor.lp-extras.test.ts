// Live Preview extras: setext headings, callout folding, inline footnotes.
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { createEditor, obsidianMarkdown, buildInline, buildSetext, envFacet, type EditorHost } from "../src/editor";

const host: EditorHost = {
  resolveLink: () => null, listLinkTargets: () => [], listTags: () => [], getResourceUrl: (p) => p,
  openLink: () => {}, readFile: async () => "",
};
const env = { host, getSourcePath: () => "N.md" };

function mkstate(doc: string, cursor: number) {
  const s = EditorState.create({ doc, selection: EditorSelection.single(cursor), extensions: [obsidianMarkdown(), envFacet.of(env)] });
  ensureSyntaxTree(s, doc.length, 5000);
  return s;
}
function hiddenBy(set: ReturnType<typeof buildSetext>, doc: string): string[] {
  const out: string[] = [];
  set.between(0, doc.length, (f, t) => { out.push(doc.slice(f, t)); });
  return out;
}

describe("setext headings in Live Preview", () => {
  const doc = "Title **one**\n===\n\npara\n\nSub\n---\n\n> Quoted\n> ===\n\nend";
  it("hide the underline (with its line break) when the cursor is elsewhere, reveal on either line", () => {
    expect(hiddenBy(buildSetext(mkstate(doc, doc.length)), doc)).toEqual(["\n===", "\n---", "\n> ==="]);
    expect(hiddenBy(buildSetext(mkstate(doc, 2)), doc)).toEqual(["\n---", "\n> ==="]);
    expect(hiddenBy(buildSetext(mkstate(doc, doc.indexOf("---") + 1)), doc)).toEqual(["\n===", "\n> ==="]);
  });
  it("style the text line like ATX headings (line + text classes)", () => {
    const s = mkstate(doc, doc.length);
    const set = buildInline(s, [{ from: 0, to: doc.length }], true, env);
    const lines: string[] = [];
    const marks: { text: string; cls: string }[] = [];
    set.between(0, doc.length, (f, t, v) => {
      const spec: any = v.spec;
      if (f === t && spec.class !== undefined) lines.push(`${s.doc.lineAt(f).number}:${spec.class}`);
      else if (spec.class) marks.push({ text: doc.slice(f, t), cls: spec.class });
    });
    expect(lines.some((l) => l.startsWith("1:") && l.includes("HyperMD-header HyperMD-header-1"))).toBe(true);
    expect(lines.some((l) => l.startsWith("6:") && l.includes("HyperMD-header-2"))).toBe(true);
    expect(marks.find((m) => m.cls === "cm-header cm-header-1")?.text).toBe("Title **one**");
  });
  it("works in a real editor: the underline is not in the DOM until the cursor enters", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const h = createEditor(parent, { doc, host, mode: "live-preview" });
    h.view.dispatch({ selection: { anchor: doc.length } });
    expect(parent.querySelector(".cm-content")!.textContent).not.toContain("===");
    expect(parent.querySelector(".cm-line.HyperMD-header-1")?.textContent).toContain("Title");
    h.view.dispatch({ selection: { anchor: 1 } });
    expect(parent.querySelector(".cm-content")!.textContent).toContain("===");
    h.setMode("source");
    h.view.dispatch({ selection: { anchor: doc.length } });
    expect(parent.querySelector(".cm-content")!.textContent).toContain("===");
    h.destroy();
  });
});

describe("callout folding in Live Preview", () => {
  const doc = "> [!note]- Folded\n> body one\n> body two\n\n> [!tip]+\n> open body\n\n> [!info] plain\n> x\n\nend";
  function mount() {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const h = createEditor(parent, { doc, host, mode: "live-preview" });
    h.view.dispatch({ selection: { anchor: doc.length } });
    return { parent, h, text: () => parent.querySelector(".cm-content")!.textContent ?? "" };
  }
  it("collapsed callouts hide their body; the chevron toggles without touching the file", () => {
    const { parent, h, text } = mount();
    const folds = () => [...parent.querySelectorAll<HTMLElement>(".cm-callout-fold")];
    expect(folds().length).toBe(2); // only foldable callouts
    expect(folds()[0].classList.contains("is-collapsed")).toBe(true);
    expect(folds()[1].classList.contains("is-collapsed")).toBe(false);
    expect(text()).not.toContain("body one");
    expect(text()).toContain("open body");
    expect(parent.querySelector(".cm-line.cm-callout-title.is-collapsed")).toBeTruthy();
    folds()[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(text()).toContain("body one");
    expect(folds()[0].classList.contains("is-collapsed")).toBe(false);
    folds()[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(text()).not.toContain("open body");
    expect(h.getValue()).toBe(doc);
    // the fold state follows edits before the callout
    h.view.dispatch({ changes: { from: 0, insert: "new line\n\n" }, selection: { anchor: doc.length + 10 } });
    expect(text()).toContain("body one");
    expect(text()).not.toContain("open body");
    // the cursor inside a collapsed callout reveals its source
    h.view.dispatch({ selection: { anchor: h.getValue().indexOf("open body") } });
    expect(text()).toContain("open body");
    h.destroy();
  });
});

describe("inline footnotes in the editor", () => {
  const doc = "a[^1] b^[see [[X]] here] c^[two]\n\n`^[code]`\n\n[^1]: def";
  it("parse with balanced brackets, render as numbered superscripts, reveal raw on cursor", () => {
    const s = mkstate(doc, doc.length);
    const names: string[] = [];
    ensureSyntaxTree(s, doc.length)!.iterate({ enter: (n) => { names.push(n.name); } });
    expect(names.filter((n) => n === "InlineFootnote").length).toBe(2);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const h = createEditor(parent, { doc, host, mode: "live-preview" });
    h.view.dispatch({ selection: { anchor: doc.length } });
    const sups = [...parent.querySelectorAll<HTMLElement>(".cm-inline-footnote-widget")];
    expect(sups.map((e) => e.textContent)).toEqual(["[2]", "[3]"]);
    expect(sups[0].title).toBe("see [[X]] here");
    expect(parent.querySelector(".cm-content")!.textContent).not.toContain("^[see");
    h.view.dispatch({ selection: { anchor: doc.indexOf("see") } });
    expect(parent.querySelector(".cm-content")!.textContent).toContain("^[see [[X]] here]");
    expect(parent.querySelector(".cm-formatting-inline-footnote")).toBeTruthy();
    expect(parent.querySelector(".cm-inline-footnote")).toBeTruthy();
    h.destroy();
  });
});
