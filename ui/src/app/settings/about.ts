// "About" settings tab.
import { Setting, SettingTab, type App } from "../../obsidian";
import { apiVersion } from "../../obsidian/util";
import { heading } from "./util";

export class AboutSettingTab extends SettingTab {
  id = "about";
  name = "About";
  icon = "lucide-info";
  constructor(app: App) { super(app); }
  display(): void {
    const el = this.containerEl;
    el.empty();
    heading(el, "About");
    new Setting(el).setName("Application").setDesc("Tachylite");
    new Setting(el).setName("Compatible plugin API version").setDesc(apiVersion);
    new Setting(el).setName("Vault").setDesc(this.app.vault.getName());
    new Setting(el).setName("Vault path").setDesc(this.app.vault.adapter.getBasePath());
  }
}
