// Ctrl/Cmd+scroll font size, and the ribbon toggle.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { clickToggle, readJson, row, show } from "./helpers/settings";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; document.body.removeAttribute("style"); localStorage.clear();
  v = makeVault({ "Note.md": "hello\n" });
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
  await app.workspace.openLinkText("Note", "", false);
  const view = app.workspace.activeLeaf!.view as any;
  await vi.waitFor(() => expect(view.file?.basename).toBe("Note"));
  return { app, view };
}
const wheel = (el: Element, deltaY: number, init: WheelEventInit = {}) => {
  const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, ...init });
  // happy-dom's WheelEvent drops the modifier flags a real one carries.
  for (const k of ["ctrlKey", "metaKey"] as const) Object.defineProperty(e, k, { value: !!init[k] });
  el.dispatchEvent(e);
  return e;
};
const size = () => document.body.style.getPropertyValue("--font-text-size");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("quick font size adjustment", () => {
  it("Ctrl+scroll over a note changes the font size a pixel per notch and persists it", async () => {
    const { view } = await boot();
    const target = view.contentEl.querySelector(".markdown-source-view") as HTMLElement;
    const e = wheel(target, -100, { ctrlKey: true });
    expect(e.defaultPrevented).toBe(true); // the page itself must not zoom
    await vi.waitFor(() => expect(size()).toBe("17px"));
    expect(readJson(v, ".obsidian/appearance.json").baseFontSize).toBe(17);
    await sleep(80);
    wheel(target, 100, { ctrlKey: true });
    await vi.waitFor(() => expect(size()).toBe(""));   // back at the default 16px, which is stored as "unset"
    await sleep(80);
    wheel(target, 100, { ctrlKey: true });
    await vi.waitFor(() => expect(size()).toBe("15px"));
  });

  it("does nothing without Ctrl, outside notes, or when switched off; stays within limits", async () => {
    const { app, view } = await boot();
    const target = view.contentEl.querySelector(".markdown-source-view") as HTMLElement;
    expect(wheel(target, -100).defaultPrevented).toBe(false);
    expect(wheel(document.body, -100, { ctrlKey: true }).defaultPrevented).toBe(false);
    await sleep(30);
    expect(size()).toBe("");
    const tab = await show(app, "appearance");
    clickToggle(row(tab.containerEl, "Quick font size adjustment"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json").baseFontSizeAction).toBe(false));
    expect(wheel(target, -100, { ctrlKey: true }).defaultPrevented).toBe(false);
    clickToggle(row(tab.containerEl, "Quick font size adjustment"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json").baseFontSizeAction).toBeUndefined());
    const { adjustFontSize } = await import("../src/app/settings");
    expect(await adjustFontSize(app, 100)).toBe(32);
    expect(await adjustFontSize(app, -100)).toBe(10);
  });
});

describe("ribbon", () => {
  it("Toggle ribbon hides and shows the left ribbon, and the Appearance switch agrees", async () => {
    const { app } = await boot();
    expect(document.body.classList.contains("is-ribbon-hidden")).toBe(false);
    app.commands.executeCommandById("app:toggle-ribbon");
    await vi.waitFor(() => expect(document.body.classList.contains("is-ribbon-hidden")).toBe(true));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/app.json").showRibbon).toBe(false));
    const tab = await show(app, "appearance");
    const toggle = row(tab.containerEl, "Show ribbon").querySelector(".checkbox-container")!;
    expect(toggle.classList.contains("is-enabled")).toBe(false);
    clickToggle(row(tab.containerEl, "Show ribbon"));
    await vi.waitFor(() => expect(document.body.classList.contains("is-ribbon-hidden")).toBe(false));
  });
});
