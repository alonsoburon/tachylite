// "Core plugins" settings tab.
import { Setting, SettingTab, type App } from "../../obsidian";
import { searchBox } from "./util";

const DESCRIPTIONS: Record<string, string> = {
  "file-explorer": "Browse and manage the files and folders of your vault.",
  "global-search": "Search for text across all notes in the vault.",
  switcher: "Jump to a note quickly by typing part of its name.",
  graph: "Visualize the links between your notes.",
  backlink: "Find notes that link to the current note.",
  canvas: "Arrange notes and media on an infinite canvas.",
  "outgoing-link": "Show the links that the current note contains.",
  "tag-pane": "List all tags in the vault and browse the notes using them.",
  properties: "View and edit the properties of the current note.",
  "page-preview": "Preview a linked note by hovering over the link.",
  "daily-notes": "Create a note for today and open it with one command.",
  templates: "Insert predefined snippets of text into notes.",
  "note-composer": "Merge notes and extract selections into new notes.",
  "command-palette": "Run any command by searching for it.",
  "slash-command": "Run commands by typing a slash in the editor.",
  "editor-status": "Show the editor state in the status bar.",
  bookmarks: "Bookmark notes, searches and headings for quick access.",
  "markdown-importer": "Import Markdown files from other apps.",
  "zk-prefixer": "Create notes with a unique timestamp prefix.",
  "random-note": "Open a random note from the vault.",
  outline: "Show the headings of the current note as an outline.",
  "word-count": "Show the word and character count in the status bar.",
  slides: "Present notes as slides.",
  "audio-recorder": "Record audio and embed it in notes.",
  workspaces: "Save and restore named window layouts.",
  "file-recovery": "Keep snapshots of notes so they can be recovered.",
  publish: "Publish notes to a website.",
  sync: "Synchronize the vault across devices.",
  bases: "Create database-like views of notes using their properties.",
  webviewer: "Open web pages inside the app.",
};

/** Core plugins Tachylite does not provide: Sync and Publish are paid services (out of scope), the others are not built yet. */
const UNAVAILABLE: Record<string, string> = {
  sync: "Not available in Tachylite (paid Obsidian service).",
  publish: "Not available in Tachylite (paid Obsidian service).",
  webviewer: "Not available in Tachylite yet.",
  "markdown-importer": "Not available in Tachylite yet.",
};

export class CorePluginsSettingTab extends SettingTab {
  id = "core-plugins";
  name = "Core plugins";
  icon = "lucide-box";
  private query = "";
  private listEl: HTMLElement | null = null;
  constructor(app: App) { super(app); }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const bar = el.createDiv({ cls: "setting-search-bar" });
    searchBox(bar, "Search core plugins...", (v) => { this.query = v.trim().toLowerCase(); this.renderList(); }).setValue(this.query);
    this.listEl = el.createDiv({ cls: "core-plugin-list" });
    this.renderList();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const plugins = Object.values(this.app.internalPlugins.plugins).sort((a, b) => a.name.localeCompare(b.name));
    let shown = 0;
    for (const p of plugins) {
      const desc = DESCRIPTIONS[p.id] ?? "";
      if (this.query && !(p.name.toLowerCase().includes(this.query) || desc.toLowerCase().includes(this.query))) continue;
      const item = new Setting(list).setName(p.name).setDesc(desc).setClass("core-plugin-item");
      const tab = p.enabled && this.app.setting.settingTabs.find((t) => (t as any).corePluginId === p.id);
      if (tab) item.addExtraButton((b) => b.setIcon("lucide-settings").setTooltip("Options").onClick(() => this.app.setting.openTabById(p.id)));
      const missing = UNAVAILABLE[p.id];
      if (missing) { item.setDesc(`${desc} ${missing}`.trim()); item.settingEl.addClass("is-unavailable"); }
      item.addToggle((t) => t.setValue(p.enabled && !missing).setDisabled(!!missing).onChange(async (v) => { await (v ? p.enable() : p.disable()); this.renderList(); }));
      list.lastElementChild?.setAttribute("data-plugin-id", p.id);
      shown++;
    }
    if (!shown) list.createDiv({ cls: "setting-item-note", text: "No core plugins match your search." });
  }
}
