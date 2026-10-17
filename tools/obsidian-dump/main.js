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

/** Run `trigger`, read the menu that opens (titles in order, "---" for separators), close it. null when none opened. */
async function captureMenu(trigger) {
  closeMenus();
  try { trigger(); } catch (e) { return { error: String(e) }; }
  await wait(200);
  const menus = [...document.querySelectorAll(".menu")];
  const menu = menus[menus.length - 1];
  if (!menu) return null;
  const items = [];
  for (const el of menu.querySelectorAll(".menu-item, .menu-separator")) {
    if (el.classList.contains("menu-separator")) items.push("---");
    else items.push(el.querySelector(".menu-item-title")?.textContent ?? "");
  }
  closeMenus();
  return items;
}

// A missing element simply opens no menu, which is recorded as null ("could not be opened").
const contextmenu = (el) => el?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80, button: 2 }));

// Method names are prefixed `dump` so they cannot collide with members of the base Plugin class.
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
        config: JSON.parse(JSON.stringify(app.vault.config ?? {})),
        menus: await this.dumpMenus(),
        cache: await this.dumpCache(),
      };
      await app.vault.adapter.write(OUTPUT, JSON.stringify(out, null, 2));
      notice.hide();
      new Notice(`Wrote ${OUTPUT} to the vault root. Copy it to compat/obsidian-reference.json in the Tachylite repo.`, 10000);
    } catch (e) {
      notice.hide();
      console.error("Tachylite reference dump failed", e);
      new Notice(`Dump failed: ${e}`, 10000);
    }
  }

  dumpCommands() {
    const hk = this.app.hotkeyManager;
    return Object.values(this.app.commands.commands)
      .map((c) => ({ id: c.id, name: c.name, hotkeys: (hk.getDefaultHotkeys?.(c.id) ?? hk.defaultKeys?.[c.id] ?? []).map((h) => ({ modifiers: [...h.modifiers], key: h.key })) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  dumpCorePlugins() {
    return Object.entries(this.app.internalPlugins.plugins)
      .map(([id, p]) => ({ id, name: p.instance?.name ?? p.name ?? id, enabled: !!p.enabled, defaultOn: p.defaultOn ?? null }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async dumpMenus() {
    const app = this.app;
    const out = {};
    // Make sure there is a note open and the side views exist; menus are read from the real DOM.
    const file = app.vault.getMarkdownFiles().find((f) => f.path.startsWith(CORPUS_FOLDER)) ?? app.vault.getMarkdownFiles()[0];
    if (file) await app.workspace.getLeaf(false).openFile(file);
    for (const id of ["file-explorer:open", "tag-pane:open", "bookmarks:open"]) app.commands.executeCommandById(id);
    await wait(500);
    const one = (selector) => document.querySelector(selector);
    out.fileMenu = await captureMenu(() => contextmenu(one('.workspace-leaf-content[data-type="file-explorer"] .nav-file-title')));
    out.folderMenu = await captureMenu(() => contextmenu(one('.workspace-leaf-content[data-type="file-explorer"] .nav-folder-title')));
    out.tabHeaderMenu = await captureMenu(() => contextmenu(one(".mod-root .workspace-tab-header.is-active")));
    out.editorMenu = await captureMenu(() => contextmenu(one(".workspace-leaf.mod-active .cm-content")));
    out.moreOptionsMenu = await captureMenu(() => one('.workspace-leaf.mod-active .view-action[aria-label="More options"]')?.click());
    out.tagMenu = await captureMenu(() => contextmenu(one('.workspace-leaf-content[data-type="tag"] .tree-item-self')));
    out.bookmarkMenu = await captureMenu(() => contextmenu(one('.workspace-leaf-content[data-type="bookmarks"] .tree-item-self')));
    out.ribbonMenu = await captureMenu(() => contextmenu(one(".workspace-ribbon.mod-left .side-dock-actions")));
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
