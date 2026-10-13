// Vim key bindings: live toggling through the editor handle, normal-mode editing, `:w`, and the CM5 adapter API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, getCM, Vim, vimAdapter, type EditorHost } from "../src/editor";

const mkhost = (save = vi.fn()): EditorHost & { save: typeof save } => ({
  resolveLink: () => null, listLinkTargets: () => [], listTags: () => [], getResourceUrl: (p) => p, openLink: () => {}, readFile: async () => "", save,
});
let parent: HTMLElement | null = null;
afterEach(() => { parent?.remove(); parent = null; });
const mount = (doc: string, host: EditorHost, vimMode = true) => {
  parent = document.body.appendChild(document.createElement("div"));
  return createEditor(parent, { doc, host, vimMode, sourcePath: "Note.md" });
};
const keys = (view: any, ...ks: string[]) => { const cm = getCM(view)!; for (const k of ks) Vim.handleKey(cm as any, k, "user"); };

describe("vim mode", () => {
  it("edits in normal mode, enters/leaves insert mode, undoes", () => {
    // (vertical motions need layout, which happy-dom lacks; these keys are layout-free)
    const ed = mount("one two three\nsecond", mkhost());
    expect(getCM(ed.view)).not.toBeNull();
    expect(ed.view.scrollDOM.classList.contains("cm-vimMode")).toBe(true);
    keys(ed.view, "w", "d", "w");
    expect(ed.getValue()).toBe("one three\nsecond");
    keys(ed.view, "d", "d");
    expect(ed.getValue()).toBe("second");
    keys(ed.view, "u");
    expect(ed.getValue()).toBe("one three\nsecond");
    keys(ed.view, "g", "g", "A");
    expect((getCM(ed.view) as any).state.vim.insertMode).toBe(true);
    ed.view.dispatch(ed.view.state.replaceSelection("!"));
    keys(ed.view, "<Esc>");
    expect((getCM(ed.view) as any).state.vim.insertMode).toBe(false);
    expect(ed.getValue()).toBe("one three!\nsecond");
    keys(ed.view, "0", "c", "w");
    ed.view.dispatch(ed.view.state.replaceSelection("1"));
    keys(ed.view, "<Esc>", "$", "x");
    expect(ed.getValue()).toBe("1 three\nsecond");
    ed.destroy();
  });

  it("toggles live through reconfigure", () => {
    const ed = mount("abc", mkhost(), false);
    expect(getCM(ed.view)).toBeNull();
    ed.reconfigure({ vimMode: true });
    expect(getCM(ed.view)).not.toBeNull();
    keys(ed.view, "x");
    expect(ed.getValue()).toBe("bc");
    ed.reconfigure({ vimMode: false });
    expect(getCM(ed.view)).toBeNull();
    expect(ed.view.scrollDOM.classList.contains("cm-vimMode")).toBe(false);
    ed.destroy();
  });

  it(":w saves through the host; the adapter exposes the Vim API to plugins", () => {
    const host = mkhost();
    const ed = mount("hello world", host);
    const cm = getCM(ed.view)! as any;
    Vim.handleEx(cm, "w");
    expect(host.save).toHaveBeenCalledWith("Note.md");
    // vimrc-style plugin usage through window.CodeMirrorAdapter
    const A = vimAdapter() as any;
    expect(A.Vim).toBe(Vim);
    const ex = vi.fn();
    A.Vim.defineEx("tachytest", "tachy", ex);
    Vim.handleEx(cm, "tachy");
    expect(ex).toHaveBeenCalled();
    A.Vim.defineAction("tachyUpper", (c: any) => { c.replaceRange(c.getLine(0).toUpperCase(), { line: 0, ch: 0 }, { line: 0, ch: c.getLine(0).length }); });
    A.Vim.mapCommand("<A-u>", "action", "tachyUpper", {}, { context: "normal" });
    keys(ed.view, "<A-u>");
    expect(ed.getValue()).toBe("HELLO WORLD");
    A.Vim.noremap("Q", "dd", "normal");
    keys(ed.view, "Q");
    expect(ed.getValue()).toBe("");
    A.Vim.unmap("Q", "normal");
    ed.destroy();
  });
});
