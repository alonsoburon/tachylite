// Value types of the Bases formula language (public API: `Value` and subclasses). The Bases engine is in ui/src/bases.
import moment from "moment";
import type { TFile } from "./files";
import type { App } from "./app";
import { setIcon } from "./icons";
import { sanitizeHTMLToDom } from "./util";

export class RenderContext { hoverPopover: any = null; }

const currentApp = (): App | null => (globalThis as any).app ?? null;

export abstract class Value {
  static type = "";
  static equals(a: Value | null, b: Value | null): boolean { return a === b || (!!a && !!b && a.constructor === b.constructor && a.equals(b as any)); }
  static looseEquals(a: Value | null, b: Value | null): boolean { return a === b || (!!a && !!b && a.looseEquals(b)); }
  abstract toString(): string;
  abstract isTruthy(): boolean;
  equals(other: this): boolean { return this.constructor === other.constructor && this.toString() === other.toString(); }
  looseEquals(other: Value): boolean { return this.toString() === other.toString(); }
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.setText(this.toString()); }
}
export abstract class NotNullValue extends Value {}
export class NullValue extends Value {
  static type = "null";
  static value: NullValue;
  toString(): string { return ""; }
  isTruthy(): boolean { return false; }
  looseEquals(other: Value): boolean { return other instanceof NullValue; }
  renderTo(_el: HTMLElement, _ctx: RenderContext): void {}
}
NullValue.value = new NullValue();

export abstract class PrimitiveValue<T> extends NotNullValue {
  constructor(public value: T) { super(); }
  toString(): string { return String(this.value); }
  isTruthy(): boolean { return !!this.value; }
}
export class StringValue extends PrimitiveValue<string> { static type = "string"; }
export class NumberValue extends PrimitiveValue<number> {
  static type = "number";
  looseEquals(other: Value): boolean {
    if (other instanceof NumberValue) return other.value === this.value;
    if (other instanceof StringValue && other.value.trim() !== "") return Number(other.value) === this.value;
    return false;
  }
}
export class BooleanValue extends PrimitiveValue<boolean> {
  static type = "boolean";
  renderTo(el: HTMLElement, _ctx: RenderContext): void {
    const cb = el.createEl("input", { attr: { type: "checkbox", disabled: "" } });
    cb.checked = this.value;
  }
}
export class HTMLValue extends StringValue {
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.appendChild(sanitizeHTMLToDom(this.value)); }
}
export class IconValue extends StringValue {
  renderTo(el: HTMLElement, _ctx: RenderContext): void { setIcon(el.createSpan({ cls: "bases-icon" }), this.value); }
}
/** Resource URL for a vault path or external URL. */
export function resolveResource(app: App | null, src: string, sourcePath = ""): string {
  if (/^(https?:|data:|app:|blob:)/i.test(src)) return src;
  const inner = /^!?\[\[([^\]|#]+)[^\]]*\]\]$/.exec(src.trim())?.[1] ?? src;
  const f = app?.metadataCache.getFirstLinkpathDest(inner, sourcePath) ?? app?.vault.getFileByPath(inner) ?? null;
  return f && app ? app.vault.getResourcePath(f) : inner;
}
export class ImageValue extends StringValue {
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.createEl("img", { cls: "bases-image", attr: { src: resolveResource(currentApp(), this.value) } }); }
}
export class UrlValue extends StringValue {
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.createEl("a", { cls: "external-link", text: this.value, attr: { href: this.value, target: "_blank", rel: "noopener" } }); }
}
export class TagValue extends StringValue {
  constructor(value: string) { super(value.startsWith("#") ? value : "#" + value); }
  looseEquals(other: Value): boolean {
    const norm = (s: string) => s.replace(/^#/, "").toLowerCase();
    return other instanceof StringValue && norm(other.value) === norm(this.value);
  }
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.createEl("a", { cls: "tag", text: this.value, attr: { href: this.value } }); }
}

function linkOpen(app: App | null, a: HTMLElement, linktext: string, sourcePath: string): void {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void app?.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(e));
  });
}

/** An internal link (`value` is the link path, without brackets) or an external URL. */
export class LinkValue extends StringValue {
  display: Value | null;
  sourcePath: string;
  constructor(value: string, display: Value | string | null = null, sourcePath = "") {
    super(value);
    this.display = typeof display === "string" ? new StringValue(display) : display;
    this.sourcePath = sourcePath;
  }
  get isExternal(): boolean { return /^[a-z][a-z0-9+.-]*:/i.test(this.value) && !/^[a-z]:[\\/]/i.test(this.value); }
  /** The vault file this link points to, if any. */
  resolve(app: App | null = currentApp()): TFile | null {
    if (!app || this.isExternal) return null;
    const path = this.value.split("#")[0];
    return path ? app.metadataCache.getFirstLinkpathDest(path, this.sourcePath) ?? app.vault.getFileByPath(path) : null;
  }
  toString(): string {
    if (this.display) return this.display.toString();
    const f = this.resolve();
    return f ? (f.extension === "md" ? f.basename : f.name) : this.value;
  }
  looseEquals(other: Value): boolean {
    if (other instanceof FileValue) return this.resolve() === other.file;
    if (other instanceof LinkValue) {
      const a = this.resolve(), b = other.resolve();
      return a && b ? a === b : this.value === other.value;
    }
    return other instanceof StringValue && other.value === this.value;
  }
  equals(other: this): boolean { return this.looseEquals(other); }
  renderTo(el: HTMLElement, ctx: RenderContext): void {
    if (this.isExternal) {
      const a = el.createEl("a", { cls: "external-link", attr: { href: this.value, target: "_blank", rel: "noopener" } });
      if (this.display) this.display.renderTo(a, ctx); else a.setText(this.value);
      return;
    }
    const f = this.resolve();
    const a = el.createEl("a", { cls: "internal-link" + (f ? "" : " is-unresolved"), attr: { "data-href": this.value, href: this.value } });
    if (this.display) this.display.renderTo(a, ctx); else a.setText(this.toString());
    linkOpen(currentApp(), a, this.value, this.sourcePath);
  }
  static parseFromString(_app: App, input: string, sourcePath: string): LinkValue | null {
    const s = input.trim();
    const wiki = /^!?\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]$/.exec(s);
    if (wiki) return new LinkValue(wiki[1].trim(), wiki[2] !== undefined ? wiki[2] : null, sourcePath);
    const md = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(s);
    if (md) { let t = md[2].trim(); try { t = decodeURI(t); } catch { /* keep */ } return new LinkValue(t, md[1] || null, sourcePath); }
    return null;
  }
}
export class FileValue extends NotNullValue {
  static type = "file";
  constructor(public file: TFile) { super(); }
  toString(): string { return this.file.extension === "md" ? this.file.basename : this.file.name; }
  isTruthy(): boolean { return true; }
  looseEquals(other: Value): boolean {
    if (other instanceof FileValue) return other.file === this.file;
    if (other instanceof LinkValue) return other.resolve() === this.file;
    return other instanceof StringValue && (other.value === this.file.path || other.value === this.file.basename);
  }
  equals(other: this): boolean { return this.looseEquals(other); }
  renderTo(el: HTMLElement, _ctx: RenderContext): void {
    const a = el.createEl("a", { cls: "internal-link", text: this.toString(), attr: { "data-href": this.file.path, href: this.file.path } });
    linkOpen(currentApp(), a, this.file.path, "");
  }
}
export class DateValue extends NotNullValue {
  static type = "date";
  /** `time` is false for date-only values (`today()`, `date("2025-01-01")`, date properties). */
  constructor(public date: Date, public time = true) { super(); }
  toString(): string { return moment(this.date).format(this.time ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD"); }
  dateOnly(): DateValue { const d = new Date(this.date); d.setHours(0, 0, 0, 0); return new DateValue(d, false); }
  relative(): string { return moment(this.date).fromNow(); }
  isTruthy(): boolean { return true; }
  looseEquals(other: Value): boolean {
    const o = other instanceof DateValue ? other : other instanceof StringValue ? DateValue.parseFromString(other.value) : null;
    return !!o && o.date.getTime() === this.date.getTime();
  }
  equals(other: this): boolean { return this.looseEquals(other); }
  static parseFromString(input: string): DateValue | null {
    const s = input.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const m = moment(s, "YYYY-MM-DD", true); return m.isValid() ? new DateValue(m.toDate(), false) : null; }
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(s)) return null;
    const m = moment(s.replace(" ", "T"), moment.ISO_8601, true);
    if (m.isValid()) return new DateValue(m.toDate(), true);
    const z = moment(s, ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm:ssZ", "YYYY-MM-DDTHH:mm:ssZZ"], true);
    return z.isValid() ? new DateValue(z.toDate(), true) : null;
  }
}
export class RelativeDateValue extends DateValue {
  toString(): string { return this.relative(); }
}

const UNIT_MS: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
const UNIT_WORDS: Record<string, string> = {
  y: "y", yr: "y", yrs: "y", year: "y", years: "y", M: "M", mo: "M", month: "M", months: "M", w: "w", wk: "w", wks: "w", week: "w", weeks: "w",
  d: "d", day: "d", days: "d", h: "h", hr: "h", hrs: "h", hour: "h", hours: "h", m: "m", min: "m", mins: "m", minute: "m", minutes: "m",
  s: "s", sec: "s", secs: "s", second: "s", seconds: "s", ms: "ms", millisecond: "ms", milliseconds: "ms",
};
/** A span of time: calendar months (years count as 12) plus a fixed number of milliseconds. */
export class DurationValue extends NotNullValue {
  static type = "duration";
  constructor(public ms: number, public months = 0) { super(); }
  toString(): string {
    const parts: string[] = [];
    const y = Math.trunc(this.months / 12), mo = this.months % 12;
    if (y) parts.push(`${y} year${Math.abs(y) === 1 ? "" : "s"}`);
    if (mo) parts.push(`${mo} month${Math.abs(mo) === 1 ? "" : "s"}`);
    let rest = this.ms;
    for (const [n, u] of [["day", 86400000], ["hour", 3600000], ["minute", 60000], ["second", 1000]] as const) {
      const q = Math.trunc(rest / u);
      if (q) { parts.push(`${q} ${n}${Math.abs(q) === 1 ? "" : "s"}`); rest -= q * u; }
    }
    if (rest || !parts.length) parts.push(`${rest} ms`);
    return parts.join(" ");
  }
  isTruthy(): boolean { return this.ms !== 0 || this.months !== 0; }
  addToDate(value: DateValue, subtract = false): DateValue {
    const sign = subtract ? -1 : 1;
    const m = moment(value.date).add(sign * this.months, "months").add(sign * this.ms, "milliseconds");
    return new DateValue(m.toDate(), value.time || this.ms % 86400000 !== 0);
  }
  /** Months are counted as 30 days. */
  getMilliseconds(): number { return this.ms + this.months * 30 * 86400000; }
  looseEquals(other: Value): boolean { return other instanceof DurationValue ? other.getMilliseconds() === this.getMilliseconds() : other instanceof NumberValue && other.value === this.getMilliseconds(); }
  static fromMilliseconds(ms: number): DurationValue { return new DurationValue(ms); }
  /** Accepts ISO 8601 durations (`P1DT2H`) and the Bases shorthand (`1d`, `2 hours`, `1M 4h`, `-3w`). */
  static parseFromString(input: string): DurationValue | null {
    const s = input.trim();
    if (!s) return null;
    const iso = /^([+-])?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s);
    if (iso && s.length > 1 + (iso[1] ? 1 : 0)) {
      const n = (i: number) => (iso[i] ? parseFloat(iso[i]) : 0), sign = iso[1] === "-" ? -1 : 1;
      return new DurationValue(sign * (n(4) * 604800000 + n(5) * 86400000 + n(6) * 3600000 + n(7) * 60000 + n(8) * 1000), sign * (n(2) * 12 + n(3)));
    }
    const re = /([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*,?\s*/y;
    let ms = 0, months = 0, i = 0, any = false;
    while (i < s.length) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m) return null;
      const word = m[2], unit = UNIT_WORDS[word] ?? (word.length > 1 ? UNIT_WORDS[word.toLowerCase()] : undefined);
      if (!unit) return null;
      const q = parseFloat(m[1]);
      if (unit === "y") months += q * 12; else if (unit === "M") months += q; else if (unit === "ms") ms += q; else ms += q * UNIT_MS[unit];
      any = true;
      i = re.lastIndex;
    }
    return any ? new DurationValue(ms, months) : null;
  }
}
export class RegExpValue extends NotNullValue {
  static type = "regexp";
  constructor(public regex: RegExp) { super(); }
  toString(): string { return this.regex.toString(); }
  isTruthy(): boolean { return true; }
}

/** Wrap a plain JS value (frontmatter, plugin data) as a Value. */
export function wrapValue(v: unknown, sourcePath = ""): Value {
  if (v instanceof Value) return v;
  if (v === null || v === undefined) return NullValue.value;
  if (typeof v === "number") return new NumberValue(v);
  if (typeof v === "boolean") return new BooleanValue(v);
  if (v instanceof Date) return new DateValue(v, true);
  if (Array.isArray(v)) return new ListValue(v.map((x) => wrapValue(x, sourcePath)));
  if (typeof v === "object") return new ObjectValue(Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, wrapValue(x, sourcePath)])));
  return new StringValue(String(v));
}

export class ListValue extends NotNullValue {
  static type = "list";
  value: Value[];
  constructor(value: unknown[]) {
    super();
    for (let i = 0; i < value.length; i++) value[i] = wrapValue(value[i]);
    this.value = value as Value[];
  }
  toString(): string { return this.value.map((v) => v.toString()).join(", "); }
  isTruthy(): boolean { return this.value.length > 0; }
  includes(v: Value): boolean { return this.value.some((x) => Value.looseEquals(x, v) || Value.looseEquals(v, x)); }
  length(): number { return this.value.length; }
  get(i: number): Value { return this.value[i < 0 ? this.value.length + i : i] ?? NullValue.value; }
  concat(o: ListValue): ListValue { return new ListValue([...this.value, ...o.value]); }
  looseEquals(other: Value): boolean { return other instanceof ListValue && other.value.length === this.value.length && this.value.every((v, i) => Value.looseEquals(v, other.value[i])); }
  equals(other: this): boolean { return this.looseEquals(other); }
  renderTo(el: HTMLElement, ctx: RenderContext): void {
    this.value.forEach((v, i) => {
      if (i) el.createSpan({ cls: "bases-value-separator", text: ", " });
      v.renderTo(el.createSpan({ cls: "bases-value-element" }), ctx);
    });
  }
}
export class ObjectValue extends NotNullValue {
  static type = "object";
  constructor(public value: Record<string, Value> = {}) { super(); }
  toString(): string {
    const plain = (v: Value): unknown => (v instanceof ListValue ? v.value.map(plain) : v instanceof ObjectValue ? Object.fromEntries(Object.entries(v.value).map(([k, x]) => [k, plain(x)])) : v instanceof NullValue ? null : v instanceof NumberValue || v instanceof BooleanValue ? v.value : v.toString());
    return JSON.stringify(plain(this));
  }
  isTruthy(): boolean { return true; }
  isEmpty(): boolean { return Object.keys(this.value).length === 0; }
  get(key: string): Value { return wrapValue(this.value[key]); }
}

export class Tasks {
  private pending: Promise<unknown>[] = [];
  add(cb: () => Promise<any>): void { this.pending.push(cb()); }
  addPromise(p: Promise<any>): void { this.pending.push(p); }
  isEmpty(): boolean { return this.pending.length === 0; }
  promise(): Promise<any> { return Promise.all(this.pending); }
}

import { Events, Keymap } from "./events";
export class SecretStorage extends Events {
  constructor(private prefix: string) { super(); }
  private k(id: string): string { return `${this.prefix}-secret-${id}`; }
  setSecret(id: string, secret: string): void { localStorage.setItem(this.k(id), secret); this.trigger("change", id); }
  getSecret(id: string): string | null { return localStorage.getItem(this.k(id)); }
  listSecrets(): string[] {
    const p = `${this.prefix}-secret-`, out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(p)) out.push(k.slice(p.length)); }
    return out;
  }
}
