// Right-click on the ribbon lists its buttons with checkmarks; hidden ones stay hidden across restarts (workspace.json).
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
  v = makeVault({ "Note.md": "x\n" });
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
  session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  return session.app;
}
const titles = () => [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent);

describe("ribbon menu", () => {
  it("lists the buttons and hides one, saving it to workspace.json", async () => {
    const app = await boot();
    const ribbon = app.workspace.leftRibbon;
    expect(ribbon.items.length).toBeGreaterThan(2);
    ribbon.containerEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(titles()).toEqual(expect.arrayContaining(ribbon.items.map((i) => i.title)));
    const first = ribbon.items[0];
    const row = [...document.querySelectorAll<HTMLElement>(".menu-item")].find((e) => e.querySelector(".menu-item-title")?.textContent === first.title)!;
    row.click();
    expect(first.buttonEl.style.display).toBe("none");
    expect(ribbon.isHidden(first)).toBe(true);
    await vi.waitFor(() => {
      const ws = JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/workspace.json"), "utf8"));
      expect(ws["left-ribbon"].hiddenItems[first.id]).toBe(true);
    }, { timeout: 8000 });
  });

  it("restores hidden buttons from workspace.json and ignores a malformed entry", async () => {
    const app = await boot();
    const second = app.workspace.leftRibbon.items[1];
    await app.workspace.changeLayout({ ...app.workspace.getLayout(), "left-ribbon": { hiddenItems: { [second.id]: true } } });
    expect(second.buttonEl.style.display).toBe("none");
    await app.workspace.changeLayout({ ...app.workspace.getLayout(), "left-ribbon": { hiddenItems: [1, 2] } });
    expect(second.buttonEl.style.display).toBe("");
  });
});
