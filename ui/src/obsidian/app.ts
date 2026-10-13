// The App object handed to every plugin.
import { ipc, listen, type VaultEvent, type VaultInfo } from "../ipc";
import moment from "moment";
import { vimAdapter } from "../editor/vim";
import { installDomHelpers } from "./dom";
import { Keymap, Scope } from "./events";
import { FileManager, MetadataCache, MetadataTypeManager } from "./metadata";
import { CustomCss, InternalPlugins } from "./internal";
import { MarkdownRenderer } from "./markdown";
import { PluginManager, createRequire } from "./pluginLoader";
import { Commands, HotkeyManager, ViewRegistry } from "./plugin";
import { SettingManager } from "./setting";
import { Buffer, createProcess } from "./shims";
import { Vault } from "./vault";
import { EditorSuggestManager } from "./editorSuggest";
import { EmbedRegistry, registerDefaultEmbeds } from "./embeds";
import { RenderContext, SecretStorage } from "./values";
import { Workspace, type LayoutHost } from "./workspace";
import type { BasesViewRegistration } from "../bases/api";

export interface AppOptions {
  info: VaultInfo;
  layoutHost?: LayoutHost;
  /** Install document-level keyboard/mouse tracking (hotkeys, `lastEvent`). Default true. */
  installGlobalHandlers?: boolean;
  /** Runs after plugins loaded and before `layout-ready` (the shell restores workspace.json here). */
  restoreLayout?: () => Promise<void>;
  /** Runs once core plugin state is known and before community plugins load (the shell installs core views here). */
  onCoreReady?: () => void | Promise<void>;
}

export class App {
  scope: Scope;
  keymap: Keymap;
  vault: Vault;
  metadataCache: MetadataCache;
  metadataTypeManager: MetadataTypeManager;
  fileManager: FileManager;
  workspace: Workspace;
  commands: Commands;
  hotkeyManager: HotkeyManager;
  viewRegistry: ViewRegistry;
  plugins: PluginManager;
  internalPlugins: InternalPlugins;
  customCss: CustomCss;
  setting: SettingManager;
  secretStorage: SecretStorage;
  renderContext = new RenderContext();
  lastEvent: UIEventLike | null = null;
  isMobile = false;
  statusBarEl: HTMLElement;
  /** Legacy shape some plugins read (`app.statusBar.containerEl`). */
  statusBar: { containerEl: HTMLElement };
  dom: { appContainerEl: HTMLElement; horzSplitEl?: HTMLElement; rootEl?: HTMLElement };
  protocolHandlers: Record<string, (params: any) => any> = {};
  cliHandlers: Record<string, { description: string; flags: unknown; handler: (p: any) => any }> = {};
  /** Bases view types by id: built-in (table, cards, list) and Plugin.registerBasesView. */
  basesViews: Record<string, BasesViewRegistration> = {};
  /** Internal API read by some plugins (kanban, ...). */
  embedRegistry = new EmbedRegistry();
  appId: string;
  private _process: any;
  private unlisten: (() => void) | null = null;
  private teardown: (() => void)[] = [];

  private opts: AppOptions;
  constructor(opts: AppOptions) {
    this.opts = opts;
    installDomHelpers();
    this.scope = new Scope();
    this.keymap = new Keymap(this.scope);
    this.vault = new Vault(this, opts.info);
    this.metadataCache = new MetadataCache(this);
    this.metadataTypeManager = new MetadataTypeManager(this);
    this.fileManager = new FileManager(this);
    this.workspace = new Workspace(this);
    this.workspace.host = opts.layoutHost ?? null;
    this.viewRegistry = new ViewRegistry(this);
    this.commands = new Commands(this);
    this.hotkeyManager = new HotkeyManager(this);
    this.plugins = new PluginManager(this);
    this.internalPlugins = new InternalPlugins(this);
    this.customCss = new CustomCss(this);
    this.setting = new SettingManager(this);
    this.appId = opts.info.name;
    this.secretStorage = new SecretStorage(this.appId);
    this.statusBarEl = createDiv({ cls: "status-bar" });
    // Same skeleton as Obsidian: .app-container > .horizontal-main-container > .workspace, plus the status bar.
    const appContainerEl = createDiv({ cls: "app-container" });
    const horzSplitEl = appContainerEl.createDiv({ cls: "horizontal-main-container" });
    horzSplitEl.appendChild(this.workspace.containerEl);
    appContainerEl.appendChild(this.statusBarEl);
    this.statusBar = { containerEl: this.statusBarEl };
    this.dom = { appContainerEl, horzSplitEl };
    const mgr = new EditorSuggestManager(this);
    this.workspace.editorSuggestManager = mgr;
    this.workspace.editorExtensions.push(mgr.extension());
    MarkdownRenderer.currentApp = this;
    // `app` is a global in Obsidian
    (globalThis as any).app = this;
    registerDefaultEmbeds(this.embedRegistry);
    installLegacyGlobals();
    // Obsidian (Electron) exposes window.require; plugins call window.require("electron") etc.
    Object.defineProperty(globalThis, "require", { value: createRequire(this), configurable: true, writable: true, enumerable: false });
    // Electron's renderer also has a global Buffer; bundles read `global.Buffer` (obsidian-git's isomorphic-git, simple-git).
    if (!(globalThis as any).Buffer) Object.defineProperty(globalThis, "Buffer", { value: Buffer, configurable: true, writable: true, enumerable: false });
    if (opts.installGlobalHandlers !== false) this.installGlobalHandlers();
  }

  get pluginProcess(): any { return (this._process ??= createProcess()); }

  isDarkMode(): boolean { return document.body.classList.contains("theme-dark"); }
  getAppId(): string { return this.appId; }
  loadLocalStorage(key: string): any | null {
    const raw = localStorage.getItem(`${this.appId}-${key}`);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  }
  saveLocalStorage(key: string, data: unknown | null): void {
    const k = `${this.appId}-${key}`;
    if (data === null || data === undefined) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(data));
  }

  private installGlobalHandlers(): void {
    const doc = document;
    const track = (e: Event) => { this.lastEvent = e as UIEventLike; };
    for (const t of ["click", "mousedown", "keydown", "contextmenu", "pointerdown"]) doc.addEventListener(t, track, true);
    const key = (e: KeyboardEvent) => {
      if (this.keymap.handleEvent(e)) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing && !(e.ctrlKey || e.metaKey || e.altKey)) return;
      this.hotkeyManager.handleKeydown(e);
    };
    doc.addEventListener("keydown", key);
    this.teardown.push(() => {
      for (const t of ["click", "mousedown", "keydown", "contextmenu", "pointerdown"]) doc.removeEventListener(t, track, true);
      doc.removeEventListener("keydown", key);
    });
  }

  /** Boot sequence: config, metadata, core/community plugins, then layout-ready. */
  async start(): Promise<void> {
    await this.vault.loadConfig().catch((e) => console.warn("app.json unreadable", e));
    await this.hotkeyManager.load();
    await this.metadataCache.initialize();
    await this.metadataTypeManager.load();
    await this.internalPlugins.load();
    this.internalPlugins.registerCoreCommands();
    await this.customCss.load().catch((e) => console.warn("appearance failed", e));
    this.unlisten = await listen("vault-event", (ev: VaultEvent) => this.handleVaultEvent(ev));
    if (this.opts.onCoreReady) { try { await this.opts.onCoreReady(); } catch (e) { console.error("core views failed to install", e); } }
    await this.plugins.initialize();
    if (this.opts.restoreLayout) { try { await this.opts.restoreLayout(); } catch (e) { console.error("layout restore failed", e); } }
    this.workspace.markLayoutReady();
  }

  handleVaultEvent(ev: VaultEvent): void {
    if (ev.kind === "config-changed") {
      const f = ev.path.slice(ev.path.lastIndexOf("/") + 1);
      if (f === "app.json") void this.vault.loadConfig().then(() => this.workspace.trigger("config-changed"));
      else if (f === "hotkeys.json") void this.hotkeyManager.load();
      else if (f === "appearance.json") void this.customCss.load();
      else if (f === "types.json") void this.metadataTypeManager.onConfigFileChange();
      else if (f === "data.json") void this.plugins.handleConfigChanged(ev.path);
      return;
    }
    this.vault.handleBackendEvent(ev);
  }

  async stop(): Promise<void> {
    this.unlisten?.(); this.unlisten = null;
    this.vault.dispose();
    await this.plugins.unloadAll();
    for (const t of this.teardown.splice(0)) t();
    if ((globalThis as any).app === this) { delete (globalThis as any).app; delete (globalThis as any).require; }
  }
}

/** Globals Obsidian (Electron) exposes on `window` that plugins read without importing. */
function installLegacyGlobals(): void {
  const g = globalThis as any;
  g.moment ??= moment;
  g._bundledLocaleWeekSpec ??= { dow: moment.localeData().firstDayOfWeek(), doy: moment.localeData().firstDayOfYear() };
  g.i18next ??= (() => {
    // i18next instance as exposed by Obsidian: translation calls echo the key; every other method is a harmless no-op.
    const mk = (): any => new Proxy({ language: navigator.language?.split("-")[0] ?? "en", t: (k: string) => k, exists: () => false, createInstance: mk, use: () => mk(), getFixedT: () => (k: string) => k }, {
      get: (t, p) => (p in t ? (t as any)[p] : typeof p === "symbol" || p === "then" ? undefined : () => undefined),
    });
    return mk();
  })();
  // The CM5 adapter of the Vim bindings, with the real Vim API on `.Vim` (vimrc-style plugins map keys and ex commands).
  g.CodeMirrorAdapter ??= vimAdapter();
  if (!g.CodeMirror) {
    // CodeMirror 5 is gone; some plugins still register legacy modes at load time. Accept and ignore them.
    const noop = () => undefined;
    const CM: any = function CodeMirror() { return {}; };
    Object.assign(CM, { defineMode: noop, defineMIME: noop, defineExtension: noop, defineOption: noop, defineInitHook: noop, registerHelper: noop, registerGlobalHelper: noop, modes: {}, mimeModes: {}, commands: {}, keyMap: {}, helpers: {}, getMode: () => ({ token: (stream: { skipToEnd(): void }) => { stream.skipToEnd(); return null; }, startState: () => ({}) }), resolveMode: (m: unknown) => m, startState: () => ({}), innerMode: (m: unknown, s: unknown) => ({ mode: m, state: s }), Pos: function Pos(line: number, ch: number) { return { line, ch }; }, Pass: {}, version: "5.65.0" });
    g.CodeMirror = CM;
  }
}

type UIEventLike = MouseEvent | KeyboardEvent | TouchEvent | PointerEvent;
export { ipc };
