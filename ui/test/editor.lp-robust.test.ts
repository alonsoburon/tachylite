// Live Preview must build for any document: multi-line constructs inside paragraphs once threw
// ("Decorations that replace line breaks may not be specified via plugins") and took the whole view down.
import { describe, expect, it } from "vitest";
import { createEditor, type EditorHost } from "../src/editor";

const host: EditorHost = { resolveLink: (p) => (p === "N" ? "N.md" : null), listLinkTargets: () => [], listTags: () => [], getResourceUrl: (p) => p, openLink: () => {}, readFile: async () => "" };

const DOCS: Record<string, string> = {
  "display math after text": "para $$\ny\n$$ tail\n\nend",
  "two math spans": "a $$\ny\n$$ and $$z$$\n\nend",
  "inline math across lines": "a $x\ny$ b\n\nend",
  "emphasis across lines": "**bold\nspans** and *it\nalic* and ==hi\nghlight== and ~~st\nrike~~",
  "inline comment across lines": "a %%hidden\ncomment%% b\n\nend",
  "unterminated comment": "a %%never closed\n\nmore\n\nend",
  "link text across lines": "[a\nb](http://x.dev) and ![al\nt](p.png)",
  "wikilink with newline": "[[N\nope]] and [[N|al\nias]]",
  "inline footnote across lines": "text^[note\nspans] more",
  "code span across lines": "a `code\nspans` b",
  "html inline across lines": "a <span\nclass='x'>b</span>",
  "tag then math": "#tag $$\nx\n$$",
  "nested quote and math": "> quote $$\n> y\n> $$\n\nend",
  "list item with display math": "- item $$\n  y\n  $$\n- next",
  "table cell with math": "| a |\n|---|\n| $x$ |",
  "callout with comment": "> [!note] T %%c\n> d%%\n> body",
  "unterminated math": "price is $5 and $$ never\n\nend",
  "setext after math": "$$x$$\n===\n",
  "frontmatter then math": "---\na: b\n---\n$$\nx\n$$ y\n",
};

describe("Live Preview robustness", () => {
  for (const [name, doc] of Object.entries(DOCS)) {
    it(`builds and keeps the text for: ${name}`, async () => {
      const parent = document.body.appendChild(document.createElement("div"));
      const h = createEditor(parent, { doc, host, mode: "live-preview" } as any);
      (h.view as any).focus = () => {};
      await new Promise((r) => setTimeout(r, 30));
      expect(h.view.state.doc.toString()).toBe(doc);
      expect(h.view.contentDOM.querySelectorAll(".cm-line").length).toBeGreaterThan(0);
      // Moving the cursor around re-renders with different parts revealed; none of it may throw.
      for (const pos of [0, Math.floor(doc.length / 2), doc.length]) h.view.dispatch({ selection: { anchor: pos } });
      h.view.destroy();
      parent.remove();
    });
  }
});
