// "Undo close tab" (Ctrl+Shift+T), "Close tab group" and "Show release notes".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;
const opened: string[] = [];

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear(); opened.length = 0;
  v = makeVault({ "A.md": "a\n", "B.md": "b\n", "C.md": "c\n" });
  setBackend(async (cmd, a: any) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      case "open_url": opened.push(a.url); return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function boot() {
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session.app;
}
const files = (app: any) => app.workspace.getLeavesOfType("markdown").map((l: any) => l.view.file?.basename);
const active = (app: any) => (app.workspace.activeLeaf.view as any).file?.basename;

describe("undo close tab", () => {
  it("reopens closed tabs newest first as the active tab, and has a Ctrl+Shift+T hotkey", async () => {
    const app = await boot();
    for (const n of ["A", "B", "C"]) await app.workspace.openLinkText(n, "", "tab");
    expect(app.commands.findCommand("workspace:undo-close-pane")?.hotkeys).toEqual([{ modifiers: ["Mod", "Shift"], key: "t" }]);
    expect(app.commands.executeCommandById("workspace:undo-close-pane")).toBe(false); // nothing closed yet
    app.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.basename === "B")!.detach();
    app.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.basename === "C")!.detach();
    expect(files(app)).toEqual(["A"]);
    expect(app.commands.executeCommandById("workspace:undo-close-pane")).toBe(true);
    await vi.waitFor(() => expect(files(app)).toContain("C"));
    expect(active(app)).toBe("C");
    app.commands.executeCommandById("workspace:undo-close-pane");
    await vi.waitFor(() => expect(files(app)).toContain("B"));
    expect(active(app)).toBe("B");
  });

  it("skips tabs whose file was deleted since, and ignores empty tabs", async () => {
    const app = await boot();
    await app.workspace.openLinkText("A", "", "tab");
    await app.workspace.openLinkText("B", "", "tab");
    app.workspace.getLeaf("tab"); // a new empty tab
    app.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.basename === "B")!.detach();
    await app.vault.delete(app.vault.getFileByPath("B.md")!);
    app.workspace.getLeavesOfType("empty").forEach((l: any) => l.detach());
    expect(app.workspace.closedLeaves.map((s: any) => s.state?.file)).toEqual(["B.md"]); // the empty tab was not remembered
    expect(app.commands.executeCommandById("workspace:undo-close-pane")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(files(app)).toEqual(["A"]); // B.md is gone, so nothing was reopened
    expect(app.commands.executeCommandById("workspace:undo-close-pane")).toBe(false);
  });

  it("remembers at most 20 closed tabs", async () => {
    const app = await boot();
    for (let i = 0; i < 25; i++) { const l = app.workspace.getLeaf("tab"); await l.openFile(app.vault.getFileByPath("A.md")!); l.detach(); }
    expect(app.workspace.closedLeaves.length).toBe(20);
  });
});

describe("other workspace commands", () => {
  it("Close tab group closes the group's unpinned tabs; Show release notes opens the releases page", async () => {
    const app = await boot();
    for (const n of ["A", "B", "C"]) await app.workspace.openLinkText(n, "", "tab");
    app.workspace.getLeavesOfType("markdown").find((l: any) => l.view.file?.basename === "A")!.togglePinned();
    app.commands.executeCommandById("workspace:close-tab-group");
    expect(files(app)).toEqual(["A"]);
    app.commands.executeCommandById("app:show-release-notes");
    await vi.waitFor(() => expect(opened).toEqual(["https://github.com/alonsoburon/tachylite/releases"]));
  });
});

describe("focus on a neighbouring tab group", () => {
  const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} }) as DOMRect;

  it("moves between side-by-side and stacked groups by their position, and is unavailable at the edge", async () => {
    const app = await boot();
    await app.workspace.openLinkText("A", "", false);
    app.commands.executeCommandById("workspace:split-vertical");           // a group to the right
    await vi.waitFor(() => expect(new Set(app.workspace.getLeavesOfType("markdown").map((l: any) => l.parent)).size).toBe(2));
    const groups = [...new Set(app.workspace.getLeavesOfType("markdown").map((l: any) => l.parent))] as any[];
    const [left, right] = groups.sort((a, b) => a.parent.children.indexOf(a) - b.parent.children.indexOf(b));
    left.containerEl.getBoundingClientRect = () => rect(0, 0, 400, 600);
    right.containerEl.getBoundingClientRect = () => rect(400, 0, 400, 600);
    app.workspace.setActiveLeaf(left.children[0], { focus: true });
    expect(app.commands.executeCommandById("workspace:focus-left")).toBe(false);   // nothing further left in the main area
    expect(app.commands.executeCommandById("workspace:focus-top")).toBe(false);
    expect(app.commands.executeCommandById("workspace:focus-right")).toBe(true);
    expect(app.workspace.activeLeaf!.parent).toBe(right);
    expect(app.commands.executeCommandById("workspace:focus-left")).toBe(true);
    expect(app.workspace.activeLeaf!.parent).toBe(left);
    expect(app.commands.findCommand("workspace:focus-top")?.name).toBe("Focus on tab group above");
    expect(app.commands.findCommand("workspace:focus-bottom")?.name).toBe("Focus on tab group below");
    // Stack them instead: the same groups, now one above the other.
    left.containerEl.getBoundingClientRect = () => rect(0, 0, 800, 300);
    right.containerEl.getBoundingClientRect = () => rect(0, 300, 800, 300);
    expect(app.commands.executeCommandById("workspace:focus-bottom")).toBe(true);
    expect(app.workspace.activeLeaf!.parent).toBe(right);
    expect(app.commands.executeCommandById("workspace:focus-top")).toBe(true);
    expect(app.workspace.activeLeaf!.parent).toBe(left);
  });
});
