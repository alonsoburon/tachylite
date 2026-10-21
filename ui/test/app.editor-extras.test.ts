// Toggle heading, Rename this heading..., Download attachments, Insert attachment and Toggle fold properties.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { headingOnLine } from "../src/app/editorExtraCommands";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "# Old title\ntext\n", "Linker.md": "see [[Note#Old title]] and [[Note#Old title|alias]] and ![[Note#Old title]]\n", "Other.md": "[[Linker#Elsewhere]]\n" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      case "http_request": return { status: 200, headers: { "content-type": "image/png" }, body: [137, 80, 78, 71] };
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function boot(open = "Note") {
  session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  const app = session.app;
  await app.workspace.openLinkText(open, "", false);
  const view = app.workspace.activeLeaf!.view as any;
  await vi.waitFor(() => expect(view.file?.basename).toBe(open));
  await vi.waitFor(() => expect(app.metadataCache.getFileCache(app.vault.getFileByPath("Linker.md")!)?.links?.length).toBe(2));
  return { app, ed: view.editor };
}
const read = (rel: string) => fs.readFileSync(path.join(v.root, rel), "utf8");

describe("heading helpers", () => {
  it("reads ATX headings, with trailing hashes", () => {
    expect(headingOnLine("## Hello ##")).toEqual({ level: 2, text: "Hello" });
    expect(headingOnLine("plain")).toBeNull();
    expect(headingOnLine("#nospace")).toBeNull();
  });
});

describe("editor extra commands", () => {
  it("Rename this heading... renames it and the links to it, only on a heading line", async () => {
    const { app, ed } = await boot();
    ed.setCursor({ line: 1, ch: 0 });
    expect(app.commands.executeCommandById("editor:rename-heading")).toBe(false);
    ed.setCursor({ line: 0, ch: 3 });
    expect(app.commands.executeCommandById("editor:rename-heading")).toBe(true);
    const input = await vi.waitFor(() => { const i = document.querySelector<HTMLInputElement>(".modal input"); if (!i) throw new Error("no prompt"); return i; });
    expect(input.value).toBe("Old title");
    input.value = "New title";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLElement>(".modal .mod-cta")!.click();
    await vi.waitFor(() => expect(ed.getLine(0)).toBe("# New title"));
    await vi.waitFor(() => expect(read("Linker.md")).toBe("see [[Note#New title]] and [[Note#New title|alias]] and ![[Note#New title]]\n"));
    expect(read("Other.md")).toBe("[[Linker#Elsewhere]]\n"); // links to other headings stay
  });

  it("Toggle heading opens a picker of levels", async () => {
    const { app } = await boot();
    expect(app.commands.executeCommandById("editor:set-heading")).toBe(true);
    await vi.waitFor(() => expect(document.querySelectorAll(".suggestion-item").length).toBe(7));
    expect([...document.querySelectorAll(".suggestion-item")].map((e) => e.textContent)).toEqual(["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6", "Remove heading"]);
  });

  it("Download attachments saves remote images into the vault and rewrites the links", async () => {
    const { app, ed } = await boot();
    ed.setValue("a ![pic](https://example.com/img/photo.png) b ![x](https://example.com/raw?id=1)\n");
    expect(app.commands.executeCommandById("editor:download-attachments")).toBe(true);
    await vi.waitFor(() => expect(ed.getValue()).not.toContain("https://"));
    expect(ed.getValue()).toMatch(/^a !\[\[photo\.png\]\] b !\[\[raw\.png\]\]\n$/);
    expect(fs.readFileSync(path.join(v.root, "photo.png")).length).toBe(4);
  });

  it("registers Insert attachment, and Toggle fold properties only when the note shows properties", async () => {
    const { app, ed } = await boot();
    expect(app.commands.commands["editor:attach-file"].name).toBe("Insert attachment");
    expect(app.commands.executeCommandById("editor:toggle-fold-properties")).toBe(false);
    void ed;
  });
});
