import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import { clickToggle, flush, pick, readJson, row, show, tabOf, type as typeIn } from "./helpers/settings";
import { installSettings, applyAppearance } from "../src/app/settings";
import { hotkeyId, prettyHotkey } from "../src/app/settings/hotkeys";
import { compareVersions, hexToHsl } from "../src/app/settings/util";
import type { App } from "../src/obsidian/app";
import { PluginSettingTab } from "../src/obsidian";

let v: FakeVault, app: App, dispose: () => void;
beforeEach(async () => {
  v = makeVault({ "A.md": "# A" });
  app = await makeApp(v);
  dispose = installSettings(app);
});
afterEach(async () => {
  dispose();
  await app.stop();
  v.cleanup();
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.className = "";
});

describe("installSettings", () => {
  it("registers the tabs in order and the disposer clears them", () => {
    expect(app.setting.settingTabs.map((t) => t.id)).toEqual(["editor", "file", "appearance", "hotkeys", "core-plugins", "community-plugins", "about"]);
    dispose();
    expect(app.setting.settingTabs).toEqual([]);
    dispose = installSettings(app);
  });
  it("renders in the dialog nav and shows plugin tabs added while open", () => {
    app.setting.open();
    expect([...document.querySelectorAll(".vertical-tab-nav-item")].map((e) => e.textContent)).toContain("Hotkeys");
    class T extends PluginSettingTab { display() {} }
    app.setting.addSettingTab(new T(app, { manifest: { id: "p", name: "My plugin" } } as any));
    expect([...document.querySelectorAll(".vertical-tab-nav-item")].map((e) => e.textContent)).toContain("My plugin");
    app.setting.close();
  });
});

describe("Editor tab", () => {
  it("writes app.json keys and triggers config-changed", async () => {
    const t = await show(app, "editor");
    const seen: string[] = [];
    app.workspace.on("config-changed", () => seen.push("c"));
    clickToggle(row(t.containerEl, "Show line numbers"));
    clickToggle(row(t.containerEl, "Readable line length"));
    pick(row(t.containerEl, "Tab indent size"), "8");
    pick(row(t.containerEl, "Default editing mode"), "preview");
    clickToggle(row(t.containerEl, "Live Preview"));
    await flush();
    const c = readJson(v, ".obsidian/app.json");
    expect(c).toMatchObject({ showLineNumber: true, readableLineLength: false, tabSize: 8, defaultViewMode: "preview", livePreview: false });
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(app.vault.getConfig("tabSize")).toBe(8);
  });
});

describe("Files and links tab", () => {
  it("writes link, file and attachment options", async () => {
    const t = await show(app, "file");
    pick(row(t.containerEl, "New link format"), "relative");
    clickToggle(row(t.containerEl, "Use [[Wikilinks]]"));
    clickToggle(row(t.containerEl, "Automatically update internal links"));
    pick(row(t.containerEl, "Deleted files"), "local");
    clickToggle(row(t.containerEl, "Confirm file deletion"));
    pick(row(t.containerEl, "Default location for new notes"), "folder");
    typeIn(row(t.containerEl, "Folder for new notes").querySelector("input")!, "Inbox");
    pick(row(t.containerEl, "Default location for new attachments"), "same");
    typeIn(row(t.containerEl, "Excluded files").querySelector("textarea")!, "private/\n\n tmp ");
    await flush();
    expect(readJson(v, ".obsidian/app.json")).toMatchObject({
      newLinkFormat: "relative", useMarkdownLinks: true, alwaysUpdateLinks: true, trashOption: "local", promptDelete: false,
      newFileLocation: "folder", newFileFolderPath: "Inbox", attachmentFolderPath: "./", userIgnoreFilters: ["private/", "tmp"],
    });
  });
  it("attachment folder modes round-trip", async () => {
    let t = await show(app, "file");
    pick(row(t.containerEl, "Default location for new attachments"), "subfolder");
    typeIn(row(t.containerEl, "Attachment folder path").querySelector("input")!, "assets");
    await flush();
    expect(readJson(v, ".obsidian/app.json").attachmentFolderPath).toBe("./assets");
    t = await show(app, "file");
    expect(row(t.containerEl, "Default location for new attachments").querySelector("select")!.value).toBe("subfolder");
    expect(row(t.containerEl, "Attachment folder path").querySelector("input")!.value).toBe("assets");
  });
});

describe("Appearance", () => {
  it("applyAppearance tolerates a missing appearance.json and is idempotent", async () => {
    await applyAppearance(app); await applyAppearance(app);
    expect(document.body.classList.contains("theme-light") || document.body.classList.contains("theme-dark")).toBe(true);
    expect(document.body.style.getPropertyValue("--font-text-size")).toBe("");
  });
  it("applies theme, accent, font size and families from appearance.json", async () => {
    v.write(".obsidian/appearance.json", JSON.stringify({ theme: "obsidian", accentColor: "#ff0000", baseFontSize: 20, textFontFamily: "Georgia", monospaceFontFamily: "Fira Code", interfaceFontFamily: "Inter" }));
    await applyAppearance(app);
    const b = document.body;
    expect(b.classList.contains("theme-dark")).toBe(true);
    expect(b.classList.contains("theme-light")).toBe(false);
    expect(b.style.getPropertyValue("--accent-h")).toBe("0");
    expect(b.style.getPropertyValue("--accent-s")).toBe("100%");
    expect(b.style.getPropertyValue("--accent-l")).toBe("50%");
    expect(b.style.getPropertyValue("--font-text-size")).toBe("20px");
    expect(b.style.getPropertyValue("--font-text-theme")).toBe("Georgia");
    expect(b.style.getPropertyValue("--font-monospace-theme")).toBe("Fira Code");
    expect(b.style.getPropertyValue("--font-interface-theme")).toBe("Inter");
    v.write(".obsidian/appearance.json", JSON.stringify({ theme: "moonstone" }));
    await applyAppearance(app);
    expect(b.classList.contains("theme-light")).toBe(true);
    expect(b.style.getPropertyValue("--accent-h")).toBe("");
  });
  it("follows the system colour scheme and stops after dispose", async () => {
    let matches = true; let cb: (() => void) | null = null;
    const mql: any = { get matches() { return matches; }, addEventListener: (_: string, f: () => void) => { cb = f; }, removeEventListener: (_: string, f: () => void) => { if (cb === f) cb = null; } };
    const spy = vi.spyOn(window, "matchMedia").mockReturnValue(mql);
    await applyAppearance(app);
    expect(document.body.classList.contains("theme-dark")).toBe(true);
    matches = false; cb!();
    expect(document.body.classList.contains("theme-light")).toBe(true);
    await applyAppearance(app); // second call must not register another listener
    expect(spy).toHaveBeenCalledTimes(1);
    dispose();
    expect(cb).toBeNull();
    dispose = installSettings(app);
    spy.mockRestore();
  });
  it("tab writes appearance.json", async () => {
    const t = await show(app, "appearance");
    pick(row(t.containerEl, "Base color scheme"), "dark");
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json")?.theme).toBe("obsidian"));
    expect(document.body.classList.contains("theme-dark")).toBe(true);
    const color = row(t.containerEl, "Accent color").querySelector<HTMLInputElement>("input[type=color]")!;
    color.value = "#00ff00"; color.dispatchEvent(new Event("input"));
    const slider = row(t.containerEl, "Font size").querySelector<HTMLInputElement>("input.slider")!;
    slider.value = "18"; slider.dispatchEvent(new Event("change"));
    typeIn(row(t.containerEl, "Text font").querySelector("input")!, "Georgia");
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json")).toMatchObject({ theme: "obsidian", accentColor: "#00ff00", baseFontSize: 18, textFontFamily: "Georgia" }));
    expect(document.body.style.getPropertyValue("--font-text-size")).toBe("18px");
    expect(hexToHsl("#00ff00")).toEqual({ h: 120, s: 100, l: 50 });
    // reset accent
    row(t.containerEl, "Accent color").querySelector<HTMLElement>(".extra-setting-button")!.click();
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json").accentColor).toBeUndefined());
    expect(document.body.style.getPropertyValue("--accent-h")).toBe("");
  });
  it("toggles show tab title bar in app.json", async () => {
    const t = await show(app, "appearance");
    clickToggle(row(t.containerEl, "Show tab title bar"));
    await flush();
    expect(readJson(v, ".obsidian/app.json").showViewHeader).toBe(false);
    expect(document.body.classList.contains("show-view-header")).toBe(false);
  });
  it("lists snippets, toggles them and picks installed themes", async () => {
    v.write(".obsidian/snippets/wide.css", "body{--x:1}");
    v.write(".obsidian/themes/Neo/theme.css", "body{--neo:1}");
    v.write(".obsidian/themes/Neo/manifest.json", JSON.stringify({ name: "Neo", version: "1.0.0" }));
    await app.customCss.requestLoadSnippets(); await app.customCss.requestLoadThemes();
    const t = await show(app, "appearance");
    clickToggle(row(t.containerEl, "wide"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json").enabledCssSnippets).toEqual(["wide"]));
    await vi.waitFor(() => expect(document.head.querySelector("style[data-tachylite-snippet=wide]")).not.toBeNull());
    pick(row(t.containerEl, "Current theme"), "Neo");
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json").cssTheme).toBe("Neo"));
    expect(app.customCss.theme).toBe("Neo");
    pick(row(t.containerEl, "Current theme"), "");
    await vi.waitFor(() => expect(readJson(v, ".obsidian/appearance.json").cssTheme).toBe(""));
  });
});

describe("Hotkeys tab", () => {
  const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  beforeEach(() => {
    app.commands.addCommand({ id: "t:one", name: "Zed one", callback() {} });
    app.commands.addCommand({ id: "t:two", name: "Zed two", callback() {}, });
    app.hotkeyManager.setDefaultHotkeys("t:two", [{ modifiers: ["Mod"], key: "j" }]);
  });
  it("formats hotkeys", () => {
    expect(prettyHotkey({ modifiers: ["Mod", "Shift"], key: "p" })).toMatch(/^(Ctrl|Cmd)\+Shift\+P$/);
    expect(prettyHotkey({ modifiers: [], key: " " })).toBe("Space");
  });
  it("captures a combination, writes hotkeys.json, warns on duplicates and removes", async () => {
    const t = await show(app, "hotkeys");
    const r1 = () => row(t.containerEl, "Zed one");
    r1().querySelector<HTMLElement>(".extra-setting-button")!.click();
    expect(r1().querySelector(".mod-capturing")).not.toBeNull();
    press({ key: "Control", ctrlKey: true }); // bare modifier is ignored
    expect(r1().querySelector(".mod-capturing")).not.toBeNull();
    press({ key: "j", ctrlKey: true });
    await flush();
    expect(readJson(v, ".obsidian/hotkeys.json")["t:one"]).toEqual([{ modifiers: ["Mod"], key: "J" }]);
    expect(r1().querySelector(".setting-hotkey-label")!.textContent).toMatch(/^(Ctrl|Cmd)\+J$/);
    expect(r1().querySelector(".setting-item-description")!.textContent).toBe("Used by Zed two");
    expect(hotkeyId({ modifiers: ["Mod"], key: "J" })).toBe(hotkeyId({ modifiers: ["Mod"], key: "j" }));
    // remove stores an empty list (so a default can be removed) and shows reset
    r1().querySelector<HTMLElement>(".setting-delete-hotkey")!.click();
    await flush();
    expect(readJson(v, ".obsidian/hotkeys.json")["t:one"]).toBeUndefined(); // back to the (empty) default
    const two = row(t.containerEl, "Zed two");
    two.querySelector<HTMLElement>(".setting-delete-hotkey")!.click();
    await flush();
    expect(readJson(v, ".obsidian/hotkeys.json")["t:two"]).toEqual([]);
    expect(app.hotkeyManager.getHotkeys("t:two")).toEqual([]);
    // reset restores the default
    const btns = row(t.containerEl, "Zed two").querySelectorAll<HTMLElement>(".extra-setting-button");
    btns[btns.length - 1].click();
    await flush();
    expect(readJson(v, ".obsidian/hotkeys.json")["t:two"]).toBeUndefined();
    expect(app.hotkeyManager.getHotkeys("t:two")).toEqual([{ modifiers: ["Mod"], key: "j" }]);
  });
  it("Escape cancels capture; filter and customized-only work", async () => {
    const t = await show(app, "hotkeys");
    row(t.containerEl, "Zed one").querySelector<HTMLElement>(".extra-setting-button")!.click();
    press({ key: "Escape" });
    expect(t.containerEl.querySelector(".mod-capturing")).toBeNull();
    expect(app.hotkeyManager.customKeys["t:one"]).toBeUndefined();
    typeIn(t.containerEl.querySelector<HTMLInputElement>("input[type=search]")!, "zed t");
    expect([...t.containerEl.querySelectorAll(".hotkey-list-item .setting-item-name")].map((e) => e.textContent)).toEqual(["Zed two"]);
    typeIn(t.containerEl.querySelector<HTMLInputElement>("input[type=search]")!, "");
    app.hotkeyManager.setHotkeys("t:one", [{ modifiers: ["Alt"], key: "x" }]);
    clickToggle(row(t.containerEl, "Customized only"));
    expect([...t.containerEl.querySelectorAll(".hotkey-list-item .setting-item-name")].map((e) => e.textContent)).toEqual(["Zed one"]);
  });
});

describe("Core plugins tab", () => {
  it("toggles write core-plugins.json as {id: bool}", async () => {
    const t = await show(app, "core-plugins");
    const name = app.internalPlugins.plugins["graph"].name;
    const r = row(t.containerEl, name);
    clickToggle(r);
    await vi.waitFor(() => expect(readJson(v, ".obsidian/core-plugins.json")?.graph).toBe(false));
    const j = readJson(v, ".obsidian/core-plugins.json");
    expect(Array.isArray(j)).toBe(false);
    expect(j["file-explorer"]).toBe(true);
    clickToggle(r);
    await vi.waitFor(() => expect(readJson(v, ".obsidian/core-plugins.json").graph).toBe(true));
  });
  it("filters by name", async () => {
    const t = await show(app, "core-plugins");
    typeIn(t.containerEl.querySelector<HTMLInputElement>("input[type=search]")!, "backlink");
    const names = [...t.containerEl.querySelectorAll(".core-plugin-item .setting-item-name")].map((e) => e.textContent!.toLowerCase());
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.includes("backlink") || n.includes("link"))).toBe(true);
  });
});

describe("About tab and utils", () => {
  it("shows the vault path", async () => {
    const t = await show(app, "about");
    expect(t.containerEl.textContent).toContain(v.root);
  });
  it("compares dotted versions", () => {
    expect(compareVersions("1.10.0", "1.9.3")).toBeGreaterThan(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("v0.9.9", "1.0.0")).toBeLessThan(0);
  });
});
