// Seeded random mixes of Markdown tokens must neither throw in Live Preview nor in the reading view.
import { it, expect } from "vitest";
import { createEditor, type EditorHost } from "../src/editor";
import { renderMarkdown } from "../src/markdown";
const host: EditorHost = { resolveLink: (p) => (p === "N" ? "N.md" : null), listLinkTargets: () => [], listTags: () => [], getResourceUrl: (p) => p, openLink: () => {}, readFile: async () => "x" };
const T = ["$$", "$", "[[", "]]", "![[", "N", "|", "**", "*", "==", "%%", "`", "```", "\n", "\n\n", "> ", "> [!note] ", "- ", "- [ ] ", "1. ", "| a | b |\n|---|---|\n", "---", "#tag", "^[", "[^1]", "[^1]: n", "[a](", "](u)", "![", "<div>", "</div>", "~~", " ", "word", "\t", "    ", "# ", "===", "^blk", "[[N#H]]", "![[N#^b]]", ":::", "\\", "<", ">", "&amp;"];
let seed = 987654;
const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const gen = () => Array.from({ length: 6 + Math.floor(rnd() * 30) }, () => T[Math.floor(rnd() * T.length)]).join("");
it("Live Preview and the reading view survive random Markdown soup", async () => {
  const fails: string[] = [];
  for (let i = 0; i < 200; i++) {
    const d = gen();
    try {
      const parent = document.body.appendChild(document.createElement("div"));
      const h = createEditor(parent, { doc: d, host, mode: "live-preview" } as any);
      (h.view as any).focus = () => {};
      for (const pos of [0, Math.floor(d.length / 2), d.length]) h.view.dispatch({ selection: { anchor: pos } });
      h.view.destroy(); parent.remove();
    } catch (e) { fails.push("LP " + JSON.stringify(d) + " :: " + String(e).slice(0, 120)); }
    try {
      const el = document.createElement("div");
      await renderMarkdown(d, el, { sourcePath: "C.md", resolveLink: (p: string) => (p === "N" ? "N.md" : null), readFile: async () => "x", getResourceUrl: (p: string) => p, openLink() {} } as any);
    } catch (e) { fails.push("READ " + JSON.stringify(d) + " :: " + String(e).slice(0, 120)); }
  }
  expect(fails).toEqual([]);
}, 120000);
