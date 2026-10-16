// Quick switcher (aliases, recents, Ctrl/Shift+Enter) and the command palette (hotkeys, pinned and recent commands).
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({
    "Alpha.md": "# Alpha\n", "Beta.md": "---\naliases: [Bravo, Second]\n---\n# Beta\n", "Gamma.md": "# Gamma\n", "sub/Delta.md": "# Delta\n",
  });
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

async function boot() {
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session.app;
}
const input = () => document.querySelector<HTMLInputElement>(".prompt-input")!;
const type = (text: string) => { input().value = text; input().dispatchEvent(new Event("input", { bubbles: true })); };
const rows = () => qa(".prompt-results .suggestion-item").map((e) => e.querySelector(".suggestion-title")?.textContent ?? "");
const key = (k: string, init: KeyboardEventInit = {}) => input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));

describe("quick switcher", () => {
  it("shows its shortcuts and matches note aliases, marked with an arrow to the note", async () => {
    const app = await boot();
    app.commands.executeCommandById("switcher:open");
    await vi.waitFor(() => expect(input()).toBeTruthy());
    const hints = qa(".prompt-instruction").map((e) => e.textContent);
    expect(hints.join(" | ")).toMatch(/to open in new tab.*to open to the right.*to create/);
    type("brav");
    await vi.waitFor(() => expect(rows()).toEqual(["Bravo"]));
    expect(qa(".prompt-results .suggestion-note")[0].textContent).toContain("Beta");
    key("Enter");
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe("Beta"));
  });

  it("with nothing typed lists recently opened notes first and leaves out the open one", async () => {
    const app = await boot();
    await app.workspace.openLinkText("Gamma", "", false);
    await app.workspace.openLinkText("Beta", "", false);
    await app.workspace.openLinkText("Alpha", "", false);
    app.commands.executeCommandById("switcher:open");
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(rows().slice(0, 2)).toEqual(["Beta", "Gamma"]);
    expect(rows()).not.toContain("Alpha");
  });

  it("Shift+Enter creates the typed note; Ctrl+Enter opens the highlighted note in a new tab", async () => {
    const app = await boot();
    await app.workspace.openLinkText("Alpha", "", false);
    app.commands.executeCommandById("switcher:open");
    await vi.waitFor(() => expect(input()).toBeTruthy());
    type("Brand New Idea");
    await new Promise((r) => setTimeout(r, 30));
    key("Enter", { shiftKey: true });
    await vi.waitFor(() => expect(fs.existsSync(path.join(v.root, "Brand New Idea.md"))).toBe(true));
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe("Brand New Idea"));

    const before = app.workspace.getLeavesOfType("markdown").length;
    app.commands.executeCommandById("switcher:open");
    await vi.waitFor(() => expect(input()).toBeTruthy());
    type("gamma");
    await vi.waitFor(() => expect(rows()).toEqual(["Gamma"]));
    key("Enter", { ctrlKey: true });
    await vi.waitFor(() => expect(app.workspace.getLeavesOfType("markdown").length).toBe(before + 1));
    expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe("Gamma");
  });
});

describe("command palette", () => {
  const open = async (app: any) => { app.commands.executeCommandById("command-palette:open"); await vi.waitFor(() => expect(input()).toBeTruthy()); };

  it("shows each command's hotkeys", async () => {
    const app = await boot();
    await open(app);
    type("quick switcher");
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
    const row = qa(".prompt-results .suggestion-item").find((e) => e.textContent?.includes("Open quick switcher"))!;
    expect(row.querySelector("kbd.suggestion-hotkey")?.textContent).toMatch(/^(Ctrl|Cmd)\+O$/);
  });

  it("with nothing typed lists pinned commands, then recently run ones, then the rest", async () => {
    const app = await boot();
    app.internalPlugins.getPluginById("command-palette")!.instance.options.pinned = ["app:open-settings"];
    await open(app);
    type("toggle left sidebar");
    await vi.waitFor(() => expect(rows()[0]).toMatch(/left sidebar/i));
    key("Enter");
    await vi.waitFor(() => expect(document.querySelector(".prompt-input")).toBeNull());
    await open(app);
    await vi.waitFor(() => expect(rows().length).toBeGreaterThan(2));
    expect(rows()[0]).toMatch(/settings/i);        // pinned
    expect(rows()[1]).toMatch(/left sidebar/i);    // then the command just run
  });
});
