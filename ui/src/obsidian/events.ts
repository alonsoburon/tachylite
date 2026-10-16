// Events, Component, Scope/Keymap, Platform.

export interface EventRef { e: Events; name: string; fn: (...a: any[]) => any; ctx?: any }

export class Events {
  _: Record<string, EventRef[]> = {};
  on(name: string, callback: (...data: any[]) => any, ctx?: any): EventRef {
    const ref: EventRef = { e: this, name, fn: callback, ctx };
    (this._[name] ??= []).push(ref);
    return ref;
  }
  off(name: string, callback: (...data: any[]) => any): void {
    const l = this._[name];
    if (!l) return;
    this._[name] = l.filter((r) => r.fn !== callback);
    if (!this._[name].length) delete this._[name];
  }
  offref(ref: EventRef): void {
    if (!ref) return;
    const l = this._[ref.name];
    if (!l) return;
    const i = l.indexOf(ref);
    if (i >= 0) l.splice(i, 1);
    if (!l.length) delete this._[ref.name];
  }
  trigger(name: string, ...data: any[]): void {
    const l = this._[name];
    if (!l) return;
    for (const ref of l.slice()) this.tryTrigger(ref, data);
  }
  tryTrigger(ref: EventRef, args: any[]): void {
    try {
      ref.fn.apply(ref.ctx, args);
    } catch (e) {
      // Obsidian reports handler errors without breaking the emitter.
      console.error(e);
    }
  }
}

export class Component {
  _loaded = false;
  _children: Component[] = [];
  _events: (() => any)[] = [];

  /** Like Obsidian: returns a promise when onload (or a child's load) is asynchronous. */
  load(): void | Promise<void> {
    if (this._loaded) return;
    this._loaded = true;
    const pending: Promise<unknown>[] = [];
    const r = this.onload();
    if (r) pending.push(r);
    for (const c of this._children.slice()) { const p = c.load(); if (p) pending.push(p); }
    return pending.length ? Promise.all(pending).then(() => {}) : undefined;
  }
  async loadAsync(): Promise<void> { await this.load(); }
  onload(): void | Promise<void> {}
  unload(): void {
    if (!this._loaded) return;
    this._loaded = false;
    // Same order as Obsidian: children (last first), registered callbacks (last first), then onunload.
    const kids = this._children, evs = this._events;
    while (kids.length) { try { kids.pop()!.unload(); } catch (e) { console.error(e); } }
    while (evs.length) { try { evs.pop()!(); } catch (e) { console.error(e); } }
    try { this.onunload(); } catch (e) { console.error(e); }
  }
  onunload(): void {}
  addChild<T extends Component>(component: T): T {
    this._children.push(component);
    if (this._loaded) component.load();
    return component;
  }
  removeChild<T extends Component>(component: T): T {
    const i = this._children.indexOf(component);
    if (i >= 0) { this._children.splice(i, 1); component.unload(); }
    return component;
  }
  register(cb: () => any): void { this._events.push(cb); }
  registerEvent(ref: EventRef): void { this.register(() => ref.e.offref(ref)); }
  registerDomEvent(el: any, type: string, callback: (ev: any) => any, options?: boolean | AddEventListenerOptions): void {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }
  registerInterval(id: number): number {
    this.register(() => clearInterval(id));
    return id;
  }
}

// ---------------------------------------------------------------- Platform

const nav: any = typeof navigator !== "undefined" ? navigator : { userAgent: "", platform: "" };
const ua: string = String(nav.userAgent ?? "");
const plat: string = String(nav.platform ?? "");
/** The OS: the desktop shell injects `__TACHYLITE_OS__` before any script runs; the user agent is the fallback. */
export function detectOS(hint: unknown = (globalThis as any).__TACHYLITE_OS__, agent = ua, platform = plat): "macos" | "windows" | "linux" {
  if (hint === "macos" || hint === "windows" || hint === "linux") return hint;
  if (/Mac|iPhone|iPad/i.test(platform) || /Mac OS X|Macintosh/.test(agent)) return "macos";
  if (/Win/i.test(platform) || /Windows/.test(agent)) return "windows";
  return "linux";
}
const os = detectOS();

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: os === "macos",
  isWin: os === "windows",
  isLinux: os === "linux",
  isSafari: /Safari/.test(ua) && !/Chrome|Chromium/.test(ua),
  /** What `getResourcePath` URLs start with (Tauri's asset protocol: `asset://localhost/`, `http://asset.localhost/` on Windows). */
  get resourcePathPrefix(): string {
    const conv = (globalThis as any).__TAURI__?.core?.convertFileSrc ?? (globalThis as any).__TAURI_INTERNALS__?.convertFileSrc;
    return conv ? conv("") : os === "windows" ? "http://asset.localhost/" : "asset://localhost/";
  },
};

// ---------------------------------------------------------------- Scope & Keymap

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";
export interface KeymapInfo { modifiers: string | null; key: string | null }
export interface KeymapContext extends KeymapInfo { vkey: string }
export interface KeymapEventHandler extends KeymapInfo { scope: Scope; func: KeymapEventListener }
export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapContext) => false | any;

function normMods(mods: readonly string[] | string | null | undefined): string {
  const list = typeof mods === "string" ? mods.split(",") : mods ?? [];
  const out = new Set<string>();
  for (const m of list) {
    const t = m.trim();
    if (!t) continue;
    out.add(t === "Mod" ? (Platform.isMacOS ? "Meta" : "Ctrl") : t === "Cmd" ? "Meta" : t === "Control" ? "Ctrl" : t);
  }
  return [...out].sort().join(",");
}
export function eventModifiers(evt: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }): string {
  const m: string[] = [];
  if (evt.altKey) m.push("Alt");
  if (evt.ctrlKey) m.push("Ctrl");
  if (evt.metaKey) m.push("Meta");
  if (evt.shiftKey) m.push("Shift");
  return m.sort().join(",");
}
/**
 * `evt.key`, or a name derived from `evt.code` when the key is not usable for a shortcut: the engine reports
 * "Unidentified" (WebKitGTK does for Shift+Tab, an ISO_Left_Tab) or a non-Latin layout types a letter such as "з"
 * on the physical P key, so Ctrl+P must still match.
 */
export function eventKey(evt: { key?: string; code?: string }): string {
  const k = evt.key ?? "";
  if (k && k !== "Unidentified" && !(k.length === 1 && /\p{L}/u.test(k) && !/\p{Script=Latin}/u.test(k))) return k;
  const c = evt.code ?? "";
  if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(c)) return c.slice(5);
  return c || k;
}
export function normalizeKey(key: string): string {
  const k = key === " " ? "Space" : key;
  return k.length === 1 ? k.toUpperCase() : k.toLowerCase();
}

export class Scope {
  parent: Scope | undefined;
  /** Registered handlers (named `keys` in Obsidian; plugins read and edit it). */
  keys: KeymapEventHandler[] = [];
  tabFocusContainerEl: HTMLElement | null = null;
  constructor(parent?: Scope) { this.parent = parent; }
  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
    const h: KeymapEventHandler = { scope: this, modifiers: modifiers === null ? null : normMods(modifiers), key, func };
    this.keys.push(h);
    return h;
  }
  unregister(handler: KeymapEventHandler): void {
    const i = this.keys.indexOf(handler);
    if (i >= 0) this.keys.splice(i, 1);
  }
  /** Returns true if some handler returned false (event consumed). */
  handleKey(evt: KeyboardEvent): boolean {
    const mods = eventModifiers(evt);
    const key = normalizeKey(eventKey(evt));
    for (const h of this.keys.slice()) {
      if (h.modifiers !== null && h.modifiers !== mods) continue;
      if (h.key !== null && normalizeKey(h.key) !== key) continue;
      const r = h.func(evt, { modifiers: mods, key: evt.key, vkey: evt.key });
      if (r === false) { evt.preventDefault(); return true; }
    }
    return false;
  }
}

export class Keymap {
  modifiers = "";
  prevScopes: Scope[] = [];
  rootScope: Scope;
  constructor(root = new Scope()) { this.rootScope = root; this.prevScopes = [root]; }
  get scope(): Scope { return this.prevScopes[this.prevScopes.length - 1]; }
  /** The app-wide scope at the bottom of the stack (internal API read by plugins, e.g. Excalidraw). */
  getRootScope(): Scope { return this.rootScope; }
  pushScope(scope: Scope): void { this.prevScopes.push(scope); }
  popScope(scope: Scope): void {
    const i = this.prevScopes.lastIndexOf(scope);
    if (i > 0) this.prevScopes.splice(i, 1);
  }
  /** Dispatch a keyboard event through the scope stack (top scope first, then its parents). */
  handleEvent(evt: KeyboardEvent): boolean {
    this.modifiers = eventModifiers(evt);
    for (let s: Scope | undefined = this.scope; s; s = s.parent) if (s.handleKey(evt)) return true;
    return false;
  }
  static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    const e = evt as KeyboardEvent;
    switch (modifier) {
      case "Mod": return Platform.isMacOS ? e.metaKey : e.ctrlKey;
      case "Ctrl": return !!e.ctrlKey;
      case "Meta": return !!e.metaKey;
      case "Shift": return !!e.shiftKey;
      case "Alt": return !!e.altKey;
    }
  }
  static isModEvent(evt?: MouseEvent | KeyboardEvent | TouchEvent | PointerEvent | null): "tab" | "split" | "window" | boolean {
    if (!evt) return false;
    const mod = Keymap.isModifier(evt, "Mod") || (evt as MouseEvent).button === 1;
    if (!mod) return false;
    const alt = Keymap.isModifier(evt, "Alt"), shift = Keymap.isModifier(evt, "Shift");
    if (alt && shift) return "window";
    if (alt) return "split";
    return "tab";
  }
}

/** Parse the "Mod+Shift+K" style used in UIs into a Hotkey. */
export interface Hotkey { modifiers: Modifier[]; key: string }
export function hotkeyMatches(h: Hotkey, evt: KeyboardEvent): boolean {
  return normMods(h.modifiers) === eventModifiers(evt) && normalizeKey(h.key) === normalizeKey(eventKey(evt));
}
export function hotkeyToString(h: Hotkey): string {
  return [...h.modifiers, h.key].join("+");
}

/** "Mod+Shift+K" as shown in the UI: Ctrl/Cmd, Alt/Opt and readable key names. */
const KEY_NAMES: Record<string, string> = {
  " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Escape: "Esc", Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Tab: "Tab",
};

export function prettyHotkey(h: Hotkey): string {
  const mods = h.modifiers.map((m) => {
    switch (m) {
      case "Mod": return Platform.isMacOS ? "Cmd" : "Ctrl";
      case "Meta": return Platform.isMacOS ? "Cmd" : Platform.isWin ? "Win" : "Super";
      case "Alt": return Platform.isMacOS ? "Opt" : "Alt";
      default: return m;
    }
  });
  const k = KEY_NAMES[h.key] ?? (h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return [...mods, k].join("+");
}

