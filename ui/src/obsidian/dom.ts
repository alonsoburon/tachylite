// Global DOM helpers that obsidian.d.ts declares as globals (plugins use them without importing).
import type {} from "obsidian"; // pulls in the global augmentations for typing only

const SVG_NS = "http://www.w3.org/2000/svg";
const INSTALLED = Symbol.for("tachylite.dom-helpers");

type Info = {
  cls?: string | string[]; text?: string | DocumentFragment; attr?: Record<string, string | number | boolean | null>;
  title?: string; parent?: Node; value?: string; type?: string; prepend?: boolean; placeholder?: string; href?: string;
};

function def(target: object, name: string, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(target, name) && (target as any)[name] === value) return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}
function getter(target: object, name: string, get: (this: any) => unknown): void {
  Object.defineProperty(target, name, { get, configurable: true, enumerable: false });
}

function applyAttrs(el: Element, attr?: Record<string, string | number | boolean | null>): void {
  if (!attr) return;
  for (const k of Object.keys(attr)) {
    const v = attr[k];
    if (v === null || v === undefined) el.removeAttribute(k);
    else el.setAttribute(k, String(v));
  }
}
function applyCls(el: Element, cls?: string | string[]): void {
  if (!cls) return;
  const list = Array.isArray(cls) ? cls : cls.split(/\s+/);
  for (const c of list) if (c) el.classList.add(c);
}
function place(el: Node, parent: Node | undefined, prepend?: boolean): void {
  if (!parent) return;
  if (prepend) parent.insertBefore(el, parent.firstChild);
  else parent.appendChild(el);
}

export function createElIn<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, o?: Info | string, cb?: (el: HTMLElementTagNameMap[K]) => void, parentOverride?: Node): HTMLElementTagNameMap[K] {
  const info: Info = typeof o === "string" ? { cls: o } : o ?? {};
  const el = doc.createElement(tag) as HTMLElementTagNameMap[K];
  applyCls(el, info.cls);
  if (info.text !== undefined) {
    if (typeof info.text === "string") el.textContent = info.text;
    else el.appendChild(info.text);
  }
  applyAttrs(el, info.attr);
  if (info.title !== undefined) el.title = info.title;
  if (info.value !== undefined) (el as any).value = info.value;
  if (info.type !== undefined) (el as any).type = info.type;
  if (info.placeholder !== undefined) (el as any).placeholder = info.placeholder;
  if (info.href !== undefined) (el as any).href = info.href;
  place(el, parentOverride ?? info.parent, info.prepend);
  cb?.(el);
  return el;
}

export function createSvgIn<K extends keyof SVGElementTagNameMap>(doc: Document, tag: K, o?: { cls?: string | string[]; attr?: Record<string, string | number | boolean | null>; parent?: Node; prepend?: boolean } | string, cb?: (el: SVGElementTagNameMap[K]) => void, parentOverride?: Node): SVGElementTagNameMap[K] {
  const info = typeof o === "string" ? { cls: o } : o ?? {};
  const el = doc.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  applyCls(el, info.cls);
  applyAttrs(el, (info as any).attr);
  place(el, parentOverride ?? (info as any).parent, (info as any).prepend);
  cb?.(el);
  return el;
}

function docOf(n: any): Document { return n?.ownerDocument ?? (n?.nodeType === 9 ? n : document); }

/** Install all helper globals. Safe to call repeatedly. */
export function installDomHelpers(): void {
  const g = globalThis as any;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  // ---- primitives
  def(Object, "isEmpty", (o: Record<string, any>) => { for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return false; return true; });
  def(Object, "each", (o: Record<string, any>, cb: (v: any, k?: string) => boolean | void, ctx?: any) => {
    for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k) && cb.call(ctx, o[k], k) === false) return false;
    return true;
  });
  def(Array, "combine", (arrays: any[][]) => ([] as any[]).concat(...arrays));
  const AP = Array.prototype as any;
  def(AP, "first", function (this: any[]) { return this[0]; });
  def(AP, "last", function (this: any[]) { return this[this.length - 1]; });
  def(AP, "contains", function (this: any[], t: any) { return this.includes(t); });
  def(AP, "remove", function (this: any[], t: any) { for (let i = this.length - 1; i >= 0; i--) if (this[i] === t) this.splice(i, 1); });
  def(AP, "shuffle", function (this: any[]) {
    for (let i = this.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this[i], this[j]] = [this[j], this[i]]; }
    return this;
  });
  def(AP, "unique", function (this: any[]) { return Array.from(new Set(this)); });
  if (!AP.findLastIndex) def(AP, "findLastIndex", function (this: any[], p: (v: any) => boolean) { for (let i = this.length - 1; i >= 0; i--) if (p(this[i])) return i; return -1; });
  def(Math, "clamp", (v: number, min: number, max: number) => Math.min(Math.max(v, min), max));
  def(Math, "square", (v: number) => v * v);
  def(String, "isString", (o: any) => typeof o === "string" || o instanceof String);
  def(Number, "isNumber", (o: any) => typeof o === "number");
  def(String.prototype, "contains", function (this: string, t: string) { return this.includes(t); });
  def(String.prototype, "format", function (this: string, ...args: string[]) {
    return this.replace(/{(\d+)}/g, (m, i) => (typeof args[+i] !== "undefined" ? args[+i] : m));
  });

  // ---- DOM
  const N = g.Node?.prototype, E = g.Element?.prototype, H = g.HTMLElement?.prototype;
  if (!N || !E || !H) return; // no DOM (node env)

  def(N, "createEl", function (this: Node, tag: any, o?: any, cb?: any) { return createElIn(docOf(this), tag, o, cb, this); });
  def(N, "createDiv", function (this: Node, o?: any, cb?: any) { return createElIn(docOf(this), "div", o, cb, this); });
  def(N, "createSpan", function (this: Node, o?: any, cb?: any) { return createElIn(docOf(this), "span", o, cb, this); });
  def(N, "createSvg", function (this: Node, tag: any, o?: any, cb?: any) { return createSvgIn(docOf(this), tag, o, cb, this); });
  def(N, "detach", function (this: Node) { this.parentNode?.removeChild(this); });
  def(N, "empty", function (this: Node) { while (this.firstChild) this.removeChild(this.firstChild); });
  def(N, "insertAfter", function (this: Node, node: Node, child: Node | null) { this.insertBefore(node, child ? child.nextSibling : this.firstChild); return node; });
  def(N, "indexOf", function (this: Node, other: Node) { return Array.prototype.indexOf.call(this.childNodes, other); });
  def(N, "setChildrenInPlace", function (this: Node, children: Node[]) {
    let cur = this.firstChild;
    for (const c of children) {
      if (cur === c) { cur = cur.nextSibling; continue; }
      this.insertBefore(c, cur);
    }
    while (cur) { const next = cur.nextSibling; this.removeChild(cur); cur = next; }
  });
  def(N, "appendText", function (this: Node, val: string) { this.appendChild(docOf(this).createTextNode(val)); });
  def(N, "instanceOf", function (this: Node, type: any) { return this instanceof type; });
  getter(N, "doc", function (this: Node) { return docOf(this); });
  getter(N, "win", function (this: Node) { return docOf(this).defaultView ?? window; });
  getter(N, "constructorWin", function (this: Node) { return docOf(this).defaultView ?? window; });

  def(E, "getText", function (this: Element) { return this.textContent ?? ""; });
  def(E, "setText", function (this: Element, v: string | DocumentFragment) {
    if (typeof v === "string") this.textContent = v;
    else { this.textContent = ""; this.appendChild(v); }
  });
  def(E, "addClass", function (this: Element, ...c: string[]) { for (const x of c) for (const y of x.split(/\s+/)) if (y) this.classList.add(y); });
  def(E, "addClasses", function (this: Element, c: string[]) { (this as any).addClass(...c); });
  def(E, "removeClass", function (this: Element, ...c: string[]) { for (const x of c) for (const y of x.split(/\s+/)) if (y) this.classList.remove(y); });
  def(E, "removeClasses", function (this: Element, c: string[]) { (this as any).removeClass(...c); });
  def(E, "toggleClass", function (this: Element, c: string | string[], v: boolean) {
    for (const x of Array.isArray(c) ? c : [c]) for (const y of x.split(/\s+/)) if (y) this.classList.toggle(y, !!v);
  });
  def(E, "hasClass", function (this: Element, c: string) { return this.classList.contains(c); });
  def(E, "setAttr", function (this: Element, k: string, v: any) { if (v === null || v === undefined) this.removeAttribute(k); else this.setAttribute(k, String(v)); });
  def(E, "setAttrs", function (this: Element, o: Record<string, any>) { applyAttrs(this, o); });
  def(E, "getAttr", function (this: Element, k: string) { return this.getAttribute(k); });
  def(E, "matchParent", function (this: Element, selector: string, lastParent?: Element) {
    let cur: Element | null = this.parentElement;
    while (cur) {
      if (cur.matches(selector)) return cur;
      if (cur === lastParent) return null;
      cur = cur.parentElement;
    }
    return null;
  });
  def(E, "getCssPropertyValue", function (this: Element, p: string, pseudo?: string) {
    return getComputedStyle(this, pseudo).getPropertyValue(p).trim();
  });
  def(E, "isActiveElement", function (this: Element) { return docOf(this).activeElement === this; });
  def(E, "find", function (this: Element, s: string) { return this.querySelector(s); });
  def(E, "findAll", function (this: Element, s: string) { return Array.from(this.querySelectorAll(s)); });
  def(E, "findAllSelf", function (this: Element, s: string) {
    const out = Array.from(this.querySelectorAll(s));
    return this.matches(s) ? [this as Element, ...out] : out;
  });
  const DF = g.DocumentFragment?.prototype;
  if (DF) {
    def(DF, "find", function (this: DocumentFragment, s: string) { return this.querySelector(s); });
    def(DF, "findAll", function (this: DocumentFragment, s: string) { return Array.from(this.querySelectorAll(s)); });
  }

  def(H, "show", function (this: HTMLElement) { this.style.display = ""; });
  def(H, "hide", function (this: HTMLElement) { this.style.display = "none"; });
  def(H, "toggle", function (this: HTMLElement, show: boolean) { show ? (this as any).show() : (this as any).hide(); });
  def(H, "toggleVisibility", function (this: HTMLElement, v: boolean) { this.style.visibility = v ? "" : "hidden"; });
  def(H, "isShown", function (this: HTMLElement) {
    for (let n: HTMLElement | null = this; n; n = n.parentElement) if (n.style.display === "none") return false;
    if (this.offsetWidth || this.offsetHeight || this.getClientRects().length) return true;
    return this.isConnected; // layout engines without geometry (tests) fall back to connectedness
  });
  def(H, "setCssStyles", function (this: HTMLElement, s: Record<string, any>) { Object.assign(this.style, s); });
  def(H, "setCssProps", function (this: HTMLElement, p: Record<string, string>) { for (const k of Object.keys(p)) this.style.setProperty(k, p[k]); });
  getter(H, "innerWidth", function (this: HTMLElement) { return this.clientWidth; });
  getter(H, "innerHeight", function (this: HTMLElement) { return this.clientHeight; });
  const SV = g.SVGElement?.prototype;
  if (SV) {
    def(SV, "setCssStyles", function (this: SVGElement, s: Record<string, any>) { Object.assign(this.style, s); });
    def(SV, "setCssProps", function (this: SVGElement, p: Record<string, string>) { for (const k of Object.keys(p)) this.style.setProperty(k, p[k]); });
  }

  // delegated events
  function addDelegated(this: any, type: string, selector: string, listener: Function, options?: boolean | AddEventListenerOptions) {
    const self = this;
    const callback = function (evt: Event) {
      const t = evt.target as Element | null;
      if (!t || !(t as any).closest) return;
      const delegate = selector ? t.closest(selector) : t;
      if (delegate && (self === delegate || self.contains(delegate))) listener.call(delegate, evt, delegate);
    };
    (self._EVENTS ??= {});
    (self._EVENTS[type] ??= []).push({ selector, listener, options, callback });
    self.addEventListener(type, callback, options);
  }
  function removeDelegated(this: any, type: string, selector: string, listener: Function, options?: boolean | AddEventListenerOptions) {
    const list: any[] | undefined = this._EVENTS?.[type];
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.selector === selector && it.listener === listener && it.options === options) {
        this.removeEventListener(type, it.callback, options);
        list.splice(i, 1);
        return;
      }
    }
  }
  def(H, "on", addDelegated);
  def(H, "off", removeDelegated);
  // `document` may inherit from a different Document class than the global one (happy-dom), so patch its real prototype too.
  for (const dp of new Set([g.Document?.prototype, typeof document !== "undefined" ? Object.getPrototypeOf(document) : undefined])) {
    if (!dp) continue;
    def(dp, "on", addDelegated);
    def(dp, "off", removeDelegated);
  }
  def(H, "onClickEvent", function (this: HTMLElement, listener: (e: MouseEvent) => any, options?: boolean | AddEventListenerOptions) {
    this.addEventListener("click", listener as any, options);
    this.addEventListener("auxclick", ((e: MouseEvent) => { if (e.button === 1) listener.call(this, e); }) as any, options);
  });
  def(H, "onNodeInserted", function (this: HTMLElement, listener: () => any, once?: boolean) {
    const el = this;
    if (typeof MutationObserver === "undefined") return () => {};
    const obs = new MutationObserver(() => {
      if (el.isConnected) { listener(); if (once) obs.disconnect(); }
    });
    obs.observe(docOf(el).documentElement ?? docOf(el), { childList: true, subtree: true });
    return () => obs.disconnect();
  });
  def(H, "onWindowMigrated", function () { return () => {}; });
  def(H, "trigger", function (this: HTMLElement, type: string) { this.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })); });

  const UE = g.UIEvent?.prototype;
  if (UE) {
    getter(UE, "targetNode", function (this: Event) { return this.target as Node | null; });
    getter(UE, "win", function (this: Event) { return ((this.target as any)?.ownerDocument?.defaultView) ?? window; });
    getter(UE, "doc", function (this: Event) { return ((this.target as any)?.ownerDocument) ?? document; });
    def(UE, "instanceOf", function (this: Event, type: any) { return this instanceof type; });
  }

  // ---- global functions
  g.createEl = (tag: any, o?: any, cb?: any) => createElIn(document, tag, o, cb);
  g.createDiv = (o?: any, cb?: any) => createElIn(document, "div", o, cb);
  g.createSpan = (o?: any, cb?: any) => createElIn(document, "span", o, cb);
  g.createSvg = (tag: any, o?: any, cb?: any) => createSvgIn(document, tag, o, cb);
  g.createFragment = (cb?: (f: DocumentFragment) => void) => { const f = document.createDocumentFragment(); cb?.(f); return f; };
  g.isBoolean = (o: any) => typeof o === "boolean";
  g.fish = (s: string) => document.querySelector(s);
  g.fishAll = (s: string) => Array.from(document.querySelectorAll(s));
  g.sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  g.nextFrame = () => new Promise<void>((r) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));
  g.ready = (fn: () => any) => {
    if (document.readyState !== "loading") fn();
    else document.addEventListener("DOMContentLoaded", () => fn());
  };
  g.activeWindow = typeof window !== "undefined" ? window : g;
  g.activeDocument = document;
  g.ajaxPromise = ajaxPromise;
  g.ajax = ajax;
}

export interface AjaxOptions {
  method?: "GET" | "POST"; url: string; success?: (r: any, req: XMLHttpRequest) => any; error?: (e: any, req: XMLHttpRequest) => any;
  data?: object | string | ArrayBuffer; headers?: Record<string, string>; withCredentials?: boolean; req?: XMLHttpRequest;
}

export function ajax(o: AjaxOptions): void {
  const req = o.req ?? new XMLHttpRequest();
  req.open(o.method ?? "GET", o.url, true);
  req.withCredentials = !!o.withCredentials;
  let body: any = null;
  if (o.data !== undefined) {
    if (typeof o.data === "string" || o.data instanceof ArrayBuffer) body = o.data;
    else { body = JSON.stringify(o.data); req.setRequestHeader("Content-Type", "application/json"); }
  }
  for (const k of Object.keys(o.headers ?? {})) req.setRequestHeader(k, o.headers![k]);
  req.onload = () => {
    if (req.status >= 200 && req.status < 300) {
      let r: any = req.responseText;
      try { r = JSON.parse(r); } catch { /* plain text */ }
      o.success?.(r, req);
    } else o.error?.(req.responseText, req);
  };
  req.onerror = () => o.error?.(req.responseText, req);
  req.send(body);
}
export function ajaxPromise(o: AjaxOptions): Promise<any> {
  return new Promise((resolve, reject) => ajax({ ...o, success: (r) => resolve(r), error: (e, req) => reject(Object.assign(new Error(String(e) || `Request failed ${req.status}`), { status: req.status })) }));
}
