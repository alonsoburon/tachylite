// Fold state is remembered per note, in the shape Obsidian 1.14.4 stores it: localStorage `<appId>-note-fold-<path>` holding
// `{ folds: [{ from, to }], lines }`. The expected values below were produced by that real Obsidian (see ROADMAP.md,
// scripts/obsidian-reference.sh with OBSIDIAN_EVAL) for exactly this text.
import { afterEach, expect, it } from "vitest";
import { foldedRanges } from "@codemirror/language";
import { setBackend } from "../src/ipc";
import { makeVault } from "./helpers/backend";
import { startSession } from "../src/app/session";
import { countLines, parseFoldInfo } from "../src/obsidian/foldInfo";

const NOTE = "# One\n\nalpha\n\n- item\n  - child\n  - child2\n- item2\n  - sub\n\n## Two\n\nbeta\n\n# Three\n\ngamma\n";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function boot(files: Record<string, string> = { "Folds.md": NOTE }) {
  document.body.innerHTML = "";
  const v = makeVault(files);
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  const s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  return s;
}
const key = (s: any, path = "Folds.md") => `${s.app.appId}-note-fold-${path}`;
const saved = (s: any, path?: string) => { const r = localStorage.getItem(key(s, path)); return r === null ? null : JSON.parse(r); };
async function open(s: any, mode: "source" | "preview" = "source", path = "Folds.md") {
  const leaf = s.app.workspace.getLeaf("tab");
  await leaf.openFile(s.app.vault.getFileByPath(path));
  s.app.workspace.setActiveLeaf(leaf, { focus: true });
  if (mode === "preview") { await leaf.view.setState({ ...leaf.view.getState(), mode: "preview" }, { history: false }); await leaf.view.previewMode.whenRendered(); }
  await sleep(30);
  return leaf;
}
const collapsedHeadings = (leaf: any) => [...leaf.view.previewEl.querySelectorAll("h1.is-collapsed, h2.is-collapsed, h3.is-collapsed")].map((h: any) => h.getAttribute("data-heading"));
const foldedCount = (leaf: any) => { let n = 0; foldedRanges(leaf.view.cm.state).between(0, leaf.view.cm.state.doc.length, () => { n++; }); return n; };

afterEach(() => localStorage.clear());

it("saves editor folds when the note closes, in Obsidian's shape (from = header line, to = last hidden line)", async () => {
  const s = await boot({ "Folds.md": "# One\n\nalpha\n\n- item\n  - child\n  - child2\n- item2\n\n## Two\n\nbeta\n\n# Three\n\ngamma\n" });
  const leaf = await open(s);
  leaf.view.editor.focus();
  s.app.commands.executeCommandById("editor:fold-all");
  expect(foldedCount(leaf)).toBeGreaterThan(0);
  leaf.detach();
  await sleep(30);
  // what the real Obsidian wrote after "Fold all headings and lists" on this text
  expect(saved(s)).toEqual({ folds: [{ from: 0, to: 12 }, { from: 4, to: 6 }, { from: 9, to: 12 }, { from: 13, to: 16 }], lines: 17 });
  await s.stop();
});

it("restores editor folds, and the reading view's, when the note is opened again", async () => {
  const s = await boot();
  localStorage.setItem(key(s), JSON.stringify({ folds: [{ from: 0, to: 1 }, { from: 7, to: 9 }, { from: 14, to: 15 }], lines: countLines(NOTE) }));
  const edit = await open(s);
  expect(foldedCount(edit)).toBe(3);
  await edit.view.setState({ ...edit.view.getState(), mode: "preview" }, { history: false });
  await edit.view.previewMode.whenRendered();
  expect(collapsedHeadings(edit)).toEqual(["One", "Three"]);
  expect(edit.view.previewEl.querySelector("li[data-line='7'].is-collapsed")).not.toBeNull();
  edit.detach();
  const direct = await open(s, "preview");
  expect(collapsedHeadings(direct)).toEqual(["One", "Three"]);
  await s.stop();
});

it("a click on a reading-view heading arrow is saved the way the real app saves it", async () => {
  const s = await boot();
  const leaf = await open(s, "preview");
  const arrows = [...leaf.view.previewEl.querySelectorAll(".heading-collapse-indicator")] as HTMLElement[];
  arrows[1].click(); // "## Two"
  leaf.detach();
  await sleep(30);
  expect(saved(s)).toEqual({ folds: [{ from: 10, to: 11 }], lines: countLines(NOTE) });
  await s.stop();
});

it("list item folds in the reading view record the item's line and the line after its sub-items", async () => {
  const s = await boot();
  const leaf = await open(s, "preview");
  (leaf.view.previewEl.querySelector("li[data-line='7'] > .list-collapse-indicator") as HTMLElement).click(); // "- item2" with "- sub"
  (leaf.view.previewEl.querySelector(".heading-collapse-indicator") as HTMLElement).click(); // "# One"
  leaf.detach();
  await sleep(30);
  expect(saved(s)).toEqual({ folds: [{ from: 0, to: 1 }, { from: 7, to: 9 }], lines: countLines(NOTE) });
  await s.stop();
});

it("folds are shared between the two modes", async () => {
  const s = await boot();
  const leaf = await open(s, "preview");
  ([...leaf.view.previewEl.querySelectorAll(".heading-collapse-indicator")] as HTMLElement[])[2].click(); // "# Three"
  await leaf.view.setState({ ...leaf.view.getState(), mode: "source" }, { history: false });
  expect(foldedCount(leaf)).toBe(1);
  // unfold in the editor, back to reading: nothing is folded any more
  leaf.view.editor.focus();
  s.app.commands.executeCommandById("editor:unfold-all");
  await leaf.view.setState({ ...leaf.view.getState(), mode: "preview" }, { history: false });
  await leaf.view.previewMode.whenRendered();
  expect(collapsedHeadings(leaf)).toEqual([]);
  leaf.detach();
  await sleep(30);
  expect(saved(s)).toBeNull(); // no folds left: the key is removed
  await s.stop();
});

it("ignores saved folds when the note has a different number of lines now, like Obsidian", async () => {
  const s = await boot();
  localStorage.setItem(key(s), JSON.stringify({ folds: [{ from: 0, to: 1 }], lines: countLines(NOTE) + 1 }));
  const leaf = await open(s);
  expect(foldedCount(leaf)).toBe(0);
  await leaf.view.setState({ ...leaf.view.getState(), mode: "preview" }, { history: false });
  await leaf.view.previewMode.whenRendered();
  expect(collapsedHeadings(leaf)).toEqual([]);
  await s.stop();
});

it("untouched notes write nothing, and bad saved data is ignored", async () => {
  const s = await boot({ "Folds.md": NOTE, "Other.md": "# H\n\ntext\n" });
  const leaf = await open(s);
  leaf.detach();
  const other = await open(s, "source", "Other.md");
  other.detach();
  await sleep(30);
  expect(localStorage.length).toBe(0);
  localStorage.setItem(key(s, "Other.md"), "{not json");
  localStorage.setItem(key(s), JSON.stringify({ folds: "nope", lines: countLines(NOTE) }));
  expect(await open(s, "source", "Other.md")).toBeTruthy();
  expect(foldedCount(await open(s))).toBe(0);
  await s.stop();
});

it("parseFoldInfo validates shape and line count", () => {
  expect(parseFoldInfo({ folds: [{ from: 1, to: 2 }, { from: "x" }, null], lines: 5 }, 5)).toEqual({ folds: [{ from: 1, to: 2 }], lines: 5 });
  expect(parseFoldInfo({ folds: [], lines: 4 }, 5)).toBeNull();
  expect(parseFoldInfo(null, 5)).toBeNull();
  expect(parseFoldInfo("x", 5)).toBeNull();
});

it("app.foldManager reads and writes the same key (Calendar and Periodic Notes copy folds through it)", async () => {
  const s = await boot();
  const f = s.app.vault.getFileByPath("Folds.md")!;
  s.app.foldManager.save(f, { folds: [{ from: 0, to: 1 }], lines: 3 });
  expect(saved(s)).toEqual({ folds: [{ from: 0, to: 1 }], lines: 3 });
  expect(s.app.foldManager.load(f)).toEqual({ folds: [{ from: 0, to: 1 }], lines: 3 });
  await s.stop();
});
