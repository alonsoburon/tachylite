import { createRequire } from "../src/obsidian/pluginLoader";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import { MarkdownPreviewRenderer, runPostProcessors, createPostProcessorContext } from "../src/obsidian/markdown";
import { ItemView, MarkdownView } from "../src/obsidian";
import type { App } from "../src/obsidian/app";

const FIXTURE = `
"use strict";
var obsidian = require("obsidian");
var view = require("@codemirror/view");
var state = require("@codemirror/state");
var nodePath = require("path");
var fs = require("fs");
var os = require("os");
var crypto = require("crypto");
var electron = require("electron");
var cp = require("child_process");
const VIEW_TYPE = "fixture-view";
class FixtureView extends obsidian.ItemView {
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Fixture"; }
  async onOpen() { const c = this.containerEl.children[1]; c.empty(); c.createEl("h4", { text: "Hello view" }); }
  async onClose() { globalThis.__fixtureClosed = (globalThis.__fixtureClosed || 0) + 1; }
}
class FixtureTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    new obsidian.Setting(containerEl).setName("Greeting").setDesc("Say hi")
      .addText((t) => t.setValue(this.plugin.settings.greeting).onChange(async (v) => { this.plugin.settings.greeting = v; await this.plugin.saveData(this.plugin.settings); }));
    new obsidian.Setting(containerEl).setName("Enabled").addToggle((t) => t.setValue(this.plugin.settings.on).onChange(async (v) => { this.plugin.settings.on = v; await this.plugin.saveData(this.plugin.settings); }));
  }
}
class FixturePlugin extends obsidian.Plugin {
  async onload() {
    globalThis.__order = ["onload-start", "app:" + (this.app === globalThis.app), "dir:" + this.manifest.dir];
    this.settings = Object.assign({ greeting: "hi", on: false }, await this.loadData());
    globalThis.__loadedSettings = this.settings;
    this.addCommand({ id: "say", name: "Say", callback: () => { globalThis.__said = this.settings.greeting; } });
    this.addCommand({ id: "check", name: "Check", checkCallback: (checking) => { if (!globalThis.__canRun) return false; if (!checking) globalThis.__checked = true; return true; } });
    this.addCommand({ id: "ed", name: "Editor", editorCallback: (editor, ctx) => { editor.replaceSelection("[" + ctx.file.basename + "]"); } });
    this.addSettingTab(new FixtureTab(this.app, this));
    this.registerView(VIEW_TYPE, (leaf) => new FixtureView(leaf));
    this.registerExtensions(["fix"], VIEW_TYPE);
    this.registerMarkdownPostProcessor((el) => { el.querySelectorAll("p").forEach((p) => p.classList.add("fixture-pp")); });
    this.registerMarkdownCodeBlockProcessor("fixture", (src, el) => { el.createEl("b", { text: src.toUpperCase() }); });
    this.registerObsidianProtocolHandler("fixture", (p) => { globalThis.__proto = p; });
    this.registerEditorExtension(view.EditorView.editorAttributes.of({ "data-fixture": "yes" }));
    this.statusBar = this.addStatusBarItem(); this.statusBar.setText("fixture ready");
    this.ribbon = this.addRibbonIcon("dice", "Fixture ribbon", () => { globalThis.__ribbon = true; });
    this.registerEvent(this.app.vault.on("modify", (f) => { globalThis.__modified = f.path; }));
    this.registerEvent(this.app.workspace.on("file-open", (f) => { globalThis.__opened = f && f.path; }));
    this.registerDomEvent(document, "keydown", () => { globalThis.__keys = (globalThis.__keys || 0) + 1; });
    this.registerInterval(window.setInterval(() => { globalThis.__ticks = (globalThis.__ticks || 0) + 1; }, 5));
    this.app.workspace.onLayoutReady(() => { globalThis.__order.push("layout-ready"); });
    globalThis.__env = {
      join: nodePath.join("a", "b", "..", "c"), os: typeof os.platform(), electronShell: typeof electron.shell.openExternal, remote: typeof electron.remote.app.getPath,
      sha1: crypto.createHash("sha1").update("abc").digest("hex"), md5: crypto.createHash("md5").update("abc").digest("hex"),
      sha256: crypto.createHash("sha256").update("abc").digest("hex"), hmac: crypto.createHmac("sha256", "key").update("data").digest("hex"),
      existsSync: fs.existsSync("Home.md"), cpThrows: (() => { try { cp.execSync("ls"); } catch (e) { return e.message; } })(),
      process: typeof process.platform, buffer: Buffer.from("hi").toString("hex"),
    };
    globalThis.__order.push("onload-end");
  }
  onunload() { globalThis.__unloaded = true; }
}
module.exports = FixturePlugin; module.exports.default = FixturePlugin;
`;

let v: FakeVault, app: App;
const G = globalThis as any;
const reset = () => { for (const k of Object.keys(G)) if (k.startsWith("__")) delete G[k]; };

beforeEach(() => reset());
afterEach(async () => { await app?.stop(); v?.cleanup(); document.body.innerHTML = ""; document.head.innerHTML = ""; });

async function boot(extra: Record<string, any> = {}, enabled = ["fixture", ...Object.keys(extra)]) {
  v = makeVault({ "Home.md": "# Home\nhello", "x.fix": "data" }, { plugins: { fixture: { main: FIXTURE, styles: ".fixture{color:red}", data: { greeting: "yo", on: true } }, ...extra }, enabled });
  app = await makeApp(v);
}

describe("plugin loader with a hand-written CommonJS fixture", () => {
  it("loads via community-plugins.json, sets app/manifest.dir before onload, awaits onload, layout-ready after", async () => {
    await boot();
    expect(app.plugins.getPlugin("fixture")).not.toBeNull();
    expect(app.plugins.enabledPlugins.has("fixture")).toBe(true);
    expect(G.__order).toEqual(["onload-start", "app:true", "dir:.obsidian/plugins/fixture", "onload-end", "layout-ready"]);
    expect(app.workspace.layoutReady).toBe(true);
    expect(app.plugins.manifests.fixture.name).toBe("fixture");
    expect(app.plugins.loadErrors).toEqual({});
  });
  it("onLayoutReady called immediately when the layout is already ready", async () => {
    await boot();
    const fn = vi.fn();
    app.workspace.onLayoutReady(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("loadData returns saved data, null when absent; saveData round-trips as data.json", async () => {
    await boot();
    expect(G.__loadedSettings).toEqual({ greeting: "yo", on: true });
    const p = app.plugins.getPlugin("fixture")!;
    await p.saveData({ a: 1 });
    expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/plugins/fixture/data.json"), "utf8"))).toEqual({ a: 1 });
    expect(await p.loadData()).toEqual({ a: 1 });
    fs.rmSync(path.join(v.root, ".obsidian/plugins/fixture/data.json"));
    expect(await p.loadData()).toBeNull();
  });
  it("commands: id/name prefixed, callback, checkCallback, editorCallback, hotkeys not required", async () => {
    await boot();
    const cmds = app.commands.commands;
    expect(Object.keys(cmds).filter((k) => k.startsWith("fixture:"))).toEqual(["fixture:say", "fixture:check", "fixture:ed"]);
    expect(cmds["fixture:say"].name).toBe("fixture: Say");
    expect(app.commands.executeCommandById("fixture:say")).toBe(true);
    expect(G.__said).toBe("yo");
    expect(app.commands.executeCommandById("fixture:check")).toBe(false);
    G.__canRun = true;
    expect(app.commands.executeCommandById("fixture:check")).toBe(true);
    expect(G.__checked).toBe(true);
    expect(app.commands.executeCommandById("nope:nope")).toBe(false);
    expect(app.commands.executeCommandById("fixture:ed")).toBe(false); // no active markdown view
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getFileByPath("Home.md")!, { active: true });
    expect(app.workspace.getActiveViewOfType(MarkdownView)).toBeInstanceOf(MarkdownView);
    app.workspace.getActiveViewOfType(MarkdownView)!.editor.setCursor({ line: 0, ch: 0 });
    expect(app.commands.executeCommandById("fixture:ed")).toBe(true);
    expect(app.workspace.getActiveViewOfType(MarkdownView)!.editor.getLine(0)).toBe("[Home]# Home");
    expect(G.__opened).toBe("Home.md");
  });
  it("settings tab registered and rendered with Obsidian class names; edits persist through saveData", async () => {
    await boot();
    expect(app.setting.pluginTabs).toHaveLength(1);
    const tab = app.setting.pluginTabs[0];
    expect(tab.id).toBe("fixture");
    tab.display();
    expect(tab.containerEl.querySelectorAll(".setting-item")).toHaveLength(2);
    expect(tab.containerEl.querySelector(".setting-item-name")!.textContent).toBe("Greeting");
    expect(tab.containerEl.querySelector(".setting-item-description")!.textContent).toBe("Say hi");
    const input = tab.containerEl.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.value).toBe("yo");
    input.value = "hola"; input.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/plugins/fixture/data.json"), "utf8")).greeting).toBe("hola"));
    const toggle = tab.containerEl.querySelector(".checkbox-container") as HTMLElement;
    expect(toggle.classList.contains("is-enabled")).toBe(true);
    toggle.click();
    expect(toggle.classList.contains("is-enabled")).toBe(false);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/plugins/fixture/data.json"), "utf8")).on).toBe(false));
    app.setting.openTabById("fixture");
    expect(document.querySelector(".modal.mod-settings .vertical-tab-nav-item.is-active")!.textContent).toBe("fixture");
    expect(document.querySelector(".vertical-tab-content .setting-item")).not.toBeNull();
    app.setting.close();
    expect(document.querySelector(".mod-settings")).toBeNull();
  });
  it("registerView + registerExtensions: leaves can open the view; .fix files route to it", async () => {
    await boot();
    const leaf = app.workspace.getRightLeaf(false)!;
    await leaf.setViewState({ type: "fixture-view", active: true });
    expect(leaf.view).toBeInstanceOf(ItemView);
    expect(leaf.view.getViewType()).toBe("fixture-view");
    expect(leaf.view.containerEl.children[1].querySelector("h4")!.textContent).toBe("Hello view");
    expect(app.workspace.getLeavesOfType("fixture-view")).toEqual([leaf]);
    expect(app.workspace.getActiveViewOfType(ItemView)).toBe(leaf.view);
    const l2 = app.workspace.getLeaf("tab");
    await l2.openFile(app.vault.getFileByPath("x.fix")!);
    expect(l2.view.getViewType()).toBe("fixture-view");
    expect(() => app.viewRegistry.registerView("fixture-view", () => leaf.view)).toThrow(/existing view type/);
  });
  it("markdown post-processor and code-block processor registered", async () => {
    await boot();
    const el = document.createElement("div");
    el.innerHTML = "<p>para</p><pre><code class='language-fixture'>abc\n</code></pre><pre><code class='language-js'>x</code></pre>";
    await runPostProcessors(el, createPostProcessorContext(app, "Home.md", app.workspace as any));
    expect(el.querySelector("p")!.classList.contains("fixture-pp")).toBe(true);
    expect(el.querySelector(".block-language-fixture b")!.textContent).toBe("ABC");
    expect(el.querySelector("pre code.language-js")).not.toBeNull();
    expect(MarkdownPreviewRenderer.getPostProcessors().length).toBeGreaterThanOrEqual(2);
  });
  it("status bar item, ribbon icon, protocol handler, editor extension, styles", async () => {
    await boot();
    expect(app.statusBarEl.querySelector(".status-bar-item")!.textContent).toBe("fixture ready");
    const rib = app.workspace.leftRibbon.ribbonEl.querySelector(".side-dock-ribbon-action") as HTMLElement;
    expect(rib.getAttribute("aria-label")).toBe("Fixture ribbon");
    rib.click();
    expect(G.__ribbon).toBe(true);
    app.protocolHandlers.fixture({ action: "fixture", a: "1" });
    expect(G.__proto).toEqual({ action: "fixture", a: "1" });
    expect(app.workspace.editorExtensions.length).toBeGreaterThanOrEqual(2);
    const style = document.head.querySelector('style[data-tachylite-plugin="fixture"]')!;
    expect(style.textContent).toBe(".fixture{color:red}");
    // editor extension reaches editors
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getFileByPath("Home.md")!);
    expect((leaf.view as MarkdownView).containerEl.querySelector(".cm-editor [data-fixture=yes], [data-fixture=yes]")).not.toBeNull();
  });
  it("node/electron shims behave", async () => {
    await boot();
    expect(G.__env).toMatchObject({
      join: "a/c", os: "string", electronShell: "function", remote: "function",
      sha1: "a9993e364706816aba3e25717850c26c9cd0d89d", md5: "900150983cd24fb0d6963f7d28e17f72",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      hmac: "5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0", // matches node:crypto
      existsSync: true, process: "string", buffer: "6869",
    });
    expect(G.__env.cpThrows).toMatch(/not supported/);
  });

  it("http/https: createServer returns a server whose listen reports an error event; clients throw", async () => {
    const req = createRequire({} as any);
    for (const id of ["http", "node:https"]) {
      const http = req(id);
      expect(Object.keys(http)).toContain("createServer"); // survives bundlers' namespace interop
      const server = http.createServer(() => {});
      const err = await new Promise<any>((res) => { server.on("error", res); server.listen(27123, "127.0.0.1"); });
      expect(err.code).toBe("ERR_NOT_SUPPORTED");
      await new Promise<void>((res) => server.close(() => res()));
      expect(() => http.request("http://x")).toThrow(/not supported/);
    }
  });
  it("vault events reach plugin handlers (registerEvent) and file-open fires", async () => {
    await boot();
    await app.vault.modify(app.vault.getFileByPath("Home.md")!, "zzz");
    expect(G.__modified).toBe("Home.md");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(G.__keys).toBe(1);
  });
  it("unload cleans up commands, tab, view, ribbon, status bar, styles, events, intervals, DOM listeners, post-processors", async () => {
    await boot();
    await app.workspace.getRightLeaf(false)!.setViewState({ type: "fixture-view" });
    const ppBefore = MarkdownPreviewRenderer.getPostProcessors().length;
    await app.plugins.disablePlugin("fixture");
    expect(G.__unloaded).toBe(true);
    expect(app.plugins.getPlugin("fixture")).toBeNull();
    expect(Object.keys(app.commands.commands).filter((k) => k.startsWith("fixture:"))).toEqual([]);
    expect(app.setting.pluginTabs).toHaveLength(0);
    expect(app.viewRegistry.getViewCreatorByType("fixture-view")).toBeUndefined();
    expect(app.viewRegistry.isExtensionRegistered("fix")).toBe(false);
    expect(app.workspace.leftRibbon.ribbonEl.querySelectorAll(".side-dock-ribbon-action")).toHaveLength(0);
    expect(app.statusBarEl.querySelectorAll(".status-bar-item")).toHaveLength(0);
    expect(document.head.querySelector('style[data-tachylite-plugin="fixture"]')).toBeNull();
    expect(app.protocolHandlers.fixture).toBeUndefined();
    expect(MarkdownPreviewRenderer.getPostProcessors().length).toBe(ppBefore - 2);
    expect(app.workspace.editorExtensions.length).toBe(1); // only the suggest manager's
    // events, keydown listener and interval are gone
    G.__modified = undefined; G.__keys = 0; const ticks = G.__ticks ?? 0;
    await app.vault.modify(app.vault.getFileByPath("Home.md")!, "after");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(G.__modified).toBeUndefined();
    expect(G.__keys).toBe(0);
    expect(G.__ticks ?? 0).toBe(ticks);
    // the leaf survives as a placeholder and revives when the plugin is re-enabled
    expect(app.workspace.getLeavesOfType("fixture-view")).toHaveLength(1);
    expect(await app.plugins.enablePlugin("fixture")).toBe(true);
    await vi.waitFor(() => expect(app.workspace.getLeavesOfType("fixture-view")[0].view.containerEl.querySelector("h4")).not.toBeNull());
  });
});

describe("error isolation and manifest gating", () => {
  const broken = { main: "throw new Error('boom at eval');" };
  const brokenOnload = { main: "var o=require('obsidian');class P extends o.Plugin{ onload(){ this.addCommand({id:'c',name:'c',callback(){}}); throw new Error('onload boom'); } } module.exports=P;" };
  const desktopOnly = { manifest: { id: "future", name: "Future", version: "1", minAppVersion: "99.0.0", description: "", author: "" }, main: "module.exports = class extends require('obsidian').Plugin {}" };
  const missingModule = { main: "require('nonexistent-module')" };
  const notAPlugin = { main: "module.exports = { default: 42 }" };

  it("one failing plugin does not stop others; failures are recorded and surfaced as Notices", async () => {
    await boot({ broken, brokenOnload, future: desktopOnly, missing: missingModule, notplugin: notAPlugin }, ["broken", "fixture", "brokenOnload", "future", "missing", "notplugin"]);
    expect(app.plugins.getPlugin("fixture")).not.toBeNull();
    expect(Object.keys(app.plugins.loadErrors).sort()).toEqual(["broken", "brokenOnload", "future", "missing", "notplugin"]);
    expect(app.plugins.loadErrors.broken).toMatch(/boom at eval/);
    expect(app.plugins.loadErrors.brokenOnload).toMatch(/onload boom/);
    expect(app.plugins.loadErrors.future).toMatch(/99\.0\.0/);
    expect(app.plugins.loadErrors.missing).toMatch(/Cannot find module 'nonexistent-module'/);
    const notices = Array.from(document.querySelectorAll(".notice-container .notice-message")).map((n) => n.textContent);
    expect(notices).toContain("Failed to load plugin broken");
    expect(notices).toContain("Failed to load plugin Future");
    expect(app.plugins.getPlugin("brokenOnload")).toBeNull();
    // partially registered state of a failed onload was rolled back
    expect(app.commands.commands["brokenOnload:c"]).toBeUndefined();
    expect(app.workspace.layoutReady).toBe(true);
  });
  it("a plugin that is missing from disk is isolated too", async () => {
    v = makeVault({}, { plugins: { fixture: { main: FIXTURE } }, enabled: ["ghost", "fixture"] });
    app = await makeApp(v);
    expect(app.plugins.loadErrors.ghost).toBeDefined();
    expect(app.plugins.getPlugin("fixture")).not.toBeNull();
  });
  it("enablePluginAndSave persists via plugin_set_enabled and calls onUserEnable", async () => {
    v = makeVault({}, { plugins: { fixture: { main: FIXTURE } }, enabled: [] });
    app = await makeApp(v);
    expect(app.plugins.getPlugin("fixture")).toBeNull();
    expect(await app.plugins.enablePluginAndSave("fixture")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/community-plugins.json"), "utf8"))).toEqual(["fixture"]);
    await app.plugins.disablePluginAndSave("fixture");
    expect(JSON.parse(fs.readFileSync(path.join(v.root, ".obsidian/community-plugins.json"), "utf8"))).toEqual([]);
  });
  it("onExternalSettingsChange fires for foreign edits of data.json but not for our own saves", async () => {
    v = makeVault({}, { plugins: { ext: { main: "var o=require('obsidian');module.exports=class extends o.Plugin{ async onload(){ globalThis.__ext=0; this.onExternalSettingsChange=()=>{globalThis.__ext++;}; } }" } }, enabled: ["ext"] });
    app = await makeApp(v);
    const p = app.plugins.getPlugin("ext")!;
    await p.saveData({ k: 1 });
    app.handleVaultEvent({ kind: "config-changed", path: ".obsidian/plugins/ext/data.json" });
    await new Promise((r) => setTimeout(r, 20));
    expect(G.__ext).toBe(0);
    fs.writeFileSync(path.join(v.root, ".obsidian/plugins/ext/data.json"), '{"k":2}');
    app.handleVaultEvent({ kind: "config-changed", path: ".obsidian/plugins/ext/data.json" });
    await vi.waitFor(() => expect(G.__ext).toBe(1));
  });
});
