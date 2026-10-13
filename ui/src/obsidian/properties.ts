// Property (frontmatter) types: the widgets that edit each type and app.metadataTypeManager (.obsidian/types.json).
import { ipc } from "../ipc";
import { Component, Events } from "./events";
import { setIcon } from "./icons";
import { AbstractInputSuggest } from "./ui";
import type { App } from "./app";

/** Passed to a widget's render(); `onChange` writes the new value (undefined/null = empty). */
export interface PropertyRenderContext {
  app: App;
  key: string;
  sourcePath: string;
  onChange(value: unknown): void;
  /** Leave the value editor (focus goes back to the row). */
  blur(): void;
}
export interface PropertyWidget {
  type: string;
  icon: string;
  name(): string;
  validate(value: unknown): boolean;
  render(el: HTMLElement, value: unknown, ctx: PropertyRenderContext): PropertyWidgetComponent;
}
export class PropertyWidgetComponent extends Component {
  type = "";
  focus(_where?: "start" | "end"): void {}
  setValue(_v: unknown): void {}
}
export interface PropertyInfo { name: string; widget: string; /** same as widget (older shape) */ type: string; occurrences: number }

const DATE_RE = /^\d{4}-[01]\d-[0-3]\d$/;
const DATETIME_RE = /^\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/;
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x));

/** Type a value would get without an explicit assignment. */
export function inferPropertyType(v: unknown): string {
  if (v === null || v === undefined) return "text";
  if (typeof v === "string") return DATETIME_RE.test(v) ? "datetime" : DATE_RE.test(v) ? "date" : "text";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  return isStringList(v) ? "multitext" : "unknown";
}

/** Values as a list of strings (multitext, tags, aliases); a scalar becomes a one-item list. */
export function toList(v: unknown): string[] {
  if (v === null || v === undefined || v === "") return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== "").map(String);
}

// ---------------------------------------------------------------- suggestions

/** Existing values of a property across the vault (for autocomplete). */
export function knownValues(app: App, key: string): string[] {
  const lc = key.toLowerCase(), out = new Map<string, number>();
  for (const p of app.metadataCache.getCachedFiles()) {
    const fm = app.metadataCache.getCache(p)?.frontmatter;
    if (!fm) continue;
    for (const k of Object.keys(fm)) {
      if (k.toLowerCase() !== lc) continue;
      for (const s of toList(fm[k])) out.set(s, (out.get(s) ?? 0) + 1);
    }
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

interface ValueSuggestion { text: string; insert: string; note?: string }
/** Suggests vault links after `[[`, else known values of the property (tags: all tags). */
class ValueSuggest extends AbstractInputSuggest<ValueSuggestion> {
  constructor(app: App, el: HTMLDivElement, private ctx: PropertyRenderContext, private kind: string, private exclude: () => string[], private pick: (v: string) => void) {
    super(app, el);
    this.limit = 30;
    this.onSelect((v, evt) => { evt.preventDefault?.(); this.pick(v.insert); this.close(); });
  }
  protected getSuggestions(query: string): ValueSuggestion[] {
    const q = query.trim(), lq = q.toLowerCase();
    const link = /\[\[([^\]|#]*)$/.exec(q);
    if (link) {
      const t = link[1].toLowerCase();
      return this.app.vault.getMarkdownFiles().filter((f) => f.path.toLowerCase().includes(t)).slice(0, this.limit)
        .map((f) => ({ text: f.basename, note: f.parent && !f.parent.isRoot() ? f.parent.path : undefined, insert: q.slice(0, link.index) + `[[${this.app.metadataCache.fileToLinktext(f, this.ctx.sourcePath, true)}]]` }));
    }
    const ex = new Set(this.exclude().map((s) => s.toLowerCase()));
    const pool = this.kind === "tags" ? Object.keys(this.app.metadataCache.getTags()).map((t) => t.replace(/^#/, "")) : knownValues(this.app, this.ctx.key);
    return [...new Set(pool)].filter((s) => !ex.has(s.toLowerCase()) && (!lq || s.toLowerCase().includes(lq)) && s !== q).map((s) => ({ text: s, insert: s }));
  }
  renderSuggestion(v: ValueSuggestion, el: HTMLElement): void {
    el.addClass("mod-complex");
    const c = el.createDiv({ cls: "suggestion-content" });
    c.createDiv({ cls: "suggestion-title", text: v.text });
    if (v.note) c.createDiv({ cls: "suggestion-note", text: v.note });
  }
}

// ---------------------------------------------------------------- inline link rendering

const LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|(https?:\/\/[^\s<>"]+)/g;
/** Render text with its wikilinks/URLs as clickable links (properties are not markdown otherwise). */
export function renderPropertyText(app: App, el: HTMLElement, text: string, sourcePath: string): void {
  let i = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index! > i) el.appendText(text.slice(i, m.index));
    if (m[3]) {
      const a = el.createEl("a", { cls: "external-link", text: m[3], attr: { href: m[3], target: "_blank", rel: "noopener" } });
      a.addEventListener("mousedown", (e) => e.stopPropagation());
      a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void ipc.openUrl(m[3]).catch(() => window.open(m[3], "_blank", "noopener")); });
    } else {
      const target = m[1].trim();
      const dest = app.metadataCache.getFirstLinkpathDest(target.split("#")[0], sourcePath);
      const a = el.createEl("a", { cls: "internal-link" + (dest ? "" : " is-unresolved"), text: m[2] ?? target, attr: { href: target, "data-href": target } });
      a.addEventListener("mousedown", (e) => e.stopPropagation());
      a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void app.workspace.openLinkText(target, sourcePath, e.ctrlKey || e.metaKey ? "tab" : false); });
    }
    i = m.index! + m[0].length;
  }
  if (i < text.length) el.appendText(text.slice(i));
}

async function openTagSearch(app: App, tag: string): Promise<void> {
  const leaf = await app.workspace.ensureSideLeaf("search", "left", { active: true, reveal: true });
  (leaf.view as any).setQuery?.(`tag:#${tag.replace(/^#/, "")}`);
}

/** contenteditable div that behaves like a single-line input. */
function lineEditor(parent: HTMLElement, cls: string, placeholder = "Empty"): HTMLDivElement {
  const el = parent.createDiv({ cls, attr: { contenteditable: "true", spellcheck: "false", "data-placeholder": placeholder, tabindex: 0 } }) as HTMLDivElement;
  el.addEventListener("paste", (e) => { e.preventDefault(); document.execCommand("insertText", false, (e.clipboardData?.getData("text/plain") ?? "").replace(/\r?\n/g, " ")); });
  return el;
}
const textOf = (el: HTMLElement) => (el.textContent ?? "").replace(/ /g, " ");
const caretToEnd = (el: HTMLElement) => {
  const sel = window.getSelection?.();
  if (!sel) return;
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
};

// ---------------------------------------------------------------- widgets

class TextWidget extends PropertyWidgetComponent {
  type = "text";
  inputEl: HTMLDivElement;
  private value = "";
  constructor(el: HTMLElement, value: unknown, private ctx: PropertyRenderContext) {
    super();
    this.inputEl = lineEditor(el, "metadata-input-longtext mod-truncate");
    this.value = value === null || value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    this.show(false);
    const suggest = new ValueSuggest(ctx.app, this.inputEl, ctx, "text", () => [], (v) => { this.inputEl.setText(v); this.commit(); ctx.blur(); });
    this.register(() => suggest.close());
    this.inputEl.addEventListener("focus", () => { this.show(true); caretToEnd(this.inputEl); });
    this.inputEl.addEventListener("blur", () => { suggest.close(); this.commit(); this.show(false); });
    this.inputEl.addEventListener("keydown", (e) => {
      if (suggest.isOpen && (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp")) return;
      if (e.key === "Enter") { e.preventDefault(); this.commit(); ctx.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); this.inputEl.setText(this.value); ctx.blur(); }
    });
  }
  private show(editing: boolean): void {
    this.inputEl.empty();
    if (editing || !/\[\[|https?:\/\//.test(this.value)) this.inputEl.setText(this.value);
    else renderPropertyText(this.ctx.app, this.inputEl, this.value, this.ctx.sourcePath);
  }
  private commit(): void {
    const v = textOf(this.inputEl).trim();
    if (v === this.value) return;
    this.value = v;
    this.ctx.onChange(v === "" ? null : v);
  }
  setValue(v: unknown): void { this.value = v == null ? "" : String(v); this.show(document.activeElement === this.inputEl); }
  focus(): void { this.inputEl.focus(); }
}

/** Pills plus a trailing input; used by multitext, tags and aliases. */
export class MultiSelectWidget extends PropertyWidgetComponent {
  values: string[];
  containerEl: HTMLElement;
  inputEl: HTMLDivElement;
  constructor(el: HTMLElement, value: unknown, private ctx: PropertyRenderContext, type: string) {
    super();
    this.type = type;
    this.values = toList(value).map((s) => (type === "tags" ? s.replace(/^#/, "") : s));
    this.containerEl = el.createDiv({ cls: "multi-select-container", attr: { tabindex: -1 } });
    this.inputEl = lineEditor(this.containerEl, "multi-select-input", "");
    this.renderPills();
    const suggest = new ValueSuggest(ctx.app, this.inputEl, ctx, type, () => this.values, (v) => { this.add(v); this.inputEl.setText(""); });
    this.register(() => suggest.close());
    this.containerEl.addEventListener("mousedown", (e) => { if (e.target === this.containerEl) { e.preventDefault(); this.inputEl.focus(); } });
    this.inputEl.addEventListener("keydown", (e) => {
      if (suggest.isOpen && (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp")) return;
      const t = textOf(this.inputEl);
      if (e.key === "Enter" || (e.key === "," && !t.includes("[["))) {
        e.preventDefault();
        if (t.trim()) { this.add(t.trim()); this.inputEl.setText(""); } else if (e.key === "Enter") ctx.blur();
      } else if (e.key === "Backspace" && !t && this.values.length) {
        e.preventDefault();
        this.remove(this.values.length - 1);
      } else if (e.key === "Escape") { e.preventDefault(); this.inputEl.setText(""); ctx.blur(); }
    });
    this.inputEl.addEventListener("blur", () => { suggest.close(); const t = textOf(this.inputEl).trim(); if (t) { this.add(t); this.inputEl.setText(""); } });
  }
  private renderPills(): void {
    for (const p of Array.from(this.containerEl.querySelectorAll(".multi-select-pill"))) p.remove();
    const dupes = new Set(this.values.filter((v, i) => this.values.findIndex((w) => w.toLowerCase() === v.toLowerCase()) !== i).map((v) => v.toLowerCase()));
    this.values.forEach((v, i) => {
      const pill = createDiv({ cls: "multi-select-pill" + (dupes.has(v.toLowerCase()) ? " multi-select-duplicate" : ""), attr: { tabindex: 0 } });
      const content = pill.createDiv({ cls: "multi-select-pill-content" });
      if (this.type === "tags") {
        content.createSpan({ text: v });
        content.addEventListener("click", (e) => { e.stopPropagation(); void openTagSearch(this.ctx.app, v); });
      } else renderPropertyText(this.ctx.app, content, v, this.ctx.sourcePath);
      const rm = pill.createDiv({ cls: "multi-select-pill-remove-button", attr: { "aria-label": "Remove" } });
      setIcon(rm, "lucide-x");
      rm.addEventListener("mousedown", (e) => e.preventDefault());
      rm.addEventListener("click", (e) => { e.stopPropagation(); this.remove(i); });
      pill.addEventListener("keydown", (e) => { if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); this.remove(i); this.inputEl.focus(); } });
      this.containerEl.insertBefore(pill, this.inputEl);
    });
  }
  add(v: string): void {
    const s = this.type === "tags" ? v.replace(/^#/, "").trim() : v;
    if (!s) return;
    this.values.push(s);
    this.renderPills();
    this.ctx.onChange(this.values.slice());
  }
  remove(i: number): void {
    this.values.splice(i, 1);
    this.renderPills();
    this.ctx.onChange(this.values.length ? this.values.slice() : null);
  }
  setValue(v: unknown): void { this.values = toList(v); this.renderPills(); }
  focus(): void { this.inputEl.focus(); }
}

class InputWidget extends PropertyWidgetComponent {
  inputEl: HTMLInputElement;
  constructor(el: HTMLElement, value: unknown, ctx: PropertyRenderContext, type: "number" | "date" | "datetime") {
    super();
    this.type = type;
    const html = type === "datetime" ? "datetime-local" : type;
    this.inputEl = el.createEl("input", { cls: `metadata-input ${type === "number" ? "metadata-input-number" : `metadata-input-text mod-${type}`}`, type: html, attr: { placeholder: "Empty" } });
    if (type === "number") this.inputEl.step = "any";
    this.setValue(value);
    let last = this.inputEl.value;
    const commit = () => {
      const raw = this.inputEl.value.trim();
      if (raw === last) return;
      last = raw;
      if (!raw) { ctx.onChange(null); return; }
      if (type === "number") { const n = Number(raw); if (Number.isFinite(n)) ctx.onChange(n); return; }
      ctx.onChange(raw);
    };
    this.inputEl.addEventListener("change", commit);
    this.inputEl.addEventListener("blur", commit);
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); ctx.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); this.setValue(value); ctx.blur(); }
    });
  }
  setValue(v: unknown): void {
    const s = v === null || v === undefined ? "" : String(v);
    this.inputEl.value = this.type === "datetime" ? s.replace(/Z$/, "").slice(0, 19) : this.type === "date" ? s.slice(0, 10) : s;
  }
  focus(): void { this.inputEl.focus(); }
}

class CheckboxWidget extends PropertyWidgetComponent {
  type = "checkbox";
  inputEl: HTMLInputElement;
  constructor(el: HTMLElement, value: unknown, ctx: PropertyRenderContext) {
    super();
    this.inputEl = el.createEl("input", { cls: "metadata-input-checkbox", type: "checkbox" });
    this.setValue(value);
    this.inputEl.addEventListener("change", () => ctx.onChange(this.inputEl.checked));
  }
  setValue(v: unknown): void { this.inputEl.checked = v === true || v === "true"; }
  focus(): void { this.inputEl.focus(); }
}

class UnknownWidget extends PropertyWidgetComponent {
  type = "unknown";
  constructor(el: HTMLElement, value: unknown) {
    super();
    el.createSpan({ cls: "metadata-property-value-item mod-unknown", text: value === undefined ? "" : JSON.stringify(value), attr: { tabindex: 0 } });
  }
}

const widget = (type: string, icon: string, name: string, validate: (v: unknown) => boolean, render: PropertyWidget["render"]): PropertyWidget => ({ type, icon, name: () => name, validate, render });
const listOk = (v: unknown) => typeof v === "string" || isStringList(v);
/** Built-in property types (app.metadataTypeManager.registeredTypeWidgets). */
export function builtinWidgets(): Record<string, PropertyWidget> {
  return {
    text: widget("text", "lucide-text", "Text", (v) => typeof v === "string", (el, v, ctx) => new TextWidget(el, v, ctx)),
    multitext: widget("multitext", "lucide-list", "List", listOk, (el, v, ctx) => new MultiSelectWidget(el, v, ctx, "multitext")),
    number: widget("number", "lucide-binary", "Number", (v) => typeof v === "number" && !Number.isNaN(v), (el, v, ctx) => new InputWidget(el, v, ctx, "number")),
    checkbox: widget("checkbox", "lucide-check-square", "Checkbox", (v) => typeof v === "boolean", (el, v, ctx) => new CheckboxWidget(el, v, ctx)),
    date: widget("date", "lucide-calendar", "Date", (v) => typeof v === "string" && DATE_RE.test(v), (el, v, ctx) => new InputWidget(el, v, ctx, "date")),
    datetime: widget("datetime", "lucide-clock", "Date & time", (v) => typeof v === "string" && (DATETIME_RE.test(v) || DATE_RE.test(v)), (el, v, ctx) => new InputWidget(el, v, ctx, "datetime")),
    aliases: widget("aliases", "lucide-forward", "Aliases", listOk, (el, v, ctx) => new MultiSelectWidget(el, v, ctx, "aliases")),
    tags: widget("tags", "lucide-tags", "Tags", listOk, (el, v, ctx) => new MultiSelectWidget(el, v, ctx, "tags")),
  };
}
export const unknownWidget: PropertyWidget = widget("unknown", "lucide-file-question", "Unknown", () => true, (el, v) => new UnknownWidget(el, v));
/** Types offered in the "Property type" menu (aliases and tags are reserved for their keys). */
export const USER_TYPES = ["text", "multitext", "number", "checkbox", "date", "datetime"];
/** Keys with a fixed type in every vault. */
export const RESERVED_TYPES: Record<string, string> = { aliases: "aliases", cssclasses: "multitext", tags: "tags" };

// ---------------------------------------------------------------- app.metadataTypeManager

/** Property types assigned by the user (types.json, keyed by lowercased name) and inferred from every note's frontmatter. */
export class MetadataTypeManager extends Events {
  registeredTypeWidgets: Record<string, PropertyWidget> = builtinWidgets();
  /** lowercased name -> { name (as written), widget } */
  assignedWidgets: Record<string, { name: string; widget: string }> = {};
  private cached: Record<string, PropertyInfo> | null = null;
  private lastSave = 0;
  constructor(public app: App) {
    super();
    for (const ev of ["changed", "deleted", "resolved"]) app.metadataCache.on(ev, () => { this.cached = null; });
  }
  async load(): Promise<void> {
    this.assignedWidgets = {};
    for (const [k, w] of Object.entries(RESERVED_TYPES)) this.assignedWidgets[k] = { name: k, widget: w };
    try {
      const v = await ipc.configRead("types.json");
      const t = v && typeof v === "object" && v.types && typeof v.types === "object" ? v.types : {};
      for (const [name, w] of Object.entries(t)) if (typeof w === "string") this.assignedWidgets[name.toLowerCase()] = { name, widget: w };
    } catch { /* no types.json yet */ }
    this.cached = null;
    this.trigger("changed");
  }
  /** Re-read types.json after an external change (not for our own writes). */
  async onConfigFileChange(): Promise<void> { if (Date.now() - this.lastSave > 1000) await this.load(); }
  async save(): Promise<void> {
    const types: Record<string, string> = {};
    for (const { name, widget } of Object.values(this.assignedWidgets)) types[name] = widget;
    this.lastSave = Date.now();
    await ipc.configWrite("types.json", { types });
  }
  /** Compatibility view: lowercased name -> type. */
  get types(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.assignedWidgets).map(([k, v]) => [k, v.widget]));
  }
  getPropertyOccurrences(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.app.metadataCache.getCachedFiles()) {
      for (const k of Object.keys(this.app.metadataCache.getCache(p)?.frontmatter ?? {})) out[k.toLowerCase()] = (out[k.toLowerCase()] ?? 0) + 1;
    }
    return out;
  }
  /** Every known property: lowercased name -> { name, widget, occurrences }. */
  getAllProperties(): Record<string, PropertyInfo> {
    if (this.cached) return this.cached;
    const out: Record<string, PropertyInfo> = {};
    for (const [k, a] of Object.entries(this.assignedWidgets)) out[k] = { name: a.name, widget: a.widget, type: a.widget, occurrences: 0 };
    for (const p of this.app.metadataCache.getCachedFiles()) {
      const fm = this.app.metadataCache.getCache(p)?.frontmatter;
      for (const [k, v] of Object.entries(fm ?? {})) {
        const lc = k.toLowerCase();
        let info = out[lc];
        if (!info) info = out[lc] = { name: k, widget: "", type: "", occurrences: 0 };
        info.occurrences++;
        if (!info.widget && v !== null && v !== undefined) info.widget = info.type = inferPropertyType(v);
      }
    }
    for (const i of Object.values(out)) if (!i.widget) i.widget = i.type = "text";
    return (this.cached = out);
  }
  getPropertyInfo(name: string): PropertyInfo {
    return this.getAllProperties()[name.toLowerCase()] ?? { name, widget: "text", type: "text", occurrences: 0 };
  }
  getAssignedWidget(name: string): string | null { return this.assignedWidgets[name.toLowerCase()]?.widget ?? null; }
  getWidget(type: string): PropertyWidget { return this.registeredTypeWidgets[type?.toLowerCase()] ?? unknownWidget; }
  /** `expected`: the assigned type (or the property's usual type); `inferred`: what `value` looks like. */
  getTypeInfo(name: string, value?: unknown): { expected: PropertyWidget; inferred: PropertyWidget } {
    const assigned = this.getAssignedWidget(name);
    const exp = assigned ? this.getWidget(assigned) : undefined;
    if (exp && (value === undefined || value === null || exp.validate(value))) return { expected: exp, inferred: exp };
    if (value === undefined || value === null) {
      const w = this.getWidget(this.getPropertyInfo(name).widget);
      return { expected: exp ?? w, inferred: w };
    }
    const inf = this.getWidget(inferPropertyType(value));
    return { expected: exp ?? inf, inferred: inf };
  }
  async setType(name: string, type: string): Promise<void> {
    const lc = name.toLowerCase();
    this.assignedWidgets[lc] = { name, widget: type };
    this.cached = null;
    await this.save();
    this.trigger("changed", lc);
  }
  async unsetType(name: string): Promise<void> {
    const lc = name.toLowerCase();
    delete this.assignedWidgets[lc];
    this.cached = null;
    await this.save();
    this.trigger("changed", lc);
  }
}
