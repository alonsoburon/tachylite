// Plugin base class, commands, hotkeys, view registry.
import { ipc } from "../ipc";
import { Component, hotkeyMatches, type Hotkey } from "./events";
import type { App } from "./app";
import type { Editor } from "./editor";
import { EditorSuggest } from "./editorSuggest";
import { MarkdownPreviewRenderer, type MarkdownPostProcessor, type MarkdownPostProcessorContext } from "./markdown";
import { MarkdownView, MediaFileView, type View, type ViewCreator } from "./views";
import type { SettingTab } from "./setting";
import { Notice } from "./ui";
import type { BasesViewRegistration } from "../bases/api";

export interface PluginManifest {
  dir?: string; id: string; name: string; author: string; version: string; minAppVersion: string;
  description: string; authorUrl?: string; fundingUrl?: string | Record<string, string>; isDesktopOnly?: boolean;
}

export interface Command {
  id: string; name: string; icon?: string; mobileOnly?: boolean; repeatable?: boolean;
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: Editor, ctx: MarkdownView | any) => any;
  editorCheckCallback?: (checking: boolean, editor: Editor, ctx: MarkdownView | any) => boolean | void;
  hotkeys?: Hotkey[];
}

export class Commands {
  commands: Record<string, Command> = {};
  editorCommands: Record<string, Command> = {};
  constructor(public app: App) {}
  addCommand(cmd: Command): void {
    if (!cmd || !cmd.id) throw new Error("Command must have an id");
    this.commands[cmd.id] = cmd;
    if (cmd.editorCallback || cmd.editorCheckCallback) this.editorCommands[cmd.id] = cmd;
    if (cmd.hotkeys?.length) this.app.hotkeyManager.setDefaultHotkeys(cmd.id, cmd.hotkeys);
  }
  removeCommand(id: string): void {
    delete this.commands[id];
    delete this.editorCommands[id];
    this.app.hotkeyManager.removeDefaultHotkeys(id);
  }
  findCommand(id: string): Command | undefined { return this.commands[id]; }
  listCommands(): Command[] { return Object.values(this.commands); }
  private activeMarkdown(): MarkdownView | null { return this.app.workspace.getActiveViewOfType(MarkdownView); }
  /** True when the command could run right now (what the command palette filters on). */
  canExecute(cmd: Command): boolean {
    try {
      if (cmd.mobileOnly && !this.app.isMobile) return false;
      if (cmd.checkCallback) return !!cmd.checkCallback(true);
      if (cmd.editorCheckCallback || cmd.editorCallback) {
        const v = this.activeMarkdown();
        if (!v) return false;
        return cmd.editorCheckCallback ? !!cmd.editorCheckCallback(true, v.editor, v) : true;
      }
      return !!cmd.callback;
    } catch (e) { console.error(e); return false; }
  }
  executeCommand(cmd: Command): boolean {
    try {
      if (cmd.checkCallback) return cmd.checkCallback(false) !== false;
      if (cmd.callback) { cmd.callback(); return true; }
      if (cmd.editorCheckCallback || cmd.editorCallback) {
        const v = this.activeMarkdown();
        if (!v) return false;
        if (cmd.editorCheckCallback) return cmd.editorCheckCallback(false, v.editor, v) !== false;
        cmd.editorCallback!(v.editor, v);
        return true;
      }
    } catch (e) {
      console.error(`Command "${cmd.id}" failed`, e);
      new Notice(`Command "${cmd.name}" failed: ${(e as Error).message ?? e}`);
    }
    return false;
  }
  executeCommandById(id: string): boolean {
    const c = this.commands[id];
    return c ? this.executeCommand(c) : false;
  }
}

export class HotkeyManager {
  defaultKeys: Record<string, Hotkey[]> = {};
  customKeys: Record<string, Hotkey[]> = {};
  constructor(public app: App) {}
  async load(): Promise<void> {
    try {
      const v = await ipc.configRead("hotkeys.json");
      // hotkeys.json is user-editable: keep only well-formed `command id -> [{ modifiers, key }]` entries.
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const ok = (h: any) => h && typeof h.key === "string" && Array.isArray(h.modifiers) && h.modifiers.every((m: unknown) => typeof m === "string");
        this.customKeys = Object.fromEntries(Object.entries(v).filter(([, keys]) => Array.isArray(keys) && keys.every(ok))) as Record<string, Hotkey[]>;
      }
    } catch (e) { console.warn("hotkeys.json unreadable", e); }
  }
  setDefaultHotkeys(id: string, keys: Hotkey[]): void { this.defaultKeys[id] = keys; }
  addDefaultHotkeys(id: string, keys: Hotkey[]): void { this.defaultKeys[id] = [...(this.defaultKeys[id] ?? []), ...keys]; }
  bake(): void {}
  removeDefaultHotkeys(id: string): void { delete this.defaultKeys[id]; }
  getDefaultHotkeys(id: string): Hotkey[] { return this.defaultKeys[id] ?? []; }
  getHotkeys(id: string): Hotkey[] { return this.customKeys[id] ?? this.getDefaultHotkeys(id); }
  setHotkeys(id: string, keys: Hotkey[]): void { this.customKeys[id] = keys; void ipc.configWrite("hotkeys.json", this.customKeys).catch(() => {}); }
  removeHotkeys(id: string): void { delete this.customKeys[id]; void ipc.configWrite("hotkeys.json", this.customKeys).catch(() => {}); }
  printHotkeyForCommand(id: string): string {
    const h = this.getHotkeys(id)[0];
    return h ? [...h.modifiers, h.key].join("+") : "";
  }
  /** Run the first command bound to this keyboard event. Returns true if one ran. */
  handleKeydown(evt: KeyboardEvent): boolean {
    const ids = new Set([...Object.keys(this.defaultKeys), ...Object.keys(this.customKeys)]);
    for (const id of ids) {
      const cmd = this.app.commands.commands[id];
      if (!cmd) continue;
      if (!this.getHotkeys(id).some((h) => hotkeyMatches(h, evt))) continue;
      if (!this.app.commands.canExecute(cmd)) continue;
      evt.preventDefault();
      this.app.commands.executeCommand(cmd);
      return true;
    }
    return false;
  }
}

export class ViewRegistry {
  viewByType: Record<string, ViewCreator> = {};
  typeByExtension: Record<string, string> = { md: "markdown" };
  constructor(public app: App) {
    this.viewByType["markdown"] = (leaf) => new MarkdownView(leaf);
    const media: [MediaFileView["kind"], string[]][] = [
      ["image", ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]], ["audio", ["mp3", "wav", "m4a", "ogg", "3gp", "flac", "opus"]],
      ["video", ["mp4", "webm", "ogv", "mov", "mkv"]], ["pdf", ["pdf"]],
    ];
    for (const [kind, exts] of media) {
      this.viewByType[kind] = (leaf) => new MediaFileView(leaf, kind);
      for (const e of exts) this.typeByExtension[e] = kind;
    }
    this.viewByType["file-unsupported"] = (leaf) => new MediaFileView(leaf, "unsupported");
  }
  registerView(type: string, creator: ViewCreator): void {
    if (this.viewByType[type]) throw new Error(`Attempting to register an existing view type "${type}"`);
    this.viewByType[type] = creator;
    this.app.workspace.trigger("view-registered", type);
  }
  unregisterView(type: string): void { delete this.viewByType[type]; }
  getViewCreatorByType(type: string): ViewCreator | undefined { return this.viewByType[type]; }
  registerExtensions(exts: string[], type: string): void {
    for (const e of exts) {
      if (this.typeByExtension[e]) throw new Error(`Attempting to register an existing file extension "${e}"`);
      this.typeByExtension[e] = type;
    }
  }
  unregisterExtensions(exts: string[]): void { for (const e of exts) delete this.typeByExtension[e]; }
  isExtensionRegistered(ext: string): boolean { return !!this.typeByExtension[ext]; }
  getTypeByExtension(ext: string): string | undefined { return this.typeByExtension[ext.toLowerCase()] ?? this.typeByExtension[ext]; }
}

export abstract class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  settings?: unknown;
  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }
  onload(): Promise<void> | void {}
  private get dir(): string { return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`; }

  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const ribbon = this.app.workspace.leftRibbon;
    const el = ribbon.addRibbonItemButton(`${this.manifest.id}:${title}`, icon, title, callback);
    this.register(() => ribbon.removeRibbonItemButton(el));
    this._ui.push(el);
    return el;
  }
  addStatusBarItem(): HTMLElement {
    const el = this.app.statusBarEl.createDiv({ cls: "status-bar-item plugin-" + this.manifest.id });
    this.register(() => el.detach());
    this._ui.push(el);
    return el;
  }
  addCommand(command: Command): Command {
    const id = `${this.manifest.id}:${command.id}`;
    command.id = id;
    command.name = `${this.manifest.name}: ${command.name}`;
    this.app.commands.addCommand(command);
    this.register(() => this.app.commands.removeCommand(id));
    return command;
  }
  removeCommand(commandId: string): void { this.app.commands.removeCommand(`${this.manifest.id}:${commandId}`); }
  addSettingTab(tab: SettingTab): void {
    if (!tab.id) tab.id = this.manifest.id;
    if (!tab.name) tab.name = this.manifest.name;
    this.app.setting.addSettingTab(tab);
    this.register(() => this.app.setting.removeSettingTab(tab));
  }
  registerView(type: string, viewCreator: ViewCreator): void {
    const reg = this.app.viewRegistry;
    reg.registerView(type, viewCreator);
    this.register(() => {
      reg.unregisterView(type);
      this.app.workspace.deferLeavesOfType(type);
    });
    this.app.workspace.reviveDeferred(type);
  }
  registerHoverLinkSource(id: string, info: { display: string; defaultMod: boolean }): void {
    this.app.workspace.registerHoverLinkSource(id, info);
    this.register(() => this.app.workspace.unregisterHoverLinkSource(id));
  }
  registerExtensions(extensions: string[], viewType: string): void {
    this.app.viewRegistry.registerExtensions(extensions, viewType);
    this.register(() => this.app.viewRegistry.unregisterExtensions(extensions));
  }
  registerMarkdownPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number): MarkdownPostProcessor {
    MarkdownPreviewRenderer.registerPostProcessor(postProcessor, sortOrder);
    this.register(() => MarkdownPreviewRenderer.unregisterPostProcessor(postProcessor));
    return postProcessor;
  }
  registerMarkdownCodeBlockProcessor(language: string, handler: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void, sortOrder?: number): MarkdownPostProcessor {
    const pp = MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler) as MarkdownPostProcessor;
    return this.registerMarkdownPostProcessor(pp, sortOrder);
  }
  registerBasesView(viewId: string, registration: BasesViewRegistration): boolean {
    if (this.app.basesViews[viewId]) return false;
    this.app.basesViews[viewId] = registration;
    this.register(() => delete this.app.basesViews[viewId]);
    return true;
  }
  registerEditorExtension(extension: any): void {
    const exts = this.app.workspace.editorExtensions;
    exts.push(extension);
    this.app.workspace.updateOptions();
    this.register(() => {
      const i = exts.indexOf(extension);
      if (i >= 0) exts.splice(i, 1);
      this.app.workspace.updateOptions();
    });
  }
  registerObsidianProtocolHandler(action: string, handler: (params: any) => any): void {
    this.app.protocolHandlers.set(action, handler);
    this.register(() => this.app.protocolHandlers.delete(action));
  }
  registerEditorSuggest(editorSuggest: EditorSuggest<any>): void {
    const m = this.app.workspace.editorSuggestManager!;
    m.add(editorSuggest);
    this.register(() => m.remove(editorSuggest));
  }
  registerCliHandler(command: string, description: string, flags: unknown, handler: (p: any) => any): void {
    this.app.cliHandlers[command] = { description, flags, handler };
    this.register(() => delete this.app.cliHandlers[command]);
  }
  async loadData(): Promise<any> {
    const path = `${this.dir}/data.json`;
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      const text = await this.app.vault.adapter.read(path);
      return text.trim() ? JSON.parse(text) : null;
    } catch (e) {
      console.error(`${this.manifest.id}: loadData failed`, e);
      return null;
    }
  }
  async saveData(data: any): Promise<void> {
    const path = `${this.dir}/data.json`;
    const json = JSON.stringify(data, null, 2);
    this.lastSaved = json;
    await this.app.vault.adapter.write(path, json);
  }
  /** Internal: things this plugin put into the UI, so unloading can sweep stragglers (e.g. re-added during onunload). */
  _ui: HTMLElement[] = [];
  /** Remove commands, settings tabs and UI elements that survived the plugin's own cleanup. */
  _sweep(): void {
    const id = this.manifest.id;
    for (const cid of Object.keys(this.app.commands.commands)) if (cid.startsWith(id + ":")) this.app.commands.removeCommand(cid);
    for (const t of this.app.setting.pluginTabs.slice()) if (t.id === id || (t as any).plugin === this) this.app.setting.removeSettingTab(t);
    for (const el of this._ui.splice(0)) {
      const rib = this.app.workspace.leftRibbon.items.find((i) => i.buttonEl === el);
      if (rib) this.app.workspace.leftRibbon.removeRibbonItemButton(el); else el.detach();
    }
  }
  /** Internal: used to ignore the watcher echo of our own writes. */
  lastSaved: string | null = null;
  onUserEnable(): void {}
  onExternalSettingsChange?(): any;
}
export type { View };
