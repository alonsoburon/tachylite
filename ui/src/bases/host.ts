// BasesController: renders one base (toolbar + current view) into an element, runs the query and keeps it live.
// Used by the `.base` file view, `![[x.base]]` embeds and ```base code blocks.
import type { App } from "../obsidian/app";
import type { TFile } from "../obsidian/files";
import { setIcon } from "../obsidian/icons";
import { Menu, Notice } from "../obsidian/ui";
import { BasesViewConfig, QueryController, runQuery, type BasesView, type BasesViewRegistration } from "./api";
import { BaseConfig, displayName, type ViewRaw } from "./config";
import { CORE_VIEWS } from "./views";
import { FilterModal, PropertiesModal, SortModal, ViewSettingsModal } from "./toolbar";

export interface HostOptions {
  /** YAML source of the base. */
  source: string;
  /** What `this` refers to in formulas. */
  thisFile: TFile | null;
  /** The `.base` file the source came from (reloaded when it changes on disk). */
  baseFile?: TFile | null;
  /** Initially selected view (by name); defaults to the first view. */
  viewName?: string | null;
  /** Persist a changed config; when absent changes stay in memory (code blocks). */
  save?: ((yaml: string) => void | Promise<void>) | null;
  /** Embeds/code blocks unload themselves once their element leaves the document. */
  embedded?: boolean;
}

const REFRESH_MS = 250;

export class BasesController extends QueryController {
  config: BaseConfig | null = null;
  error: string | null = null;
  viewIndex = 0;
  view: BasesView | null = null;
  root: HTMLElement;
  toolbarEl: HTMLElement;
  viewEl: HTMLElement;
  private viewType = "";
  private viewEpoch = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSaved: string | null = null;
  private wasConnected = false;
  private total = 0;
  private props: string[] = [];

  constructor(app: App, public containerEl: HTMLElement, public opts: HostOptions) {
    super();
    this.app = app;
    this.root = containerEl.createDiv({ cls: "bases-container" });
    this.toolbarEl = this.root.createDiv({ cls: "bases-toolbar" });
    this.viewEl = this.root.createDiv({ cls: "bases-view" });
    this.parse(opts.source);
    if (this.config) this.viewIndex = this.config.viewIndex(opts.viewName);
  }

  onload(): void {
    const sched = () => this.requestRefresh();
    this.registerEvent(this.app.metadataCache.on("changed", sched));
    this.registerEvent(this.app.vault.on("create", sched));
    this.registerEvent(this.app.vault.on("delete", sched));
    this.registerEvent(this.app.vault.on("rename", sched));
    this.registerEvent(this.app.vault.on("modify", (f: any) => {
      if (f && f === this.opts.baseFile) { void this.reloadFromFile(); return; }
      if (f?.extension !== "md") sched();
    }));
    this.render();
  }
  onunload(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.view?.unload();
    this.view = null;
  }

  private parse(text: string): void {
    try { this.config = BaseConfig.parse(text); this.error = null; }
    catch (e) { this.config = null; this.error = (e as Error).message; }
    if (this.config && !this.config.views.length) this.config.raw.views = [{ type: "table", name: "Table" }];
  }

  /** Replace the source (file reloaded, code block edited). Keeps the selected view when it still exists. */
  setSource(text: string): void {
    const cur = this.currentRaw()?.name ?? this.opts.viewName ?? null;
    this.parse(text);
    if (this.config) { const i = this.config.views.findIndex((v) => v.name === cur); this.viewIndex = i >= 0 ? i : Math.min(this.viewIndex, this.config.views.length - 1); }
    this.render(true);
  }
  private async reloadFromFile(): Promise<void> {
    const f = this.opts.baseFile;
    if (!f) return;
    const text = await this.app.vault.read(f);
    if (text === this.lastSaved) return;
    this.setSource(text);
  }

  registrations(): Record<string, BasesViewRegistration> {
    return { ...CORE_VIEWS, ...(this.app.basesViews as Record<string, BasesViewRegistration>) };
  }
  currentRaw(): ViewRaw | null { return this.config?.views[this.viewIndex] ?? null; }
  viewConfigFor(i: number): BasesViewConfig {
    return new BasesViewConfig(this.config!.views[i], this.config!, (key) => this.configChanged(key));
  }
  displayName(id: string): string { return this.config ? displayName(this.config, id) : id; }
  allProperties(): string[] { return this.props; }

  /** A view or the base changed through the UI: persist it and re-render. */
  configChanged(key = ""): void {
    if (!this.config) return;
    const text = this.config.serialize();
    this.lastSaved = text;
    if (this.opts.save) { try { void Promise.resolve(this.opts.save(text)).catch((e) => console.error("saving base failed", e)); } catch (e) { console.error(e); } }
    const raw = this.currentRaw();
    if (key === "type" || (raw && raw.type !== this.viewType)) this.render(true); else this.refresh();
  }

  selectView(i: number): void {
    if (!this.config || i < 0 || i >= this.config.views.length) return;
    this.viewIndex = i;
    this.render(true);
  }

  requestRefresh(delay = REFRESH_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, delay);
  }

  /** Full rebuild: toolbar and a fresh view instance. */
  render(recreate = false): void {
    if (recreate || !this.view) { this.view?.unload(); this.view = null; }
    this.viewEl.empty();
    if (!this.config) {
      this.toolbarEl.empty();
      this.viewEl.createDiv({ cls: "bases-error", text: this.error ?? "Invalid base" });
      return;
    }
    this.refresh();
  }

  /** Re-run the query and hand new data to the view (creating it if needed). */
  refresh(): void {
    if (this.opts.embedded) {
      if (this.root.isConnected) this.wasConnected = true;
      else if (this.wasConnected) { this.unload(); return; }
    }
    const cfg = this.config;
    if (!cfg) return;
    const raw = this.currentRaw();
    if (!raw) return;
    let run;
    try { run = runQuery(this.app, cfg, raw, this.opts.thisFile); }
    catch (e) {
      console.error("bases query failed", e);
      this.viewEl.empty();
      this.viewEl.createDiv({ cls: "bases-error", text: `Query failed: ${(e as Error).message}` });
      return;
    }
    this.total = run.total;
    this.props = run.allProperties;
    this.scope = run.result.scope;
    this._result = run.result;
    this._allProperties = run.allProperties;
    this._viewConfig = this.viewConfigFor(this.viewIndex);
    this.renderToolbar();
    if (!this.view || this.viewType !== raw.type) {
      this.view?.unload();
      this.viewEl.empty();
      const regs = this.registrations();
      let reg = regs[raw.type];
      if (!reg) {
        this.viewEl.createDiv({ cls: "bases-error mod-warning", text: `The "${raw.type}" view type is not available; showing a table.` });
        reg = CORE_VIEWS.table;
      }
      this.viewType = raw.type;
      this.viewEl.setAttribute("data-view-type", raw.type);
      const host = this.viewEl.createDiv({ cls: "bases-view-content" });
      const epoch = ++this.viewEpoch;
      try {
        const v = reg.factory(this, host);
        if (epoch !== this.viewEpoch) return;
        this.view = v;
        v.config = this._viewConfig;
        v.data = run.result;
        v.allProperties = run.allProperties;
        this.addChild(v);
        v.onDataUpdated();
      } catch (e) {
        console.error(`bases view "${raw.type}" failed`, e);
        host.createDiv({ cls: "bases-error", text: `View failed: ${(e as Error).message}` });
      }
      return;
    }
    const v = this.view;
    v.config = this._viewConfig;
    v.data = run.result;
    v.allProperties = run.allProperties;
    try { v.onDataUpdated(); } catch (e) { console.error("bases view update failed", e); }
  }

  // ---------------------------------------------------------------- toolbar

  private item(cls: string, icon: string, label: string, onClick: (evt: MouseEvent) => void): HTMLElement {
    const el = this.toolbarEl.createDiv({ cls: `bases-toolbar-item ${cls}`, attr: { role: "button", tabindex: "0", "aria-label": label } });
    const btn = el.createDiv({ cls: "text-icon-button" });
    if (icon) setIcon(btn.createSpan({ cls: "text-button-icon" }), icon);
    btn.createSpan({ cls: "text-button-label", text: label });
    el.addEventListener("click", onClick);
    return el;
  }

  private renderToolbar(): void {
    const tb = this.toolbarEl;
    tb.empty();
    const cfg = this.config!, raw = this.currentRaw()!;
    const regs = this.registrations();
    this.item("bases-toolbar-views-menu", regs[raw.type]?.icon ?? "lucide-table", raw.name || raw.type, (evt) => this.viewsMenu().showAtMouseEvent(evt));
    this.item("bases-toolbar-results-menu", "", `${this.total} result${this.total === 1 ? "" : "s"}`, (evt) => this.resultsMenu().showAtMouseEvent(evt));
    tb.createDiv({ cls: "bases-toolbar-spacer" });
    const sortCount = Array.isArray(raw.sort) ? raw.sort.length : 0;
    this.item("bases-toolbar-sort-menu", "lucide-arrow-up-down", sortCount ? `Sort (${sortCount})` : "Sort", () => new SortModal(this.app, this).open());
    this.item("bases-toolbar-filter-menu", "lucide-list-filter", "Filter", () => new FilterModal(this.app, this).open());
    this.item("bases-toolbar-properties-menu", "lucide-list", "Properties", () => new PropertiesModal(this.app, this).open());
    this.item("bases-toolbar-new-item-menu", "lucide-plus", "New", () => { if (this.view) void this.createFile(this.view); });
    void cfg;
  }

  private viewsMenu(): Menu {
    const m = new Menu();
    const regs = this.registrations();
    this.config!.views.forEach((v, i) => m.addItem((it) => it.setTitle(v.name || v.type).setIcon(regs[v.type]?.icon ?? "lucide-table").setChecked(i === this.viewIndex).onClick(() => this.selectView(i))));
    m.addSeparator();
    m.addItem((it) => it.setTitle("View settings").setIcon("lucide-settings").onClick(() => new ViewSettingsModal(this.app, this, this.viewIndex).open()));
    m.addItem((it) => it.setTitle("Add view").setIcon("lucide-plus").onClick(() => this.addView()));
    if (this.config!.views.length > 1) {
      m.addItem((it) => it.setTitle("Delete view").setIcon("lucide-trash-2").setWarning(true).onClick(() => {
        this.config!.views.splice(this.viewIndex, 1);
        this.viewIndex = Math.max(0, this.viewIndex - 1);
        this.configChanged("type");
      }));
    }
    return m;
  }
  addView(type = "table"): void {
    const views = this.config!.views;
    const base = this.registrations()[type]?.name ?? "View";
    let name = base, n = 1;
    while (views.some((v) => v.name === name)) name = `${base} ${++n}`;
    const cur = this.currentRaw();
    views.push({ type, name, ...(cur?.order ? { order: [...cur.order] } : {}) });
    this.viewIndex = views.length - 1;
    this.configChanged("type");
    new ViewSettingsModal(this.app, this, this.viewIndex).open();
  }
  private resultsMenu(): Menu {
    const m = new Menu();
    m.addItem((it) => it.setTitle("Copy to clipboard").setIcon("lucide-copy").onClick(() => {
      void navigator.clipboard?.writeText(this.asTable("\t")).then(() => new Notice("Copied to clipboard"), () => {});
    }));
    m.addItem((it) => it.setTitle("Export CSV").setIcon("lucide-download").onClick(() => { void this.exportCsv(); }));
    return m;
  }
  /** Current results as delimited text (header row of display names). */
  asTable(sep: string): string {
    const r = this._result;
    if (!r) return "";
    const q = (s: string) => (sep === "," && /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s.replace(/[\t\n]/g, " "));
    const lines = [r.properties.map((p) => q(this.displayName(p))).join(sep)];
    for (const e of r.data) lines.push(r.properties.map((p) => q(p === "file.name" ? e.file.basename : e.getValue(p)?.toString() ?? "")).join(sep));
    return lines.join("\n");
  }
  private async exportCsv(): Promise<void> {
    const parent = this.opts.baseFile?.parent?.path ?? "";
    const base = (this.opts.baseFile?.basename ?? "Base") + (this.currentRaw()?.name ? ` - ${this.currentRaw()!.name}` : "");
    let path = (parent && parent !== "/" ? parent + "/" : "") + base + ".csv", n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = (parent && parent !== "/" ? parent + "/" : "") + `${base} ${n++}.csv`;
    await this.app.vault.create(path, this.asTable(","));
    new Notice(`Exported ${path}`);
  }

  async createFile(_view: BasesView, name?: string, fm?: (frontmatter: any, file: TFile) => void): Promise<void> {
    const parent = this.app.fileManager.getNewFileParent(this.opts.thisFile?.path ?? this.opts.baseFile?.path ?? "");
    const dir = parent.isRoot() ? "" : parent.path + "/";
    const base = (name ?? "Untitled").replace(/\.md$/, "");
    let path = `${dir}${base}.md`, n = 1;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${dir}${base} ${n++}.md`;
    const file = await this.app.vault.create(path, "");
    if (fm) await this.app.fileManager.processFrontMatter(file, (f) => fm(f, file));
    await this.app.workspace.getLeaf("tab").openFile(file, { active: true });
  }
}
