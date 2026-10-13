// Community theme browser: live catalog grid with search, mode filter and install / use / uninstall.
import { ipc } from "../../ipc";
import { Modal, DropdownComponent, type App } from "../../obsidian";
import { errMsg, notify, searchBox } from "./util";

interface CatalogTheme { name: string; author: string; repo: string; screenshot: string; modes: string[] }

function normalize(raw: any): CatalogTheme {
  return {
    name: String(raw?.name ?? ""), author: String(raw?.author ?? ""), repo: String(raw?.repo ?? ""),
    screenshot: String(raw?.screenshot ?? ""), modes: Array.isArray(raw?.modes) ? raw.modes.map(String) : [],
  };
}

export function screenshotUrl(t: Pick<CatalogTheme, "repo" | "screenshot">): string | null {
  if (!t.repo || !t.screenshot) return null;
  return `https://raw.githubusercontent.com/${t.repo}/HEAD/${t.screenshot.replace(/^\/+/, "")}`;
}

const PAGE = 30;

export class ThemeBrowserModal extends Modal {
  private all: CatalogTheme[] = [];
  private query = "";
  private mode = "all";
  private shown = PAGE;
  private resultsEl!: HTMLElement;
  private busy = new Set<string>();
  onChanged: () => void;

  constructor(app: App, onChanged: () => void = () => {}) {
    super(app);
    this.onChanged = onChanged;
    this.modalEl.addClass("mod-community-modal", "mod-community-theme");
    this.setTitle("Community themes");
  }

  onOpen(): void {
    const c = this.contentEl;
    c.empty();
    const controls = c.createDiv({ cls: "community-modal-controls" });
    const search = controls.createDiv({ cls: "community-modal-search" });
    searchBox(search, "Search community themes...", (v) => { this.query = v.trim().toLowerCase(); this.shown = PAGE; this.render(); }).inputEl.focus();
    const dd = new DropdownComponent(controls);
    dd.addOptions({ all: "All themes", light: "Light themes", dark: "Dark themes" }).onChange((v) => { this.mode = v; this.shown = PAGE; this.render(); });
    this.resultsEl = c.createDiv({ cls: "community-modal-search-results theme-list" });
    void this.load();
  }

  onClose(): void { this.contentEl.empty(); }

  async load(): Promise<void> {
    this.resultsEl.empty();
    this.resultsEl.createDiv({ cls: "community-modal-search-results-status", text: "Loading themes..." });
    try {
      const raw = await ipc.themeCatalog();
      this.all = raw.map(normalize).filter((t) => t.name).sort((a, b) => a.name.localeCompare(b.name));
      this.render();
    } catch (e) {
      this.resultsEl.empty();
      const box = this.resultsEl.createDiv({ cls: "community-modal-empty-state mod-error" });
      box.createDiv({ text: `Could not load the theme catalog. Check your internet connection. (${errMsg(e)})` });
      box.createEl("button", { text: "Retry" }).addEventListener("click", () => void this.load());
    }
  }

  private filtered(): CatalogTheme[] {
    return this.all.filter((t) => {
      if (this.mode !== "all" && t.modes.length && !t.modes.includes(this.mode)) return false;
      if (!this.query) return true;
      return t.name.toLowerCase().includes(this.query) || t.author.toLowerCase().includes(this.query);
    });
  }

  render(): void {
    if (!this.resultsEl) return;
    const list = this.filtered();
    this.resultsEl.empty();
    if (!list.length) {
      this.resultsEl.createDiv({ cls: "community-modal-empty-state", text: "No themes found." });
      return;
    }
    for (const t of list.slice(0, this.shown)) this.card(t);
    if (list.length > this.shown) {
      const more = this.resultsEl.createDiv({ cls: "community-modal-grid-button-container" });
      more.createEl("button", { text: `Show more (${list.length - this.shown})` }).addEventListener("click", () => { this.shown += PAGE; this.render(); });
    }
  }

  private card(t: CatalogTheme): void {
    const css = this.app.customCss;
    const el = this.resultsEl.createDiv({ cls: "community-item community-theme" });
    el.dataset.theme = t.name;
    const shot = el.createDiv({ cls: "community-item-screenshot" });
    const url = screenshotUrl(t);
    if (url) {
      const img = shot.createEl("img", { attr: { src: url, alt: t.name, loading: "lazy" } });
      img.addEventListener("error", () => { img.remove(); shot.addClass("is-missing"); });
    } else shot.addClass("is-missing");
    const info = el.createDiv({ cls: "community-item-info" });
    info.createDiv({ cls: "community-item-name", text: t.name });
    info.createDiv({ cls: "community-item-author", text: `By ${t.author}` });
    const bar = el.createDiv({ cls: "community-item-buttons" });
    const installed = css.isThemeInstalled(t.name), active = css.theme === t.name;
    const busy = this.busy.has(t.name);
    if (!installed) {
      const b = bar.createEl("button", { cls: "mod-cta", text: busy ? "Installing..." : "Install and use" });
      b.disabled = busy;
      b.addEventListener("click", () => void this.install(t));
    } else {
      const use = bar.createEl("button", { cls: active ? "" : "mod-cta", text: active ? "In use" : "Use" });
      use.disabled = active;
      use.addEventListener("click", () => void this.use(t.name));
      bar.createEl("button", { cls: "mod-warning", text: "Uninstall" }).addEventListener("click", () => void this.uninstall(t.name));
    }
  }

  private async install(t: CatalogTheme): Promise<void> {
    this.busy.add(t.name); this.render();
    try {
      await ipc.themeInstall(t.name);
      await this.app.customCss.requestLoadThemes();
      await this.app.customCss.setTheme(t.name);
      notify(`Theme "${t.name}" installed and enabled.`);
    } catch (e) { notify(`Could not install "${t.name}": ${errMsg(e)}`, 6000); }
    this.busy.delete(t.name);
    this.render(); this.onChanged();
  }

  private async use(name: string): Promise<void> {
    await this.app.customCss.setTheme(name);
    this.render(); this.onChanged();
  }

  private async uninstall(name: string): Promise<void> {
    const css = this.app.customCss;
    try {
      if (css.theme === name) await css.setTheme("Default");
      await this.app.vault.adapter.rmdir(`${this.app.vault.configDir}/themes/${name}`, true);
      await css.requestLoadThemes();
    } catch (e) { notify(`Could not uninstall "${name}": ${errMsg(e)}`, 6000); }
    this.render(); this.onChanged();
  }
}
