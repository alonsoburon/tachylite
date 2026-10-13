// Popout windows. The main webview opens `about:blank` with window.open; the Rust side answers with a new OS
// window whose webview is related to ours (crates/tachylite-app/src/popout.rs), so we get a same-origin
// WindowProxy and build the popout's DOM from this realm, as Electron popouts do: one `app`, one set of plugins,
// views moved (not re-created) between documents. This module owns the popout documents: skeleton, mirrored
// stylesheets and body classes, per-window input handlers, titles, geometry and closing.
import { ipc, listen } from "../ipc";
import { installDomHelpersIn, registerAppWindow, setActiveWindow, unregisterAppWindow } from "../obsidian/dom";
import type { App, WorkspaceLeaf, WorkspaceWindow, WorkspaceWindowInitData } from "../obsidian";

/** Opens the OS window for a popout URL. Tests substitute one returning a second DOM window. */
export type PopoutOpener = (url: string, name: string) => Window | null;
const defaultOpener: PopoutOpener = (url, name) => window.open(url, name);
let opener: PopoutOpener = defaultOpener;
export function setPopoutOpener(fn: PopoutOpener | null): void { opener = fn ?? defaultOpener; }

/** What the shell does for every window it renders into (keymap, focus tracking, ...); returns a cleanup. */
export interface PopoutHost { installWindowHandlers(win: Window): () => void; flush(): void; decorate(): void }

interface Popout { ws: WorkspaceWindow; win: Window; label: string; cleanups: (() => void)[] }

const MIRROR = "data-tachylite-mirror";

export class Popouts {
  private open_ = new Map<string, Popout>();
  private unlisten: Promise<() => void>[] = [];
  private cleanups: (() => void)[] = [];
  private titleTimer = false;
  /** The window that last had the OS focus (`activeWindow` follows the active leaf, this follows the OS). */
  focused: Window = window;

  constructor(private app: App, private host: PopoutHost) {
    const find = (label: unknown) => (typeof label === "string" ? this.open_.get(label) : undefined);
    // The OS window's close button: close its leaves (saving them) like Obsidian, then destroy the window.
    this.unlisten.push(listen("popout-close-requested", (label) => { find(label)?.ws.close(); }));
    this.unlisten.push(listen("popout-destroyed", (label) => { const p = find(label); if (p && !p.ws.isClosing) p.ws.close(); }));
    this.unlisten.push(listen("popout-focus", (label) => { const p = find(label); if (p) this.onFocus(p.win); }));
    this.unlisten.push(listen("popout-geometry", (g: { label: string; x: number; y: number; width: number; height: number; maximize: boolean }) => {
      const p = find(g?.label);
      if (!p) return;
      if (!g.maximize) p.ws.geometry = { x: g.x, y: g.y, width: g.width, height: g.height };
      p.ws.maximize = !!g.maximize;
      this.app.workspace.requestSaveLayout();
    }));
    const ws = this.app.workspace;
    const refs = [ws.on("layout-change", () => this.scheduleTitles()), ws.on("active-leaf-change", () => this.scheduleTitles()), ws.on("file-open", () => this.scheduleTitles())];
    this.cleanups.push(() => { for (const r of refs) ws.offref(r); });
    const focusMain = () => this.onFocus(window);
    window.addEventListener("focus", focusMain);
    this.cleanups.push(() => window.removeEventListener("focus", focusMain));
  }

  get windows(): Window[] { return [...this.open_.values()].map((p) => p.win); }
  labelOf(ws: WorkspaceWindow): string | null { for (const [l, p] of this.open_) if (p.ws === ws) return l; return null; }

  /** Open the OS window of `ws` and mount it. Throws when the window could not be opened. */
  open(ws: WorkspaceWindow, data?: WorkspaceWindowInitData): Window {
    const label = `popout-${ws.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
    const g = ws.geometry;
    const q = new URLSearchParams({ label });
    for (const k of ["x", "y", "width", "height"] as const) if (typeof g[k] === "number") q.set(k, String(Math.round(g[k]!)));
    if (ws.maximize || data?.maximize) q.set("maximize", "1");
    const win = opener(`about:blank#tachylite-popout?${q.toString()}`, label);
    if (!win) throw new Error("Unable to open a new window.");
    const p: Popout = { ws, win, label, cleanups: [] };
    this.open_.set(label, p);
    registerAppWindow(win);
    this.focused = win; // a new OS window takes the focus
    this.build(p);
    void ipc.popoutGeometry(label).then((geo) => { if (geo && !ws.geometry.width) ws.geometry = { x: geo.x, y: geo.y, width: geo.width, height: geo.height }; }).catch(() => {});
    return win;
  }

  /** The model closed `ws` (its leaves are gone): drop the document's hooks and destroy the OS window. */
  close(ws: WorkspaceWindow): void {
    const label = this.labelOf(ws);
    const p = label ? this.open_.get(label) : undefined;
    if (!p) return;
    this.open_.delete(p.label);
    for (const c of p.cleanups.splice(0)) { try { c(); } catch (e) { console.error(e); } }
    unregisterAppWindow(p.win);
    if ((globalThis as any).activeWindow === p.win) setActiveWindow(window);
    if (this.focused === p.win) this.focused = window;
    void ipc.popoutClose(p.label).catch(() => { try { p.win.close(); } catch { /* already gone */ } });
  }

  focus(ws: WorkspaceWindow | null): void {
    const label = ws ? this.labelOf(ws) : "main";
    if (!label) return;
    this.focused = ws ? ws.win : window;
    void ipc.popoutFocus(label).catch(() => {});
  }

  dispose(): void {
    for (const c of this.cleanups.splice(0)) c();
    for (const u of this.unlisten.splice(0)) void u.then((f) => f());
    for (const p of [...this.open_.values()]) { for (const c of p.cleanups.splice(0)) c(); unregisterAppWindow(p.win); }
    this.open_.clear();
  }

  // ---------------------------------------------------------------- document
  private build(p: Popout): void {
    const { win, ws } = p;
    const doc = win.document;
    installDomHelpersIn(win);
    // Same skeleton as the main window, minus ribbons and status bar.
    doc.documentElement.lang = document.documentElement.lang;
    doc.title = "Tachylite";
    const appEl = createDiv({ cls: "app-container" });
    const workspaceEl = appEl.createDiv({ cls: "horizontal-main-container" }).createDiv({ cls: "workspace mod-popout" });
    doc.body.replaceChildren(appEl);
    workspaceEl.appendChild(ws.containerEl);
    p.cleanups.push(this.mirrorStyles(doc));
    p.cleanups.push(this.host.installWindowHandlers(win));
    const onFocus = () => this.onFocus(win);
    const onBlur = () => this.host.flush();
    // The OS window went away without asking (crash, external close): treat it like closing it.
    const onGone = () => { if (this.open_.get(p.label) === p && !ws.isClosing) ws.close(); };
    const onResize = () => { for (const l of ws.leaves()) l.onResize(); };
    win.addEventListener("focus", onFocus);
    win.addEventListener("blur", onBlur);
    win.addEventListener("pagehide", onGone);
    win.addEventListener("resize", onResize);
    p.cleanups.push(() => {
      win.removeEventListener("focus", onFocus);
      win.removeEventListener("blur", onBlur);
      win.removeEventListener("pagehide", onGone);
      win.removeEventListener("resize", onResize);
    });
    this.scheduleTitles();
  }

  /** Keep the popout's stylesheets, `<html>`/`<body>` classes and inline CSS variables in step with the main window. */
  private mirrorStyles(doc: Document): () => void {
    const clones = new Map<Element, { clone: Element; sig: string }>();
    const sigOf = (el: Element) => el.tagName === "LINK" ? `L|${(el as HTMLLinkElement).href}|${el.getAttribute("media") ?? ""}` : `S|${el.getAttribute("media") ?? ""}|${el.textContent ?? ""}`;
    const syncSheets = () => {
      const src = [...document.querySelectorAll("head > style, head > link[rel~='stylesheet'], body > style")];
      const live = new Set(src);
      for (const [el, c] of clones) if (!live.has(el)) { c.clone.remove(); clones.delete(el); }
      let prev: Element | null = null;
      for (const el of src) {
        const sig = sigOf(el);
        let c = clones.get(el);
        if (!c || c.sig !== sig) {
          c?.clone.remove();
          const clone = doc.createElement(el.tagName === "LINK" ? "link" : "style");
          for (const a of [...el.attributes]) clone.setAttribute(a.name, a.value);
          if (el.tagName === "LINK") clone.setAttribute("href", (el as HTMLLinkElement).href); // absolute: about:blank has no base of its own
          else clone.textContent = el.textContent;
          clone.setAttribute(MIRROR, "");
          c = { clone, sig };
          clones.set(el, c);
        }
        // Only move nodes that are out of order: re-inserting a stylesheet makes the engine re-parse it.
        const want: ChildNode | null = prev ? prev.nextSibling : doc.head.firstChild;
        if (c.clone !== want || c.clone.parentNode !== doc.head) doc.head.insertBefore(c.clone, want);
        prev = c.clone;
      }
    };
    const syncAttrs = () => {
      for (const [from, to] of [[document.documentElement, doc.documentElement], [document.body, doc.body]] as const) {
        const style = from.getAttribute("style");
        if (style === null) to.removeAttribute("style"); else if (to.getAttribute("style") !== style) to.setAttribute("style", style);
        const cls = from.className + (to === doc.body ? " is-popout-window" : "");
        if (to.className !== cls) to.className = cls;
      }
    };
    let pending = false;
    const schedule = () => {
      if (pending) return;
      pending = true;
      queueMicrotask(() => { pending = false; try { syncSheets(); syncAttrs(); } catch (e) { console.error("popout style sync failed", e); } });
    };
    syncSheets();
    syncAttrs();
    const heads = new MutationObserver(schedule);
    heads.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    heads.observe(document.body, { childList: true });
    const attrs = new MutationObserver(schedule);
    attrs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    attrs.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    const ref = this.app.workspace.on("css-change", schedule);
    return () => { heads.disconnect(); attrs.disconnect(); this.app.workspace.offref(ref); for (const c of clones.values()) c.clone.remove(); };
  }

  /** A window got the OS focus: point `activeWindow` at it and make its most recent leaf the active one. */
  private onFocus(win: Window): void {
    this.focused = win;
    setActiveWindow(win);
    const ws = this.app.workspace;
    const container = win === window ? ws.rootSplit : [...this.open_.values()].find((p) => p.win === win)?.ws;
    if (!container || !ws.activeLeaf || ws.activeLeaf.getContainer() === container) return;
    if (win === window && ws.activeLeaf.getRoot() !== ws.activeLeaf.getContainer()) return; // a sidebar leaf is in the main window
    const leaf = ws.getMostRecentLeaf(container) ?? (container.leaves()[0] as WorkspaceLeaf | undefined);
    if (leaf) ws.setActiveLeaf(leaf);
  }

  private scheduleTitles(): void {
    if (this.titleTimer) return;
    this.titleTimer = true;
    queueMicrotask(() => { this.titleTimer = false; this.updateTitles(); });
  }
  /** The OS title of a popout follows its most recent leaf, like the main window's. */
  private updateTitles(): void {
    const ws = this.app.workspace;
    for (const p of this.open_.values()) {
      const leaf = ws.activeLeaf?.getContainer() === p.ws ? ws.activeLeaf : ws.getMostRecentLeaf(p.ws) ?? p.ws.leaves()[0];
      const t = leaf?.getDisplayText();
      const title = t ? `${t} - ${this.app.vault.getName()} - Tachylite` : `${this.app.vault.getName()} - Tachylite`;
      if (p.win.document.title !== title) p.win.document.title = title;
    }
  }
}
