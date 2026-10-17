// Runs tools/obsidian-dump/main.js against a stub of the Obsidian API and checks that the JSON it writes has the shape the
// comparison reads. This catches syntax and runtime mistakes in the plugin; it does NOT prove the plugin works in a real
// Obsidian (menu capture in particular depends on that app's DOM), which only a real run can show.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffCommands, diffConfig, diffCorePlugins, diffMenus } from "./helpers/reference";

const SOURCE = fs.readFileSync(path.join(__dirname, "../../tools/obsidian-dump/main.js"), "utf8");
const CORPUS = path.join(__dirname, "../../tools/obsidian-dump/corpus");

class StubNotice { static all: string[] = []; constructor(public msg: string) { StubNotice.all.push(msg); } hide() {} }
class StubPlugin { app: any; commands: any[] = []; addCommand(c: any) { this.commands.push(c); } }

function menuOn(el: Element, titles: string[]) {
  el.addEventListener("contextmenu", () => {
    const m = document.body.appendChild(document.createElement("div"));
    m.className = "menu";
    for (const t of titles) {
      if (t === "---") { m.appendChild(document.createElement("div")).className = "menu-separator"; continue; }
      const item = m.appendChild(document.createElement("div"));
      item.className = "menu-item";
      item.appendChild(document.createElement("div")).className = "menu-item-title";
      item.querySelector(".menu-item-title")!.textContent = t;
    }
  });
}

function fakeVault() {
  document.body.innerHTML = `
    <div class="workspace-leaf-content" data-type="file-explorer"><div class="nav-file-title">a</div><div class="nav-folder-title">f</div></div>
    <div class="mod-root"><div class="workspace-tab-header is-active"></div></div>
    <div class="workspace-leaf mod-active"><div class="view-action" aria-label="More options"></div><div class="cm-content"></div></div>
    <div class="workspace-ribbon side-dock-ribbon mod-primary"><div class="side-dock-actions"></div></div>
    <div class="workspace-leaf-content" data-type="bookmarks"><div class="tree-item-self"></div></div>`;
  menuOn(document.querySelector(".nav-file-title")!, ["Open in new tab", "---", "Delete"]);
  menuOn(document.querySelector(".nav-folder-title")!, ["New note", "Delete"]);
  menuOn(document.querySelector(".workspace-tab-header")!, ["Close", "Pin"]);
  menuOn(document.querySelector(".cm-content")!, ["Cut", "Copy", "Paste"]);
  document.querySelector(".view-action")!.addEventListener("click", () => document.querySelector(".cm-content")!.dispatchEvent(new MouseEvent("contextmenu")));
  menuOn(document.querySelector(".side-dock-ribbon")!, ["Open quick switcher", "---", "Hide ribbon"]);

  const files = fs.readdirSync(CORPUS).map((n) => ({ path: `tachylite-corpus/${n}`, text: fs.readFileSync(path.join(CORPUS, n), "utf8") }));
  const written: Record<string, string> = {};
  const app: any = {
    commands: { commands: { "app:open-settings": { id: "app:open-settings", name: "Open settings" }, "switcher:open": { id: "switcher:open", name: "Quick switcher: Open quick switcher" } }, executeCommandById: () => true },
    hotkeyManager: { getDefaultHotkeys: (id: string) => (id === "switcher:open" ? [{ modifiers: ["Mod"], key: "o" }] : []) },
    internalPlugins: { plugins: { graph: { enabled: true, instance: { name: "Graph view" }, defaultOn: true }, sync: { enabled: false, name: "Sync" } } },
    vault: {
      config: { tabSize: 4, readableLineLength: true },
      getConfig(k: string) { return (this.config as any)[k]; },
      getMarkdownFiles: () => files.map((f) => ({ path: f.path })),
      read: async (f: any) => files.find((x) => x.path === f.path)!.text,
      adapter: { write: async (p: string, d: string) => { written[p] = d; } },
    },
    metadataCache: { getFileCache: (f: any) => ({ links: [], tags: [{ tag: "#x", position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 2, offset: 2 } } }] }) },
    workspace: { getLeaf: () => ({ openFile: async () => {} }) },
  };
  return { app, written };
}

async function runDump() {
  const { app, written } = fakeVault();
  const module: any = { exports: {} };
  const require = (name: string) => {
    if (name !== "obsidian") throw new Error("unexpected require " + name);
    return { Plugin: StubPlugin, Notice: StubNotice, apiVersion: "stub-1.0", Platform: { isLinux: true } };
  };
  new Function("require", "module", SOURCE)(require, module);
  const plugin: any = new module.exports();
  plugin.app = app;
  await plugin.onload();
  expect(plugin.commands.map((c: any) => c.id)).toEqual(["dump-reference-data"]);
  await plugin.dump();
  return { out: JSON.parse(written["tachylite-reference.json"]), written };
}

afterEach(() => { document.body.innerHTML = ""; StubNotice.all = []; });

describe("tools/obsidian-dump plugin (against a stub Obsidian API)", () => {
  it("is valid JavaScript with a manifest that matches", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../tools/obsidian-dump/manifest.json"), "utf8"));
    expect(manifest.id).toBe("tachylite-reference-dump");
    expect(manifest.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("writes commands, core plugins, config, menus and the corpus cache in the shape the comparison reads", async () => {
    const { out } = await runDump();
    expect(out.apiVersion).toBe("stub-1.0");
    expect(out.commands).toEqual([
      { id: "app:open-settings", name: "Open settings", hotkeys: [] },
      { id: "switcher:open", name: "Quick switcher: Open quick switcher", hotkeys: [{ modifiers: ["Mod"], key: "o" }] },
    ]);
    expect(out.corePlugins).toEqual([{ id: "graph", name: "Graph view", enabled: true, defaultOn: true }, { id: "sync", name: "Sync", enabled: false, defaultOn: null }]);
    expect(out.config).toEqual({ tabSize: 4, readableLineLength: true });
    expect(out.menus.fileMenu).toEqual(["Open in new tab", "---", "Delete"]);
    expect(out.menus.folderMenu).toEqual(["New note", "Delete"]);
    expect(out.menus.tabHeaderMenu).toEqual(["Close", "Pin"]);
    expect(out.menus.moreOptionsMenu).toEqual(["Cut", "Copy", "Paste"]); // the stub routes the button to a menu
    expect(out.menus.ribbonMenu).toEqual(["Open quick switcher", "---", "Hide ribbon"]);
    expect(out.menus.tagMenu).toBeNull(); // no such element in the stub: recorded as null
    expect(out.menus.bookmarkMenu).toEqual({ none: true }) // the element exists but no menu opens: recorded as { none: true }
    const names = Object.keys(out.cache).sort();
    expect(names).toEqual(fs.readdirSync(CORPUS).sort());
    expect(out.cache["tags.md"].text).toBe(fs.readFileSync(path.join(CORPUS, "tags.md"), "utf8"));
    expect(out.cache["tags.md"].cache.tags[0].tag).toBe("#x");
    expect(document.querySelectorAll(".menu")).toHaveLength(0); // menus are closed again
    expect(StubNotice.all.some((m) => m.includes("Wrote tachylite-reference.json"))).toBe(true);
  });

  it("produces a file the comparison helpers accept, and a menu the plugin could not open is skipped", async () => {
    const { out } = await runDump();
    expect(diffCommands(out.commands, out.commands)).toEqual([]);
    expect(diffCorePlugins(out.corePlugins, out.corePlugins)).toEqual([]);
    expect(diffConfig(out.config, (k) => out.config[k])).toEqual([]);
    expect(diffMenus(out.menus, { fileMenu: ["Open in new tab", "---", "Delete"], tagMenu: ["never compared"] })).toEqual(
      expect.arrayContaining([expect.stringContaining("folderMenu: not compared")]),
    );
    expect(diffMenus(out.menus, { fileMenu: ["Open in new tab", "---", "Delete"] }).some((d) => d.startsWith("tagMenu"))).toBe(false);
    // Obsidian opened no menu, Tachylite does: reported, not skipped.
    expect(diffMenus(out.menus, { bookmarkMenu: ["Remove"] })).toContain("bookmarkMenu: Obsidian opens no menu here, Tachylite opens one (Remove)");
  });
});
