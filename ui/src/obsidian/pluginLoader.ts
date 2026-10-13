// Loads community plugins the way Obsidian does: CommonJS evaluation of main.js with an injected `require`.
import * as cmAutocomplete from "@codemirror/autocomplete";
import * as cmCollab from "@codemirror/collab";
import * as cmCommands from "@codemirror/commands";
import * as cmLangMarkdown from "@codemirror/lang-markdown";
import * as cmLanguage from "@codemirror/language";
import * as cmLint from "@codemirror/lint";
import * as cmSearch from "@codemirror/search";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import * as lezerCommon from "@lezer/common";
import * as lezerHighlight from "@lezer/highlight";
import * as lezerLr from "@lezer/lr";
import { tokenClassNodeProp } from "../editor/tokens";
import moment from "moment";
import { ipc, type PluginBundle } from "../ipc";
import type { App } from "./app";
import { Events } from "./events";
import { Plugin as PluginBase, type Plugin, type PluginManifest } from "./plugin";
import * as shims from "./shims";
import { createBridgeChildProcess, createBridgeFs, nodeBridge } from "./nodeBridge";
import { Notice } from "./ui";
import { apiVersion, requireApiVersion } from "./util";
import { Platform } from "./events";

import * as obsidianApi from "./index";

/** Token-class prop (value: space-separated CM5 class names) exposed through `@codemirror/language` like Obsidian does. */
export { tokenClassNodeProp };
export type ObsidianModule = Record<string, unknown>;
let obsidianModule: ObsidianModule | null = null;
/** Override the module handed to plugins (tests). Defaults to this package's own index. */
export function setObsidianModule(m: ObsidianModule | null): void { obsidianModule = m; }

const BUILTIN_EMPTY = ["constants", "module", "vm", "worker_threads", "readline", "net", "tls", "dns", "dgram", "http2", "cluster", "inspector", "repl", "v8", "async_hooks", "diagnostics_channel", "domain", "punycode", "tty", "zlib", "http", "https", "perf_hooks", "trace_events"];

export type RequireFn = (id: string) => any;

/** Modules whose implementation depends on the Node bridge: resolved on every require, never cached. */
const BRIDGED = new Set(["fs", "fs/promises", "child_process"]);
let bridgeFs: any = null, bridgeCp: any = null;
let warnedDisabled = false;
/** `child_process` while the bridge is off: requiring works, every call throws a clear error (and hints once per session). */
function disabledChildProcess(): any {
  return shims.unsupportedModule("child_process", Object.fromEntries(["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"].map((m) => [m, () => {
    if (!warnedDisabled) {
      warnedDisabled = true;
      new Notice("A plugin tried to run a program. To allow this, turn on \"Allow plugins to run programs and access files outside the vault\" in Settings > Community plugins.", 10000);
    }
    const e: any = new Error(`child_process.${m} is not supported: plugins are not allowed to run programs in this vault (Settings > Community plugins > "Allow plugins to run programs and access files outside the vault")`);
    e.code = "ERR_BRIDGE_DISABLED";
    throw e;
  }])));
}

/**
 * Obsidian's classes are ES5 functions, so plugins compiled to ES5 subclass them with `_super.call(this, ...)`.
 * Native ES classes throw on a plain call; this proxy turns the call into a construct with the subclass prototype,
 * which is exactly what TypeScript's `_super.call(this, ...) || this` expects.
 */
export function legacyCallable<T extends Function>(cls: T): T {
  return new Proxy(cls, {
    apply(target, thisArg, args) {
      const nt = thisArg && typeof thisArg === "object" && typeof thisArg.constructor === "function" && thisArg.constructor !== target ? thisArg.constructor : target;
      return Reflect.construct(target, args, nt);
    },
  });
}
let wrappedModule: Record<string, unknown> | null = null;
function pluginFacingObsidian(): Record<string, unknown> {
  if (obsidianModule) return obsidianModule;
  if (!wrappedModule) {
    wrappedModule = {};
    for (const k of Object.keys(obsidianApi)) {
      const v = (obsidianApi as Record<string, unknown>)[k];
      wrappedModule[k] = typeof v === "function" && /^class[\s{]/.test(Function.prototype.toString.call(v)) ? legacyCallable(v) : v;
    }
  }
  return wrappedModule;
}

export function createRequire(app: App): RequireFn {
  const cache = new Map<string, unknown>();
  const factories: Record<string, () => unknown> = {
    obsidian: () => {
      return pluginFacingObsidian();
    },
    "@codemirror/state": () => cmState,
    "@codemirror/view": () => cmView,
    "@codemirror/commands": () => cmCommands,
    // Obsidian's build of @codemirror/language also exports `tokenClassNodeProp` (CM5-style token classes per node);
    // plugins read it with `node.type.prop(...)`; the editor's markdown parser attaches the values (editor/tokens.ts).
    "@codemirror/language": () => ({ ...cmLanguage, tokenClassNodeProp }),
    "@codemirror/autocomplete": () => cmAutocomplete,
    "@codemirror/search": () => cmSearch,
    "@codemirror/lint": () => cmLint,
    "@codemirror/collab": () => cmCollab,
    "@codemirror/lang-markdown": () => cmLangMarkdown,
    "@lezer/common": () => lezerCommon,
    "@lezer/highlight": () => lezerHighlight,
    "@lezer/lr": () => lezerLr,
    moment: () => moment,
    electron: () => shims.createElectron(app),
    "@electron/remote": () => shims.createElectron(app).remote,
    path: () => shims.path,
    "path/posix": () => shims.path,
    "path/win32": () => (shims.path as any).win32 ?? shims.path,
    fs: () => (nodeBridge.active ? (bridgeFs ??= createBridgeFs()) : shims.createFs(app)),
    "fs/promises": () => (nodeBridge.active ? (bridgeFs ??= createBridgeFs()).promises : shims.createFs(app).promises),
    os: () => shims.createOs(),
    url: () => shims.createUrl(),
    querystring: () => shims.createQuerystring(),
    util: () => shims.createUtil(),
    assert: () => shims.createAssert(),
    "assert/strict": () => shims.createAssert(),
    events: () => shims.EventEmitter,
    buffer: () => ({ Buffer: shims.Buffer, kMaxLength: 2 ** 31 - 1, constants: {} }),
    crypto: () => shims.createCrypto(),
    child_process: () => (nodeBridge.active ? (bridgeCp ??= createBridgeChildProcess()) : disabledChildProcess()),
    stream: () => shims.createStream(),
    "stream/promises": () => shims.unsupportedModule("stream/promises"),
    string_decoder: () => shims.createStringDecoder(),
    timers: () => shims.createTimers(),
    "timers/promises": () => shims.createTimers().promises,
    process: () => app.pluginProcess,
  };
  const resolve = (raw: string): unknown => {
    const id = raw.startsWith("node:") ? raw.slice(5) : raw;
    if (BRIDGED.has(id)) return factories[id]();
    if (cache.has(id)) return cache.get(id);
    let mod: unknown;
    if (factories[id]) mod = factories[id]();
    else if (BUILTIN_EMPTY.includes(id)) mod = shims.unsupportedModule(id, id === "perf_hooks" ? { performance } : id === "constants" ? {} : {});
    else {
      const err: any = new Error(`Cannot find module '${raw}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    cache.set(id, mod);
    return mod;
  };
  return resolve;
}

export interface LoadedPlugin { plugin: Plugin; manifest: PluginManifest; styleEl: HTMLStyleElement | null }

/** Evaluate a CommonJS bundle. Exposed for tests and for loading plugins from non-vault sources. */
export function evaluateBundle(app: App, code: string, id: string): any {
  const module: { exports: any } = { exports: {} };
  const sourceUrl = /\/\/[#@]\s*sourceURL=/.test(code) ? "" : `\n//# sourceURL=tachylite-plugin://${id}/main.js`;
  const fn = new Function("module", "exports", "require", "process", "global", "Buffer", "__dirname", "__filename", `${code}${sourceUrl}`);
  fn.call(module.exports, module, module.exports, createRequire(app), app.pluginProcess, globalThis, shims.Buffer, `${app.vault.configDir}/plugins/${id}`, `${app.vault.configDir}/plugins/${id}/main.js`);
  return module.exports;
}

export class PluginManager extends Events {
  plugins: Record<string, Plugin> = {};
  manifests: Record<string, PluginManifest> = {};
  enabledPlugins = new Set<string>();
  loadErrors: Record<string, string> = {};
  /** Original error objects (with stacks) for diagnostics. */
  loadErrorDetails: Record<string, unknown> = {};
  loaded: Record<string, LoadedPlugin> = {};
  private loading = new Map<string, Promise<Plugin | null>>();
  constructor(public app: App) { super(); }

  getPlugin(id: string): Plugin | null { return this.plugins[id] ?? null; }
  isEnabled(id: string): boolean { return this.enabledPlugins.has(id); }
  getPluginFolder(): string { return `${this.app.vault.configDir}/plugins`; }

  async loadManifests(): Promise<void> {
    try {
      for (const [m] of await ipc.pluginsInstalled()) this.manifests[m.id] = { dir: `${this.getPluginFolder()}/${m.id}`, ...m } as unknown as PluginManifest;
    } catch (e) { console.warn("plugins_installed failed", e); }
  }

  /** Read community-plugins.json and load every enabled plugin (in order, isolated from each other). */
  /** Restricted mode (Obsidian's "Safe mode"): installed plugins are listed but none is loaded. Set by the shell before start(). */
  restrictedMode = false;
  /** Leave restricted mode and load every plugin listed in community-plugins.json. */
  async turnOnCommunityPlugins(): Promise<void> {
    this.restrictedMode = false;
    await this.initialize();
  }
  /** Enter restricted mode: unload everything (the enabled list on disk is kept). */
  async turnOffCommunityPlugins(): Promise<void> {
    this.restrictedMode = true;
    await this.unloadAll();
    this.enabledPlugins.clear();
    await nodeBridge.activate(false);
  }
  /** Unload and load every enabled plugin again (after the Node bridge was switched, so plugins see the new modules). */
  async reloadCommunityPlugins(): Promise<void> {
    await this.unloadAll();
    this.enabledPlugins.clear();
    await this.initialize();
  }

  async initialize(): Promise<void> {
    await this.loadManifests();
    if (this.restrictedMode) return;
    // Real fs / child_process for desktop plugins, only if the user allowed it for this vault (enforced in Rust too).
    await nodeBridge.activate(true);
    let ids: string[] = [];
    try {
      const v = await ipc.configRead("community-plugins.json");
      if (Array.isArray(v)) ids = v.filter((x) => typeof x === "string");
    } catch (e) { console.warn("community-plugins.json unreadable", e); }
    for (const id of ids) {
      this.enabledPlugins.add(id);
      await this.loadPlugin(id);
    }
  }

  private fail(id: string, name: string, err: unknown): null {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    this.loadErrors[id] = msg;
    this.loadErrorDetails[id] = err;
    console.error(`Failed to load plugin ${name} (${id})`, err);
    new Notice(`Failed to load plugin ${name}`);
    this.trigger("load-error", id, msg);
    return null;
  }

  /** Load (evaluate + onload) one plugin. Never throws. Resolves null on failure. */
  loadPlugin(id: string): Promise<Plugin | null> {
    const existing = this.loading.get(id);
    if (existing) return existing;
    const p = this.doLoad(id).finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  private async doLoad(id: string): Promise<Plugin | null> {
    if (this.plugins[id]) return this.plugins[id];
    delete this.loadErrors[id];
    delete this.loadErrorDetails[id];
    let bundle: PluginBundle;
    try { bundle = await ipc.pluginBundle(id); }
    catch (e) { return this.fail(id, this.manifests[id]?.name ?? id, e); }
    const manifest = { ...bundle.manifest, dir: bundle.dir } as unknown as PluginManifest;
    this.manifests[id] = manifest;
    const name = manifest.name || id;
    if (manifest.isDesktopOnly && Platform.isMobile) return this.fail(id, name, new Error("This plugin is desktop-only"));
    if (manifest.minAppVersion && !requireApiVersion(manifest.minAppVersion)) {
      return this.fail(id, name, new Error(`Requires app version ${manifest.minAppVersion} or newer (this is ${apiVersion})`));
    }
    let styleEl: HTMLStyleElement | null = null;
    let plugin: Plugin | null = null;
    try {
      const exports = evaluateBundle(this.app, bundle.mainJs, id);
      const Ctor = exports?.default ?? exports?.Plugin ?? exports;
      if (typeof Ctor !== "function") throw new Error("main.js does not export a Plugin class (module.exports.default)");
      plugin = new Ctor(this.app, manifest) as Plugin;
      if (!(plugin instanceof PluginBase)) throw new Error("The exported class does not extend Plugin");
      this.plugins[id] = plugin;
      this.loaded[id] = { plugin, manifest, styleEl: null };
      this.enabledPlugins.add(id);
      await plugin.load();
      // Same order as Obsidian: styles.css is applied after onload.
      if (bundle.stylesCss) styleEl = this.loaded[id].styleEl = this.injectStyle(id, bundle.stylesCss);
    } catch (e) {
      try { plugin?.unload(); plugin?._sweep(); } catch (e2) { console.error(e2); }
      styleEl?.remove();
      delete this.plugins[id];
      delete this.loaded[id];
      return this.fail(id, name, e);
    }
    this.trigger("loaded", id);
    return plugin;
  }

  private injectStyle(id: string, css: string): HTMLStyleElement {
    document.head.querySelectorAll(`style[data-tachylite-plugin="${CSS.escape ? CSS.escape(id) : id}"]`).forEach((e) => e.remove());
    const el = document.createElement("style");
    el.setAttribute("data-tachylite-plugin", id);
    el.textContent = css;
    document.head.appendChild(el);
    return el;
  }

  /** onunload + remove everything the plugin registered (commands, ribbon, status bar, views, events, intervals, DOM listeners). */
  async unloadPlugin(id: string): Promise<void> {
    const l = this.loaded[id];
    const plugin = this.plugins[id];
    if (!plugin) return;
    try { plugin.unload(); } catch (e) { console.error(e); }
    plugin._sweep();
    l?.styleEl?.remove();
    document.head.querySelectorAll(`style[data-tachylite-plugin="${id}"]`).forEach((e) => e.remove());
    delete this.plugins[id];
    delete this.loaded[id];
    this.trigger("unloaded", id);
  }

  async enablePlugin(id: string): Promise<boolean> {
    this.enabledPlugins.add(id);
    return !!(await this.loadPlugin(id));
  }
  async enablePluginAndSave(id: string): Promise<boolean> {
    const ok = await this.enablePlugin(id);
    await ipc.pluginSetEnabled(id, true);
    if (ok) { try { this.plugins[id]?.onUserEnable(); } catch (e) { console.error(e); } }
    return ok;
  }
  async disablePlugin(id: string): Promise<void> {
    this.enabledPlugins.delete(id);
    await this.unloadPlugin(id);
  }
  async disablePluginAndSave(id: string): Promise<void> {
    await this.disablePlugin(id);
    await ipc.pluginSetEnabled(id, false);
  }
  async uninstallPlugin(id: string): Promise<void> {
    await this.disablePlugin(id);
    await ipc.pluginUninstall(id);
    delete this.manifests[id];
  }
  async unloadAll(): Promise<void> {
    for (const id of Object.keys(this.plugins).reverse()) await this.unloadPlugin(id);
  }
  /** Forward `data.json` watcher events to plugins (onExternalSettingsChange). */
  async handleConfigChanged(path: string): Promise<void> {
    const m = /^\.[^/]+\/plugins\/([^/]+)\/data\.json$/.exec(path);
    if (!m) return;
    const plugin = this.plugins[m[1]];
    if (!plugin?.onExternalSettingsChange) return;
    try {
      const cur = await this.app.vault.adapter.read(path);
      if (cur === plugin.lastSaved) return;
      await plugin.onExternalSettingsChange();
    } catch (e) { console.error(e); }
  }
}
