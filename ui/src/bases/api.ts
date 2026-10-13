// Public Bases API (BasesEntry, BasesQueryResult, BasesViewConfig, BasesView, QueryController, parsePropertyId) and query execution.
import { Component } from "../obsidian/events";
import type { App } from "../obsidian/app";
import type { TFile } from "../obsidian/files";
import {
  BooleanValue, DateValue, DurationValue, ListValue, NullValue, NumberValue, StringValue, Value, wrapValue,
} from "../obsidian/values";
import { BaseConfig, displayName, matchesFilter, normalizePropertyId, splitPropertyId, type SortSpec, type ViewRaw } from "./config";
import { ErrorValue, evaluateFormula, evaluate, fileField, median, noteProperty, sortCompare, valuesEqual, type EvalEnv } from "./evaluate";
import { parseExpression } from "./expr";

export type BasesPropertyId = string;

export function parsePropertyId(propertyId: BasesPropertyId): { type: "note" | "formula" | "file"; name: string } {
  return splitPropertyId(propertyId);
}

/** Shared state of one query run (formulas and `this`), referenced by every entry. */
export interface QueryScope { app: App; formulas: Record<string, string>; thisFile: TFile | null }

/** One row (file) of a base. */
export class BasesEntry {
  private env: EvalEnv | null;
  constructor(public file: TFile, scope?: QueryScope) {
    this.env = scope ? { app: scope.app, file, thisFile: scope.thisFile, formulas: scope.formulas, formulaCache: new Map() } : null;
  }
  /** Evaluation environment for this row (internal). */
  get _env(): EvalEnv {
    return (this.env ??= { app: (globalThis as any).app, file: this.file, thisFile: null, formulas: {}, formulaCache: new Map() });
  }
  getValue(propertyId: BasesPropertyId): Value | null {
    const { type, name } = splitPropertyId(propertyId);
    const env = this._env;
    try {
      if (type === "file") return fileField(env.app, this.file, name) ?? NullValue.value;
      if (type === "formula") return name in env.formulas ? evaluateFormula(name, env) : null;
      return noteProperty(env.app, this.file, name);
    } catch (e) { return new ErrorValue((e as Error).message); }
  }
}

export class BasesEntryGroup {
  key?: Value;
  entries: BasesEntry[] = [];
  constructor(key?: Value, entries: BasesEntry[] = []) { this.key = key; this.entries = entries; }
  hasKey(): boolean { return !!this.key && !(this.key instanceof NullValue); }
}

const isEmptyValue = (v: Value | null): boolean =>
  !v || v instanceof NullValue || (v instanceof StringValue && v.value === "") || (v instanceof ListValue && v.value.length === 0);

/** Built-in summary functions (names as written in `.base` files). */
export const DEFAULT_SUMMARIES = ["Average", "Min", "Max", "Sum", "Range", "Median", "Stddev", "Earliest", "Latest", "Checked", "Unchecked", "Empty", "Filled", "Unique"];

export function computeSummary(name: string, values: (Value | null)[], custom: Record<string, string>, env?: Omit<EvalEnv, "file">): Value {
  const key = DEFAULT_SUMMARIES.find((d) => d.toLowerCase() === name.toLowerCase());
  const nums = values.filter((v): v is NumberValue => v instanceof NumberValue).map((v) => v.value);
  const dates = values.filter((v): v is DateValue => v instanceof DateValue);
  const n = (x: number | null) => (x === null || isNaN(x) ? NullValue.value : new NumberValue(x));
  switch (key) {
    case "Average": return n(nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null);
    case "Sum": return n(nums.reduce((a, b) => a + b, 0));
    case "Min": return n(nums.length ? Math.min(...nums) : null);
    case "Max": return n(nums.length ? Math.max(...nums) : null);
    case "Median": return n(median(nums));
    case "Stddev": {
      if (!nums.length) return NullValue.value;
      const m = nums.reduce((a, b) => a + b, 0) / nums.length;
      return n(Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length));
    }
    case "Range":
      if (dates.length && !nums.length) {
        const t = dates.map((d) => d.date.getTime());
        return new DurationValue(Math.max(...t) - Math.min(...t));
      }
      return n(nums.length ? Math.max(...nums) - Math.min(...nums) : null);
    case "Earliest": case "Latest": {
      if (!dates.length) return NullValue.value;
      return dates.reduce((a, b) => ((key === "Earliest" ? b.date < a.date : b.date > a.date) ? b : a));
    }
    case "Checked": return new NumberValue(values.filter((v) => v instanceof BooleanValue && v.value).length);
    case "Unchecked": return new NumberValue(values.filter((v) => v instanceof BooleanValue && !v.value).length);
    case "Empty": return new NumberValue(values.filter(isEmptyValue).length);
    case "Filled": return new NumberValue(values.filter((v) => !isEmptyValue(v)).length);
    case "Unique": {
      const seen: Value[] = [];
      for (const v of values) if (!isEmptyValue(v) && !seen.some((s) => valuesEqual(s, v!))) seen.push(v!);
      return new NumberValue(seen.length);
    }
  }
  const src = custom[name];
  if (src === undefined || !env) return NullValue.value;
  try {
    return evaluate(parseExpression(String(src)), { ...env, file: null, locals: { values: new ListValue(values.map((v) => v ?? NullValue.value)) } });
  } catch (e) { return new ErrorValue((e as Error).message); }
}

export class BasesQueryResult {
  data: BasesEntry[];
  private _groups: BasesEntryGroup[] | null;
  private _properties: BasesPropertyId[];
  constructor(data: BasesEntry[] = [], opts: { groups?: BasesEntryGroup[] | null; properties?: BasesPropertyId[]; config?: BaseConfig; scope?: QueryScope } = {}) {
    this.data = data;
    this._groups = opts.groups ?? null;
    this._properties = opts.properties ?? [];
    this.config = opts.config ?? null;
    this.scope = opts.scope ?? null;
  }
  /** Internal: what produced this result (custom summaries need the base config). */
  config: BaseConfig | null;
  scope: QueryScope | null;
  get groupedData(): BasesEntryGroup[] { return this._groups ?? [new BasesEntryGroup(undefined, this.data)]; }
  get properties(): BasesPropertyId[] { return this._properties; }
  getSummaryValue(_queryController: QueryController | null, entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
    const values = entries.map((e) => e.getValue(prop));
    const scope = this.scope;
    return computeSummary(summaryKey, values, this.config?.summaries ?? {}, scope ? { app: scope.app, thisFile: scope.thisFile, formulas: scope.formulas } : undefined);
  }
}

/** The in-memory form of one entry of `views:`; writes go back to the raw YAML object and notify the owner. */
export class BasesViewConfig {
  constructor(public raw: ViewRaw = { type: "table", name: "" }, public base: BaseConfig = new BaseConfig({ views: [raw] }), private onChange: (key: string) => void = () => {}) {}
  get name(): string { return String(this.raw.name ?? ""); }
  set name(v: string) { this.raw.name = v; this.onChange("name"); }
  get type(): string { return String(this.raw.type ?? "table"); }
  get(key: string): unknown { return this.raw[key]; }
  getAsPropertyId(key: string): BasesPropertyId | null {
    const v = this.raw[key];
    return typeof v === "string" && v.trim() ? normalizePropertyId(v) : null;
  }
  getEvaluatedFormula(view: BasesView, key: string): Value {
    const v = this.raw[key];
    if (typeof v !== "string" || !v.trim()) return NullValue.value;
    const scope = (view.controller as QueryController | undefined)?.scope;
    try {
      return evaluate(parseExpression(v), { app: view.app, file: scope?.thisFile ?? null, thisFile: scope?.thisFile ?? null, formulas: this.base.formulas });
    } catch { return NullValue.value; }
  }
  set(key: string, value: any | null): void {
    if (value === null || value === undefined) delete this.raw[key]; else this.raw[key] = value;
    this.onChange(key);
  }
  getOrder(): BasesPropertyId[] {
    const o = this.raw.order;
    return Array.isArray(o) ? o.filter((x) => typeof x === "string" && x.trim()).map(normalizePropertyId) : [];
  }
  getSort(): { property: BasesPropertyId; direction: "ASC" | "DESC" }[] {
    const s = this.raw.sort;
    if (!Array.isArray(s)) return [];
    return s.filter((x: any) => x && typeof x.property === "string" && x.property.trim())
      .map((x: SortSpec) => ({ property: normalizePropertyId(x.property), direction: String(x.direction).toUpperCase() === "DESC" ? "DESC" : "ASC" }));
  }
  getDisplayName(propertyId: BasesPropertyId): string { return displayName(this.base, propertyId); }
}

/** Runs the query for a view and feeds results to it. Concrete implementation: BasesController (host.ts). */
export class QueryController extends Component {
  app!: App;
  /** Formulas and `this` of the current run. */
  scope: QueryScope | null = null;
  /** Config/result for the view being constructed (read by the BasesView constructor). */
  _viewConfig: BasesViewConfig | null = null;
  _result: BasesQueryResult | null = null;
  _allProperties: BasesPropertyId[] = [];
  /** Create a note for the given view (BasesView.createFileForView). */
  async createFile(_view: BasesView, _name?: string, _fm?: (frontmatter: any, file: TFile) => void): Promise<void> {}
}

export abstract class BasesView extends Component {
  abstract type: string;
  app: App;
  config: BasesViewConfig;
  allProperties: BasesPropertyId[];
  data: BasesQueryResult;
  controller: QueryController;
  protected constructor(controller: QueryController) {
    super();
    this.controller = controller;
    this.app = controller?.app ?? (globalThis as any).app;
    this.config = controller?._viewConfig ?? new BasesViewConfig();
    this.data = controller?._result ?? new BasesQueryResult();
    this.allProperties = controller?._allProperties ?? [];
  }
  abstract onDataUpdated(): void;
  async createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any, file: TFile) => void): Promise<void> {
    await this.controller?.createFile(this, baseFileName, frontmatterProcessor);
  }
}

export interface BasesViewRegistration {
  name: string;
  icon: string;
  factory: (controller: QueryController, containerEl: HTMLElement) => BasesView;
  options?: (config: BasesViewConfig) => any[];
}

// ------------------------------------------------------------------ query execution

export interface QueryRun {
  result: BasesQueryResult;
  /** Rows that matched the filters before `limit` was applied. */
  total: number;
  allProperties: BasesPropertyId[];
}

/** Execute view `view` of `config` against the vault. */
export function runQuery(app: App, config: BaseConfig, view: ViewRaw | undefined, thisFile: TFile | null): QueryRun {
  const scope: QueryScope = { app, formulas: config.formulas, thisFile };
  const files = app.vault.getFiles().slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let rows: BasesEntry[] = [];
  for (const f of files) {
    const e = new BasesEntry(f, scope);
    if (matchesFilter(config.filters, e._env) && matchesFilter(view?.filters, e._env)) rows.push(e);
  }
  const vc = new BasesViewConfig(view ?? { type: "table", name: "" }, config);
  const sorts = vc.getSort();
  if (sorts.length) {
    const keyed = rows.map((e, i) => ({ e, i, k: sorts.map((s) => e.getValue(s.property)) }));
    keyed.sort((a, b) => {
      for (let j = 0; j < sorts.length; j++) {
        const c = sortCompare(a.k[j], b.k[j]);
        if (c) return sorts[j].direction === "DESC" && !(isEmptyValue(a.k[j]) || isEmptyValue(b.k[j])) ? -c : c;
      }
      return a.i - b.i;
    });
    rows = keyed.map((x) => x.e);
  }
  const total = rows.length;
  const limit = Number(view?.limit);
  if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);

  let groups: BasesEntryGroup[] | null = null;
  const gb = view?.groupBy;
  const gprop = gb && typeof gb === "object" && typeof gb.property === "string" && gb.property.trim() ? normalizePropertyId(gb.property) : null;
  if (gprop) {
    const buckets: BasesEntryGroup[] = [];
    for (const e of rows) {
      const k = e.getValue(gprop) ?? NullValue.value;
      const key = isEmptyValue(k) ? NullValue.value : k;
      let g = buckets.find((b) => valuesEqual(b.key ?? NullValue.value, key));
      if (!g) buckets.push((g = new BasesEntryGroup(key)));
      g.entries.push(e);
    }
    const desc = String(gb!.direction ?? "ASC").toUpperCase() === "DESC";
    buckets.sort((a, b) => {
      const an = !a.hasKey(), bn = !b.hasKey();
      if (an || bn) return an && bn ? 0 : an ? 1 : -1;
      const c = sortCompare(a.key!, b.key!);
      return desc ? -c : c;
    });
    if (Array.isArray(view!.groupOrder)) {
      groups = view!.groupOrder.map((raw) => {
        const want = raw === null ? NullValue.value : wrapValue(raw);
        return buckets.find((b) => valuesEqual(b.key ?? NullValue.value, want)) ?? new BasesEntryGroup(want);
      });
    } else groups = buckets;
  }

  let properties = vc.getOrder();
  if (!properties.length) properties = ["file.name"];
  const result = new BasesQueryResult(rows, { groups, properties, config, scope });
  return { result, total, allProperties: collectProperties(app, config, rows) };
}

/** Every property id available in a result set: note properties seen in the rows, file properties, formulas. */
export function collectProperties(app: App, config: BaseConfig, rows: BasesEntry[]): BasesPropertyId[] {
  const note = new Map<string, string>();
  for (const e of rows) {
    const fm = e.file.extension === "md" ? app.metadataCache.getFileCache(e.file)?.frontmatter : null;
    for (const k of Object.keys(fm ?? {})) if (!note.has(k.toLowerCase())) note.set(k.toLowerCase(), k);
  }
  for (const id of config.views.flatMap((v) => (Array.isArray(v.order) ? v.order : []))) {
    const n = normalizePropertyId(String(id));
    if (n.startsWith("note.") && !note.has(n.slice(5).toLowerCase())) note.set(n.slice(5).toLowerCase(), n.slice(5));
  }
  const fileProps = ["file.name", "file.basename", "file.path", "file.folder", "file.ext", "file.size", "file.ctime", "file.mtime", "file.tags", "file.links", "file.embeds", "file.backlinks"];
  return [...[...note.values()].sort((a, b) => a.localeCompare(b)).map((k) => `note.${k}`), ...fileProps, ...Object.keys(config.formulas).map((k) => `formula.${k}`)];
}
