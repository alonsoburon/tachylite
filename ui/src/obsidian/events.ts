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
const isMac = /Mac|iPhone|iPad/i.test(plat) || /Mac OS X/.test(ua);
const isWin = /Win/i.test(plat) || /Windows/.test(ua);
const isLinux = !isMac && !isWin && (/Linux|X11/i.test(plat) || /Linux|X11/.test(ua) || true);

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: isMac,
  isWin,
  isLinux: isLinux && !isMac && !isWin,
  isSafari: /Safari/.test(ua) && !/Chrome|Chromium/.test(ua),
  resourcePathPrefix: "app://local/",
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
    const key = normalizeKey(evt.key ?? "");
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
  return normMods(h.modifiers) === eventModifiers(evt) && normalizeKey(h.key) === normalizeKey(evt.key ?? "");
}
export function hotkeyToString(h: Hotkey): string {
  return [...h.modifiers, h.key].join("+");
}
