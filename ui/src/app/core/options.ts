// Options of the core plugins: the live object plugins read (`internalPlugins.getPluginById(id).instance.options`),
// its persistence in .obsidian/<id>.json and the options tab listed under Settings > "Core plugins".
import moment from "moment";
import { Notice, SettingTab, TFile, getFrontMatterInfo, normalizePath, parseYaml, stringifyYaml, type App } from "../../obsidian";
import { whileCoreEnabled } from "./util";

/** The options object of a core plugin (mutate it, then call saveOptions). */
export function coreOptions(app: App, id: string): Record<string, any> {
  const p = app.internalPlugins.getPluginById(id);
  if (!p) return {};
  if (!p.instance.options || typeof p.instance.options !== "object") p.instance.options = {};
  return p.instance.options;
}

export async function saveOptions(app: App, id: string): Promise<void> {
  const p = app.internalPlugins.getPluginById(id);
  if (p) await p.saveData(p.instance.options);
}

/** A core plugin's options tab; `corePluginId` makes the settings dialog group it under "Core plugins". */
export abstract class CoreOptionsTab extends SettingTab {
  constructor(app: App, public corePluginId: string, name: string, icon = "") {
    super(app);
    this.id = corePluginId;
    this.name = name;
    this.icon = icon;
  }
  get options(): Record<string, any> { return coreOptions(this.app, this.corePluginId); }
  save(): Promise<void> { return saveOptions(this.app, this.corePluginId); }
  abstract render(el: HTMLElement): void;
  display(): void { this.containerEl.empty(); this.render(this.containerEl); }
}

/** Show `tab` in the settings dialog while the core plugin is enabled. */
export function whileCoreTab(app: App, tab: CoreOptionsTab): () => void {
  return whileCoreEnabled(app, tab.corePluginId, () => {
    app.setting.addCorePluginTab(tab);
    return () => app.setting.removeCorePluginTab(tab);
  });
}

/** Normalised vault folder from a settings value ("" for the root). */
export function folderOption(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  const p = normalizePath(v.trim());
  return p === "/" ? "" : p;
}

/** Resolve a "template file" option (path with or without .md); shows a notice when it is missing. */
export function resolveTemplateOption(app: App, v: unknown, what: string): TFile | null | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  let p = normalizePath(v.trim());
  if (!/\.md$/i.test(p)) p += ".md";
  const f = app.vault.getFileByPath(p);
  if (!f) new Notice(`${what} "${v}" not found.`);
  return f;
}

export const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT = "HH:mm";

/**
 * Template variables as the core plugins expand them: every `{{key}}` of `vars` (case-insensitive), then
 * `{{date}}`, `{{time}}` and `{{date:FORMAT}}` / `{{time:FORMAT}}`, all from one timestamp.
 */
export function expandVariables(text: string, vars: Record<string, string>, fmt: { dateFormat?: string; timeFormat?: string } = {}, when?: moment.Moment): string {
  for (const [k, val] of Object.entries(vars)) {
    const re = new RegExp(`\\{\\{${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}\\}`, "gi");
    text = text.replace(re, () => val);
  }
  let now: moment.Moment | null = when ?? null;
  return text.replace(/\{\{(date|time)(?::(.*?))?\}\}/gi, (_m, kind: string, f?: string) => {
    now ??= moment();
    if (f) return now.format(f);
    return kind.toLowerCase() === "date" ? now.format(fmt.dateFormat || DEFAULT_DATE_FORMAT) : now.format(fmt.timeFormat || DEFAULT_TIME_FORMAT);
  });
}

// ---- frontmatter (properties) helpers shared by Templates and Note composer

/** Split a note into its properties object and body; throws on invalid YAML. */
export function splitFrontmatter(text: string): { props: Record<string, any>; body: string; exists: boolean } {
  const info = getFrontMatterInfo(text);
  if (!info.exists) return { props: {}, body: text, exists: false };
  const v = info.frontmatter.trim() ? parseYaml(info.frontmatter) : {};
  if (v !== null && v !== undefined && (typeof v !== "object" || Array.isArray(v))) throw new Error("Properties are not a YAML mapping");
  return { props: v ?? {}, body: text.slice(info.contentStart), exists: true };
}

/** Merge `src` properties into `dst`: lists are joined without duplicates, objects merge, other values win unless null. */
export function mergeProperties(dst: Record<string, any>, src: Record<string, any>): Record<string, any> {
  for (const [k, v] of Object.entries(src)) {
    const cur = dst[k];
    if (cur === undefined || cur === null || cur === "" || cur === false || cur === 0) dst[k] = v;
    else if (Array.isArray(cur) && Array.isArray(v)) dst[k] = [...new Set([...cur, ...v])];
    else if (typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object" && !Array.isArray(v)) mergeProperties(cur, v);
    else if (v !== null) dst[k] = v;
  }
  return dst;
}

/** `---\n<yaml>\n---\n` for a non-empty properties object, else "". */
export function frontmatterBlock(props: Record<string, any>): string {
  return Object.keys(props).length ? `---\n${stringifyYaml(props).trim()}\n---\n` : "";
}

/** Left-ribbon button of a core plugin, with the "<plugin id>:<title>" id workspace.json's ribbon state uses. */
export function coreRibbon(app: App, id: string, icon: string, title: string, cb: (evt: MouseEvent) => void): () => void {
  const el = app.workspace.leftRibbon.addRibbonItemButton(`${id}:${title}`, icon, title, cb);
  return () => app.workspace.leftRibbon.removeRibbonItemButton(el);
}
