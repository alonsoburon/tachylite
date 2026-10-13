import { describe, it, expect, vi } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree, indentUnit } from "@codemirror/language";
import { CompletionContext } from "@codemirror/autocomplete";
import {
  createEditor, continueMarkup, obsidianMarkdown, buildInline, buildBlocks, envFacet, toggleBold, toggleItalic, toggleHighlight,
  toggleStrikethrough, toggleInlineCode, insertLink, toggleChecklist, toggleTask, indentListMore, indentListLess,
  wikilinkCompletionSource, tagCompletionSource, headingFold, listFold, parseTable,
  type EditorHost, type LinkTarget,
} from "../src/editor";

const FILES = ["Alpha.md", "Beta.md", "folder/Gamma.md", "img/pic.png"];

function mkhost(over: Partial<EditorHost> = {}): EditorHost & { opened: any[] } {
  const opened: any[] = [];
  return {
    resolveLink: (p) => FILES.find((f) => f === p || f === p + ".md" || f.endsWith("/" + p) || f.endsWith("/" + p + ".md")) ?? null,
    listLinkTargets: (q): LinkTarget[] => {
      const [file, sub] = q.split("#");
      if (sub !== undefined && sub.startsWith("^")) return [{ linktext: `${file}#^abc123`, type: "block", detail: "a block" }];
      if (sub !== undefined) return [{ linktext: `${file}#Intro`, type: "heading" as const }, { linktext: `${file}#Outro`, type: "heading" as const }].filter((t) => t.linktext.toLowerCase().includes(sub.toLowerCase()));
      return FILES.filter((f) => f.toLowerCase().includes(q.toLowerCase())).map((f) => ({ linktext: f.replace(/\.md$/, ""), type: "file" as const }));
    },
    listTags: () => ["#project", "#project/alpha", "idea"],
    getResourceUrl: (p) => "app://res/" + p,
    openLink: (...a) => opened.push(a),
    opened,
    readFile: async () => "",
    ...over,
  };
}

function env(host = mkhost(), source = "Alpha.md") {
  return { host, getSourcePath: () => source };
}

function mkstate(doc: string, cursor = 0, anchor?: number) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor ?? cursor, cursor),
    extensions: [obsidianMarkdown(), indentUnit.of("\t"), envFacet.of(env())],
  });
}

function decos(doc: string, cursor: number, live = true) {
  const state = mkstate(doc, cursor);
  const set = buildInline(state, [{ from: 0, to: doc.length }], live, env());
  const hidden: string[] = [];
  const widgets: string[] = [];
  const marks: { text: string; cls: string; attrs: any }[] = [];
  const lines: { from: number; cls: string; attrs: any }[] = [];
  set.between(0, doc.length, (from, to, v) => {
    const spec: any = v.spec;
    if (spec.widget) widgets.push(spec.widget.constructor.name);
    else if (spec.class !== undefined && from === to) lines.push({ from, cls: spec.class, attrs: spec.attributes });
    else if ((v as any).point) hidden.push(doc.slice(from, to));
    else if (spec.class !== undefined) marks.push({ text: doc.slice(from, to), cls: spec.class, attrs: spec.attributes });
  });
  return { hidden, widgets, marks, lines };
}

function run(cmd: any, doc: string, from: number, to = from) {
  let state = mkstate(doc, to, from);
  const ok = cmd({ state, dispatch: (tr: any) => (state = tr.state) });
  return { ok, doc: state.doc.toString(), sel: state.selection.main };
}

function nodeNames(doc: string): string[] {
  const names: string[] = [];
  syntaxTree(mkstate(doc)).iterate({ enter: (n) => { names.push(n.name); } });
  return names;
}

describe("parser", () => {
  it("parses wikilinks, embeds, tags, highlights, comments, math, footnotes", () => {
    const names = nodeNames("[[A|b]] ![[img.png]] #tag ==hl== %%c%% $x$ [^1]");
    for (const n of ["Wikilink", "WikiLinkAlias", "Embed", "Tag", "Highlight", "HighlightMark", "ObsComment", "MathInline", "FootnoteRef"]) {
      expect(names).toContain(n);
    }
  });
  it("does not parse tags in code or headings", () => {
    expect(nodeNames("`#nope`")).not.toContain("Tag");
    expect(nodeNames("# Heading")).not.toContain("Tag");
    expect(nodeNames("http://x.y/#frag")).not.toContain("Tag");
    expect(nodeNames("#123")).not.toContain("Tag");
  });
  it("parses frontmatter and math blocks", () => {
    expect(nodeNames("---\ntitle: x\n# not heading\n---\n\ntext")).toContain("Frontmatter");
    expect(nodeNames("---\ntitle: x\n# not heading\n---\n\ntext")).not.toContain("ATXHeading1");
    expect(nodeNames("$$\na+b\n$$")).toContain("MathBlock");
    expect(nodeNames("$$ unterminated")).not.toContain("MathBlock");
  });
});

describe("live preview decorations", () => {
  it("hides heading marker away from the cursor, shows on its line", () => {
    const doc = "# Title\n\nbody";
    expect(decos(doc, doc.length).hidden).toContain("# ");
    expect(decos(doc, 3).hidden).not.toContain("# ");
    const d = decos(doc, doc.length);
    expect(d.lines.some((l) => l.cls.includes("HyperMD-header-1"))).toBe(true);
    expect(d.marks.some((m) => m.cls.includes("cm-header-1") && m.text === "Title")).toBe(true);
  });

  it("hides ** only when the cursor is outside the element", () => {
    const doc = "a **bold** b";
    expect(decos(doc, 0).hidden).toEqual(["**", "**"]);
    expect(decos(doc, 5).hidden).toEqual([]);
    expect(decos(doc, 3).hidden).toEqual([]); // adjacent counts as touching
    expect(decos(doc, 5).marks.some((m) => m.cls.includes("cm-formatting-strong"))).toBe(true);
    expect(decos(doc, 0).marks.some((m) => m.cls === "cm-strong" && m.text === "bold")).toBe(true);
  });

  it("source mode never hides", () => {
    const d = decos("a **bold** and *em* ==hl== ~~s~~ `c` [[x]]", 0, false);
    expect(d.hidden).toEqual([]);
    const all = d.marks.map((m) => m.cls).join(" ");
    for (const c of ["cm-strong", "cm-em", "cm-highlight", "cm-strikethrough", "cm-inline-code", "cm-formatting", "cm-hmd-internal-link"]) expect(all).toContain(c);
  });

  it("handles em, strike, highlight, inline code, comments", () => {
    const doc = "x *em* ~~st~~ ==hl== `code` %%cm%% y";
    const d = decos(doc, doc.length);
    expect(d.hidden).toEqual(["*", "*", "~~", "~~", "==", "==", "`", "`", "%%", "%%"]);
  });

  it("wikilinks: brackets hidden, alias shown, unresolved flagged, data-href set", () => {
    const doc = "see [[Alpha|the alpha]] and [[Nope]] end";
    const d = decos(doc, doc.length);
    expect(d.hidden).toEqual(["[[", "Alpha|", "]]", "[[", "]]"]);
    const a = d.marks.find((m) => m.text === "the alpha")!;
    expect(a.attrs["data-href"]).toBe("Alpha");
    expect(a.cls).toContain("cm-hmd-internal-link");
    expect(a.cls).not.toContain("is-unresolved");
    expect(d.marks.find((m) => m.text === "Nope")!.cls).toContain("is-unresolved");
    expect(decos(doc, 8).hidden).toEqual(["[[", "]]"].slice(0, 0).concat(["[[", "]]"])); // second link only
  });

  it("tags get hashtag classes", () => {
    const d = decos("a #my/tag b", 0);
    expect(d.marks.some((m) => m.text === "#" && m.cls.includes("cm-formatting-hashtag"))).toBe(true);
    expect(d.marks.some((m) => m.text === "my/tag" && m.cls.includes("cm-hashtag-end"))).toBe(true);
  });

  it("markdown links hide label brackets and url", () => {
    const doc = "go [here](http://x.y/z) now";
    expect(decos(doc, doc.length).hidden).toEqual(["[", "](http://x.y/z)"]);
    const d = decos(doc, 5);
    expect(d.hidden).toEqual([]);
    expect(d.marks.some((m) => m.cls.includes("cm-url"))).toBe(true);
  });

  it("bullets and checkboxes become widgets; raw when cursor on marker", () => {
    const doc = "- one\n- [ ] task\n- [x] done\n\nend";
    const d = decos(doc, doc.length);
    expect(d.widgets.filter((w) => w === "BulletWidget").length).toBe(3);
    expect(d.widgets.filter((w) => w === "CheckboxWidget").length).toBe(2);
    expect(d.lines.some((l) => l.cls.includes("HyperMD-task-line") && l.attrs["data-task"] === "x")).toBe(true);
    expect(d.lines.some((l) => l.cls.includes("HyperMD-list-line-1"))).toBe(true);
    const d2 = decos(doc, 8); // inside "[ ]" of task line
    expect(d2.widgets.filter((w) => w === "CheckboxWidget").length).toBe(1);
  });

  it("nested list levels", () => {
    const d = decos("- a\n\t- b\n\t\t- c", 0);
    const lv = d.lines.map((l) => /HyperMD-list-line-(\d)/.exec(l.cls)?.[1]).filter(Boolean);
    expect(lv).toEqual(["1", "2", "3"]);
  });

  it("quote marks hide off-line; quote line classes", () => {
    const doc = "> quoted\n\nafter";
    expect(decos(doc, doc.length).hidden).toContain("> ");
    expect(decos(doc, 3).hidden).not.toContain("> ");
    expect(decos(doc, 3).lines.some((l) => l.cls.includes("HyperMD-quote"))).toBe(true);
  });

  it("callouts: styled with icon when cursor outside, raw when inside", () => {
    const doc = "> [!warning] Careful\n> body text\n\nafter";
    const out = decos(doc, doc.length);
    expect(out.widgets).toContain("CalloutIconWidget");
    expect(out.lines.find((l) => l.attrs?.["data-callout"] === "warning")).toBeTruthy();
    const inside = decos(doc, 25);
    expect(inside.widgets).not.toContain("CalloutIconWidget");
    expect(inside.hidden).toEqual([]);
  });

  it("horizontal rule becomes widget off-line", () => {
    expect(decos("a\n\n---\n\nb", 8).widgets).toContain("HrWidget");
    expect(decos("a\n\n---\n\nb", 4).widgets).not.toContain("HrWidget");
  });

  it("fenced code: block lines, language, fence hidden outside", () => {
    const doc = "```js\nlet a = 1;\n```\n\nafter";
    const d = decos(doc, doc.length);
    expect(d.lines.filter((l) => l.cls.includes("HyperMD-codeblock")).length).toBe(3);
    expect(d.lines.find((l) => l.cls.includes("HyperMD-codeblock-begin"))!.attrs["data-lang"]).toBe("js");
    expect(d.hidden).toEqual(["```js", "```"]);
    expect(decos(doc, 8).hidden).toEqual([]);
  });

  it("math inline: widget outside, raw inside", () => {
    const doc = "a $x^2$ b";
    expect(decos(doc, doc.length).widgets).toContain("MathWidget");
    expect(decos(doc, 4).widgets).not.toContain("MathWidget");
  });

  it("embeds and images", () => {
    const doc = "![[pic.png|200]]\n\n![alt|100](img/pic.png)\n\nend";
    const d = decos(doc, doc.length);
    expect(d.widgets).toContain("EmbedWidget");
    expect(d.widgets).toContain("ImageWidget");
    expect(decos(doc, 3).widgets).not.toContain("EmbedWidget");
  });

  it("block ids and footnote refs are marked", () => {
    const d = decos("para ^abc123\n\ntext[^1]", 0);
    expect(d.marks.some((m) => m.text === "^abc123" && m.cls.includes("cm-blockid"))).toBe(true);
    expect(d.marks.some((m) => m.cls.includes("cm-footref"))).toBe(true);
  });

  it("table: block widget when cursor outside; raw rows when inside", () => {
    const doc = "| a | b |\n|---|:-:|\n| 1 | 2 |\n\nend";
    const outside = mkstate(doc, doc.length);
    const set = buildBlocks(outside, env());
    let n = 0;
    set.between(0, doc.length, () => { n++; });
    expect(n).toBe(1);
    const inside = mkstate(doc, 3);
    let m = 0;
    buildBlocks(inside, env()).between(0, doc.length, () => { m++; });
    expect(m).toBe(0);
    expect(decos(doc, 3).lines.filter((l) => l.cls.includes("HyperMD-table-row")).length).toBe(3);
  });

  it("frontmatter becomes a block widget; math block too", () => {
    const doc = "---\ntitle: x\n---\n\n$$\na+b\n$$\n\nend";
    let n = 0;
    buildBlocks(mkstate(doc, doc.length), env()).between(0, doc.length, () => { n++; });
    expect(n).toBe(2);
    let m = 0;
    buildBlocks(mkstate(doc, 6), env()).between(0, doc.length, () => { m++; });
    expect(m).toBe(1);
  });

  it("parseTable handles alignment, escaped pipes and wikilinks", () => {
    const p = parseTable("| a | b \\| c | [[x|y]] |\n|:--|--:|:-:|\n| 1 | 2 | 3 |")!;
    expect(p.rows[0].map((c) => c.text)).toEqual(["a", "b \\| c", "[[x|y]]"]);
    expect(p.align).toEqual(["left", "right", "center"]);
    expect(p.rows.length).toBe(2);
  });
});

describe("commands", () => {
  it("Mod-B wraps and unwraps selection", () => {
    const a = run(toggleBold, "hello world", 0, 5);
    expect(a.doc).toBe("**hello** world");
    expect(a.sel.from).toBe(2);
    expect(a.sel.to).toBe(7);
    const b = run(toggleBold, a.doc, a.sel.from, a.sel.to);
    expect(b.doc).toBe("hello world");
    expect(b.sel.from).toBe(0);
    expect(b.sel.to).toBe(5);
  });
  it("bold with empty selection wraps the word or inserts a pair", () => {
    expect(run(toggleBold, "hello world", 2).doc).toBe("**hello** world");
    expect(run(toggleBold, "a  b", 2).doc).toBe("a **** b");
    expect(run(toggleBold, "a **** b", 4).doc).toBe("a  b");
  });
  it("italic vs bold do not confuse each other", () => {
    expect(run(toggleItalic, "**x**", 2, 3).doc).toBe("***x***");
    expect(run(toggleBold, "***x***", 3, 4).doc).toBe("*x*");
    expect(run(toggleItalic, "*x*", 1, 2).doc).toBe("x");
  });
  it("selection containing markers is unwrapped", () => {
    expect(run(toggleBold, "**x**", 0, 5).doc).toBe("x");
    expect(run(toggleHighlight, "a b", 0, 3).doc).toBe("==a b==");
    expect(run(toggleStrikethrough, "~~a~~", 2, 3).doc).toBe("a");
    expect(run(toggleInlineCode, "x", 0, 1).doc).toBe("`x`");
  });
  it("Mod-K link insertion", () => {
    const a = run(insertLink, "text here", 0, 4);
    expect(a.doc).toBe("[text]() here");
    expect(a.sel.from).toBe(7);
    const b = run(insertLink, "https://a.b", 0, 11);
    expect(b.doc).toBe("[](https://a.b)");
    expect(b.sel.from).toBe(1);
    expect(run(insertLink, "x", 1).doc).toBe("x[]()");
  });
  it("Mod-L toggles checklists and Mod-Enter toggles status", () => {
    expect(run(toggleChecklist, "item", 0).doc).toBe("- [ ] item");
    expect(run(toggleChecklist, "- item", 3).doc).toBe("- [ ] item");
    expect(run(toggleChecklist, "- [ ] item", 3).doc).toBe("- item");
    expect(run(toggleChecklist, "- a\n- b", 0, 7).doc).toBe("- [ ] a\n- [ ] b");
    expect(run(toggleTask, "- [ ] item", 8).doc).toBe("- [x] item");
    expect(run(toggleTask, "- [x] item", 8).doc).toBe("- [ ] item");
    expect(run(toggleTask, "1. item", 5).doc).toBe("1. [ ] item");
  });
  it("Tab / Shift-Tab indent lists", () => {
    expect(run(indentListMore, "- a", 3).doc).toBe("\t- a");
    expect(run(indentListMore, "- a\n- b", 0, 7).doc).toBe("\t- a\n\t- b");
    expect(run(indentListLess, "\t- a", 3).doc).toBe("- a");
    expect(run(indentListMore, "plain", 2).doc).toBe("pl\tain");
  });
  it("Enter continues bullets, numbers, tasks, quotes and exits on empty item", () => {
    expect(run(continueMarkup, "- item", 6).doc).toBe("- item\n- ");
    expect(run(continueMarkup, "1. item", 7).doc).toBe("1. item\n2. ");
    expect(run(continueMarkup, "- [ ] item", 10).doc).toBe("- [ ] item\n- [ ] ");
    expect(run(continueMarkup, "> quote", 7).doc).toBe("> quote\n> ");
    expect(run(continueMarkup, "- item\n- ", 9).doc).toBe("- item\n");
  });
});

describe("folding", () => {
  it("headings fold to the next heading of same or higher level", () => {
    const doc = "# A\ntext\n## B\nmore\n# C\nend";
    const s = mkstate(doc);
    expect(headingFold(s, 0)).toEqual({ from: 3, to: doc.indexOf("# C") - 1 });
    expect(headingFold(s, doc.indexOf("## B"))).toEqual({ from: doc.indexOf("## B") + 4, to: doc.indexOf("# C") - 1 });
    expect(headingFold(s, 4)).toBeNull();
  });
  it("list items fold their children", () => {
    const doc = "- a\n\t- b\n\t- c\n- d";
    const s = mkstate(doc);
    expect(listFold(s, 0)).toEqual({ from: 3, to: doc.indexOf("\n- d") });
    expect(listFold(s, doc.indexOf("- d"))).toBeNull();
  });
});

describe("autocomplete", () => {
  const e = env();
  const src = wikilinkCompletionSource(e);
  const ctxAt = (doc: string, pos = doc.length) => new CompletionContext(mkstate(doc, pos), pos, true);

  it("[[ lists files", async () => {
    const r = await src(ctxAt("see [[al"));
    expect(r!.from).toBe(6);
    expect(r!.options.map((o) => o.label)).toEqual(["Alpha"]);
    const all = await src(ctxAt("[["));
    expect(all!.options.length).toBe(4);
  });
  it("[[Note# lists headings and #^ lists blocks", async () => {
    const h = await src(ctxAt("[[Alpha#"));
    expect(h!.options.map((o) => o.label)).toEqual(["Alpha#Intro", "Alpha#Outro"]);
    expect(h!.from).toBe(2);
    const b = await src(ctxAt("[[Alpha#^"));
    expect(b!.options.map((o) => o.label)).toEqual(["Alpha#^abc123"]);
  });
  it("![[ works, no completion after | or outside link, none in code", async () => {
    expect((await src(ctxAt("![[be")))!.options[0].label).toBe("Beta");
    expect(await src(ctxAt("[[Alpha|al"))).toBeNull();
    expect(await src(ctxAt("plain text"))).toBeNull();
    expect(await src(ctxAt("`[[al`", 5))).toBeNull();
  });
  it("applying a completion closes the link", async () => {
    const state = mkstate("x [[al", 6);
    let st = state;
    const view = { state, dispatch: (tr: any) => (st = st.update(tr).state) } as any;
    const r: any = await src(new CompletionContext(state, 6, true));
    const opt: any = r.options[0];
    opt.apply(view, opt, r.from, 6);
    expect(st.doc.toString()).toBe("x [[Alpha]]");
    expect(st.selection.main.head).toBe(11);
  });
  it("#tag completion", async () => {
    const t = tagCompletionSource(e);
    const r = await t(ctxAt("a #pro"));
    expect(r!.from).toBe(2);
    expect(r!.options.map((o) => o.label)).toEqual(["#project", "#project/alpha"]);
    expect(await t(ctxAt("# heading"))).toBeNull();
    expect(await t(ctxAt("word#pro"))).toBeNull();
  });
});

describe("createEditor (DOM)", () => {
  function mount(doc: string, extra: any = {}) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const host = mkhost();
    const onChange = vi.fn();
    const h = createEditor(parent, { doc, host, sourcePath: "Alpha.md", onChange, mode: "live-preview", ...extra });
    return { parent, h, host, onChange };
  }
  function type(view: EditorView, text: string) {
    const sel = view.state.selection.main;
    const handlers = view.state.facet(EditorView.inputHandler);
    const insert = () => view.state.update(view.state.replaceSelection(text), { userEvent: "input.type" });
    for (const fn of handlers) if (fn(view, sel.from, sel.to, text, insert)) return;
    view.dispatch(insert());
  }

  it("applies root and CM classes, mode switching", () => {
    const { parent, h } = mount("# hi");
    expect(parent.classList.contains("markdown-source-view")).toBe(true);
    expect(parent.classList.contains("cm-s-obsidian")).toBe(true);
    expect(parent.classList.contains("mod-cm6")).toBe(true);
    expect(parent.classList.contains("is-live-preview")).toBe(true);
    expect(parent.querySelector(".cm-editor .cm-scroller .cm-content .cm-line")).toBeTruthy();
    h.setMode("source");
    expect(parent.classList.contains("is-live-preview")).toBe(false);
    expect(h.mode).toBe("source");
    h.destroy();
    expect(parent.classList.contains("mod-cm6")).toBe(false);
  });

  it("renders decorated lines in the DOM", () => {
    const { parent, h } = mount("# Title\n\n- [ ] task\n\n> [!note] N\n> x\n\n**b** [[Alpha]]\n\nend", { });
    h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
    const c = parent.querySelector(".cm-content")!;
    expect(c.querySelector(".HyperMD-header.HyperMD-header-1")).toBeTruthy();
    expect(c.querySelector(".cm-header-1")).toBeTruthy();
    expect(c.querySelector(".HyperMD-task-line")).toBeTruthy();
    expect(c.querySelector(".HyperMD-list-line")).toBeTruthy();
    expect(c.querySelector(".HyperMD-quote")).toBeTruthy();
    expect(c.querySelector(".cm-strong")).toBeTruthy();
    expect(c.querySelector(".cm-hmd-internal-link")).toBeTruthy();
    expect(c.querySelector("input.task-list-item-checkbox")).toBeTruthy();
    expect(c.querySelector(".cm-active")).toBeTruthy();
    expect(c.textContent).not.toContain("**");
    h.view.dispatch({ selection: { anchor: 20 } });
    h.destroy();
  });

  it("source mode keeps markers visible in DOM", () => {
    const { parent, h } = mount("**b** and `c`", { mode: "source" });
    expect(parent.querySelector(".cm-content")!.textContent).toBe("**b** and `c`");
    expect(parent.querySelector(".cm-formatting-strong")).toBeTruthy();
    h.destroy();
  });

  it("clicking a task checkbox rewrites [ ] / [x]", () => {
    const { parent, h } = mount("- [ ] a\n\nend");
    h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
    const box = parent.querySelector<HTMLInputElement>("input.task-list-item-checkbox")!;
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(h.getValue()).toBe("- [x] a\n\nend");
    h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
    parent.querySelector<HTMLInputElement>("input.task-list-item-checkbox")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(h.getValue()).toBe("- [ ] a\n\nend");
    h.destroy();
  });

  it("click on a wikilink in live preview opens it; ctrl-click in source mode", () => {
    const { parent, h, host } = mount("see [[Alpha|A]] now");
    h.view.dispatch({ selection: { anchor: h.view.state.doc.length } });
    const link = parent.querySelector<HTMLElement>(".cm-hmd-internal-link")!;
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(host.opened).toEqual([["Alpha", "Alpha.md", false]]);
    h.setMode("source");
    const l2 = parent.querySelector<HTMLElement>(".cm-hmd-internal-link")!;
    l2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    expect(host.opened.length).toBe(1);
    l2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ctrlKey: true }));
    expect(host.opened[1]).toEqual(["Alpha", "Alpha.md", true]);
    h.destroy();
  });

  it("bracket auto-closing: [[ -> [[]], backtick, **, wrap selection", () => {
    const { h } = mount("");
    type(h.view, "[");
    expect(h.getValue()).toBe("[]");
    type(h.view, "[");
    expect(h.getValue()).toBe("[[]]");
    expect(h.view.state.selection.main.head).toBe(2);
    h.setValue("");
    type(h.view, "`");
    expect(h.getValue()).toBe("``");
    h.setValue("");
    type(h.view, "*");
    expect(h.getValue()).toBe("*");
    type(h.view, "*");
    expect(h.getValue()).toBe("****");
    expect(h.view.state.selection.main.head).toBe(2);
    type(h.view, "x");
    type(h.view, "*");
    type(h.view, "*");
    expect(h.getValue()).toBe("**x**");
    expect(h.view.state.selection.main.head).toBe(5);
    h.setValue("word");
    h.view.dispatch({ selection: { anchor: 0, head: 4 } });
    type(h.view, "*");
    expect(h.getValue()).toBe("*word*");
    h.setValue("(");
    h.view.dispatch({ selection: { anchor: 1 } });
    h.destroy();
  });

  it("onChange fires for edits but not for setValue", () => {
    const { h, onChange } = mount("a");
    h.view.dispatch({ changes: { from: 1, insert: "b" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe("ab");
    h.setValue("zzz");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(h.getValue()).toBe("zzz");
    h.destroy();
  });

  it("keymap: Mod-b via keydown, undo via history", () => {
    const { h } = mount("word");
    h.view.dispatch({ selection: { anchor: 0, head: 4 } });
    h.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(h.getValue()).toBe("**word**");
    h.destroy();
  });

  it("extraExtensions and reconfigure", () => {
    const marker = EditorView.contentAttributes.of({ "data-plugin": "yes" });
    const { h, parent } = mount("x", { extraExtensions: [marker] });
    expect(parent.querySelector(".cm-content")!.getAttribute("data-plugin")).toBe("yes");
    h.reconfigure({ extraExtensions: [] });
    expect(parent.querySelector(".cm-content")!.getAttribute("data-plugin")).toBeNull();
    h.reconfigure({ readOnly: true, showLineNumbers: true, lineWrapping: false });
    expect(h.view.state.readOnly).toBe(true);
    expect(parent.querySelector(".cm-lineNumbers")).toBeTruthy();
    h.destroy();
  });
});
