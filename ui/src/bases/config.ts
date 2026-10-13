// `.base` file model: parse/serialize YAML (unknown keys survive a round trip), property ids, display names, filter trees.
import * as yaml from "js-yaml";
import { evaluate, type EvalEnv } from "./evaluate";
import { parseExpression } from "./expr";

export type FilterNode = string | { and: FilterNode[] } | { or: FilterNode[] } | { not: FilterNode[] };
export interface SortSpec { property: string; direction: "ASC" | "DESC" }
export interface ViewRaw {
  type: string;
  name: string;
  limit?: number;
  filters?: FilterNode;
  order?: string[];
  sort?: SortSpec[];
  groupBy?: { property: string; direction?: "ASC" | "DESC" };
  groupOrder?: unknown[];
  summaries?: Record<string, string>;
  [key: string]: unknown;
}

export class BaseConfigError extends Error {}

/** In-memory `.base` document. `raw` is the parsed YAML object itself, so keys this code does not know are kept. */
export class BaseConfig {
  constructor(public raw: Record<string, any>) {}
  static parse(text: string): BaseConfig {
    let v: unknown;
    try { v = text.trim() ? yaml.load(text) : {}; } catch (e) { throw new BaseConfigError(`Invalid YAML: ${(e as Error).message.split("\n")[0]}`); }
    if (v === null || v === undefined) v = {};
    if (typeof v !== "object" || Array.isArray(v)) throw new BaseConfigError("A base must be a YAML mapping");
    const raw = v as Record<string, any>;
    if (raw.views !== undefined && !Array.isArray(raw.views)) throw new BaseConfigError("\"views\" must be a list");
    return new BaseConfig(raw);
  }
  serialize(): string {
    const clean = JSON.parse(JSON.stringify(this.raw, (_k, v) => (v === undefined ? undefined : v)));
    if (Array.isArray(clean.views) && !clean.views.length) delete clean.views;
    return Object.keys(clean).length ? yaml.dump(clean, { lineWidth: -1, noRefs: true }) : "";
  }
  get filters(): FilterNode | undefined { return this.raw.filters ?? undefined; }
  get formulas(): Record<string, string> { const f = this.raw.formulas; return f && typeof f === "object" ? f : {}; }
  get properties(): Record<string, Record<string, any>> { const p = this.raw.properties; return p && typeof p === "object" ? p : {}; }
  get summaries(): Record<string, string> { const s = this.raw.summaries; return s && typeof s === "object" ? s : {}; }
  get views(): ViewRaw[] {
    if (!Array.isArray(this.raw.views)) this.raw.views = [];
    return (this.raw.views as ViewRaw[]).filter((v) => v && typeof v === "object");
  }
  /** Index of the view called `name` (case-insensitive), else 0. */
  viewIndex(name?: string | null): number {
    if (!name) return 0;
    const l = name.toLowerCase();
    const i = this.views.findIndex((v) => String(v.name ?? "").toLowerCase() === l);
    return i < 0 ? 0 : i;
  }
  setFormula(name: string, src: string | null): void {
    const f = (this.raw.formulas && typeof this.raw.formulas === "object" ? this.raw.formulas : (this.raw.formulas = {})) as Record<string, string>;
    if (src === null) delete f[name]; else f[name] = src;
    if (!Object.keys(f).length) delete this.raw.formulas;
  }
  setDisplayName(id: string, name: string | null): void {
    const props = (this.raw.properties && typeof this.raw.properties === "object" ? this.raw.properties : (this.raw.properties = {})) as Record<string, any>;
    const key = id.startsWith("note.") && !(id in props) && id.slice(5) in props ? id.slice(5) : id;
    const entry = (props[key] && typeof props[key] === "object" ? props[key] : (props[key] = {})) as Record<string, any>;
    if (name === null || name === "") delete entry.displayName; else entry.displayName = name;
    if (!Object.keys(entry).length) delete props[key];
    if (!Object.keys(props).length) delete this.raw.properties;
  }
}

/** `status` -> `note.status`; prefixed ids are kept. */
export function normalizePropertyId(id: string): string {
  const s = String(id).trim();
  return /^(note|file|formula)\./.test(s) ? s : `note.${s}`;
}
export function splitPropertyId(id: string): { type: "note" | "file" | "formula"; name: string } {
  const n = normalizePropertyId(id), i = n.indexOf(".");
  return { type: n.slice(0, i) as "note", name: n.slice(i + 1) };
}

export const FILE_PROPERTIES: Record<string, string> = {
  "file.name": "file name", "file.basename": "file base name", "file.path": "file path", "file.folder": "folder", "file.ext": "file extension",
  "file.size": "file size", "file.ctime": "created time", "file.mtime": "modified time", "file.tags": "file tags", "file.links": "file links",
  "file.embeds": "file embeds", "file.backlinks": "backlinks", "file.properties": "file properties",
};

export function displayName(cfg: BaseConfig, id: string): string {
  const n = normalizePropertyId(id), props = cfg.properties;
  const bare = n.startsWith("note.") ? n.slice(5) : null;
  const entry = props[n] ?? (bare !== null ? props[bare] : undefined) ?? props[id];
  if (entry && typeof entry === "object" && typeof entry.displayName === "string" && entry.displayName) return entry.displayName;
  return FILE_PROPERTIES[n] ?? splitPropertyId(n).name;
}

/** Evaluate a filter tree for one row; a statement that fails to evaluate counts as false. */
export function matchesFilter(node: FilterNode | undefined | null, env: EvalEnv): boolean {
  if (node === undefined || node === null) return true;
  if (typeof node === "string") {
    if (!node.trim()) return true;
    try { return evaluate(parseExpression(node), env).isTruthy(); } catch { return false; }
  }
  if (typeof node === "boolean") return node;
  if (typeof node !== "object") return true;
  const o = node as Record<string, FilterNode[]>;
  const list = (k: string): FilterNode[] => (Array.isArray(o[k]) ? o[k] : o[k] !== undefined && o[k] !== null ? [o[k] as unknown as FilterNode] : []);
  if ("and" in o) return list("and").every((n) => matchesFilter(n, env));
  if ("or" in o) { const l = list("or"); return !l.length || l.some((n) => matchesFilter(n, env)); }
  if ("not" in o) return !list("not").some((n) => matchesFilter(n, env));
  return true;
}

/** Add `expr` to an `and` group of the filter (creating or wrapping as needed). */
export function addCondition(f: FilterNode | undefined, expr: string): FilterNode {
  if (f === undefined || f === null || f === "") return { and: [expr] };
  if (typeof f === "object" && "and" in f && Array.isArray(f.and)) return { ...f, and: [...f.and, expr] };
  return { and: [f, expr] };
}

/** Syntax errors of every statement in a filter tree. */
export function filterErrors(node: FilterNode | undefined | null): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (typeof n === "string") { try { if (n.trim()) parseExpression(n); } catch (e) { out.push(`${n}: ${(e as Error).message}`); } }
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") Object.values(n).forEach(walk);
  };
  walk(node);
  return out;
}
