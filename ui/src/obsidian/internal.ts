// app.internalPlugins (core plugin registry) and app.customCss (themes / snippets).
import { ipc } from "../ipc";
import { Events, Keymap, Platform, prettyHotkey } from "./events";
import { setIcon } from "./icons";
import type { TFile } from "./files";
import { FuzzySuggestModal, SuggestModal, type FuzzyMatch } from "./ui";
import { parseFrontMatterAliases, prepareFuzzySearch, renderResults, sortSearchResults, type SearchResult } from "./util";
import type { Command } from "./plugin";
import type { App } from "./app";

interface SwitcherItem { file: TFile; match: SearchResult; /** Set when the match is on one of the note's aliases. */ alias?: string }
/** Core "Quick switcher" modal (exposed as internalPlugins.getPluginById("switcher").instance.QuickSwitcherModal). */
export class QuickSwitcherModal extends SuggestModal<SwitcherItem> {
  constructor(app: App) {
    super(app);
    this.setPlaceholder("Find or create a note...");
    const mod = Platform.isMacOS ? "cmd" : "ctrl";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" }, { command: "↵", purpose: "to open" }, { command: `${mod} ↵`, purpose: "to open in new tab" },
      { command: `${mod} alt ↵`, purpose: "to open to the right" }, { command: "shift ↵", purpose: "to create" }, { command: "esc", purpose: "to dismiss" },
    ]);
  }
  get chooser() { return this.suggestions; }
  private supported(file: TFile): boolean {
    return file.extension === "md" || file.extension === "canvas" || !!this.app.vault.getConfig("showUnsupportedFiles");
  }
  getSuggestions(query: string): SwitcherItem[] {
    const search = prepareFuzzySearch(query);
    const files = this.app.vault.getFiles().filter((f) => this.supported(f));
    if (!query.trim()) {
      // Nothing typed: the notes you opened most recently first (not the one you are in), then the newest edits.
      const recent = new Map(this.app.workspace.getLastOpenFiles().map((p, i) => [p, i] as const));
      const active = this.app.workspace.getActiveFile()?.path;
      return files.filter((f) => f.path !== active)
        .sort((a, b) => (recent.get(a.path) ?? Infinity) - (recent.get(b.path) ?? Infinity) || b.stat.mtime - a.stat.mtime)
        .map((file) => ({ file, match: search(file.basename) ?? { score: 0, matches: [] } }));
    }
    const out: SwitcherItem[] = [];
    for (const file of files) {
      const m = search(file.extension === "md" ? file.path.replace(/\.md$/, "") : file.path);
      if (m) out.push({ file, match: m });
      if (file.extension === "md") {
        for (const alias of parseFrontMatterAliases(this.app.metadataCache.getFileCache(file)?.frontmatter) ?? []) {
          const am = search(alias);
          if (am) out.push({ file, match: am, alias });
        }
      }
    }
    sortSearchResults(out);
    return out;
  }
  renderSuggestion(item: SwitcherItem, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    if (item.alias) {
      renderResults(title, item.alias, item.match);
      const note = content.createDiv({ cls: "suggestion-note" });
      setIcon(note.createSpan({ cls: "suggestion-flair" }), "lucide-forward");
      note.createSpan({ text: ` ${item.file.path.replace(/\.md$/, "")}` });
      return;
    }
    const text = item.file.extension === "md" ? item.file.basename : item.file.name;
    renderResults(title, text, item.match, item.file.path.length - text.length - (item.file.extension === "md" ? 3 : 0));
    if (item.file.parent && !item.file.parent.isRoot()) content.createDiv({ cls: "suggestion-note", text: item.file.parent.path });
  }
  /** Shift+Enter creates (or opens) the note named by what was typed, whatever is highlighted. */
  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void {
    const name = this.inputEl.value.trim();
    if (evt instanceof KeyboardEvent && evt.shiftKey && name) {
      this.close();
      void this.app.workspace.openLinkText(name, "", evt.ctrlKey || evt.metaKey ? (evt.altKey ? "split" : "tab") : false);
      return;
    }
    super.selectActiveSuggestion(evt);
  }
  onChooseSuggestion(item: SwitcherItem, evt: MouseEvent | KeyboardEvent): void {
    void this.app.workspace.openLinkText(item.file.path, "", Keymap.isModEvent(evt));
  }
}

const RECENT_COMMANDS = "recent-commands";
class CommandPaletteModal extends FuzzySuggestModal<Command> {
  constructor(app: App) { super(app); this.setPlaceholder("Select a command..."); }
  getItems(): Command[] { return this.app.commands.listCommands().filter((c) => this.app.commands.canExecute(c)); }
  getItemText(c: Command): string { return c.name; }
  getSuggestions(query: string): FuzzyMatch<Command>[] {
    const res = super.getSuggestions(query);
    if (query.trim()) return res;
    // Nothing typed: pinned commands (command-palette.json "pinned"), then the ones you ran lately, then the rest.
    const pinned: string[] = this.app.internalPlugins.getPluginById("command-palette")?.instance.options?.pinned ?? [];
    const recent: string[] = this.app.loadLocalStorage(RECENT_COMMANDS) ?? [];
    const rank = (c: Command) => { const p = pinned.indexOf(c.id); if (p >= 0) return p; const r = recent.indexOf(c.id); return r >= 0 ? pinned.length + r : Infinity; };
    return res.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.item) - rank(b.m.item) || a.i - b.i).map((x) => x.m);
  }
  renderSuggestion(v: FuzzyMatch<Command>, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const aux = el.createDiv({ cls: "suggestion-aux" });
    renderResults(content.createDiv({ cls: "suggestion-title" }), v.item.name, v.match);
    for (const h of this.app.hotkeyManager.getHotkeys(v.item.id)) aux.createEl("kbd", { cls: "suggestion-hotkey", text: prettyHotkey(h) });
  }
  onChooseItem(c: Command): void {
    const recent: string[] = (this.app.loadLocalStorage(RECENT_COMMANDS) ?? []).filter((id: string) => id !== c.id);
    this.app.saveLocalStorage(RECENT_COMMANDS, [c.id, ...recent].slice(0, 10));
    this.app.commands.executeCommand(c);
  }
}

const CORE_NAMES: Record<string, string> = {
  "file-explorer": "Files", "global-search": "Search", switcher: "Quick switcher", graph: "Graph view", backlink: "Backlinks",
  canvas: "Canvas", "outgoing-link": "Outgoing links", "tag-pane": "Tags view", properties: "Properties view", "page-preview": "Page preview",
  "daily-notes": "Daily notes", templates: "Templates", "note-composer": "Note composer", "command-palette": "Command palette",
  "slash-command": "Slash commands", "editor-status": "Show editing mode in status bar", bookmarks: "Bookmarks",
  "zk-prefixer": "Unique note creator", "random-note": "Random note", outline: "Outline", "word-count": "Word count", slides: "Slides",
  "audio-recorder": "Audio recorder", workspaces: "Workspaces", "file-recovery": "File recovery", publish: "Publish", sync: "Sync",
  bases: "Bases", webviewer: "Web viewer", footnotes: "Footnotes view",
};

export interface InternalPluginInstance { id: string; name: string; options: Record<string, any>; [k: string]: unknown }
export class InternalPluginWrapper extends Events {
  instance: InternalPluginInstance;
  constructor(public manager: InternalPlugins, public id: string, public enabled: boolean) {
    super();
    this.instance = { id, name: CORE_NAMES[id] ?? id, options: {} };
    if (id === "switcher") (this.instance as any).QuickSwitcherModal = QuickSwitcherModal;
    // Obsidian Sync is out of scope, but plugins (Smart Connections) read its status before they run: report "not syncing".
    if (id === "sync") Object.assign(this.instance, { syncStatus: "Fully synced", syncing: false });
    if (id === "graph") {
      // The graph engine is not implemented; plugins that patch its prototype (hover-editor) only need the shape.
      class GraphEngine { onNodeHover(): void {} onNodeUnhover(): void {} onNodeClick(): void {} }
      const stub = () => ({ engine: new GraphEngine(), renderer: { worker: null }, containerEl: createDiv() });
      (this as any).views = { graph: stub, localgraph: stub };
    }
  }
  /** Obsidian keeps a `_loaded` flag and an async load() on the wrapper; some plugins call them. */
  get _loaded(): boolean { return this.enabled; }
  async load(): Promise<void> {}
  get name(): string { return this.instance.name; }
  /** Options persistence in .obsidian/<id>.json, as the core plugins' own loadData/saveData. */
  async loadData(): Promise<any> { try { return await ipc.configRead(`${this.id}.json`); } catch { return null; } }
  async saveData(data: any): Promise<void> { await ipc.configWrite(`${this.id}.json`, data); }
  enable(): Promise<void> { return this.set(true); }
  disable(): Promise<void> { return this.set(false); }
  private async set(on: boolean): Promise<void> {
    if (this.enabled === on) return;
    this.enabled = on;
    await this.manager.save();
    this.trigger(on ? "enable" : "disable");
    this.manager.trigger("change", this.id, on);
  }
}

export class InternalPlugins extends Events {
  plugins: Record<string, InternalPluginWrapper> = {};
  constructor(public app: App) { super(); }
  async load(): Promise<void> {
    try {
      for (const [id, on] of await ipc.corePlugins()) this.plugins[id] = new InternalPluginWrapper(this, id, on);
    } catch (e) { console.warn("core_plugins unavailable", e); }
    // Core plugin options live in .obsidian/<id>.json (daily-notes.json, templates.json, ...).
    await Promise.all(Object.values(this.plugins).map(async (p) => {
      try {
        const o = await ipc.configRead(`${p.id}.json`);
        if (o && typeof o === "object" && !Array.isArray(o)) p.instance.options = o;
      } catch { /* optional */ }
    }));
  }
  /** Register the handful of core commands the shell relies on (quick switcher, command palette). */
  registerCoreCommands(): void {
    const c = this.app.commands;
    if (this.plugins.switcher?.enabled) c.addCommand({ id: "switcher:open", name: "Quick switcher: Open quick switcher", hotkeys: [{ modifiers: ["Mod"], key: "o" }], callback: () => new QuickSwitcherModal(this.app).open() });
    if (this.plugins["command-palette"]?.enabled) c.addCommand({ id: "command-palette:open", name: "Command palette: Open command palette", hotkeys: [{ modifiers: ["Mod"], key: "p" }], callback: () => new CommandPaletteModal(this.app).open() });
  }
  getPluginById(id: string): InternalPluginWrapper | undefined { return this.plugins[id]; }
  getEnabledPluginById(id: string): InternalPluginInstanceOrNull { const p = this.plugins[id]; return p?.enabled ? p.instance : null; }
  getEnabledPlugins(): InternalPluginWrapper[] { return Object.values(this.plugins).filter((p) => p.enabled); }
  async save(): Promise<void> {
    const out: Record<string, boolean> = {};
    for (const [id, p] of Object.entries(this.plugins)) out[id] = p.enabled;
    await ipc.configWrite("core-plugins.json", out);
  }
}
type InternalPluginInstanceOrNull = InternalPluginInstance | null;

export class CustomCss extends Events {
  themes: Record<string, { name: string; version?: string; author?: string }> = {};
  snippets: string[] = [];
  enabledSnippets = new Set<string>();
  theme = "";
  csscache = new Map<string, string>();
  private styleEls = new Map<string, HTMLStyleElement>();
  private themeEl: HTMLStyleElement | null = null;
  constructor(public app: App) { super(); }

  async load(): Promise<void> {
    try {
      const ap = (await ipc.configRead("appearance.json")) ?? {};
      this.theme = ap.cssTheme ?? "";
      this.enabledSnippets = new Set(ap.enabledCssSnippets ?? []);
    } catch { /* no appearance.json */ }
    await this.requestLoadThemes();
    await this.requestLoadSnippets();
    await this.apply();
  }
  async requestLoadThemes(): Promise<void> {
    this.themes = {};
    const a = this.app.vault.adapter, dir = `${this.app.vault.configDir}/themes`;
    try {
      if (!(await a.exists(dir))) return;
      for (const f of (await a.list(dir)).folders) {
        const name = f.slice(f.lastIndexOf("/") + 1);
        let meta: any = {};
        try { meta = JSON.parse(await a.read(`${f}/manifest.json`)); } catch { /* optional */ }
        this.themes[name] = { name, ...meta };
      }
    } catch (e) { console.warn("themes unreadable", e); }
  }
  async requestLoadSnippets(): Promise<void> {
    this.snippets = [];
    const a = this.app.vault.adapter, dir = `${this.app.vault.configDir}/snippets`;
    try {
      if (!(await a.exists(dir))) return;
      this.snippets = (await a.list(dir)).files.filter((f) => f.endsWith(".css")).map((f) => f.slice(f.lastIndexOf("/") + 1, -4)).sort();
    } catch (e) { console.warn("snippets unreadable", e); }
  }
  getSnippetPath(s: string): string { return `${this.app.vault.configDir}/snippets/${s}.css`; }
  getThemePath(t: string): string { return `${this.app.vault.configDir}/themes/${t}/theme.css`; }
  isThemeInstalled(name: string): boolean { return name in this.themes; }
  async setTheme(name: string): Promise<void> { this.theme = name === "Default" ? "" : name; await this.save(); await this.apply(); this.app.workspace.trigger("css-change"); }
  async setCssEnabledStatus(snippet: string, enabled: boolean): Promise<void> {
    if (enabled) this.enabledSnippets.add(snippet); else this.enabledSnippets.delete(snippet);
    await this.save(); await this.apply(); this.app.workspace.trigger("css-change");
  }
  private async save(): Promise<void> {
    let ap: any = {};
    try { ap = (await ipc.configRead("appearance.json")) ?? {}; } catch { /* new */ }
    ap.cssTheme = this.theme;
    ap.enabledCssSnippets = [...this.enabledSnippets];
    await ipc.configWrite("appearance.json", ap);
  }
  /** (Re)inject the active theme and enabled snippets as <style> elements. */
  private applyGen = 0;
  async apply(): Promise<void> {
    // Calls can overlap (load, setTheme, css-change...); only the latest one may leave elements behind.
    const gen = ++this.applyGen;
    const stale = () => gen !== this.applyGen;
    const a = this.app.vault.adapter;
    let themeCss: string | null = null;
    if (this.theme && this.themes[this.theme]) {
      try { themeCss = await a.read(this.getThemePath(this.theme)); } catch (e) { console.warn("theme css unreadable", e); }
    }
    const snippets: [string, string][] = [];
    for (const s of this.enabledSnippets) {
      if (!this.snippets.includes(s)) continue;
      try { snippets.push([s, await a.read(this.getSnippetPath(s))]); } catch (e) { console.warn("snippet unreadable", s, e); }
    }
    if (stale()) return;
    this.themeEl?.remove(); this.themeEl = null;
    for (const el of this.styleEls.values()) el.remove();
    this.styleEls.clear();
    if (themeCss !== null) this.themeEl = document.head.createEl("style", { attr: { "data-tachylite-theme": this.theme }, text: themeCss });
    for (const [s, css] of snippets) this.styleEls.set(s, document.head.createEl("style", { attr: { "data-tachylite-snippet": s }, text: css }));
  }
}
