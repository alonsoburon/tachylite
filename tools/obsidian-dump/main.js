// Tachylite reference dump: a tiny, standalone Obsidian plugin (MIT, original code). It only reads state that the
// public plugin API and the app's own DOM expose, and writes it to one JSON file in the vault root.
// Tachylite's tests compare that file with Tachylite's behavior; see README.md next to this file.
const { Plugin, Notice, apiVersion, Platform } = require("obsidian");

const OUTPUT = "tachylite-reference.json";
const CORPUS_FOLDER = "tachylite-corpus";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function closeMenus() {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  document.querySelectorAll(".menu").forEach((m) => m.remove());
}

/**
 * Run `trigger` (async, returns false when the element it needs is missing), read the menu that opens (titles in order, "---"
 * for separators) and close it. null: the element was missing. { none: true }: the element was there but no menu opened.
 */
async function captureMenu(trigger) {
  closeMenus();
  let found;
  try { found = await trigger(); } catch (e) { return { error: String(e) }; }
  if (found === false) return null;
  await wait(250);
  const menus = [...document.querySelectorAll(".menu")];
  const menu = menus[menus.length - 1];
  if (!menu) return { none: true };
  const items = [];
  for (const el of menu.querySelectorAll(".menu-item, .menu-separator")) {
    if (el.classList.contains("menu-separator")) items.push("---");
    else items.push(el.querySelector(".menu-item-title")?.textContent ?? "");
  }
  closeMenus();
  return items;
}

/** A right click on the first element matching `selector`. Uses a genuine (trusted) click when the automation exposes one. */
async function rightClick(selector) {
  const el = document.querySelector(selector);
  if (!el) return false;
  if (window.tachyRightClick) {
    await new Promise((resolve) => { window.__rightClicked = resolve; window.tachyRightClick(selector); });
  } else {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80, button: 2 }));
  }
  return true;
}

module.exports = class TachyliteReferenceDump extends Plugin {
  async onload() {
    this.addCommand({ id: "dump-reference-data", name: "Dump Tachylite reference data", callback: () => { void this.dump(); } });
  }

  async dump() {
    const app = this.app;
    const notice = new Notice("Dumping reference data...", 0);
    try {
      const out = {
        _note: "Produced by the Tachylite reference dump plugin. Use a fresh vault with no community plugins and default settings, or the defaults below are not defaults.",
        generatedAt: new Date().toISOString(),
        apiVersion,
        platform: { isMacOS: !!Platform.isMacOS, isWin: !!Platform.isWin, isLinux: !!Platform.isLinux },
        commands: this.dumpCommands(),
        corePlugins: this.dumpCorePlugins(),
        config: await this.dumpConfig(),
        menus: await this.dumpMenus(),
        cache: await this.dumpCache(),
      };
      await app.vault.adapter.write(OUTPUT, JSON.stringify(out, null, 2));
      window.__tachyDumpDone = true; // lets the automation (scripts/obsidian-reference.sh) know it can disconnect
      notice.hide();
      new Notice(`Wrote ${OUTPUT} to the vault root. Copy it to compat/obsidian-reference.json in the Tachylite repo.`, 10000);
    } catch (e) {
      window.__tachyDumpDone = true;
      notice.hide();
      console.error("Tachylite reference dump failed", e);
      new Notice(`Dump failed: ${e}`, 10000);
    }
  }

  dumpCommands() {
    const hk = this.app.hotkeyManager;
    return Object.values(this.app.commands.commands)
      .filter((c) => !c.id.startsWith("tachylite-reference-dump:")) // this plugin's own command is not part of the app
      .map((c) => ({ id: c.id, name: c.name, hotkeys: (hk.getDefaultHotkeys?.(c.id) ?? hk.defaultKeys?.[c.id] ?? []).map((h) => ({ modifiers: [...h.modifiers], key: h.key })) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /**
   * Every setting the app reads with its current (default, in a fresh vault) value. The vault's own config object only holds
   * what the user changed, so the key names come from the `getConfig("name")` calls in the app's scripts (names only).
   */
  async dumpConfig() {
    const app = this.app;
    const names = new Set(Object.keys(app.vault.config ?? {}));
    for (const script of document.querySelectorAll("script[src]")) {
      try {
        const text = await (await fetch(script.src)).text();
        for (const m of text.matchAll(/(?:getConfig|setConfig)\("([A-Za-z][A-Za-z0-9]*)"/g)) names.add(m[1]);
      } catch (e) { /* a script that cannot be read adds no names */ }
    }
    const out = {};
    for (const name of [...names].sort()) {
      let value;
      try { value = app.vault.getConfig(name); } catch (e) { continue; }
      if (value === undefined) continue;
      try { out[name] = JSON.parse(JSON.stringify(value)); } catch (e) { /* not plain data */ }
    }
    return out;
  }

  dumpCorePlugins() {
    return Object.entries(this.app.internalPlugins.plugins)
      .map(([id, p]) => ({ id, name: p.instance?.name ?? p.name ?? id, enabled: !!p.enabled, defaultOn: p.defaultOn ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async dumpMenus() {
    const app = this.app;
    const out = {};
    // Make sure there is a note open; menus are read from the real DOM, so each view is brought to the front first.
    const file = app.vault.getMarkdownFiles().find((f) => f.path.startsWith(CORPUS_FOLDER)) ?? app.vault.getMarkdownFiles()[0];
    if (file) await app.workspace.getLeaf(false).openFile(file);
    const show = async (commandId) => { app.commands.executeCommandById(commandId); await wait(700); };
    const view = (type) => '.workspace-leaf-content[data-type="' + type + '"]';
    const visible = (selector) => { const el = document.querySelector(selector); return !!el && el.getClientRects().length > 0; };
    // A right click on `selector`, only when it is on screen (a hidden element would take the click somewhere else).
    const onScreen = (selector) => async () => (visible(selector) ? rightClick(selector) : false);

    await show("file-explorer:open");
    out.fileMenu = await captureMenu(onScreen(view("file-explorer") + " .nav-file-title"));
    out.folderMenu = await captureMenu(onScreen(view("file-explorer") + " .nav-folder-title"));
    out.tabHeaderMenu = await captureMenu(onScreen(".mod-root .workspace-tab-header.is-active"));
    out.editorMenu = await captureMenu(onScreen(".workspace-leaf.mod-active .cm-content"));
    out.moreOptionsMenu = await captureMenu(async () => { const b = document.querySelector('.workspace-leaf.mod-active .view-action[aria-label="More options"]'); if (!b) return false; b.click(); return true; });
    await show("tag-pane:open");
    out.tagMenu = await captureMenu(onScreen(view("tag") + " .tree-item-self"));
    // The bookmark menu needs a bookmark. Add one only if there is none, and take it away again afterwards.
    const bookmarks = app.internalPlugins.getPluginById?.("bookmarks")?.instance;
    let temporary = null;
    if (bookmarks && file && !(bookmarks.items ?? []).length) {
      try { temporary = { type: "file", path: file.path, title: "" }; bookmarks.addItem(temporary); } catch (e) { temporary = null; }
    }
    await show("bookmarks:open");
    out.bookmarkMenu = await captureMenu(onScreen(view("bookmarks") + " .tree-item-self"));
    if (temporary) { try { bookmarks.removeItem(temporary); } catch (e) { /* the throwaway vault keeps one bookmark */ } }
    out.ribbonMenu = await captureMenu(onScreen(".workspace-ribbon.side-dock-ribbon"));
    return out;
  }

  /** metadataCache output for the corpus notes (copy tools/obsidian-dump/corpus/ into the vault as `tachylite-corpus/`). */
  async dumpCache() {
    const app = this.app;
    const out = {};
    const files = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(CORPUS_FOLDER + "/"));
    for (const file of files) {
      let cache = null;
      for (let i = 0; i < 50 && !cache; i++) {
        cache = app.metadataCache.getFileCache(file);
        if (!cache) await wait(100);
      }
      out[file.path.slice(CORPUS_FOLDER.length + 1)] = { text: await app.vault.read(file), cache: cache ? JSON.parse(JSON.stringify(cache)) : null };
    }
    return out;
  }
};
