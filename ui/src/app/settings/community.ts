// "Community plugins" settings tab: restricted mode, browser, update check and the installed list.
import { Setting, SettingTab, type App } from "../../obsidian";
import { confirmDialog } from "../dialogs";
import { PluginBrowserModal } from "./pluginBrowser";
import { checkForUpdates, updatePlugin, type UpdateInfo } from "./updates";
import { errMsg, heading, notify } from "./util";

export class CommunityPluginsSettingTab extends SettingTab {
  id = "community-plugins";
  name = "Community plugins";
  icon = "lucide-puzzle";
  private updates: UpdateInfo[] | null = null;
  private checking = false;
  private checkError = "";
  constructor(app: App) { super(app); }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const app = this.app, pl = app.plugins;

    if (pl.restrictedMode) {
      new Setting(el).setName("Restricted mode is on").setDesc(
        "Community plugins are disabled. Plugins are third-party code that can read and change anything in your vault and on your computer. Turn on community plugins to install and run them.")
        .addButton((b) => b.setButtonText("Turn on community plugins").setCta().onClick(async () => {
          const ok = await confirmDialog(app, {
            title: "Turn on community plugins?",
            message: "Community plugins are created by third parties and run with full access to your vault and files. Only install plugins from authors you trust.",
            cta: "Turn on community plugins",
          });
          if (!ok) return;
          app.saveLocalStorage("enable-plugin", true);
          await pl.turnOnCommunityPlugins();
          this.display();
        }));
      return;
    }

    new Setting(el).setName("Community plugins").setDesc("Community plugins are turned on.")
      .addButton((b) => b.setButtonText("Turn off community plugins").onClick(async () => {
        const ok = await confirmDialog(app, {
          title: "Turn on restricted mode?", message: "All community plugins will be unloaded until you turn them back on. Your installed plugins and their settings are kept.", cta: "Turn on restricted mode", warning: true,
        });
        if (!ok) return;
        app.saveLocalStorage("enable-plugin", false);
        await pl.turnOffCommunityPlugins();
        this.updates = null;
        this.display();
      }));
    new Setting(el).setName("Browse community plugins").setDesc("Find, install and enable plugins made by the community.")
      .addButton((b) => b.setButtonText("Browse").setCta().onClick(() => new PluginBrowserModal(app, () => this.display()).open()));
    new Setting(el).setName("Check for updates").setDesc(this.checking ? "Checking..." : this.checkError || "Look for newer versions of your installed plugins.")
      .addButton((b) => b.setButtonText("Check for updates").setDisabled(this.checking).onClick(() => void this.check()));
    if (this.updates) this.renderUpdates(el, this.updates);

    heading(el, "Installed plugins");
    const manifests = Object.values(pl.manifests).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    if (!manifests.length) new Setting(el).setDesc("No community plugins installed.").setClass("setting-item-note");
    for (const m of manifests) {
      const s = new Setting(el).setClass("community-plugin-item");
      s.settingEl.dataset.pluginId = m.id;
      s.nameEl.createSpan({ cls: "community-plugin-name", text: m.name || m.id });
      s.nameEl.createSpan({ cls: "community-plugin-version", text: m.version ?? "" });
      s.descEl.createDiv({ cls: "community-plugin-author", text: m.author ? `By ${m.author}` : "" });
      s.descEl.createDiv({ cls: "community-plugin-desc", text: m.description ?? "" });
      const err = pl.loadErrors[m.id];
      if (err) {
        const w = s.controlEl.createSpan({ cls: "community-plugin-error mod-warning", text: "Failed to load", attr: { "aria-label": err, title: err } });
        w.dataset.error = err;
      }
      const tab = pl.isEnabled(m.id) && app.setting.pluginTabs.find((t) => t.id === m.id);
      if (tab) s.addExtraButton((b) => b.setIcon("lucide-settings").setTooltip("Options").onClick(() => app.setting.openTabById(m.id)));
      s.addExtraButton((b) => b.setIcon("lucide-trash").setTooltip("Uninstall").onClick(async () => {
        const ok = await confirmDialog(app, { title: "Uninstall plugin", message: `Uninstall "${m.name || m.id}"? Its files and settings will be deleted.`, cta: "Uninstall", warning: true });
        if (!ok) return;
        try { await pl.uninstallPlugin(m.id); } catch (e) { notify(`Could not uninstall: ${errMsg(e)}`, 6000); }
        this.display();
      }));
      s.addToggle((t) => t.setValue(pl.isEnabled(m.id)).onChange(async (on) => {
        try {
          if (on) { if (!(await pl.enablePluginAndSave(m.id))) notify(`Plugin failed to load: ${pl.loadErrors[m.id] ?? "unknown error"}`, 8000); }
          else await pl.disablePluginAndSave(m.id);
        } catch (e) { notify(errMsg(e), 6000); }
        this.display();
      }));
    }
  }

  private async check(): Promise<void> {
    this.checking = true; this.checkError = ""; this.display();
    try { this.updates = await checkForUpdates(this.app); }
    catch (e) { this.updates = null; this.checkError = `Could not check for updates: ${errMsg(e)}`; }
    this.checking = false;
    this.display();
  }

  private renderUpdates(el: HTMLElement, list: UpdateInfo[]): void {
    const box = el.createDiv({ cls: "community-plugins-updates" });
    if (!list.length) { new Setting(box).setDesc("All your plugins are up to date.").setClass("setting-item-note"); return; }
    const head = new Setting(box).setName(`${list.length} update${list.length === 1 ? "" : "s"} available`).setHeading();
    head.addButton((b) => b.setButtonText("Update all").setCta().onClick(async () => {
      for (const u of list.slice()) await this.applyUpdate(u, false);
      this.display();
    }));
    for (const u of list) {
      new Setting(box).setName(u.name).setDesc(`${u.current} → ${u.latest}`).setClass("community-plugin-update-item")
        .addButton((b) => b.setButtonText("Update").setCta().onClick(async () => { await this.applyUpdate(u, true); }));
    }
  }

  private async applyUpdate(u: UpdateInfo, redraw: boolean): Promise<void> {
    try {
      const ok = await updatePlugin(this.app, u.id);
      if (!ok) notify(`${u.name} updated, but failed to reload: ${this.app.plugins.loadErrors[u.id] ?? "unknown error"}`, 8000);
      else notify(`${u.name} updated to ${u.latest}.`);
      this.updates = (this.updates ?? []).filter((x) => x.id !== u.id);
    } catch (e) { notify(`Could not update ${u.name}: ${errMsg(e)}`, 6000); }
    if (redraw) this.display();
  }
}
