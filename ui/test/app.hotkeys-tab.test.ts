// Settings > Hotkeys: capture, delete, restore, conflicts, filters.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { readJson, show } from "./helpers/settings";
import { eventToHotkey, hotkeyId } from "../src/app/settings/hotkeys";

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
  const host = document.body.appendChild(document.createElement("div"));
  session = await startSession((await v.backend("vault_info")) as any, host);
  const app = session.app;
  app.commands.addCommand({ id: "t:a", name: "Alpha test", callback: () => {} });
  app.commands.addCommand({ id: "t:b", name: "Beta test", callback: () => {} });
  app.hotkeyManager.setDefaultHotkeys("t:a", [{ modifiers: ["Mod"], key: "J" }]);
  return app;
}
const item = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-command-id="${id}"]`)!;
const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

describe("hotkeys tab", () => {
  it("eventToHotkey drops bare modifiers and normalises shifted digits", () => {
    expect(eventToHotkey(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBeNull();
    expect(eventToHotkey(new KeyboardEvent("keydown", { key: "!", code: "Digit1", shiftKey: true, ctrlKey: true }))).toEqual({ modifiers: ["Mod", "Shift"], key: "1" });
    expect(hotkeyId({ modifiers: ["Mod", "Shift"], key: "a" })).toBe(hotkeyId({ modifiers: ["Shift", "Ctrl"], key: "A" }));
  });

  it("captures a new hotkey, persists it, and Escape cancels", async () => {
    const app = await boot();
    const el = (await show(app, "hotkeys")).containerEl;
    item(el, "t:b").querySelector<HTMLElement>(".clickable-icon")!.click();
    expect(el.querySelector(".mod-capturing")).toBeTruthy();
    press({ key: "Escape" });
    expect(el.querySelector(".mod-capturing")).toBeNull();
    item(el, "t:b").querySelector<HTMLElement>(".clickable-icon")!.click();
    press({ key: "k", ctrlKey: true });
    await vi.waitFor(() => expect(readJson(v, ".obsidian/hotkeys.json")["t:b"]).toEqual([{ modifiers: ["Mod"], key: "K" }]));
    expect(item(el, "t:b").textContent).toContain("Ctrl+K");
  });

  it("clicking elsewhere cancels a capture", async () => {
    const app = await boot();
    const el = (await show(app, "hotkeys")).containerEl;
    item(el, "t:b").querySelector<HTMLElement>(".clickable-icon")!.click();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(el.querySelector(".mod-capturing")).toBeNull();
  });

  it("deleting a default hotkey leaves an empty override, and restoring the default drops it", async () => {
    const app = await boot();
    const el = (await show(app, "hotkeys")).containerEl;
    item(el, "t:a").querySelector<HTMLElement>(".setting-delete-hotkey")!.click();
    expect(app.hotkeyManager.getHotkeys("t:a")).toEqual([]);
    await vi.waitFor(() => expect(readJson(v, ".obsidian/hotkeys.json")["t:a"]).toEqual([]));
    item(el, "t:a").querySelector<HTMLElement>(".clickable-icon")!.click();
    press({ key: "j", ctrlKey: true });
    // Re-adding exactly the default removes the override instead of storing a duplicate.
    expect(app.hotkeyManager.customKeys["t:a"]).toBeUndefined();
    await vi.waitFor(() => expect(readJson(v, ".obsidian/hotkeys.json")["t:a"]).toBeUndefined());
  });

  it("warns about conflicts and filters by hotkey and customized-only", async () => {
    const app = await boot();
    app.hotkeyManager.setHotkeys("t:b", [{ modifiers: ["Mod"], key: "j" }]);
    const t = await show(app, "hotkeys");
    const el = t.containerEl;
    expect(item(el, "t:a").textContent).toContain("Used by Beta test");
    el.querySelector<HTMLElement>(".hotkey-search-container .clickable-icon")!.click();
    press({ key: "j", ctrlKey: true });
    const ids = [...el.querySelectorAll<HTMLElement>(".hotkey-list-item")].map((x) => x.dataset.commandId);
    expect(ids.sort()).toEqual(["t:a", "t:b"]);
    el.querySelector<HTMLElement>(".hotkey-search-container .clickable-icon")!.click(); // clear
    expect(el.querySelectorAll(".hotkey-list-item").length).toBeGreaterThan(2);
  });
});
