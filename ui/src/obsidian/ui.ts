// Notice, Modal, Menu, tooltips and the suggestion family (PopoverSuggest, SuggestModal, ...).
import { Component, Scope, type Modifier } from "./events";
import { setIcon } from "./icons";
import { activeDoc } from "./dom";
import { prepareFuzzySearch, renderResults, sortSearchResults, type SearchResult } from "./util";
import type { App } from "./app";

// ---------------------------------------------------------------- Notice

export class Notice {
  /** The notice container of the main window (each popout gets its own, found by class). */
  static containerEl: HTMLElement | null = null;
  noticeEl: HTMLElement;
  messageEl: HTMLElement;
  containerEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(message: string | DocumentFragment, duration?: number) {
    // Notices show in the focused window.
    const doc = activeDoc();
    let c = doc === document ? Notice.containerEl : doc.body.querySelector<HTMLElement>(":scope > .notice-container");
    if (!c || !c.isConnected) {
      c = createDiv({ cls: "notice-container" });
      doc.body.appendChild(c);
      if (doc === document) Notice.containerEl = c;
    }
    this.containerEl = c;
    this.noticeEl = c.createDiv({ cls: "notice" });
    this.messageEl = this.noticeEl.createDiv({ cls: "notice-message" });
    this.setMessage(message);
    this.noticeEl.addEventListener("click", () => this.hide());
    const d = duration === undefined ? 5000 : duration;
    if (d > 0) this.timer = setTimeout(() => this.hide(), d);
  }
  setMessage(message: string | DocumentFragment): this {
    this.messageEl.empty();
    if (typeof message === "string") this.messageEl.textContent = message;
    else this.messageEl.appendChild(message);
    return this;
  }
  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.noticeEl.detach();
    if (this.containerEl.isConnected && !this.containerEl.childElementCount) this.containerEl.detach();
  }
}

// ---------------------------------------------------------------- Tooltips

export interface TooltipOptions { placement?: "bottom" | "right" | "left" | "top"; classes?: string[]; gap?: number; delay?: number }
export function setTooltip(el: HTMLElement, tooltip: string, options?: TooltipOptions): void {
  el.setAttribute("aria-label", tooltip);
  if (options?.placement) el.setAttribute("data-tooltip-position", options.placement);
  if (options?.delay !== undefined) el.setAttribute("data-tooltip-delay", String(options.delay));
  if (options?.classes?.length) el.setAttribute("aria-label-classes", options.classes.join(" "));
}
export function displayTooltip(target: HTMLElement, content: string | DocumentFragment, options?: TooltipOptions): void {
  const tip = createDiv({ cls: ["tooltip", ...(options?.classes ?? [])] });
  target.ownerDocument.body.appendChild(tip);
  tip.createDiv({ cls: "tooltip-arrow" });
  const body = tip.createDiv();
  if (typeof content === "string") body.textContent = content; else body.appendChild(content);
  const r = target.getBoundingClientRect();
  tip.style.position = "fixed";
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${options?.placement === "top" ? r.top - (options.gap ?? 4) : r.bottom + (options?.gap ?? 4)}px`;
  setTimeout(() => tip.detach(), 3000);
}

// ---------------------------------------------------------------- Modal

export class Modal {
  app: App;
  scope: Scope;
  containerEl: HTMLElement;
  bgEl: HTMLElement;
  modalEl: HTMLElement;
  closeButtonEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  shouldRestoreSelection = false;
  private isOpen = false;
  private closeCallback: (() => any) | null = null;
  private previousFocus: Element | null = null;

  constructor(app: App) {
    this.app = app;
    this.scope = new Scope(app.scope);
    this.scope.register([], "Escape", () => { this.close(); return false; });
    this.containerEl = createDiv({ cls: "modal-container mod-dim" });
    this.bgEl = this.containerEl.createDiv({ cls: "modal-bg" });
    this.modalEl = this.containerEl.createDiv({ cls: "modal" });
    this.closeButtonEl = this.modalEl.createDiv({ cls: "modal-close-button" });
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
    this.bgEl.addEventListener("click", () => this.close());
    this.closeButtonEl.addEventListener("click", () => this.close());
  }
  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    // Modals open in the focused window (a command run from a popout shows its modal there).
    const doc = activeDoc();
    this.previousFocus = doc.activeElement;
    doc.body.appendChild(this.containerEl);
    this.app.keymap.pushScope(this.scope);
    const r = this.onOpen();
    if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((e) => console.error(e));
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.app.keymap.popScope(this.scope);
    try { this.onClose(); } catch (e) { console.error(e); }
    this.containerEl.detach();
    try { (this.previousFocus as HTMLElement | null)?.focus?.(); } catch { /* ignore */ }
    const cb = this.closeCallback;
    this.closeCallback = null;
    cb?.();
  }
  onHistoryBack(): void { this.close(); }
  onOpen(): Promise<void> | void {}
  onClose(): void {}
  setTitle(title: string): this { this.titleEl.setText(title); return this; }
  setContent(content: string | DocumentFragment): this { this.contentEl.setText(content); return this; }
  setCloseCallback(cb: () => any): this { this.closeCallback = cb; return this; }
}

// ---------------------------------------------------------------- Menu

export class MenuSeparator {
  dom: HTMLElement | null = null;
  section = "";
}

export class MenuItem {
  dom: HTMLElement;
  iconEl: HTMLElement;
  titleEl: HTMLElement;
  section = "";
  disabled = false;
  checked: boolean | null = null;
  callback: ((evt: MouseEvent | KeyboardEvent) => any) | null = null;
  submenu: Menu | null = null;
  constructor(public menu: Menu) {
    this.dom = createDiv({ cls: "menu-item", attr: { tabindex: -1 } });
    this.iconEl = this.dom.createDiv({ cls: "menu-item-icon" });
    this.titleEl = this.dom.createDiv({ cls: "menu-item-title" });
    this.dom.addEventListener("click", (evt) => {
      if (this.disabled) return;
      if (this.submenu) return;
      this.callback?.(evt);
      menu.hide();
    });
  }
  setTitle(title: string | DocumentFragment): this { this.titleEl.setText(title); return this; }
  setIcon(icon: string | null): this {
    this.iconEl.empty();
    if (icon) setIcon(this.iconEl, icon);
    this.dom.toggleClass("has-icon", !!icon);
    return this;
  }
  setChecked(checked: boolean | null): this {
    this.checked = checked;
    this.dom.toggleClass("is-checked", !!checked);
    if (checked !== null) setIcon(this.iconEl, checked ? "check" : "");
    return this;
  }
  setDisabled(disabled: boolean): this { this.disabled = disabled; this.dom.toggleClass("is-disabled", disabled); return this; }
  setWarning(w: boolean): this { this.dom.toggleClass("is-warning", w); return this; }
  setIsLabel(l: boolean): this { this.dom.toggleClass("is-label", l); return this; }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => any): this { this.callback = cb; return this; }
  setSection(section: string): this { this.section = section; return this; }
  /** Undocumented but widely used: turns the item into a submenu parent. */
  setSubmenu(): Menu {
    if (this.submenu) return this.submenu;
    const sub = new Menu();
    this.submenu = sub;
    this.dom.addClass("has-submenu");
    this.dom.createDiv({ cls: "menu-item-icon mod-submenu-chevron" }, (e) => setIcon(e, "chevron-right"));
    this.dom.addEventListener("mouseenter", () => {
      const r = this.dom.getBoundingClientRect();
      sub.parentMenu = this.menu;
      sub.showAtPosition({ x: r.right, y: r.top });
    });
    return sub;
  }
}

export class Menu extends Component {
  items: (MenuItem | MenuSeparator)[] = [];
  dom: HTMLElement;
  parentMenu: Menu | null = null;
  parentEl: HTMLElement | null = null;
  scope: Scope;
  private hideCbs: (() => any)[] = [];
  private shown = false;
  private noIcon = false;
  private outside = (e: Event) => { if (!this.dom.contains(e.target as Node) && !this.isInSubmenu(e.target as Node)) this.hide(); };
  private selected = -1;
  private appKeymap: { pushScope(s: Scope): void; popScope(s: Scope): void } | null = null;

  constructor() {
    super();
    this.dom = createDiv({ cls: "menu" });
    this.scope = new Scope();
    this.scope.register([], "Escape", () => { this.hide(); return false; });
    this.scope.register([], "ArrowDown", () => { this.move(1); return false; });
    this.scope.register([], "ArrowUp", () => { this.move(-1); return false; });
    this.scope.register([], "Enter", () => { this.activate(); return false; });
  }
  private isInSubmenu(n: Node): boolean {
    return this.items.some((i) => i instanceof MenuItem && i.submenu?.dom.contains(n));
  }
  private selectable(): MenuItem[] { return this.items.filter((i): i is MenuItem => i instanceof MenuItem && !i.disabled); }
  private move(d: number): void {
    const s = this.selectable();
    if (!s.length) return;
    this.selected = (this.selected + d + s.length) % s.length;
    s.forEach((it, i) => it.dom.toggleClass("selected", i === this.selected));
  }
  private activate(): void {
    const it = this.selectable()[this.selected];
    if (it) it.dom.click();
  }

  setNoIcon(): this { this.noIcon = true; return this; }
  setUseNativeMenu(_b: boolean): this { return this; }
  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem(this);
    this.items.push(item);
    cb(item);
    return this;
  }
  addSeparator(): this { this.items.push(new MenuSeparator()); return this; }
  setParentElement(el: HTMLElement): this { this.parentEl = el; return this; }

  private render(): void {
    this.dom.empty();
    this.dom.toggleClass("no-icon", this.noIcon);
    // Group by section, keeping first-appearance order; sections are separated automatically.
    const order: string[] = [];
    const groups = new Map<string, (MenuItem | MenuSeparator)[]>();
    for (const it of this.items) {
      const s = it instanceof MenuItem ? it.section : (it as MenuSeparator).section;
      if (!groups.has(s)) { groups.set(s, []); order.push(s); }
      groups.get(s)!.push(it);
    }
    order.forEach((s, gi) => {
      if (gi > 0) this.dom.createDiv({ cls: "menu-separator" });
      for (const it of groups.get(s)!) {
        if (it instanceof MenuItem) this.dom.appendChild(it.dom);
        else { it.dom = this.dom.createDiv({ cls: "menu-separator" }); }
      }
    });
  }
  showAtMouseEvent(evt: MouseEvent): this {
    return this.showAtPosition({ x: evt.clientX ?? evt.pageX, y: evt.clientY ?? evt.pageY }, (evt.target as Node | null)?.ownerDocument ?? document);
  }
  showAtPosition(pos: { x: number; y: number; width?: number; overlap?: boolean; left?: boolean }, doc: Document = this.parentMenu?.dom.ownerDocument ?? activeDoc()): this {
    if (this.shown) this.hide();
    this.render();
    this.shown = true;
    this.load();
    (this.parentEl ?? doc.body).appendChild(this.dom);
    const dom = this.dom;
    dom.style.position = "absolute";
    const w = dom.offsetWidth || 200, h = dom.offsetHeight || 0;
    const vw = doc.defaultView?.innerWidth ?? 1024, vh = doc.defaultView?.innerHeight ?? 768;
    let x = pos.left ? pos.x - w : pos.x, y = pos.y;
    if (x + w > vw) x = Math.max(0, vw - w - 4);
    if (y + h > vh) y = Math.max(0, vh - h - 4);
    dom.style.left = `${x}px`;
    dom.style.top = `${y}px`;
    setTimeout(() => {
      if (!this.shown) return;
      doc.addEventListener("mousedown", this.outside, true);
      doc.addEventListener("contextmenu", this.outside, true);
    }, 0);
    const km = (globalThis as any).app?.keymap ?? null;
    if (km) { this.appKeymap = km; km.pushScope(this.scope); }
    return this;
  }
  onHistoryBack(): void { this.hide(); }
  hide(): this {
    if (!this.shown) return this;
    this.shown = false;
    this.dom.ownerDocument.removeEventListener("mousedown", this.outside, true);
    this.dom.ownerDocument.removeEventListener("contextmenu", this.outside, true);
    this.appKeymap?.popScope(this.scope);
    this.appKeymap = null;
    for (const i of this.items) if (i instanceof MenuItem) i.submenu?.hide();
    this.dom.detach();
    this.unload();
    const cbs = this.hideCbs.slice();
    for (const cb of cbs) { try { cb(); } catch (e) { console.error(e); } }
    return this;
  }
  close(): void { this.hide(); }
  onHide(cb: () => any): void { this.hideCbs.push(cb); }
  static forEvent(_evt: PointerEvent | MouseEvent): Menu { return new Menu(); }
}

// ---------------------------------------------------------------- Popover & suggestions

export enum PopoverState { Showing, Shown, Hiding, Hidden }

export interface ISuggestOwner<T> {
  renderSuggestion(value: T, el: HTMLElement): void;
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}

/** Renders a list of suggestions into a container and tracks the selected row. */
export class SuggestionList<T> {
  values: T[] = [];
  items: HTMLElement[] = [];
  selectedItem = -1;
  constructor(public owner: ISuggestOwner<T>, public containerEl: HTMLElement, private itemCls = "suggestion-item") {
    containerEl.addEventListener("mousedown", (e) => e.preventDefault());
  }
  setSuggestions(values: T[]): void {
    this.containerEl.empty();
    this.values = values;
    this.items = values.map((v, i) => {
      const el = this.containerEl.createDiv({ cls: this.itemCls });
      this.owner.renderSuggestion(v, el);
      el.addEventListener("click", (evt) => this.owner.selectSuggestion(v, evt));
      el.addEventListener("mousemove", () => this.setSelectedItem(i, false));
      return el;
    });
    this.selectedItem = -1;
    if (values.length) this.setSelectedItem(0, false);
  }
  setSelectedItem(i: number, scroll: boolean): void {
    if (!this.items.length) { this.selectedItem = -1; return; }
    i = ((i % this.items.length) + this.items.length) % this.items.length;
    this.items[this.selectedItem]?.classList.remove("is-selected");
    this.selectedItem = i;
    this.items[i].classList.add("is-selected");
    if (scroll) (this.items[i] as any).scrollIntoView?.({ block: "nearest" });
  }
  moveSelection(d: number): void { this.setSelectedItem(this.selectedItem + d, true); }
  useSelectedItem(evt: MouseEvent | KeyboardEvent): boolean {
    const v = this.values[this.selectedItem];
    if (v === undefined) return false;
    this.owner.selectSuggestion(v, evt);
    return true;
  }
}

export abstract class PopoverSuggest<T> implements ISuggestOwner<T> {
  app: App;
  scope: Scope;
  suggestEl: HTMLElement;
  suggestions: SuggestionList<T>;
  isOpen = false;
  constructor(app: App, scope?: Scope) {
    this.app = app;
    this.scope = scope ?? new Scope(app.scope);
    this.suggestEl = createDiv({ cls: "suggestion-container" });
    const inner = this.suggestEl.createDiv({ cls: "suggestion" });
    this.suggestions = new SuggestionList<T>(this, inner);
    this.scope.register([], "ArrowDown", () => { this.suggestions.moveSelection(1); return false; });
    this.scope.register([], "ArrowUp", () => { this.suggestions.moveSelection(-1); return false; });
    this.scope.register([], "Enter", (evt) => { this.suggestions.useSelectedItem(evt); return false; });
    this.scope.register([], "Escape", () => { this.close(); return false; });
  }
  onHistoryBack(): void { this.close(); }
  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    activeDoc().body.appendChild(this.suggestEl);
    this.app.keymap.pushScope(this.scope);
  }
  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.app.keymap.popScope(this.scope);
    this.suggestEl.detach();
  }
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
  limit = 100;
  textInputEl: HTMLInputElement | HTMLDivElement;
  private callbacks: ((v: T, evt: MouseEvent | KeyboardEvent) => any)[] = [];
  private token = 0;
  constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement) {
    super(app);
    this.textInputEl = textInputEl;
    const upd = () => void this.update();
    textInputEl.addEventListener("input", upd);
    textInputEl.addEventListener("focus", upd);
    textInputEl.addEventListener("blur", () => this.close());
  }
  private async update(): Promise<void> {
    const my = ++this.token;
    const res = await this.getSuggestions(this.getValue());
    if (my !== this.token) return;
    const list = res.slice(0, this.limit);
    if (!list.length) { this.close(); return; }
    this.suggestions.setSuggestions(list);
    this.open();
    const r = this.textInputEl.getBoundingClientRect();
    this.suggestEl.style.position = "absolute";
    this.suggestEl.style.left = `${r.left}px`;
    this.suggestEl.style.top = `${r.bottom}px`;
    this.suggestEl.style.minWidth = `${r.width}px`;
  }
  setValue(value: string): void {
    const el = this.textInputEl as HTMLElement;
    if (el.tagName === "INPUT") (el as HTMLInputElement).value = value; else el.setText(value);
  }
  getValue(): string {
    const el = this.textInputEl as HTMLElement;
    return el.tagName === "INPUT" ? (el as HTMLInputElement).value : el.getText();
  }
  protected abstract getSuggestions(query: string): T[] | Promise<T[]>;
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    for (const cb of this.callbacks) cb(value, evt);
  }
  onSelect(cb: (value: T, evt: MouseEvent | KeyboardEvent) => any): this { this.callbacks.push(cb); return this; }
}

export interface Instruction { command: string; purpose: string }
function renderInstructions(el: HTMLElement, list: Instruction[]): void {
  el.empty();
  for (const i of list) {
    const row = el.createDiv({ cls: "prompt-instruction" });
    row.createSpan({ cls: "prompt-instruction-command", text: i.command });
    row.createSpan({ text: i.purpose });
  }
}

export abstract class SuggestModal<T> extends Modal implements ISuggestOwner<T> {
  limit = 100;
  emptyStateText = "No results found.";
  inputEl: HTMLInputElement;
  resultContainerEl: HTMLElement;
  instructionsEl: HTMLElement;
  suggestions: SuggestionList<T>;
  private token = 0;
  constructor(app: App) {
    super(app);
    this.modalEl.addClass("prompt");
    this.modalEl.empty();
    const ic = this.modalEl.createDiv({ cls: "prompt-input-container" });
    this.inputEl = ic.createEl("input", { cls: "prompt-input", attr: { enterkeyhint: "done", type: "text", spellcheck: "false" } });
    this.resultContainerEl = this.modalEl.createDiv({ cls: "prompt-results" });
    this.instructionsEl = this.modalEl.createDiv({ cls: "prompt-instructions" });
    this.suggestions = new SuggestionList<T>(this, this.resultContainerEl);
    this.inputEl.addEventListener("input", () => void this.updateSuggestions());
    this.scope.register([], "ArrowDown", () => { this.suggestions.moveSelection(1); return false; });
    this.scope.register([], "ArrowUp", () => { this.suggestions.moveSelection(-1); return false; });
    // Enter, and Enter with the modifiers pickers use to open elsewhere (Ctrl/Cmd: tab, + Alt: split, Shift: create).
    for (const mods of [[], ["Mod"], ["Mod", "Alt"], ["Shift"], ["Mod", "Shift"], ["Alt"]] as Modifier[][]) {
      this.scope.register(mods, "Enter", (evt) => { this.selectActiveSuggestion(evt); return false; });
    }
  }
  setPlaceholder(p: string): void { this.inputEl.placeholder = p; }
  setInstructions(list: Instruction[]): void { renderInstructions(this.instructionsEl, list); }
  onOpen(): void {
    void this.updateSuggestions();
    this.inputEl.focus();
  }
  onClose(): void { this.token++; }
  async updateSuggestions(): Promise<void> {
    const my = ++this.token;
    const res = await this.getSuggestions(this.inputEl.value);
    if (my !== this.token) return;
    const list = res.slice(0, this.limit);
    this.suggestions.setSuggestions(list);
    if (!list.length) this.onNoSuggestion();
  }
  onNoSuggestion(): void {
    this.resultContainerEl.empty();
    this.resultContainerEl.createDiv({ cls: "prompt-no-results", text: this.emptyStateText });
  }
  selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.close();
    this.onChooseSuggestion(value, evt);
  }
  selectActiveSuggestion(evt: MouseEvent | KeyboardEvent): void { this.suggestions.useSelectedItem(evt); }
  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export interface FuzzyMatch<T> { item: T; match: SearchResult }

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  getSuggestions(query: string): FuzzyMatch<T>[] {
    const search = prepareFuzzySearch(query);
    const out: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const match = search(this.getItemText(item));
      if (match) out.push({ item, match });
    }
    if (query.trim()) sortSearchResults(out);
    return out;
  }
  renderSuggestion(value: FuzzyMatch<T>, el: HTMLElement): void {
    el.addClass("mod-complex");
    const text = this.getItemText(value.item);
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    renderResults(title, text, value.match);
  }
  onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void { this.onChooseItem(item.item, evt); }
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

// ---------------------------------------------------------------- HoverPopover

export interface HoverParent { hoverPopover: HoverPopover | null }

/** True when the pointer moved from outside `el` into it (mouseover) or from it to outside (mouseout). */
function crossesBoundary(evt: MouseEvent, el: HTMLElement): boolean {
  const rel = evt.relatedTarget as Node | null;
  return !rel || !(rel === el || el.contains(rel));
}

/** Popovers currently alive (showing or shown), oldest first. */
const livePopovers: HoverPopover[] = [];
let lastPointer: { x: number; y: number; doc: Document | null } = { x: 0, y: 0, doc: null };
const globalsInstalled = new WeakSet<Document>();

function installPopoverGlobals(doc: Document): void {
  if (globalsInstalled.has(doc)) return;
  globalsInstalled.add(doc);
  doc.addEventListener("mousemove", (e) => { lastPointer = { x: e.clientX, y: e.clientY, doc }; }, true);
  // A click anywhere outside a popover closes it (and its nested popovers); clicks inside keep the chain open.
  doc.addEventListener("mousedown", (e) => {
    const t = e.target as Node | null;
    for (const p of livePopovers.slice()) if (!(t && p.containsNode(t))) p.hide();
  }, true);
  doc.addEventListener("keydown", (e) => { if (e.key === "Escape" && livePopovers.length) livePopovers[livePopovers.length - 1].hide(); }, true);
}

/**
 * A floating box shown next to a link while the pointer is over the link or the box. It closes shortly after the pointer
 * leaves both, unless a nested popover (one whose target lives inside this one) is still open.
 */
export class HoverPopover extends Component {
  hoverEl: HTMLElement;
  state = PopoverState.Showing;
  /** Pointer currently over the target element / over the popover itself. */
  onTarget: boolean;
  onHover = false;
  isPinned = false;
  /** Delay before hiding once the pointer has left target and popover. */
  hideDelay = 300;
  timer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private targetListeners: [string, (e: MouseEvent) => void][] = [];

  constructor(public parent: HoverParent, public targetEl: HTMLElement | null, public waitTime = 300, public staticPos: { x: number; y: number } | null = null) {
    super();
    const doc = targetEl?.ownerDocument ?? lastPointer.doc ?? (activeDoc() as Document);
    installPopoverGlobals(doc);
    this.hoverEl = doc.createElement("div");
    this.hoverEl.className = "popover hover-popover";
    this.onTarget = true;
    if (parent.hoverPopover && parent.hoverPopover !== this) parent.hoverPopover.hide();
    parent.hoverPopover = this;
    if (targetEl) {
      const enter = (e: MouseEvent) => { if (crossesBoundary(e, targetEl)) { this.onTarget = true; this.transition(); } };
      const leave = (e: MouseEvent) => { if (crossesBoundary(e, targetEl)) { this.onTarget = false; this.transition(); } };
      targetEl.addEventListener("mouseover", enter);
      targetEl.addEventListener("mouseout", leave);
      this.targetListeners = [["mouseover", enter], ["mouseout", leave]];
    }
    this.hoverEl.addEventListener("mouseover", (e) => { if (crossesBoundary(e, this.hoverEl)) { this.onHover = true; this.transition(); } });
    this.hoverEl.addEventListener("mouseout", (e) => { if (crossesBoundary(e, this.hoverEl)) { this.onHover = false; this.transition(); } });
    livePopovers.push(this);
    this.load();
    this.timer = setTimeout(() => { this.timer = null; this.show(); }, waitTime);
  }

  /** Whether `node` is inside this popover or inside a popover nested in it. */
  containsNode(node: Node): boolean {
    if (this.hoverEl.contains(node)) return true;
    return this.childPopovers().some((c) => c.containsNode(node));
  }
  /** Popovers opened from links inside this one. */
  childPopovers(): HoverPopover[] {
    return livePopovers.filter((p) => p !== this && !!p.targetEl && this.hoverEl.contains(p.targetEl));
  }
  /** Whether the popover should stay (pointer on target or popover, pinned, or a nested popover still wants to stay). */
  shouldShow(): boolean {
    if (this.state === PopoverState.Hidden) return false;
    if (this.isPinned || this.onTarget || this.onHover) return !this.targetEl || this.targetEl.isConnected || this.onHover;
    return this.childPopovers().some((c) => c.shouldShow());
  }
  /** Re-evaluate after the pointer moved: cancel a pending show, or schedule/cancel hiding. */
  transition(): void {
    if (this.state === PopoverState.Hidden) return;
    if (this.shouldShow()) {
      if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
      if (this.state === PopoverState.Hiding) this.state = PopoverState.Shown;
      return;
    }
    if (this.state === PopoverState.Showing) { this.hide(); return; }
    if (this.hideTimer) return;
    this.state = PopoverState.Hiding;
    this.hideTimer = setTimeout(() => { this.hideTimer = null; if (!this.shouldShow()) this.hide(); else this.state = PopoverState.Shown; }, this.hideDelay);
  }
  show(): void {
    if (this.state !== PopoverState.Showing) return;
    if (this.targetEl && !this.targetEl.isConnected) { this.hide(); return; }
    const doc = this.hoverEl.ownerDocument;
    doc.body.appendChild(this.hoverEl);
    this.state = PopoverState.Shown;
    this.position();
    try { this.onShow(); } catch (e) { console.error(e); }
    // The pointer may already have left everything while we were waiting.
    this.transition();
  }
  /** Place the popover under (or above, when there is no room) the target, or at the static/pointer position, inside the window. */
  position(pos: { x: number; y: number } | null = this.staticPos): void {
    const el = this.hoverEl;
    const win = el.ownerDocument.defaultView ?? window;
    const vw = win.innerWidth || 1024, vh = win.innerHeight || 768;
    el.style.position = "fixed";
    const w = el.offsetWidth || 450, h = el.offsetHeight || 300;
    const gap = 8;
    let x: number, y: number;
    const r = !pos && this.targetEl ? this.targetEl.getBoundingClientRect() : null;
    if (r) {
      x = r.left;
      y = r.bottom + gap;
      if (y + h > vh && r.top - gap - h >= 0) y = r.top - gap - h;
    } else {
      const p = pos ?? { x: lastPointer.x, y: lastPointer.y };
      x = p.x + gap; y = p.y + gap;
      if (y + h > vh && p.y - gap - h >= 0) y = p.y - gap - h;
    }
    x = Math.max(gap, Math.min(x, vw - w - gap));
    y = Math.max(gap, Math.min(y, vh - h - gap));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }
  onShow(): void {}
  hide(): void {
    if (this.state === PopoverState.Hidden) return;
    this.state = PopoverState.Hidden;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    for (const c of this.childPopovers()) c.hide();
    const i = livePopovers.indexOf(this);
    if (i >= 0) livePopovers.splice(i, 1);
    for (const [t, fn] of this.targetListeners) this.targetEl?.removeEventListener(t, fn as EventListener);
    this.targetListeners = [];
    this.hoverEl.detach();
    if (this.parent.hoverPopover === this) this.parent.hoverPopover = null;
    this.unload();
    // A popover this one was nested in may have been kept open only for it.
    for (const p of livePopovers.slice()) if (this.targetEl && p.hoverEl.contains(this.targetEl)) p.transition();
  }
  /** Popovers alive right now (testing and plugins that close every preview). */
  static getActive(): HoverPopover[] { return livePopovers.slice(); }
}

export type { Modifier };
