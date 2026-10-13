// Editor surfaces plugins build on: HyperMD-compatible syntax nodes/token classes (Dataview's inline queries,
// latex-suite) and Live Preview widgets for fenced blocks claimed by code-block processors.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
  createEditor, obsidianMarkdown, splitFence, tokenClassNodeProp, type EditorHost, type CodeBlockRenderInfo,
} from "../src/editor";
import { createRequire } from "../src/obsidian/pluginLoader";

function host(over: Partial<EditorHost> = {}): EditorHost {
  return {
    resolveLink: () => null, listLinkTargets: () => [], listTags: () => [], getResourceUrl: (p) => p,
    openLink: () => {}, readFile: async () => "", ...over,
  };
}
const nodes = (doc: string) => {
  const out: { name: string; text: string; cls?: string }[] = [];
  syntaxTree(EditorState.create({ doc, extensions: [obsidianMarkdown()] })).iterate({
    enter: (n) => { out.push({ name: n.name, text: doc.slice(n.from, n.to), cls: n.type.prop(tokenClassNodeProp) }); },
  });
  return out;
};

class Chip extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: Chip) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "dataview-inline"; s.textContent = "Q:" + this.text; return s; }
}
/** The decision logic of Dataview's LP inline-query plugin: content node classes, `[from - 1, to + 1)` replacement. */
const inlineQueries = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = this.build(v); }
  update(u: { view: EditorView; docChanged: boolean; selectionSet: boolean }) { if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view); }
  build(v: EditorView) {
    const out: any[] = [];
    syntaxTree(v.state).iterate({
      enter: ({ node }) => {
        const props = new Set(node.type.prop(tokenClassNodeProp)?.split(" "));
        if (!props.has("inline-code") || props.has("formatting")) return;
        const text = v.state.doc.sliceString(node.from, node.to);
        if (!text.startsWith("=")) return;
        if (v.state.selection.ranges.some((r) => r.from <= node.to + 1 && r.to >= node.from - 1)) return;
        out.push(Decoration.replace({ widget: new Chip(text.slice(1).trim()) }).range(node.from - 1, node.to + 1));
      },
    });
    return Decoration.set(out, true);
  }
}, { decorations: (p) => p.decorations });

let parent: HTMLElement | null = null;
afterEach(() => { parent?.remove(); parent = null; });
const mount = (doc: string, h: EditorHost, extra: any[] = [], cursor = 0) => {
  parent = document.body.appendChild(document.createElement("div"));
  const ed = createEditor(parent, { doc, host: h, mode: "live-preview", extraExtensions: extra });
  ed.view.dispatch({ selection: { anchor: cursor } });
  return ed;
};

describe("HyperMD-compatible syntax nodes", () => {
  it("gives inline code a content node with the `inline-code` token class and no formatting class", () => {
    const n = nodes("a `= this.file.name` b **c** `` x ` y ``");
    const content = n.filter((x) => x.name === "inline-code");
    expect(content.map((x) => x.text)).toEqual(["= this.file.name", " x ` y "]);
    expect(content.every((x) => x.cls === "inline-code")).toBe(true);
    expect(n.filter((x) => x.name === "CodeMark").map((x) => [x.text, x.cls])).toEqual([["`", undefined], ["`", undefined], ["``", undefined], ["``", undefined]]);
    expect(n.find((x) => x.name === "InlineCode")?.cls).toBeUndefined();
    expect(n.find((x) => x.name === "StrongEmphasis")?.cls).toBe("strong");
    // unclosed backticks stay plain text
    expect(nodes("a `b").some((x) => x.name === "InlineCode")).toBe(false);
  });

  it("is what plugins get as `tokenClassNodeProp` from @codemirror/language", () => {
    const req = createRequire({} as any);
    expect(req("@codemirror/language").tokenClassNodeProp).toBe(tokenClassNodeProp);
  });

  it("lets a Dataview-style extension replace inline queries in Live Preview, raw again under the cursor", () => {
    const doc = "Name: `= this.file.name` and `plain`\nsecond line";
    const ed = mount(doc, host(), [inlineQueries], doc.length);
    const text = () => ed.view.contentDOM.textContent ?? "";
    expect(ed.view.contentDOM.querySelector(".dataview-inline")?.textContent).toBe("Q:this.file.name");
    expect(text()).not.toContain("`");
    expect(ed.view.contentDOM.querySelector(".cm-inline-code")?.textContent).toBe("plain");
    ed.view.dispatch({ selection: { anchor: doc.indexOf("this") } });
    expect(ed.view.contentDOM.querySelector(".dataview-inline")).toBeNull();
    expect(text()).toContain("`= this.file.name`");
    ed.destroy();
  });
});

describe("Live Preview code-block processor widgets", () => {
  it("splits fences like reading view hands them to processors", () => {
    expect(splitFence("```dataview\nLIST\nFROM \"x\"\n```")).toEqual({ lang: "dataview", source: "LIST\nFROM \"x\"" });
    expect(splitFence("~~~~ chart extra\na\n~~~~")).toEqual({ lang: "chart", source: "a" });
    expect(splitFence("```q\nopen")).toEqual({ lang: "q", source: "open" });
    expect(splitFence("````q\n```\n````")).toEqual({ lang: "q", source: "```" });
  });

  it("renders the block through the host with section info and unloads it when the cursor enters", async () => {
    const calls: { source: string; path: string; info?: CodeBlockRenderInfo }[] = [];
    const unload = vi.fn();
    const h = host({
      codeBlockLanguages: () => ["fixture"],
      renderCodeBlock: (el, md, path, info) => { calls.push({ source: md, path, info }); el.textContent = "rendered:" + splitFence(md).source; return { unload }; },
    });
    const doc = "intro\n\n```fixture\nhello\n```\n\nafter";
    const ed = mount(doc, h, [], 0);
    ed.setSourcePath("Note.md");
    ed.view.dispatch({ selection: { anchor: doc.length } });
    const w = ed.view.dom.querySelector(".cm-preview-code-block.cm-lang-fixture");
    expect(w?.textContent).toContain("rendered:hello");
    expect(w?.classList.contains("markdown-rendered")).toBe(true);
    const last = calls[calls.length - 1];
    expect(last.path).toBe("Note.md");
    expect(last.info?.getSectionInfo()).toMatchObject({ lineStart: 2, lineEnd: 4, text: doc });
    // edits elsewhere keep the same widget (no re-render)
    const n = calls.length;
    ed.view.dispatch({ changes: { from: doc.length, insert: "!" } });
    expect(calls.length).toBe(n);
    ed.view.dispatch({ selection: { anchor: doc.indexOf("hello") } });
    expect(ed.view.dom.querySelector(".cm-preview-code-block")).toBeNull();
    expect(unload).toHaveBeenCalled();
    ed.destroy();
  });

  it("unloads a render that finishes after the widget was destroyed", async () => {
    let resolve!: (h: { unload(): void }) => void;
    const unload = vi.fn();
    const h = host({ codeBlockLanguages: () => ["slow"], renderCodeBlock: () => new Promise((r) => { resolve = r; }) });
    const doc = "```slow\nx\n```\n\nend";
    const ed = mount(doc, h, [], doc.length);
    expect(ed.view.dom.querySelector(".cm-lang-slow")).not.toBeNull();
    ed.view.dispatch({ selection: { anchor: 3 } });
    expect(ed.view.dom.querySelector(".cm-lang-slow")).toBeNull();
    resolve({ unload });
    await new Promise((r) => setTimeout(r, 0));
    expect(unload).toHaveBeenCalledTimes(1);
    ed.destroy();
  });
});
