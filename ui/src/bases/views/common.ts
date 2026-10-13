// Helpers shared by the built-in Bases views: value rendering, group headings, frontmatter editing.
import type { App } from "../../obsidian/app";
import type { TFile } from "../../obsidian/files";
import { BooleanValue, DateValue, LinkValue, ListValue, NullValue, NumberValue, RenderContext, StringValue, UrlValue, Value } from "../../obsidian/values";
import { splitPropertyId } from "../config";
import type { BasesEntry, BasesEntryGroup } from "../api";

const ctx = new RenderContext();

/** Render a cell value. `file.name` renders as a link to the row's file. */
export function renderValue(el: HTMLElement, app: App, entry: BasesEntry, prop: string): void {
  const wrap = el.createDiv({ cls: "bases-rendered-value" });
  if (prop === "file.name") {
    const f = entry.file;
    const a = wrap.createEl("a", { cls: "internal-link", text: f.extension === "md" ? f.basename : f.name, attr: { "data-href": f.path, href: f.path } });
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); void app.workspace.getLeaf(e.ctrlKey || e.metaKey ? "tab" : false).openFile(f); });
    return;
  }
  const v = entry.getValue(prop);
  renderPlain(wrap, v);
}
export function renderPlain(el: HTMLElement, v: Value | null): void {
  if (!v || v instanceof NullValue) return;
  if (v.constructor === StringValue && /^https?:\/\/\S+$/.test((v as StringValue).value)) { new UrlValue((v as StringValue).value).renderTo(el, ctx); return; }
  v.renderTo(el, ctx);
}

export function groupLabel(el: HTMLElement, group: BasesEntryGroup, prop: string | null, displayName: (p: string) => string): void {
  const head = el.createDiv({ cls: "bases-group-heading" });
  if (prop) head.createSpan({ cls: "bases-group-property", text: displayName(prop) });
  const val = head.createSpan({ cls: "bases-group-value" });
  if (group.hasKey()) renderPlain(val, group.key!); else val.setText("None");
  head.createSpan({ cls: "bases-group-row-count", text: String(group.entries.length) });
}

/** Actual frontmatter key for a note property (case-insensitive match), or the name itself. */
export function frontmatterKey(app: App, file: TFile, name: string): string {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
  return Object.keys(fm).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

/** Parse what the user typed into a cell, guided by the previous value's type. */
export function parseCellInput(text: string, prev: Value | null): unknown {
  const t = text.trim();
  if (t === "") return null;
  if (prev instanceof ListValue) return t.split(",").map((s) => s.trim()).filter(Boolean);
  if (prev instanceof NumberValue || (!(prev instanceof StringValue) && /^-?\d+(\.\d+)?$/.test(t))) { const n = Number(t); if (!isNaN(n)) return n; }
  if (prev instanceof BooleanValue) return /^(true|yes|1)$/i.test(t);
  return text;
}
export function cellInputText(v: Value | null): string {
  if (!v || v instanceof NullValue) return "";
  if (v instanceof ListValue) return v.value.map((x) => rawText(x)).join(", ");
  return rawText(v);
}
function rawText(v: Value): string {
  if (v instanceof LinkValue) return v.isExternal ? v.value : v.display ? `[[${v.value}|${v.display}]]` : `[[${v.value}]]`;
  if (v instanceof DateValue) return v.toString();
  return v instanceof StringValue ? v.value : v.toString();
}

/** Write a note property of `file` (frontmatter) through FileManager.processFrontMatter. */
export async function writeProperty(app: App, file: TFile, prop: string, value: unknown): Promise<void> {
  const { type, name } = splitPropertyId(prop);
  if (type !== "note" || file.extension !== "md") return;
  const key = frontmatterKey(app, file, name);
  await app.fileManager.processFrontMatter(file, (fm) => { fm[key] = value; });
}
export const isEditable = (prop: string, file: TFile) => splitPropertyId(prop).type === "note" && file.extension === "md";
