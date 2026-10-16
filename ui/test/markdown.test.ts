import { describe, it, expect, vi } from "vitest";
import {
  renderMarkdown, renderView, scrollToSubpath, slugifyHeading, extractSubpath,
  type RenderContext,
} from "../src/markdown";

const files: Record<string, string> = {
  "Note A.md": "# Note A\nhello from A\n\n## Sub\nsub text ^blk1\n\n## Other\nother",
  "Loop.md": "loop start ![[Loop]]",
  "Ping.md": "ping ![[Pong]]",
  "Pong.md": "pong ![[Ping]]",
  "img/pic.png": "",
  "doc.pdf": "",
  "a.mp3": "",
  "v.mp4": "",
};

function mkctx(over: Partial<RenderContext> = {}): RenderContext & { opened: any[] } {
  const opened: any[] = [];
  return {
    sourcePath: "Current.md",
    resolveLink: (p) => {
      if (files[p]) return p;
      if (files[p + ".md"]) return p + ".md";
      const hit = Object.keys(files).find((k) => k.endsWith("/" + p) || k === p);
      return hit ?? null;
    },
    readFile: async (p) => files[p] ?? "",
    getResourceUrl: (p) => "app://res/" + p,
    openLink: (...a) => opened.push(a),
    opened,
    ...over,
  };
}

async function render(md: string, over: Partial<RenderContext> = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const ctx = mkctx(over);
  await renderMarkdown(md, el, ctx);
  return { el, ctx };
}

describe("markdown renderer", () => {
  it("wraps sections in sizer", async () => {
    const { el } = await render("# T\n\npara");
    expect(el.querySelector(".markdown-preview-sizer > .markdown-preview-section")).toBeTruthy();
    expect(el.querySelectorAll(".markdown-preview-section").length).toBe(2);
  });

  it("renderView adds root classes", async () => {
    const el = document.createElement("div");
    await renderView(el, "x", mkctx());
    expect(el.classList.contains("markdown-preview-view")).toBe(true);
    expect(el.classList.contains("markdown-rendered")).toBe(true);
  });

  it("renders GFM: tables, strikethrough, autolink, task lists", async () => {
    const { el } = await render("| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ https://example.com\n\n- [ ] todo\n- [x] done\n- [-] custom");
    expect(el.querySelector("table th")?.textContent).toBe("a");
    expect(el.querySelector("s")?.textContent).toBe("gone");
    expect(el.querySelector("a.external-link")?.getAttribute("href")).toBe("https://example.com");
    const items = el.querySelectorAll("li.task-list-item");
    expect(items.length).toBe(3);
    expect(items[0].getAttribute("data-task")).toBe(" ");
    expect(items[1].classList.contains("is-checked")).toBe(true);
    expect(items[1].querySelector("input.task-list-item-checkbox")?.hasAttribute("checked")).toBe(true);
    expect(items[2].getAttribute("data-task")).toBe("-");
    expect(el.querySelector("ul.contains-task-list")).toBeTruthy();
  });

  it("soft breaks become <br> by default and not in strict mode", async () => {
    const a = await render("one\ntwo");
    expect(a.el.querySelector("p br")).toBeTruthy();
    const b = await render("one\ntwo", { strictLineBreaks: true });
    expect(b.el.querySelector("p br")).toBeNull();
  });

  it("renders frontmatter as collapsed properties block", async () => {
    const { el } = await render("---\ntitle: Hi\ntags: [a, b]\ndone: true\n---\nbody");
    const fm = el.querySelector(".frontmatter-container");
    expect(fm).toBeTruthy();
    expect(fm!.classList.contains("is-collapsed")).toBe(true);
    expect(fm!.querySelector('[data-property-key="title"] .metadata-property-value')?.textContent).toBe("Hi");
    expect(fm!.querySelectorAll("a.tag").length).toBe(2);
    expect(el.textContent).not.toContain("---");
  });

  it("wikilinks: resolved, unresolved, heading, block, alias", async () => {
    const { el } = await render("[[Note A]] [[Note A#Sub|alias]] [[Nope]] [[Note A#^blk1]] [[#Local]]");
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>("a.internal-link"));
    expect(links.length).toBe(5);
    expect(links[0].getAttribute("data-href")).toBe("Note A");
    expect(links[0].classList.contains("is-unresolved")).toBe(false);
    expect(links[1].textContent).toBe("alias");
    expect(links[1].getAttribute("data-href")).toBe("Note A#Sub");
    expect(links[2].classList.contains("is-unresolved")).toBe(true);
    expect(links[3].getAttribute("data-href")).toBe("Note A#^blk1");
    expect(links[3].textContent).toBe("Note A > ^blk1");
    expect(links[4].classList.contains("is-unresolved")).toBe(false);
  });

  it("click on internal link calls openLink; ctrl opens new leaf", async () => {
    const { el, ctx } = await render("[[Note A]]");
    const a = el.querySelector("a")!;
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(ctx.opened).toEqual([["Note A", "Current.md", false], ["Note A", "Current.md", "tab"]]);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, altKey: true }));
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true, altKey: true, shiftKey: true }));
    expect(ctx.opened.slice(2)).toEqual([["Note A", "Current.md", "split"], ["Note A", "Current.md", "window"]]);
  });

  it("markdown links to notes become internal links; external stay external", async () => {
    const { el } = await render("[x](Note%20A.md) [y](Missing.md) [z](https://a.b/c)");
    const as = el.querySelectorAll("a");
    expect(as[0].classList.contains("internal-link")).toBe(true);
    expect(as[0].getAttribute("data-href")).toBe("Note A.md");
    expect(as[1].classList.contains("is-unresolved")).toBe(true);
    expect(as[2].classList.contains("external-link")).toBe(true);
  });

  it("note embeds with heading and block subpaths", async () => {
    const { el } = await render("![[Note A#Sub]]\n\n![[Note A#^blk1]]");
    const embeds = el.querySelectorAll(".markdown-embed");
    expect(embeds.length).toBe(2);
    expect(embeds[0].querySelector(".markdown-embed-title")).toBeTruthy();
    const c0 = embeds[0].querySelector(".markdown-embed-content")!;
    expect(c0.textContent).toContain("sub text");
    expect(c0.textContent).not.toContain("other");
    expect(embeds[1].querySelector(".markdown-embed-content")!.textContent!.trim()).toBe("sub text");
  });

  it("embed recursion guard (self and mutual)", async () => {
    const a = await render("![[Loop]]", { sourcePath: "Loop.md" });
    expect(a.el.querySelector(".embed-recursion-message")).toBeTruthy();
    const b = await render("![[Ping]]", { sourcePath: "Start.md" });
    expect(b.el.querySelectorAll(".markdown-embed").length).toBe(3);
    expect(b.el.querySelector(".embed-recursion-message")).toBeTruthy();
  });

  it("embeds: images with sizing, pdf, audio, video, unresolved", async () => {
    const { el } = await render("![[pic.png|100]] ![[pic.png|100x50]] ![[pic.png|caption]] ![[doc.pdf#page=2]] ![[a.mp3]] ![[v.mp4]] ![[missing.png]]");
    const imgs = el.querySelectorAll<HTMLImageElement>(".image-embed img");
    expect(imgs.length).toBe(3);
    expect(imgs[0].getAttribute("width")).toBe("100");
    expect(imgs[1].getAttribute("height")).toBe("50");
    expect(imgs[2].alt).toBe("caption");
    expect(imgs[0].getAttribute("src")).toBe("app://res/img/pic.png");
    expect(el.querySelector("iframe")?.getAttribute("src")).toBe("app://res/doc.pdf#page=2");
    expect(el.querySelector("audio")).toBeTruthy();
    expect(el.querySelector("video")).toBeTruthy();
    expect(el.querySelector(".internal-embed.is-unresolved")).toBeTruthy();
  });

  it("tags render, but not in code", async () => {
    const { el } = await render("hello #tag/sub and `#notag`\n\n```\n#nope\n```\n\nissue #123 url http://x.y/#frag");
    const tags = Array.from(el.querySelectorAll("a.tag"));
    expect(tags.map((t) => t.getAttribute("href"))).toEqual(["#tag/sub"]);
  });

  it("highlight, comments, block ids", async () => {
    const { el } = await render("a ==marked== b %%secret%% c\n\n%%\nmulti\nline\n%%\n\npara ^abc123\n\n- item ^li1\n\nlast\n\n^later");
    expect(el.querySelector("mark")?.textContent).toBe("marked");
    expect(el.textContent).not.toContain("secret");
    expect(el.textContent).not.toContain("multi");
    expect(el.querySelector('[data-block-id="abc123"]')?.textContent).toBe("para");
    expect(el.querySelector('li[data-block-id="li1"]')).toBeTruthy();
    expect(el.querySelector('[data-block-id="later"]')?.textContent).toBe("last");
  });

  it("callouts: basic, titled, foldable, nested", async () => {
    const { el } = await render("> [!note]\n> body\n\n> [!tip] My Title\n> tip body\n\n> [!warning]- Folded\n> hidden\n\n> [!info]+ Open\n> > [!bug] Inner\n> > inner body");
    const cs = el.querySelectorAll<HTMLElement>(".callout");
    expect(cs.length).toBe(5);
    expect(cs[0].getAttribute("data-callout")).toBe("note");
    expect(cs[0].querySelector(".callout-title-inner")?.textContent).toBe("Note");
    expect(cs[0].querySelector(".callout-content")?.textContent!.trim()).toBe("body");
    expect(cs[1].querySelector(".callout-title-inner")?.textContent).toBe("My Title");
    expect(cs[0].querySelector(".callout-icon svg")).toBeTruthy();
    expect(cs[2].classList.contains("is-collapsed")).toBe(true);
    expect(cs[2].getAttribute("data-callout-fold")).toBe("-");
    cs[2].querySelector<HTMLElement>(".callout-title")!.click();
    expect(cs[2].classList.contains("is-collapsed")).toBe(false);
    expect(cs[3].classList.contains("is-collapsed")).toBe(false);
    const inner = cs[3].querySelector(".callout-content .callout");
    expect(inner?.getAttribute("data-callout")).toBe("bug");
    expect(inner?.querySelector(".callout-content")?.textContent!.trim()).toBe("inner body");
    expect(el.querySelector("blockquote")).toBeNull();
  });

  it("plain blockquote stays a blockquote", async () => {
    const { el } = await render("> just a quote");
    expect(el.querySelector("blockquote")).toBeTruthy();
    expect(el.querySelector(".callout")).toBeNull();
  });

  it("math inline and block via KaTeX", async () => {
    const { el } = await render("inline $x^2$ and cost $5 and $6\n\n$$\n\\frac{a}{b}\n$$");
    expect(el.querySelectorAll("span.math-inline").length).toBe(1);
    expect(el.querySelector("span.math-inline .katex")).toBeTruthy();
    expect(el.querySelector("div.math-block .katex-display")).toBeTruthy();
  });

  it("footnotes", async () => {
    const { el } = await render("text[^1] more[^n]\n\n[^1]: First note.\n[^n]: Second\n    continued");
    expect(el.querySelectorAll("sup.footnote-ref").length).toBe(2);
    const lis = el.querySelectorAll("section.footnotes li");
    expect(lis.length).toBe(2);
    expect(lis[0].querySelector(".footnote-backref")).toBeTruthy();
    expect(lis[0].textContent).toContain("First note.");
    expect(el.textContent).not.toContain("[^1]:");
  });

  it("inline footnotes ^[...] are numbered with regular ones in document order", async () => {
    const { el } = await render("a[^x] b^[inline **one** [[Note A]]] c[^y] d^[two] e[^x]\n\n[^y]: Y note\n[^x]: X note");
    const refs = [...el.querySelectorAll("sup.footnote-ref")].map((s) => s.textContent);
    expect(refs).toEqual(["1", "2", "3", "4", "1"]);
    const lis = [...el.querySelectorAll("section.footnotes li")];
    expect(lis.map((l) => l.textContent!.replace("↩", "").trim())).toEqual(["X note", "inline one Note A", "Y note", "two"]);
    expect(lis[1].querySelector("strong")?.textContent).toBe("one");
    expect(lis[1].querySelector("a.internal-link")).toBeTruthy();
    expect(el.textContent).not.toContain("^[");
    const { el: none } = await render("no ^[] footnote and x^2");
    expect(none.querySelector("sup.footnote-ref")).toBeNull();
  });

  it("footnotes/comments keep line structure: tight lists, one paragraph, right task lines", async () => {
    const { el } = await render("line one\nline two[^1]\n\n%%c1\nc2%%\n- [ ] a\n- [ ] b\n\n[^1]: n");
    const sec = el.querySelectorAll(".markdown-preview-section");
    expect(el.querySelectorAll("p").length).toBe(2); // the paragraph + the footnote body
    expect(el.querySelector("ul > li > p")).toBeNull(); // still a tight list
    expect([...el.querySelectorAll("input.task-list-item-checkbox")].map((b) => b.getAttribute("data-line"))).toEqual(["5", "6"]);
    expect(sec.length).toBeGreaterThan(1);
  });

  it("fenced code: pre > code.language-x and copy button", async () => {
    const { el } = await render("```ts\nconst a = 1 < 2;\n```");
    const code = el.querySelector("pre > code.language-ts")!;
    expect(code.textContent).toContain("1 < 2");
    expect(el.querySelector(".copy-code-button")).toBeTruthy();
  });

  it("mermaid degrades to a plain block when mermaid is not installed", async () => {
    const { el } = await render("```mermaid\ngraph TD; A-->B\n```");
    expect(el.querySelector("pre > code.language-mermaid")).toBeTruthy();
  });

  it("headings get data-heading and ids", async () => {
    const { el } = await render("# Hello *World*\n\n## Hello *World*");
    const hs = el.querySelectorAll("h1, h2");
    expect(hs[0].getAttribute("data-heading")).toBe("Hello World");
    expect(hs[0].id).toBe("hello-world");
    expect(hs[1].id).toBe("hello-world-1");
    expect(slugifyHeading("  Héllo, Wörld! 2 ")).toBe("héllo-wörld-2");
  });

  it("post processors and code block processors are invoked with context", async () => {
    const seen: any[] = [];
    const pp = vi.fn((el: HTMLElement, c: any) => {
      seen.push(c);
      el.querySelectorAll("p").forEach((p) => p.classList.add("pp-touched"));
    });
    const cb = vi.fn((src: string, el: HTMLElement, c: any) => {
      el.textContent = "CUSTOM:" + src;
      expect(c.getSectionInfo(el)).toBeTruthy();
    });
    const { el } = await render("---\nk: v\n---\npara\n\n```mything\nbody line\n```", {
      postProcessors: [pp],
      codeBlockProcessors: new Map([["mything", cb]]),
    });
    expect(pp).toHaveBeenCalled();
    expect(el.querySelector("p.pp-touched")).toBeTruthy();
    expect(cb).toHaveBeenCalledWith("body line", expect.anything(), expect.anything());
    expect(el.querySelector(".block-language-mything")?.textContent).toBe("CUSTOM:body line");
    expect(el.querySelector("pre")).toBeNull();
    const c = seen[0];
    expect(c.sourcePath).toBe("Current.md");
    expect(c.frontmatter).toEqual({ k: "v" });
    expect(typeof c.addChild).toBe("function");
    expect(c.containerEl).toBe(el);
  });

  it("section info reports line numbers", async () => {
    let info: any;
    await render("a\n\n# H\n\nlast", { postProcessors: [(el, c) => { if (el.querySelector("h1")) info = c.getSectionInfo(el); }] });
    expect(info.lineStart).toBe(2);
  });

  it("strips scripts and event handlers", async () => {
    const { el } = await render('<script>alert(1)</script><img src="x" onerror="alert(1)"> ok');
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")?.hasAttribute("onerror")).toBe(false);
  });

  it("scrollToSubpath finds headings and blocks", async () => {
    const { el } = await render("# Top\n\npara ^b1\n\n## Second Part\n\nx");
    expect(scrollToSubpath(el, "#Second Part")?.tagName).toBe("H2");
    expect(scrollToSubpath(el, "#second part")?.tagName).toBe("H2");
    expect(scrollToSubpath(el, "#^b1")?.tagName).toBe("P");
    expect(scrollToSubpath(el, "#Nope")).toBeNull();
    expect(scrollToSubpath(el, "#Top#Second Part")?.tagName).toBe("H2");
  });

  it("extractSubpath handles headings, blocks, fences", () => {
    const md = "# A\ntext\n```\n# not heading\n```\n## B\nb\n# C\nc";
    expect(extractSubpath(md, "#A")).toContain("b");
    expect(extractSubpath(md, "#A")).not.toContain("c\n");
    expect(extractSubpath(md, "#B")).toBe("## B\nb");
    expect(extractSubpath("para one\nline ^id1\n\nnext", "#^id1")).toBe("para one\nline");
    expect(extractSubpath(md, "#Zed")).toBeNull();
  });
});

describe("image embed sizes", () => {
  it("reads a size after a caption and keeps the caption as the alt text", async () => {
    const { el } = await render("![[img/pic.png|alt text|200]] ![[img/pic.png|caption|100x50]] ![[img/pic.png|80]]");
    const imgs = [...el.querySelectorAll("img")];
    expect(imgs.map((i) => [i.getAttribute("alt"), i.getAttribute("width"), i.getAttribute("height")])).toEqual([
      ["alt text", "200", null], ["caption", "100", "50"], ["pic.png", "80", null],
    ]);
  });
});

describe("html containers spanning blank lines", () => {
  it("renders Markdown inside <details> that is split by blank lines", async () => {
    const { el } = await render("<details><summary>S</summary>\n\ninner **b**\n\n- item\n\n</details>\n\nafter");
    const d = el.querySelector("details")!;
    expect(d.querySelector("summary")!.textContent).toBe("S");
    expect(d.querySelector("strong")!.textContent).toBe("b");
    expect(d.querySelector("li")!.textContent).toBe("item");
    expect(el.querySelectorAll("details").length).toBe(1);
    expect(el.textContent).toContain("after");
    expect(d.textContent).not.toContain("after");
  });
  it("leaves balanced html blocks alone", async () => {
    const { el } = await render("<div>a</div>\n\nplain");
    expect(el.querySelectorAll(".markdown-preview-section").length).toBe(2);
  });
});

describe("reading view heading folds", () => {
  const md = "# A\nunder A\n\n## B\nunder B\n\n## C\nunder C\n\n# D\nunder D";
  const visible = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".markdown-preview-section")].filter((s) => !s.classList.contains("is-folded-away")).map((s) => s.textContent!.replace(/\s+/g, " ").trim());
  it("adds no arrows unless the context asks for them (embeds, plugin renders)", async () => {
    const { el } = await render(md);
    expect(el.querySelector(".heading-collapse-indicator")).toBeNull();
  });
  it("folding a heading hides everything up to the next heading of the same or higher level, and unfolding restores it", async () => {
    const { el } = await render(md, { foldHeading: true });
    const arrows = el.querySelectorAll<HTMLElement>(".heading-collapse-indicator");
    expect(arrows).toHaveLength(4);
    arrows[0].click(); // fold "A": hides B, C and their text, not D
    expect(visible(el)).toEqual(["A", "D", "under D"]);
    expect(el.querySelector("h1")!.classList.contains("is-collapsed")).toBe(true);
    arrows[1].click(); // fold "B" while A is folded: still hidden
    arrows[0].click(); // unfold A: B stays folded, so "under B" is hidden but C shows
    expect(visible(el)).toEqual(["A", "under A", "B", "C", "under C", "D", "under D"]);
    arrows[1].click();
    expect(visible(el)).toHaveLength(8);
  });
});
