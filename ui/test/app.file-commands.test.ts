// "Move current file to another folder" and the open-link-under-cursor commands.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "see [[Target]] here\n", "Target.md": "# T\n", "Linker.md": "[[Note]]\n", "Archive/Old.md": "x\n", "Projects/Deep/Z.md": "z\n" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function boot(open = "Note") {
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  const app = session.app;
  if (open) {
    await app.workspace.openLinkText(open, "", false);
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe(open));
  }
  return app;
}
const input = () => document.querySelector<HTMLInputElement>(".prompt-input")!;
const type = (t: string) => { input().value = t; input().dispatchEvent(new Event("input", { bubbles: true })); };
const rows = () => [...document.querySelectorAll(".prompt-results .suggestion-item")].map((e) => e.querySelector(".suggestion-title")?.textContent ?? "");
const exists = (rel: string) => fs.existsSync(path.join(v.root, rel));

describe("move current file", () => {
  it("needs an open file, lists every folder including the vault root, and moves the file there", async () => {
    const none = await boot("");
    expect(none.commands.executeCommandById("file-explorer:move-file")).toBe(false);
    await session!.stop(); session = null; document.body.innerHTML = "";
    const app = await boot();
    expect(app.commands.executeCommandById("file-explorer:move-file")).toBe(true);
    await vi.waitFor(() => expect(input()).toBeTruthy());
    await vi.waitFor(() => expect(rows()).toEqual(expect.arrayContaining(["/", "Archive", "Projects", "Projects/Deep"])));
    type("deep");
    await vi.waitFor(() => expect(rows()).toEqual(["Projects/Deep"]));
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(exists("Projects/Deep/Note.md")).toBe(true));
    expect(exists("Note.md")).toBe(false);
    await vi.waitFor(() => expect(fs.readFileSync(path.join(v.root, "Linker.md"), "utf8")).toBe("[[Note]]\n")); // shortest link still resolves
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.path).toBe("Projects/Deep/Note.md")); // the open tab follows the file
  });
});

describe("open link under the cursor elsewhere", () => {
  const cursorIn = (app: any, ch: number) => (app.workspace.activeLeaf.view as any).editor.setCursor({ line: 0, ch });

  it("opens in a new tab, to the right or in a new window, only when the cursor is on a link", async () => {
    const app = await boot();
    const leaves = () => app.workspace.getLeavesOfType("markdown").length;
    cursorIn(app, 0);
    expect(app.commands.executeCommandById("editor:open-link-in-new-leaf")).toBe(false); // not on a link
    cursorIn(app, 7);
    const before = leaves();
    expect(app.commands.executeCommandById("editor:open-link-in-new-leaf")).toBe(true);
    await vi.waitFor(() => expect(leaves()).toBe(before + 1));
    expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe("Target");
    // back in Note, open it to the right: a new split, not a tab beside the first
    const note = app.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.basename === "Note")!;
    app.workspace.setActiveLeaf(note, { focus: true });
    cursorIn(app, 7);
    const splitsBefore = new Set(app.workspace.getLeavesOfType("markdown").map((l: any) => l.parent)).size;
    expect(app.commands.executeCommandById("editor:open-link-in-new-split")).toBe(true);
    await vi.waitFor(() => expect(new Set(app.workspace.getLeavesOfType("markdown").map((l: any) => l.parent)).size).toBe(splitsBefore + 1));
    expect(app.commands.findCommand("editor:open-link-in-new-window")?.name).toBe("Open link under cursor in new window");
  });
});

describe("footnote and clear-formatting commands", () => {
  it("run on the active editor", async () => {
    const app = await boot("Linker");
    const editor = (app.workspace.activeLeaf!.view as any).editor;
    editor.focus = () => {};
    editor.setValue("**bold** text\n");
    editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 8 });
    expect(app.commands.executeCommandById("editor:clear-formatting")).toBe(true);
    await vi.waitFor(() => expect(editor.getValue()).toBe("bold text\n"));
    editor.setCursor({ line: 0, ch: 4 });
    app.commands.executeCommandById("editor:insert-footnote");
    await vi.waitFor(() => expect(editor.getValue()).toBe("bold[^1] text\n\n[^1]: "));
  });
});
