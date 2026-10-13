// Bases value types and query scaffolding (minimal but behaviourally sound; the Bases engine itself lives in the shell).
import moment from "moment";
import { Component } from "./events";
import type { TFile } from "./files";
import type { App } from "./app";

export class RenderContext { hoverPopover: any = null; }

export abstract class Value {
  static type = "";
  static equals(a: Value | null, b: Value | null): boolean { return a === b || (!!a && !!b && a.equals(b)); }
  static looseEquals(a: Value | null, b: Value | null): boolean { return a === b || (!!a && !!b && a.looseEquals(b)); }
  abstract toString(): string;
  abstract isTruthy(): boolean;
  equals(other: this): boolean { return this.constructor === other.constructor && this.toString() === other.toString(); }
  looseEquals(other: Value): boolean { return this.toString() === other.toString(); }
  renderTo(el: HTMLElement, _ctx: RenderContext): void { el.setText(this.toString()); }
}
export abstract class NotNullValue extends Value {}
export class NullValue extends Value {
  static value = new (class extends NullValue {})();
  toString(): string { return ""; }
  isTruthy(): boolean { return false; }
}
export abstract class PrimitiveValue<T> extends NotNullValue {
  constructor(public value: T) { super(); }
  toString(): string { return String(this.value); }
  isTruthy(): boolean { return !!this.value; }
}
export class StringValue extends PrimitiveValue<string> { static type = "string"; }
export class NumberValue extends PrimitiveValue<number> { static type = "number"; }
export class BooleanValue extends PrimitiveValue<boolean> { static type = "boolean"; }
export class HTMLValue extends StringValue {}
export class IconValue extends StringValue {}
export class ImageValue extends StringValue {}
export class UrlValue extends StringValue {}
export class TagValue extends StringValue {}
export class LinkValue extends StringValue {
  static parseFromString(_app: App, input: string, _sourcePath: string): LinkValue | null {
    const m = /^\[\[(.+?)\]\]$/.exec(input.trim());
    return m ? new LinkValue(m[1]) : null;
  }
}
export class FileValue extends NotNullValue {
  constructor(public file: TFile) { super(); }
  toString(): string { return this.file.path; }
  isTruthy(): boolean { return true; }
}
export class DateValue extends NotNullValue {
  constructor(public date: Date) { super(); }
  toString(): string { return moment(this.date).format("YYYY-MM-DD HH:mm:ss"); }
  dateOnly(): DateValue { const d = new Date(this.date); d.setHours(0, 0, 0, 0); return new DateValue(d); }
  relative(): string { return moment(this.date).fromNow(); }
  isTruthy(): boolean { return true; }
  static parseFromString(input: string): DateValue | null { const m = moment(input, moment.ISO_8601, true); return m.isValid() ? new DateValue(m.toDate()) : null; }
}
export class RelativeDateValue extends DateValue {}
export class DurationValue extends NotNullValue {
  constructor(public ms: number) { super(); }
  toString(): string { return moment.duration(this.ms).humanize(); }
  isTruthy(): boolean { return this.ms !== 0; }
  addToDate(value: DateValue, subtract = false): DateValue { return new DateValue(new Date(value.date.getTime() + (subtract ? -this.ms : this.ms))); }
  getMilliseconds(): number { return this.ms; }
  static fromMilliseconds(ms: number): DurationValue { return new DurationValue(ms); }
  static parseFromString(input: string): DurationValue | null {
    const m = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(input.trim());
    if (!m) return null;
    const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2] as "ms"];
    return new DurationValue(parseFloat(m[1]) * mult);
  }
}
export class RegExpValue extends NotNullValue {
  constructor(public regex: RegExp) { super(); }
  toString(): string { return this.regex.toString(); }
  isTruthy(): boolean { return true; }
}
export class ListValue extends NotNullValue {
  static type = "list";
  value: Value[];
  constructor(value: unknown[]) { super(); this.value = value.map((v) => (v instanceof Value ? v : v === null || v === undefined ? NullValue.value : typeof v === "number" ? new NumberValue(v) : typeof v === "boolean" ? new BooleanValue(v) : new StringValue(String(v)))); }
  toString(): string { return this.value.map((v) => v.toString()).join(", "); }
  isTruthy(): boolean { return this.value.length > 0; }
  includes(v: Value): boolean { return this.value.some((x) => Value.looseEquals(x, v)); }
  length(): number { return this.value.length; }
  get(i: number): Value { return this.value[i] ?? NullValue.value; }
  concat(o: ListValue): ListValue { return new ListValue([...this.value, ...o.value]); }
}
export class ObjectValue extends NotNullValue {
  static type = "object";
  constructor(public value: Record<string, Value> = {}) { super(); }
  toString(): string { return JSON.stringify(Object.fromEntries(Object.entries(this.value).map(([k, v]) => [k, v.toString()]))); }
  isTruthy(): boolean { return true; }
  isEmpty(): boolean { return Object.keys(this.value).length === 0; }
  get(key: string): Value | null { return this.value[key] ?? null; }
}

export class QueryController extends Component {}
export class BasesEntry { constructor(public file: TFile) {} getValue(_id: string): Value | null { return null; } }
export class BasesEntryGroup { key?: Value; entries: BasesEntry[] = []; hasKey(): boolean { return !!this.key; } }
export class BasesQueryResult {
  data: BasesEntry[] = [];
  get groupedData(): BasesEntryGroup[] { const g = new BasesEntryGroup(); g.entries = this.data; return [g]; }
  get properties(): string[] { return []; }
  getSummaryValue(_qc: QueryController, _entries: BasesEntry[], _prop: string, _key: string): Value { return NullValue.value; }
}
export class BasesViewConfig {
  name = "";
  private values: Record<string, unknown> = {};
  get(key: string): unknown { return this.values[key]; }
  getAsPropertyId(key: string): string | null { const v = this.values[key]; return typeof v === "string" ? v : null; }
  getEvaluatedFormula(_view: BasesView, _key: string): Value { return NullValue.value; }
  set(key: string, value: any | null): void { if (value === null) delete this.values[key]; else this.values[key] = value; }
  getOrder(): string[] { return []; }
  getSort(): { property: string; direction: "ASC" | "DESC" }[] { return []; }
  getDisplayName(id: string): string { return id.replace(/^\w+\./, ""); }
}
export abstract class BasesView extends Component {
  abstract type: string;
  app!: App;
  config = new BasesViewConfig();
  allProperties: string[] = [];
  data = new BasesQueryResult();
  protected constructor(public controller: QueryController) { super(); }
  abstract onDataUpdated(): void;
  async createFileForView(_name?: string, _fm?: (frontmatter: any, file: TFile) => void): Promise<void> {}
}
export function parsePropertyId(id: string): { type: "note" | "formula" | "file"; name: string } {
  const i = id.indexOf(".");
  return { type: (i < 0 ? "note" : id.slice(0, i)) as "note", name: i < 0 ? id : id.slice(i + 1) };
}

export class Tasks {
  private pending: Promise<unknown>[] = [];
  add(cb: () => Promise<any>): void { this.pending.push(cb()); }
  addPromise(p: Promise<any>): void { this.pending.push(p); }
  isEmpty(): boolean { return this.pending.length === 0; }
  promise(): Promise<any> { return Promise.all(this.pending); }
}

import { Events } from "./events";
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
