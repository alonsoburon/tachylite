// Fenced-code syntax highlighting: reading view (Prism-style `token` classes) and editor (CM5-style `cm-*` classes),
// for bundled languages (synchronous) and lazily loaded ones (re-highlighted once the parser chunk arrives).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown, type RenderContext } from "../src/markdown";
import { highlightCodeBlocks } from "../src/markdown/highlight";
import { findCodeLanguage } from "../src/editor/languages";
import { createEditor, type EditorHost } from "../src/editor";

const ctx: RenderContext = { sourcePath: "N.md", resolveLink: () => null, readFile: async () => "", getResourceUrl: (p) => p, openLink: () => {} };
const tokens = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("span.token")].map((s) => `${s.className.replace("token ", "")}:${s.textContent}`);
let el: HTMLElement | null = null;
afterEach(() => { el?.remove(); el = null; });
async function render(md: string) {
  el = document.body.appendChild(document.createElement("div"));
  await renderMarkdown(md, el, ctx);
  return el;
}

describe("reading view highlighting", () => {
  it("highlights bundled languages with Prism token classes and keeps the text intact", async () => {
    const src = "const x = \"hi\"; // note\nfunction f(a) { return 42 }";
    const root = await render("```js\n" + src + "\n```\n");
    const code = root.querySelector("pre > code.language-js")!;
    expect(code.textContent).toBe(src + "\n"); // markdown-it keeps the final newline
    const t = tokens(code);
    expect(t).toEqual(expect.arrayContaining(["keyword:const", "string:\"hi\"", "comment:// note", "keyword:function", "number:42", "keyword:return"]));
    expect(t.some((x) => x.startsWith("punctuation:"))).toBe(true);
  });

  it("loads other languages lazily and highlights them (aliases, legacy modes)", async () => {
    const root = await render("```py\ndef f():\n    return None\n```\n\n```bash\necho \"$HOME\" # c\n```\n\n```nosuchlang\nplain\n```\n");
    const [py, sh, plain] = [...root.querySelectorAll("pre > code")];
    expect(tokens(py)).toEqual(expect.arrayContaining(["keyword:def", "keyword:return"]));
    expect(tokens(sh)).toEqual(expect.arrayContaining(["comment:# c"]));
    expect(sh.textContent).toBe("echo \"$HOME\" # c\n");
    expect(plain.querySelector("span")).toBeNull();
  });

  it("re-highlights a block once its language finishes loading, unless it was replaced meanwhile", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.innerHTML = '<pre><code data-lang="rust">fn main() {}</code></pre><pre><code data-lang="go">func main() {}</code></pre>';
    const go = host.querySelectorAll("pre")[1];
    const p = highlightCodeBlocks(host);
    go.replaceWith(document.createElement("div")); // a code-block processor took it over
    await p;
    expect(tokens(host)).toEqual(expect.arrayContaining(["keyword:fn"]));
    expect(go.querySelector("span.token")).toBeNull();
    host.remove();
  });

  it("matches fence info case-insensitively and strictly by first word", () => {
    expect(findCodeLanguage("TypeScript")?.name).toBe("typescript");
    expect(findCodeLanguage("c++ {title}")?.name).toBe("cpp");
    expect(findCodeLanguage("dataview")).toBeNull();
    expect(findCodeLanguage("")).toBeNull();
  });
});

describe("editor highlighting", () => {
  const host: EditorHost = { resolveLink: () => null, listLinkTargets: () => [], listTags: () => [], getResourceUrl: (p) => p, openLink: () => {}, readFile: async () => "" };
  it("highlights bundled and lazily loaded fence languages with cm-* classes", async () => {
    const parent = document.body.appendChild(document.createElement("div"));
    const ed = createEditor(parent, { doc: "```ts\nconst a: number = 1\n```\n\n```python\nimport os\n```\n", host, mode: "source" });
    const cls = (sel: string) => [...ed.view.contentDOM.querySelectorAll(sel)].map((e) => e.textContent);
    expect(cls(".cm-keyword")).toContain("const");
    await vi.waitFor(() => expect(cls(".cm-keyword")).toContain("import"), { timeout: 3000 });
    ed.destroy();
    parent.remove();
  });
});
