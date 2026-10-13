// Reading view task checkboxes write back to the note on disk (fake backend), mapped by source line.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { taskToggleAt } from "../src/obsidian/previewTasks";
import { Text } from "@codemirror/state";

let v: FakeVault;
let session: Session | null = null;

const NOTE = [
  "---", "tags: [t]", "---", // 0-2
  "%% a comment", "over two lines %%", // 3-4: multi-line comment must not shift line numbers
  "- [ ] same", // 5
  "- [ ] same", // 6
  "\t- [x] nested", // 7
  "- [/] doing", // 8
  "1. [-] cancelled", // 9
  "", // 10
  "> [!todo]- Folded", // 11
  "> - [ ] in callout", // 12
  "", // 13
  "> quote", // 14
  "> * [ ] in quote", // 15
  "", // 16
  "![[Other]]", // 17
  "",
].join("\n");

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  v = makeVault({ "T.md": NOTE, "Other.md": "- [ ] embedded\n" }, {});
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": return {};
      case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => {
  await session?.stop();
  session = null;
  v.cleanup();
  document.body.innerHTML = "";
});

describe("taskToggleAt", () => {
  it("finds the status char of list tasks (quotes, ordered, custom status) and rejects other lines", () => {
    const doc = Text.of(["- [ ] a", "> > 2) [/] b", "plain [ ] text", "- [x] c"]);
    expect(taskToggleAt(doc, 0)).toEqual({ pos: 3, from: " ", to: "x" });
    expect(taskToggleAt(doc, 1)).toEqual({ pos: 16, from: "/", to: " " });
    expect(taskToggleAt(doc, 2)).toBeNull();
    expect(taskToggleAt(doc, 3)?.to).toBe(" ");
    expect(taskToggleAt(doc, 9)).toBeNull();
  });
});

describe("reading view task checkboxes", () => {
  it("toggle the right line on disk, including duplicates, nested, custom status, callouts and quotes", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    session = await startSession((await v.backend("vault_info")) as any, host);
    const s = session;
    await s.app.workspace.openLinkText("T", "", false);
    const view = s.app.workspace.activeLeaf!.view as any;
    await vi.waitFor(() => expect(view.getViewData()).toBe(NOTE));
    view.setMode("preview");
    await view.previewMode.whenRendered();
    const disk = () => fs.readFileSync(path.join(v.root, "T.md"), "utf8").split("\n");
    const box = (line: number) => view.previewEl.querySelector(`input.task-list-item-checkbox[data-line="${line}"]`) as HTMLInputElement;
    await vi.waitFor(() => expect(box(15)).toBeTruthy());

    box(6).click(); // the second of two identical tasks
    await vi.waitFor(() => expect(disk()[6]).toBe("- [x] same"));
    expect(disk()[5]).toBe("- [ ] same");
    expect(box(6).checked).toBe(true);
    expect(box(6).closest("li")!.classList.contains("is-checked")).toBe(true);

    box(7).click();
    await vi.waitFor(() => expect(disk()[7]).toBe("\t- [ ] nested"));
    box(8).click();
    await vi.waitFor(() => expect(disk()[8]).toBe("- [ ] doing"));
    box(9).click();
    await vi.waitFor(() => expect(disk()[9]).toBe("1. [ ] cancelled"));
    box(12).click();
    await vi.waitFor(() => expect(disk()[12]).toBe("> - [x] in callout"));
    box(15).click();
    await vi.waitFor(() => expect(disk()[15]).toBe("> * [x] in quote"));
    box(6).click(); // and back
    await vi.waitFor(() => expect(disk()[6]).toBe("- [ ] same"));

    // the editor holds the same text (switching back shows it), and undo there reverts the last toggle
    expect(view.getViewData()).toBe(disk().join("\n"));
    // a task inside an embedded note is not written into this note
    const embedded = await vi.waitFor(() => {
      const b = view.previewEl.querySelector(".markdown-embed input.task-list-item-checkbox") as HTMLInputElement;
      expect(b).toBeTruthy();
      return b;
    });
    const before = disk().join("\n");
    embedded.click();
    await new Promise((r) => setTimeout(r, 50));
    expect(disk().join("\n")).toBe(before);
  });
});
