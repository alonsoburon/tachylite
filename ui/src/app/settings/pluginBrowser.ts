// Community plugin browser: lazily paged catalog with search, install, enable and uninstall.
import { ipc } from "../../ipc";
import { Modal, type App } from "../../obsidian";
import { confirmDialog } from "../dialogs";
import { errMsg, notify, searchBox } from "./util";
import { fetchCatalog, type CatalogEntry } from "./updates";

const PAGE = 40;

/** Score a catalog entry for a query (0 = no match). Name matches dominate author and description. */
export function relevance(e: CatalogEntry, query: string): number {
  if (!query) return 1;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const name = e.name.toLowerCase(), author = e.author.toLowerCase(), desc = e.description.toLowerCase(), id = e.id.toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let s = 0;
    if (name === t) s = 100;
    else if (name.startsWith(t)) s = 60;
    else if (name.includes(t) || id.includes(t)) s = 40;
    else if (author.includes(t)) s = 15;
    else if (desc.includes(t)) s = 5;
    if (!s) return 0;
    total += s;
  }
  return total;
}

export class PluginBrowserModal extends Modal {
  private all: CatalogEntry[] | null = null;
  private query = "";
  private shown = PAGE;
  private resultsEl!: HTMLElement;
  private busy = new Set<string>();
  onChanged: () => void;

  constructor(app: App, onChanged: () => void = () => {}) {
    super(app);
    this.onChanged = onChanged;
    this.modalEl.addClass("mod-community-modal", "mod-community-plugin");
    this.setTitle("Community plugins");
  }

  onOpen(): void {
    const c = this.contentEl;
    c.empty();
    const search = c.createDiv({ cls: "community-modal-search" });
    searchBox(search, "Search community plugins...", (v) => { this.query = v.trim(); this.shown = PAGE; this.render(); }).inputEl.focus();
    this.resultsEl = c.createDiv({ cls: "community-modal-search-results" });
    void this.load();
  }

  onClose(): void { this.contentEl.empty(); }

  async load(): Promise<void> {
    this.resultsEl.empty();
    this.resultsEl.createDiv({ cls: "community-modal-search-results-status", text: "Loading plugins..." });
    try {
      this.all = await fetchCatalog();
      this.render();
    } catch (e) {
      this.resultsEl.empty();
      const box = this.resultsEl.createDiv({ cls: "community-modal-empty-state mod-error" });
      box.createDiv({ text: `Could not load the plugin catalog. Check your internet connection. (${errMsg(e)})` });
      box.createEl("button", { text: "Retry" }).addEventListener("click", () => void this.load());
    }
  }

  private results(): CatalogEntry[] {
    if (!this.all) return [];
    if (!this.query) return this.all;
    return this.all.map((e) => ({ e, s: relevance(e, this.query) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e);
  }

  render(): void {
    if (!this.resultsEl || !this.all) return;
    const list = this.results();
    this.resultsEl.empty();
    if (this.app.plugins.restrictedMode) {
      this.resultsEl.createDiv({ cls: "community-plugins-banner", text: "Community plugins are turned off (Restricted mode). Turn them on in settings to install or enable plugins." });
    }
    this.resultsEl.createDiv({ cls: "community-modal-search-summary", text: `${list.length} plugin${list.length === 1 ? "" : "s"}` });
    if (!list.length) { this.resultsEl.createDiv({ cls: "community-modal-empty-state", text: "No plugins found." }); return; }
    for (const e of list.slice(0, this.shown)) this.card(e);
    if (list.length > this.shown) {
      const more = this.resultsEl.createDiv({ cls: "community-modal-grid-button-container" });
      more.createEl("button", { text: `Show more (${list.length - this.shown})` }).addEventListener("click", () => { this.shown += PAGE; this.render(); });
    }
  }

  private card(e: CatalogEntry): void {
    const pl = this.app.plugins;
    const el = this.resultsEl.createDiv({ cls: "community-item" });
    el.dataset.pluginId = e.id;
    const info = el.createDiv({ cls: "community-item-info" });
    info.createDiv({ cls: "community-item-name", text: e.name });
    info.createDiv({ cls: "community-item-author", text: `By ${e.author}` });
    info.createDiv({ cls: "community-item-desc", text: e.description });
    if (e.repo) {
      const a = info.createEl("a", { cls: "community-item-repo", text: e.repo, href: `https://github.com/${e.repo}` });
      a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
    }
    const bar = el.createDiv({ cls: "community-item-buttons" });
    const restricted = pl.restrictedMode;
    const installed = !!pl.manifests[e.id], busy = this.busy.has(e.id);
    if (!installed) {
      const b = bar.createEl("button", { cls: "mod-cta", text: busy ? "Installing..." : "Install" });
      b.disabled = busy || restricted;
      b.addEventListener("click", () => void this.install(e));
      return;
    }
    bar.createSpan({ cls: "community-item-badge", text: "Installed" });
    const enabled = pl.isEnabled(e.id);
    const toggle = bar.createEl("button", { cls: enabled ? "" : "mod-cta", text: enabled ? "Disable" : "Enable" });
    toggle.disabled = busy || restricted;
    toggle.addEventListener("click", () => void this.toggle(e.id, !enabled));
    bar.createEl("button", { cls: "mod-warning", text: "Uninstall" }).addEventListener("click", () => void this.uninstall(e));
  }

  private async install(e: CatalogEntry): Promise<void> {
    this.busy.add(e.id); this.render();
    try {
      await ipc.pluginInstall(e.id);
      await this.app.plugins.loadManifests();
      notify(`Plugin "${e.name}" installed. Enable it to start using it.`);
    } catch (err) { notify(`Could not install "${e.name}": ${errMsg(err)}`, 6000); }
    this.busy.delete(e.id);
    this.render(); this.onChanged();
  }

  private async toggle(id: string, on: boolean): Promise<void> {
    const pl = this.app.plugins;
    this.busy.add(id); this.render();
    try {
      if (on) {
        if (!(await pl.enablePluginAndSave(id))) notify(`Plugin failed to load: ${pl.loadErrors[id] ?? "unknown error"}`, 8000);
      } else await pl.disablePluginAndSave(id);
    } catch (err) { notify(errMsg(err), 6000); }
    this.busy.delete(id);
    this.render(); this.onChanged();
  }

  private async uninstall(e: CatalogEntry): Promise<void> {
    const ok = await confirmDialog(this.app, { title: "Uninstall plugin", message: `Uninstall "${e.name}"? Its files and settings will be deleted.`, cta: "Uninstall", warning: true });
    if (!ok) return;
    try { await this.app.plugins.uninstallPlugin(e.id); } catch (err) { notify(`Could not uninstall "${e.name}": ${errMsg(err)}`, 6000); }
    this.render(); this.onChanged();
  }
}
