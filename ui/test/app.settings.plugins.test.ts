import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import { clickToggle, confirmTop, flush, readJson, row, show, type as typeIn } from "./helpers/settings";
import { setBackend } from "../src/ipc";
import { installSettings } from "../src/app/settings";
import { PluginBrowserModal, relevance } from "../src/app/settings/pluginBrowser";
import { ThemeBrowserModal, screenshotUrl } from "../src/app/settings/themeBrowser";
import { checkForUpdates } from "../src/app/settings/updates";
import type { App } from "../src/obsidian/app";

const MAIN = (ver: string) => `
const { Plugin, PluginSettingTab } = require("obsidian");
class T extends PluginSettingTab { display() { this.containerEl.empty(); this.containerEl.createDiv({ text: "tab ${ver}" }); } }
module.exports = class P extends Plugin {
  async onload() {
    this.addCommand({ id: "hello", name: "Hello ${ver}", callback() {} });
    this.addRibbonIcon("star", "Hello ribbon", () => {});
    this.addSettingTab(new T(this.app, this));
  }
};`;

let v: FakeVault, app: App, dispose: () => void;
let catalog: any[], remoteVersion: string, installs: string[], failCatalog = false;
const enc = (s: string) => Array.from(Buffer.from(s));

function installStub(id: string, ver: string) {
  v.write(`.obsidian/plugins/${id}/manifest.json`, JSON.stringify({ id, name: "Hello Plugin", version: ver, minAppVersion: "0.15.0", description: "Says hello", author: "Ann" }));
  v.write(`.obsidian/plugins/${id}/main.js`, MAIN(ver));
}

beforeEach(async () => {
  v = makeVault({ "A.md": "# A" });
  catalog = [
    { id: "hello", name: "Hello Plugin", author: "Ann", description: "Says hello", repo: "ann/hello" },
    { id: "other", name: "Other", author: "Bob", description: "Does hello things too", repo: "bob/other" },
  ];
  remoteVersion = "1.0.0"; installs = []; failCatalog = false;
  setBackend(async (cmd: string, a: any) => {
    switch (cmd) {
      case "plugin_catalog": if (failCatalog) throw new Error("offline"); return catalog;
      case "plugin_install": { installs.push(a.id); installStub(a.id, remoteVersion); return JSON.parse(fs.readFileSync(path.join(v.root, `.obsidian/plugins/${a.id}/manifest.json`), "utf8")); }
      case "plugin_uninstall": {
        fs.rmSync(path.join(v.root, `.obsidian/plugins/${a.id}`), { recursive: true });
        const p = path.join(v.root, ".obsidian/community-plugins.json");
        if (fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(JSON.parse(fs.readFileSync(p, "utf8")).filter((x: string) => x !== a.id)));
        return null;
      }
      case "theme_catalog": return [
        { name: "Neo", author: "Zed", repo: "zed/neo", screenshot: "screenshot.png", modes: ["dark", "light"] },
        { name: "Night", author: "Amy", repo: "amy/night", screenshot: "s.png", modes: ["dark"] },
      ];
      case "theme_install": v.write(`.obsidian/themes/${a.name}/theme.css`, "body{--t:1}"); v.write(`.obsidian/themes/${a.name}/manifest.json`, JSON.stringify({ name: a.name, version: "1.0.0" })); return null;
      case "http_request":
        if (String(a.req.url) === "https://raw.githubusercontent.com/ann/hello/HEAD/manifest.json") return { status: 200, headers: {}, body: enc(JSON.stringify({ id: "hello", version: remoteVersion })) };
        return { status: 404, headers: {}, body: [] };
      default: return v.backend(cmd, a);
    }
  });
  app = await makeApp(v);
  dispose = installSettings(app);
});
afterEach(async () => {
  dispose();
  await app.stop();
  v.cleanup();
  document.body.innerHTML = "";
  document.body.className = "";
});

const cardFor = (id: string) => document.querySelector<HTMLElement>(`.community-item[data-plugin-id="${id}"]`)!;
const btn = (el: HTMLElement, text: string) => [...el.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text)!;

describe("Community plugins tab", () => {
  it("restricted mode: explanation, confirm, then turn on", async () => {
    app.plugins.restrictedMode = true;
    const t = await show(app, "community-plugins");
    expect(t.containerEl.textContent).toContain("Restricted mode is on");
    expect(t.containerEl.textContent).not.toContain("Installed plugins");
    btn(t.containerEl, "Turn on community plugins").click();
    await vi.waitFor(() => expect(document.querySelector(".modal.mod-confirmation")).not.toBeNull());
    expect(document.querySelector(".modal.mod-confirmation")!.textContent).toContain("full access");
    await confirmTop("Turn on community plugins");
    await vi.waitFor(() => expect(app.plugins.restrictedMode).toBe(false));
    expect(app.loadLocalStorage("enable-plugin")).toBe(true);
    await vi.waitFor(() => expect(t.containerEl.textContent).toContain("Installed plugins"));
  });
  it("turning community plugins off unloads them", async () => {
    installStub("hello", "1.0.0");
    await app.plugins.loadManifests();
    expect(await app.plugins.enablePluginAndSave("hello")).toBe(true);
    const t = await show(app, "community-plugins");
    btn(t.containerEl, "Turn off community plugins").click();
    await vi.waitFor(() => expect(document.querySelector(".modal.mod-confirmation")).not.toBeNull());
    await confirmTop("Turn on restricted mode");
    await vi.waitFor(() => expect(app.plugins.restrictedMode).toBe(true));
    expect(app.loadLocalStorage("enable-plugin")).toBe(false);
    expect(app.commands.commands["hello:hello"]).toBeUndefined();
    expect(readJson(v, ".obsidian/community-plugins.json")).toEqual(["hello"]); // list on disk is kept
  });

  it("browser: install -> enable -> command/ribbon/tab appear; disable removes; uninstall deletes", async () => {
    const t = await show(app, "community-plugins");
    btn(t.containerEl, "Browse").click();
    await vi.waitFor(() => expect(cardFor("hello")).not.toBeNull());
    expect(document.querySelectorAll(".community-item").length).toBe(2);
    btn(cardFor("hello"), "Install").click();
    await vi.waitFor(() => expect(btn(cardFor("hello"), "Enable")).toBeTruthy());
    expect(installs).toEqual(["hello"]);
    expect(fs.existsSync(path.join(v.root, ".obsidian/plugins/hello/main.js"))).toBe(true);
    expect(app.commands.commands["hello:hello"]).toBeUndefined();
    btn(cardFor("hello"), "Enable").click();
    await vi.waitFor(() => expect(btn(cardFor("hello"), "Disable")).toBeTruthy());
    expect(app.commands.commands["hello:hello"]).toBeDefined();
    expect(app.workspace.leftRibbon.items.some((i) => i.title === "Hello ribbon")).toBe(true);
    expect(app.setting.pluginTabs.map((x) => x.id)).toContain("hello");
    expect(readJson(v, ".obsidian/community-plugins.json")).toContain("hello");
    btn(cardFor("hello"), "Disable").click();
    await vi.waitFor(() => expect(btn(cardFor("hello"), "Enable")).toBeTruthy());
    expect(app.commands.commands["hello:hello"]).toBeUndefined();
    expect(app.workspace.leftRibbon.items.some((i) => i.title === "Hello ribbon")).toBe(false);
    expect(app.setting.pluginTabs.map((x) => x.id)).not.toContain("hello");
    expect(readJson(v, ".obsidian/community-plugins.json")).not.toContain("hello");
    btn(cardFor("hello"), "Uninstall").click();
    await vi.waitFor(() => expect(document.querySelector(".modal.mod-confirmation")).not.toBeNull());
    await confirmTop("Uninstall");
    await vi.waitFor(() => expect(btn(cardFor("hello"), "Install")).toBeTruthy());
    expect(fs.existsSync(path.join(v.root, ".obsidian/plugins/hello"))).toBe(false);
  });

  it("browser: search ranks by name and pages long catalogs; offline shows retry", async () => {
    catalog = Array.from({ length: 120 }, (_, i) => ({ id: `p${i}`, name: `Plugin ${i}`, author: "x", description: "d", repo: `x/p${i}` }));
    catalog.push({ id: "zeta", name: "Zeta", author: "x", description: "plugin about zeta", repo: "x/zeta" });
    const m = new PluginBrowserModal(app); m.open();
    await vi.waitFor(() => expect(document.querySelectorAll(".community-item").length).toBe(40));
    btn(document.body, "Show more (81)").click();
    expect(document.querySelectorAll(".community-item").length).toBe(80);
    typeIn(document.querySelector<HTMLInputElement>(".community-modal-search input")!, "zeta");
    expect(document.querySelectorAll(".community-item").length).toBe(1);
    expect(relevance(catalog[0], "plugin")).toBeGreaterThan(relevance(catalog[120], "plugin"));
    m.close();

    failCatalog = true;
    const m2 = new PluginBrowserModal(app); m2.open();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Could not load the plugin catalog"));
    failCatalog = false;
    btn(document.body, "Retry").click();
    await vi.waitFor(() => expect(document.querySelectorAll(".community-item").length).toBeGreaterThan(0));
    m2.close();
  });

  it("installed list: toggle, options button opens the plugin tab, uninstall", async () => {
    installStub("hello", "1.0.0");
    await app.plugins.loadManifests();
    const t = await show(app, "community-plugins");
    let r = row(t.containerEl, "Hello Plugin1.0.0");
    expect(r.textContent).toContain("Says hello");
    expect(r.textContent).toContain("By Ann");
    expect(r.querySelector(".extra-setting-button[aria-label='Options']")).toBeNull();
    clickToggle(r);
    await vi.waitFor(() => expect(app.plugins.isEnabled("hello")).toBe(true));
    await vi.waitFor(() => expect(t.containerEl.querySelectorAll(".extra-setting-button").length).toBe(3));
    r = t.containerEl.querySelector<HTMLElement>(".community-plugin-item")!;
    r.querySelectorAll<HTMLElement>(".extra-setting-button")[0].click(); // gear
    expect(app.setting.activeTab?.id).toBe("hello");
    app.setting.close();
    r.querySelectorAll<HTMLElement>(".extra-setting-button")[1].click(); // hotkeys: opens the Hotkeys tab filtered to this plugin
    expect(app.setting.activeTab?.id).toBe("hotkeys");
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>(".hotkey-search-container input")?.value).toBe("hello plugin"));
    expect([...document.querySelectorAll(".hotkey-list-item")].every((e) => e.textContent!.toLowerCase().includes("hello plugin"))).toBe(true);
    app.setting.close();
    r.querySelectorAll<HTMLElement>(".extra-setting-button")[2].click(); // trash
    await vi.waitFor(() => expect(document.querySelector(".modal.mod-confirmation")).not.toBeNull());
    await confirmTop("Uninstall");
    await vi.waitFor(() => expect(app.plugins.manifests["hello"]).toBeUndefined());
    expect(app.commands.commands["hello:hello"]).toBeUndefined();
    expect(fs.existsSync(path.join(v.root, ".obsidian/plugins/hello"))).toBe(false);
  });

  it("shows load errors", async () => {
    v.write(".obsidian/plugins/bad/manifest.json", JSON.stringify({ id: "bad", name: "Bad", version: "1.0.0", description: "", author: "x" }));
    v.write(".obsidian/plugins/bad/main.js", "throw new Error('boom')");
    await app.plugins.loadManifests();
    expect(await app.plugins.enablePluginAndSave("bad")).toBe(false);
    const t = await show(app, "community-plugins");
    expect(t.containerEl.querySelector(".community-plugin-error")!.getAttribute("title")).toContain("boom");
  });

  it("update check lists newer versions and Update reinstalls and reloads", async () => {
    installStub("hello", "1.0.0");
    await app.plugins.loadManifests();
    await app.plugins.enablePluginAndSave("hello");
    remoteVersion = "1.10.0";
    expect((await checkForUpdates(app)).map((u) => [u.id, u.current, u.latest])).toEqual([["hello", "1.0.0", "1.10.0"]]);
    const t = await show(app, "community-plugins");
    btn(t.containerEl, "Check for updates").click();
    await vi.waitFor(() => expect(t.containerEl.querySelector(".community-plugin-update-item")).not.toBeNull());
    expect(t.containerEl.querySelector(".community-plugin-update-item")!.textContent).toContain("1.0.0 → 1.10.0");
    btn(t.containerEl.querySelector<HTMLElement>(".community-plugin-update-item")!, "Update").click();
    await vi.waitFor(() => expect(app.plugins.manifests["hello"].version).toBe("1.10.0"));
    await vi.waitFor(() => expect(app.commands.commands["hello:hello"]?.name).toBe("Hello Plugin: Hello 1.10.0"));
    await vi.waitFor(() => expect(t.containerEl.textContent).not.toContain("update available"));
    expect(installs).toEqual(["hello"]);
  });
  it("no updates when versions match", async () => {
    installStub("hello", "1.0.0");
    await app.plugins.loadManifests();
    expect(await checkForUpdates(app)).toEqual([]);
  });
});

describe("Theme browser", () => {
  it("installs, uses and uninstalls a theme; filters by mode", async () => {
    const m = new ThemeBrowserModal(app); m.open();
    await vi.waitFor(() => expect(document.querySelectorAll(".community-theme").length).toBe(2));
    const img = document.querySelector<HTMLImageElement>(".community-theme img")!;
    expect(img.getAttribute("src")).toBe("https://raw.githubusercontent.com/zed/neo/HEAD/screenshot.png");
    img.dispatchEvent(new Event("error")); // offline: falls back to a placeholder
    expect(document.querySelector(".community-item-screenshot.is-missing")).not.toBeNull();
    const sel = document.querySelector<HTMLSelectElement>(".community-modal-controls select")!;
    sel.value = "light"; sel.dispatchEvent(new Event("change"));
    expect([...document.querySelectorAll(".community-theme .community-item-name")].map((e) => e.textContent)).toEqual(["Neo"]);
    const card = () => document.querySelector<HTMLElement>(".community-theme")!;
    btn(card(), "Install and use").click();
    await vi.waitFor(() => expect(btn(card(), "In use")).toBeTruthy());
    expect(app.customCss.theme).toBe("Neo");
    expect(readJson(v, ".obsidian/appearance.json").cssTheme).toBe("Neo");
    expect(fs.existsSync(path.join(v.root, ".obsidian/themes/Neo/theme.css"))).toBe(true);
    btn(card(), "Uninstall").click();
    await vi.waitFor(() => expect(btn(card(), "Install and use")).toBeTruthy());
    expect(fs.existsSync(path.join(v.root, ".obsidian/themes/Neo"))).toBe(false);
    expect(app.customCss.theme).toBe("");
    m.close();
    expect(screenshotUrl({ repo: "", screenshot: "x" })).toBeNull();
  });
});
void flush;
