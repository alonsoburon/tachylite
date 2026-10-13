// Evaluator for the Bases expression language (filters, formulas, summaries) over Value objects.
import moment from "moment";
import type { App } from "../obsidian/app";
import type { TFile } from "../obsidian/files";
import { getAllTags } from "../obsidian/util";
import {
  BooleanValue, DateValue, DurationValue, FileValue, HTMLValue, IconValue, ImageValue, LinkValue, ListValue, NotNullValue, NullValue, NumberValue,
  ObjectValue, RegExpValue, StringValue, TagValue, UrlValue, Value, wrapValue,
} from "../obsidian/values";
import { parseExpression, type Node } from "./expr";

export class BasesEvalError extends Error {}
/** Result of a formula that failed (`BasesEntry.getValue` returns these instead of throwing). */
export class ErrorValue extends NotNullValue {
  static type = "error";
  constructor(public message: string) { super(); }
  toString(): string { return `Error: ${this.message}`; }
  isTruthy(): boolean { return false; }
  renderTo(el: HTMLElement): void { el.createSpan({ cls: "bases-formula-error", text: "Error", attr: { "aria-label": this.message, title: this.message } }); }
}

export interface EvalEnv {
  app: App;
  /** The row being evaluated (null for `this`-only contexts such as view options). */
  file: TFile | null;
  /** `this`: the base file, the embedding note, or the active file. */
  thisFile: TFile | null;
  formulas: Record<string, string>;
  formulaCache?: Map<string, Value>;
  evaluating?: Set<string>;
  locals?: Record<string, Value>;
}

const fail = (msg: string): never => { throw new BasesEvalError(msg); };

/** `this` behaves like the file, but bare member names read its note properties. */
class ThisValue extends FileValue {}
/** The `formula` namespace. */
class FormulaNamespace extends NotNullValue {
  toString(): string { return "formula"; }
  isTruthy(): boolean { return true; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Convert a frontmatter value of `file` to a Value (wikilinks become links, ISO dates become dates). */
export function frontmatterValue(app: App, raw: unknown, sourcePath: string, key?: string): Value {
  const type = key ? app.metadataTypeManager?.types?.[key.toLowerCase()] : undefined;
  const conv = (v: unknown): Value => {
    if (typeof v === "string") {
      const link = /^\s*!?\[\[.+\]\]\s*$/.test(v) || /^\s*\[[^\]]*\]\([^)]+\)\s*$/.test(v) ? LinkValue.parseFromString(app, v, sourcePath) : null;
      if (link) return link;
      if (type !== "text" && DATE_RE.test(v.trim())) { const d = DateValue.parseFromString(v); if (d) return d; }
      if (type === "number" && v.trim() !== "" && !isNaN(Number(v))) return new NumberValue(Number(v));
      return new StringValue(v);
    }
    if (Array.isArray(v)) return new ListValue(v.map(conv));
    if (v && typeof v === "object" && !(v instanceof Date)) return new ObjectValue(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)])));
    return wrapValue(v, sourcePath);
  };
  return conv(raw);
}

function frontmatterOf(app: App, file: TFile | null): Record<string, unknown> {
  if (!file || file.extension !== "md") return {};
  return (app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown>) ?? {};
}
/** Note property lookup: exact key first, then case-insensitive (Obsidian property names are case-insensitive). */
export function noteProperty(app: App, file: TFile | null, name: string): Value {
  const fm = frontmatterOf(app, file);
  let key: string | undefined = name in fm ? name : undefined;
  if (key === undefined) { const l = name.toLowerCase(); key = Object.keys(fm).find((k) => k.toLowerCase() === l); }
  return key === undefined ? NullValue.value : frontmatterValue(app, fm[key], file!.path, key);
}
function noteObject(app: App, file: TFile | null): ObjectValue {
  const fm = frontmatterOf(app, file);
  return new ObjectValue(Object.fromEntries(Object.keys(fm).map((k) => [k, frontmatterValue(app, fm[k], file!.path, k)])));
}

function unique<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** `file.<name>` fields. */
export function fileField(app: App, file: TFile, name: string): Value | undefined {
  const cache = file.extension === "md" ? app.metadataCache.getFileCache(file) : null;
  switch (name) {
    case "name": return new StringValue(file.name);
    case "basename": return new StringValue(file.basename);
    case "path": return new StringValue(file.path);
    case "folder": return new StringValue(file.parent?.path ?? "/");
    case "ext": case "extension": return new StringValue(file.extension);
    case "size": return new NumberValue(file.stat.size);
    case "ctime": return new DateValue(new Date(file.stat.ctime), true);
    case "mtime": return new DateValue(new Date(file.stat.mtime), true);
    case "file": return new FileValue(file);
    case "properties": return noteObject(app, file);
    case "tags": return new ListValue(unique(cache ? getAllTags(cache) ?? [] : [], (t) => t.toLowerCase()).map((t) => new TagValue(t)));
    case "links": {
      const refs = [...(cache?.links ?? []), ...(((cache as any)?.frontmatterLinks as { link: string }[]) ?? [])];
      return new ListValue(unique(refs, (r) => r.link).map((r) => new LinkValue(r.link, null, file.path)));
    }
    case "embeds": return new ListValue(unique(cache?.embeds ?? [], (r) => r.link).map((r) => new LinkValue(r.link, null, file.path)));
    case "backlinks": {
      const out: Value[] = [];
      for (const [src, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
        const f = targets[file.path] ? app.vault.getFileByPath(src) : null;
        if (f) out.push(new FileValue(f));
      }
      return new ListValue(out);
    }
  }
  return undefined;
}

function targetFile(app: App, v: Value, sourcePath: string): TFile | null {
  if (v instanceof FileValue) return v.file;
  if (v instanceof LinkValue) return v.resolve(app);
  if (v instanceof StringValue) {
    const s = v.value;
    return app.vault.getFileByPath(s) ?? LinkValue.parseFromString(app, s, sourcePath)?.resolve(app) ?? app.metadataCache.getFirstLinkpathDest(s, sourcePath);
  }
  return null;
}
function fileLinksTo(app: App, from: TFile, to: Value): boolean {
  const target = targetFile(app, to, from.path);
  const out = app.metadataCache.resolvedLinks[from.path] ?? {};
  if (target) return !!out[target.path];
  const s = to instanceof StringValue ? to.value : "";
  const un = app.metadataCache.unresolvedLinks[from.path] ?? {};
  return !!s && !!un[s];
}

// ------------------------------------------------------------------ coercions and comparisons

function num(v: Value): number | null {
  if (v instanceof NumberValue) return v.value;
  if (v instanceof BooleanValue) return v.value ? 1 : 0;
  if (v instanceof DurationValue) return v.getMilliseconds();
  if (v instanceof DateValue) return v.date.getTime();
  if (v instanceof StringValue && !(v instanceof LinkValue) && v.value.trim() !== "" && !isNaN(Number(v.value))) return Number(v.value);
  return null;
}
function asDuration(v: Value): DurationValue | null {
  if (v instanceof DurationValue) return v;
  if (v instanceof StringValue) return DurationValue.parseFromString(v.value);
  if (v instanceof NumberValue) return new DurationValue(v.value);
  return null;
}
function asDate(v: Value): DateValue | null {
  if (v instanceof DateValue) return v;
  if (v instanceof StringValue) return DateValue.parseFromString(v.value) ?? parseLooseDate(v.value);
  return null;
}
function parseLooseDate(s: string): DateValue | null {
  const formats = ["YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DDTHH:mm", "YYYY-MM-DD", "YYYY-MM", "YYYY"];
  const m = moment(s.trim(), formats, true);
  if (!m.isValid()) return null;
  return new DateValue(m.toDate(), /[T ]\d/.test(s.trim()));
}
const isStringy = (v: Value) => v instanceof StringValue;

export function valuesEqual(a: Value, b: Value): boolean {
  if (a instanceof NullValue || b instanceof NullValue) return a instanceof NullValue && b instanceof NullValue;
  return a.looseEquals(b) || b.looseEquals(a);
}

/** Ordering of two values, or null when they are not comparable. */
export function compareValues(a: Value, b: Value): number | null {
  if (a instanceof NullValue || b instanceof NullValue) return null;
  if (a instanceof DateValue || b instanceof DateValue) {
    const x = asDate(a), y = asDate(b);
    return x && y ? x.date.getTime() - y.date.getTime() : null;
  }
  if (a instanceof DurationValue || b instanceof DurationValue) {
    const x = num(a), y = num(b);
    return x !== null && y !== null ? x - y : null;
  }
  if (a instanceof NumberValue || b instanceof NumberValue || a instanceof BooleanValue || b instanceof BooleanValue) {
    const x = num(a), y = num(b);
    if (x !== null && y !== null) return x - y;
  }
  const s = a.toString(), t = b.toString();
  return s < t ? -1 : s > t ? 1 : 0;
}

/** Total order for sorting: nulls last, then numbers/dates numerically, text naturally. */
export function sortCompare(a: Value | null, b: Value | null): number {
  const an = !a || a instanceof NullValue || (a instanceof StringValue && a.value === ""), bn = !b || b instanceof NullValue || (b instanceof StringValue && b.value === "");
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  if ((a instanceof NumberValue || a instanceof DateValue || a instanceof DurationValue || a instanceof BooleanValue) && a.constructor === b!.constructor) return compareValues(a, b!) ?? 0;
  return a!.toString().localeCompare(b!.toString(), undefined, { numeric: true, sensitivity: "base" });
}

// ------------------------------------------------------------------ evaluation

export function evaluate(node: Node, env: EvalEnv): Value {
  switch (node.t) {
    case "num": return new NumberValue(node.v);
    case "str": return new StringValue(node.v);
    case "bool": return new BooleanValue(node.v);
    case "null": return NullValue.value;
    case "regex":
      try { return new RegExpValue(new RegExp(node.source, node.flags)); } catch (e) { return fail(`Invalid regular expression: ${(e as Error).message}`); }
    case "list": return new ListValue(node.items.map((n) => evaluate(n, env)));
    case "object": return new ObjectValue(Object.fromEntries(node.entries.map(([k, n]) => [k, evaluate(n, env)])));
    case "ident": return identifier(node.name, env);
    case "member": return member(evaluate(node.obj, env), node.name, env);
    case "index": {
      const obj = evaluate(node.obj, env), key = evaluate(node.key, env);
      if (obj instanceof ListValue) { const i = num(key); return i === null ? NullValue.value : obj.get(Math.trunc(i)); }
      return member(obj, key.toString(), env);
    }
    case "unary": {
      if (node.op === "!") return new BooleanValue(!evaluate(node.x, env).isTruthy());
      const v = evaluate(node.x, env);
      if (v instanceof NullValue) return v;
      if (node.op === "-" && v instanceof DurationValue) return new DurationValue(-v.ms, -v.months);
      const n = num(v);
      if (n === null) return fail(`Cannot apply "${node.op}" to ${typeName(v)}`);
      return new NumberValue(node.op === "-" ? -n : n);
    }
    case "binary": return binary(node.op, node.l, node.r, env);
    case "call": return call(node, env);
  }
}

function identifier(name: string, env: EvalEnv): Value {
  const local = env.locals?.[name];
  if (local) return local;
  switch (name) {
    case "file": return env.file ? new FileValue(env.file) : NullValue.value;
    case "note": return noteObject(env.app, env.file);
    case "formula": return new FormulaNamespace();
    case "this": return env.thisFile ? new ThisValue(env.thisFile) : NullValue.value;
  }
  return noteProperty(env.app, env.file, name);
}

/** Evaluate `formula.<name>` for the current row (cached per row, with cycle detection). */
export function evaluateFormula(name: string, env: EvalEnv): Value {
  const src = env.formulas[name];
  if (src === undefined || src === null) return NullValue.value;
  const cache = (env.formulaCache ??= new Map());
  const hit = cache.get(name);
  if (hit) return hit;
  const active = (env.evaluating ??= new Set());
  if (active.has(name)) return fail(`Circular formula reference: ${name}`);
  active.add(name);
  try {
    const v = String(src).trim() === "" ? NullValue.value : evaluate(parseExpression(String(src)), { ...env, locals: undefined });
    cache.set(name, v);
    return v;
  } finally { active.delete(name); }
}

function member(obj: Value, name: string, env: EvalEnv): Value {
  if (obj instanceof FormulaNamespace) return evaluateFormula(name, env);
  if (obj instanceof NullValue) return NullValue.value;
  if (obj instanceof ThisValue) {
    if (name === "file") return new FileValue(obj.file);
    if (name === "note") return noteObject(env.app, obj.file);
    return noteProperty(env.app, obj.file, name);
  }
  if (obj instanceof FileValue) return fileField(env.app, obj.file, name) ?? NullValue.value;
  if (obj instanceof DateValue) {
    const d = obj.date;
    const f: Record<string, () => number> = {
      year: () => d.getFullYear(), month: () => d.getMonth() + 1, day: () => d.getDate(), hour: () => d.getHours(),
      minute: () => d.getMinutes(), second: () => d.getSeconds(), millisecond: () => d.getMilliseconds(),
    };
    return f[name] ? new NumberValue(f[name]()) : NullValue.value;
  }
  if (name === "length" && (obj instanceof ListValue)) return new NumberValue(obj.value.length);
  if (name === "length" && obj instanceof StringValue) return new NumberValue(obj.value.length);
  if (obj instanceof ObjectValue) return obj.value[name] ?? NullValue.value;
  return NullValue.value;
}

function binary(op: string, ln: Node, rn: Node, env: EvalEnv): Value {
  if (op === "&&") { const l = evaluate(ln, env); return l.isTruthy() ? evaluate(rn, env) : l; }
  if (op === "||") { const l = evaluate(ln, env); return l.isTruthy() ? l : evaluate(rn, env); }
  const l = evaluate(ln, env), r = evaluate(rn, env);
  switch (op) {
    case "==": return new BooleanValue(valuesEqual(l, r));
    case "!=": return new BooleanValue(!valuesEqual(l, r));
    case "<": case "<=": case ">": case ">=": {
      const c = compareValues(l, r);
      if (c === null || isNaN(c)) return new BooleanValue(false);
      return new BooleanValue(op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0);
    }
    case "+": return add(l, r);
    case "-": return subtract(l, r);
    case "*": case "/": case "%": {
      if (l instanceof NullValue || r instanceof NullValue) return NullValue.value;
      if (l instanceof DurationValue && op !== "%") {
        const k = num(r);
        if (k === null) return fail(`Cannot ${op === "*" ? "multiply" : "divide"} a duration by ${typeName(r)}`);
        return op === "*" ? new DurationValue(l.ms * k, l.months * k) : new DurationValue(l.ms / k, l.months / k);
      }
      const a = num(l), b = num(r);
      if (a === null || b === null) return fail(`Cannot apply "${op}" to ${typeName(l)} and ${typeName(r)}`);
      return new NumberValue(op === "*" ? a * b : op === "/" ? a / b : a % b);
    }
  }
  return fail(`Unknown operator ${op}`);
}

function add(l: Value, r: Value): Value {
  if (l instanceof DateValue) {
    const d = asDuration(r);
    if (d) return d.addToDate(l);
  }
  if (r instanceof DateValue && l instanceof DurationValue) return l.addToDate(r);
  if (l instanceof DurationValue && r instanceof DurationValue) return new DurationValue(l.ms + r.ms, l.months + r.months);
  if (l instanceof NumberValue && r instanceof NumberValue) return new NumberValue(l.value + r.value);
  if (l instanceof ListValue && r instanceof ListValue) return l.concat(r);
  if (isStringy(l) || isStringy(r)) return new StringValue(l.toString() + r.toString());
  if (l instanceof NullValue || r instanceof NullValue) return NullValue.value;
  const a = num(l), b = num(r);
  if (a !== null && b !== null && !(l instanceof DateValue) && !(r instanceof DateValue)) return new NumberValue(a + b);
  return fail(`Cannot add ${typeName(l)} and ${typeName(r)}`);
}
function subtract(l: Value, r: Value): Value {
  if (l instanceof NullValue || r instanceof NullValue) return NullValue.value;
  if (l instanceof DateValue) {
    if (r instanceof DateValue) return new NumberValue(l.date.getTime() - r.date.getTime());
    const d = asDuration(r);
    if (d) return d.addToDate(l, true);
    const rd = asDate(r);
    if (rd) return new NumberValue(l.date.getTime() - rd.date.getTime());
  }
  if (l instanceof DurationValue && r instanceof DurationValue) return new DurationValue(l.ms - r.ms, l.months - r.months);
  const a = num(l), b = num(r);
  if (a !== null && b !== null) return new NumberValue(a - b);
  return fail(`Cannot subtract ${typeName(r)} from ${typeName(l)}`);
}

export function typeName(v: Value): string {
  if (v instanceof NullValue) return "null";
  if (v instanceof LinkValue) return "link";
  if (v instanceof HTMLValue) return "html";
  if (v instanceof ImageValue) return "image";
  if (v instanceof IconValue) return "icon";
  if (v instanceof UrlValue) return "url";
  if (v instanceof TagValue) return "tag";
  if (v instanceof StringValue) return "string";
  if (v instanceof NumberValue) return "number";
  if (v instanceof BooleanValue) return "boolean";
  if (v instanceof DateValue) return "date";
  if (v instanceof DurationValue) return "duration";
  if (v instanceof ListValue) return "list";
  if (v instanceof ObjectValue) return "object";
  if (v instanceof FileValue) return "file";
  if (v instanceof RegExpValue) return "regexp";
  if (v instanceof ErrorValue) return "error";
  return "unknown";
}

// ------------------------------------------------------------------ calls

const str = (v: Value | undefined): string => (v ? v.toString() : "");
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function call(node: Extract<Node, { t: "call" }>, env: EvalEnv): Value {
  const callee = node.callee;
  if (callee.t === "ident" && !env.locals?.[callee.name]) return globalCall(callee.name, node.args, env);
  if (callee.t === "member") return methodCall(evaluate(callee.obj, env), callee.name, node.args, env);
  return fail("Only functions and methods can be called");
}

function globalCall(name: string, argNodes: Node[], env: EvalEnv): Value {
  if (name === "if") {
    if (argNodes.length < 2) return fail("if() needs a condition and a result");
    return evaluate(argNodes[0], env).isTruthy() ? evaluate(argNodes[1], env) : argNodes[2] ? evaluate(argNodes[2], env) : NullValue.value;
  }
  const args = argNodes.map((n) => evaluate(n, env));
  const a0 = args[0] ?? NullValue.value;
  const app = env.app;
  switch (name) {
    case "now": return new DateValue(new Date(), true);
    case "today": { const d = new Date(); d.setHours(0, 0, 0, 0); return new DateValue(d, false); }
    case "date": {
      if (a0 instanceof DateValue) return a0;
      if (a0 instanceof NumberValue) return new DateValue(new Date(a0.value), true);
      if (a0 instanceof NullValue) return NullValue.value;
      return asDate(a0) ?? fail(`Cannot parse "${str(a0)}" as a date`);
    }
    case "duration": {
      if (a0 instanceof NullValue) return NullValue.value;
      return asDuration(a0) ?? fail(`Cannot parse "${str(a0)}" as a duration`);
    }
    case "file": {
      if (a0 instanceof FileValue) return new FileValue(a0.file);
      const f = targetFile(app, a0, env.file?.path ?? "");
      return f ? new FileValue(f) : NullValue.value;
    }
    case "link": {
      const display = args[1] && !(args[1] instanceof NullValue) ? args[1] : null;
      if (a0 instanceof FileValue) return new LinkValue(a0.file.path, display, "");
      if (a0 instanceof LinkValue) return new LinkValue(a0.value, display ?? a0.display, a0.sourcePath);
      if (a0 instanceof NullValue) return NullValue.value;
      const parsed = LinkValue.parseFromString(app, str(a0), env.file?.path ?? "");
      return parsed ? (display ? new LinkValue(parsed.value, display, parsed.sourcePath) : parsed) : new LinkValue(str(a0), display, env.file?.path ?? "");
    }
    case "list": return a0 instanceof ListValue ? a0 : new ListValue([a0]);
    case "max": case "min": {
      const flat = args.flatMap((v) => (v instanceof ListValue ? v.value : [v])).filter((v) => !(v instanceof NullValue));
      if (!flat.length) return NullValue.value;
      return flat.reduce((best, v) => { const c = compareValues(v, best); return c !== null && (name === "max" ? c > 0 : c < 0) ? v : best; });
    }
    case "number": {
      if (a0 instanceof NullValue) return NullValue.value;
      const n = num(a0);
      return n === null ? fail(`Cannot convert "${str(a0)}" to a number`) : new NumberValue(n);
    }
    case "random": return new NumberValue(Math.random());
    case "escapeHTML": return new StringValue(escapeHtml(str(a0)));
    case "html": return new HTMLValue(str(a0));
    case "icon": return new IconValue(str(a0));
    case "image": {
      if (a0 instanceof FileValue) return new ImageValue(a0.file.path);
      if (a0 instanceof LinkValue) return new ImageValue(a0.resolve(app)?.path ?? a0.value);
      return a0 instanceof NullValue ? NullValue.value : new ImageValue(str(a0));
    }
  }
  return fail(`Unknown function "${name}"`);
}

const TYPE_ALIASES: Record<string, string[]> = { string: ["string", "link", "html", "image", "icon", "url", "tag"], date: ["date"], file: ["file"] };

function methodCall(obj: Value, name: string, argNodes: Node[], env: EvalEnv): Value {
  // Methods taking an expression evaluated per element.
  if (obj instanceof ListValue && (name === "filter" || name === "map" || name === "reduce")) {
    const expr = argNodes[0];
    if (!expr) return fail(`${name}() needs an expression`);
    const withLocals = (locals: Record<string, Value>): EvalEnv => ({ ...env, locals: { ...env.locals, ...locals } });
    if (name === "filter") return new ListValue(obj.value.filter((value, i) => evaluate(expr, withLocals({ value, index: new NumberValue(i) })).isTruthy()));
    if (name === "map") return new ListValue(obj.value.map((value, i) => evaluate(expr, withLocals({ value, index: new NumberValue(i) }))));
    let acc = argNodes[1] ? evaluate(argNodes[1], env) : NullValue.value;
    obj.value.forEach((value, i) => { acc = evaluate(expr, withLocals({ value, index: new NumberValue(i), acc })); });
    return acc;
  }
  const args = argNodes.map((n) => evaluate(n, env));
  const a0 = args[0] ?? NullValue.value;
  // Any type
  switch (name) {
    case "isTruthy": return new BooleanValue(obj.isTruthy());
    case "toString": return new StringValue(obj.toString());
    case "isType": {
      const want = str(a0).toLowerCase(), t = typeName(obj);
      return new BooleanValue(t === want || (TYPE_ALIASES[want]?.includes(t) ?? false));
    }
  }
  if (obj instanceof NullValue) return name === "isEmpty" ? new BooleanValue(true) : NullValue.value;
  if (obj instanceof ErrorValue) return obj;
  if (obj instanceof FileValue) return fileMethod(obj.file, name, args, env);
  if (obj instanceof LinkValue && !obj.isExternal && (name === "asFile" || name === "linksTo")) {
    const f = obj.resolve(env.app);
    if (name === "asFile") return f ? new FileValue(f) : NullValue.value;
    return new BooleanValue(!!f && fileLinksTo(env.app, f, a0));
  }
  if (obj instanceof StringValue) return stringMethod(obj.value, name, args);
  if (obj instanceof NumberValue) return numberMethod(obj.value, name, args);
  if (obj instanceof DateValue) {
    switch (name) {
      case "date": return obj.dateOnly();
      case "format": return new StringValue(moment(obj.date).format(args.length ? str(a0) : undefined));
      case "time": return new StringValue(moment(obj.date).format("HH:mm:ss"));
      case "relative": return new StringValue(obj.relative());
      case "isEmpty": return new BooleanValue(false);
    }
  }
  if (obj instanceof ListValue) return listMethod(obj, name, args);
  if (obj instanceof ObjectValue) {
    switch (name) {
      case "isEmpty": return new BooleanValue(obj.isEmpty());
      case "keys": return new ListValue(Object.keys(obj.value).map((k) => new StringValue(k)));
      case "values": return new ListValue(Object.values(obj.value));
    }
  }
  if (obj instanceof RegExpValue && name === "matches") { obj.regex.lastIndex = 0; return new BooleanValue(obj.regex.test(str(a0))); }
  if (name === "isEmpty") return new BooleanValue(false);
  return fail(`Unknown function "${name}" for ${typeName(obj)}`);
}

function fileMethod(file: TFile, name: string, args: Value[], env: EvalEnv): Value {
  const app = env.app;
  switch (name) {
    case "asLink": return new LinkValue(file.path, args[0] && !(args[0] instanceof NullValue) ? args[0] : null, "");
    case "hasLink": return new BooleanValue(!!args[0] && fileLinksTo(app, file, args[0]));
    case "hasProperty": {
      const want = str(args[0]).toLowerCase(), fm = frontmatterOf(app, file);
      return new BooleanValue(Object.keys(fm).some((k) => k.toLowerCase() === want));
    }
    case "hasTag": {
      const cache = file.extension === "md" ? app.metadataCache.getFileCache(file) : null;
      const tags = (cache ? getAllTags(cache) ?? [] : []).map((t) => t.replace(/^#/, "").toLowerCase());
      const wants = args.flatMap((a) => (a instanceof ListValue ? a.value : [a])).map((a) => str(a).replace(/^#/, "").toLowerCase()).filter(Boolean);
      return new BooleanValue(wants.some((w) => tags.some((t) => t === w || t.startsWith(w + "/"))));
    }
    case "inFolder": {
      const target = args[0] instanceof FileValue ? args[0].file.path : str(args[0]);
      const folder = target.replace(/^\/+|\/+$/g, "");
      if (!folder) return new BooleanValue(true);
      const f = folder.toLowerCase(), p = file.path.toLowerCase();
      return new BooleanValue(p.startsWith(f + "/"));
    }
    case "isEmpty": return new BooleanValue(false);
  }
  return fail(`Unknown function "${name}" for file`);
}

function titleCase(s: string): string { return s.replace(/(^|[\s\-_([{"'])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase()); }

function stringMethod(s: string, name: string, args: Value[]): Value {
  const a = args.map(str);
  switch (name) {
    case "contains": return new BooleanValue(s.includes(a[0] ?? ""));
    case "containsAll": return new BooleanValue(a.every((x) => s.includes(x)));
    case "containsAny": return new BooleanValue(a.some((x) => s.includes(x)));
    case "startsWith": return new BooleanValue(s.startsWith(a[0] ?? ""));
    case "endsWith": return new BooleanValue(s.endsWith(a[0] ?? ""));
    case "isEmpty": return new BooleanValue(s.length === 0);
    case "lower": return new StringValue(s.toLowerCase());
    case "title": return new StringValue(titleCase(s));
    case "trim": return new StringValue(s.trim());
    case "reverse": return new StringValue([...s].reverse().join(""));
    case "repeat": { const n = args[0] ? num(args[0]) : 0; return new StringValue(s.repeat(Math.max(0, Math.trunc(n ?? 0)))); }
    case "slice": return new StringValue(s.slice(num(args[0] ?? NullValue.value) ?? 0, args[1] && !(args[1] instanceof NullValue) ? num(args[1]) ?? undefined : undefined));
    case "replace": {
      const pat = args[0], rep = a[1] ?? "";
      if (pat instanceof RegExpValue) return new StringValue(s.replace(pat.regex, rep));
      return new StringValue(a[0] ? s.split(a[0]).join(rep) : s);
    }
    case "split": {
      const sep = args[0] instanceof RegExpValue ? args[0].regex : a[0] ?? "";
      let parts = s.split(sep as string);
      const n = args[1] ? num(args[1]) : null;
      if (n !== null) parts = parts.slice(0, n);
      return new ListValue(parts.map((p) => new StringValue(p)));
    }
  }
  return fail(`Unknown function "${name}" for string`);
}

function numberMethod(n: number, name: string, args: Value[]): Value {
  switch (name) {
    case "abs": return new NumberValue(Math.abs(n));
    case "ceil": return new NumberValue(Math.ceil(n));
    case "floor": return new NumberValue(Math.floor(n));
    case "isEmpty": return new BooleanValue(false);
    case "round": {
      const d = args[0] ? num(args[0]) ?? 0 : 0;
      const k = Math.pow(10, Math.trunc(d));
      return new NumberValue(Math.round(n * k) / k);
    }
    case "toFixed": {
      const d = Math.min(100, Math.max(0, Math.trunc(args[0] ? num(args[0]) ?? 0 : 0)));
      return new StringValue(n.toFixed(d));
    }
  }
  return fail(`Unknown function "${name}" for number`);
}

function numbers(list: ListValue): number[] {
  return list.value.filter((v) => v instanceof NumberValue).map((v) => (v as NumberValue).value);
}
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function listMethod(list: ListValue, name: string, args: Value[]): Value {
  const xs = list.value;
  switch (name) {
    case "contains": return new BooleanValue(!!args[0] && list.includes(args[0]));
    case "containsAll": return new BooleanValue(args.every((v) => list.includes(v)));
    case "containsAny": return new BooleanValue(args.some((v) => list.includes(v)));
    case "isEmpty": return new BooleanValue(xs.length === 0);
    case "flat": {
      const out: Value[] = [];
      const walk = (vs: Value[]) => { for (const v of vs) if (v instanceof ListValue) walk(v.value); else out.push(v); };
      walk(xs);
      return new ListValue(out);
    }
    case "join": return new StringValue(xs.map((v) => v.toString()).join(args[0] ? str(args[0]) : ","));
    case "reverse": return new ListValue([...xs].reverse());
    case "slice": return new ListValue(xs.slice(num(args[0] ?? NullValue.value) ?? 0, args[1] && !(args[1] instanceof NullValue) ? num(args[1]) ?? undefined : undefined));
    case "sort": return new ListValue([...xs].sort(sortCompare));
    case "unique": {
      const out: Value[] = [];
      for (const v of xs) if (!out.some((o) => valuesEqual(o, v))) out.push(v);
      return new ListValue(out);
    }
    // Aggregates used by summary formulas (`values.mean()`).
    case "sum": return new NumberValue(numbers(list).reduce((a, b) => a + b, 0));
    case "mean": case "average": { const ns = numbers(list); return ns.length ? new NumberValue(ns.reduce((a, b) => a + b, 0) / ns.length) : NullValue.value; }
    case "median": { const m = median(numbers(list)); return m === null ? NullValue.value : new NumberValue(m); }
    case "min": case "max": {
      const vs = xs.filter((v) => !(v instanceof NullValue));
      if (!vs.length) return NullValue.value;
      return vs.reduce((best, v) => { const c = compareValues(v, best); return c !== null && (name === "max" ? c > 0 : c < 0) ? v : best; });
    }
  }
  return fail(`Unknown function "${name}" for list`);
}

/** Evaluate a source string; errors become an ErrorValue. */
export function evaluateSource(src: string, env: EvalEnv): Value {
  try { return evaluate(parseExpression(src), env); } catch (e) { return new ErrorValue((e as Error).message); }
}

