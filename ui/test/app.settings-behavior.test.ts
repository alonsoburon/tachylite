// Settings > Editor switches that change how the app behaves: right-to-left text and "Always focus new tabs".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { clickToggle, readJson, row, show } from "./helpers/settings";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "x\n", "Other.md": "# Other\n" });
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

describe("editor behavior switches", () => {
  it("Right-to-left sets the is-rtl body class and persists rightToLeft", async () => {
    const app = await boot();
    const el = (await show(app, "editor")).containerEl;
    expect(document.body.classList.contains("is-rtl")).toBe(false);
    clickToggle(row(el, "Right-to-left (RTL) direction"));
    await vi.waitFor(() => expect(document.body.classList.contains("is-rtl")).toBe(true));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/app.json").rightToLeft).toBe(true));
    clickToggle(row(el, "Right-to-left (RTL) direction"));
    await vi.waitFor(() => expect(document.body.classList.contains("is-rtl")).toBe(false));
  });

  it("Always focus new tabs: off keeps the current tab active when a link opens in a new one", async () => {
    const app = await boot();
    await app.workspace.openLinkText("Note", "", false);
    const first = app.workspace.activeLeaf!;
    await app.workspace.openLinkText("Other", "", "tab");
    expect(app.workspace.activeLeaf).not.toBe(first); // default: the new tab takes the focus

    const el = (await show(app, "editor")).containerEl;
    clickToggle(row(el, "Always focus new tabs"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/app.json").focusNewTab).toBe(false));
    await app.workspace.setActiveLeaf(first, { focus: true });
    const before = app.workspace.getLeavesOfType("markdown").length;
    await app.workspace.openLinkText("Other", "", "tab");
    expect(app.workspace.getLeavesOfType("markdown").length).toBe(before + 1);
    expect(app.workspace.activeLeaf).toBe(first);
  });
});
