// "Appearance" settings tab: colour scheme, accent, fonts, themes and CSS snippets.
import { Setting, SettingTab, type App } from "../../obsidian";
import { applyAppearance, readAppearance, updateAppearance } from "./appearanceApply";
import { ThemeBrowserModal } from "./themeBrowser";
import { commitConfig, heading, hexToHsl, hslToHex } from "./util";

const THEME_VALUES: Record<string, string> = { system: "system", light: "moonstone", dark: "obsidian" };

export class AppearanceSettingTab extends SettingTab {
  id = "appearance";
  name = "Appearance";
  icon = "lucide-brush";
  private token = 0;
  constructor(app: App) { super(app); }

  display(): void {
    const token = ++this.token;
    void readAppearance().then((ap) => { if (token === this.token) this.render(ap); });
  }

  hide(): void { this.token++; }

  private render(ap: Record<string, any>): void {
    const el = this.containerEl;
    el.empty();
    const app = this.app;

    heading(el, "Interface");
    const scheme = ap.theme === "moonstone" ? "light" : ap.theme === "obsidian" ? "dark" : "system";
    new Setting(el).setName("Base color scheme").setDesc("Choose the colour scheme of the interface.").addDropdown((d) =>
      d.addOptions({ system: "Adapt to system", light: "Light", dark: "Dark" }).setValue(scheme)
        .onChange((v) => { void updateAppearance(app, { theme: THEME_VALUES[v] ?? "system" }); }));

    const accent = typeof ap.accentColor === "string" && hexToHsl(ap.accentColor) ? ap.accentColor : null;
    const dark = app.isDarkMode();
    new Setting(el).setName("Accent color").setDesc("Colour used for links, buttons and selections.")
      .addExtraButton((b) => b.setIcon("lucide-rotate-ccw").setTooltip("Restore default").onClick(() => { void updateAppearance(app, { accentColor: undefined }).then(() => this.display()); }))
      .addColorPicker((c) => c.setValue(accent ?? hslToHex(262, dark ? 75 : 62, dark ? 68 : 52)).onChange((v) => { void updateAppearance(app, { accentColor: v }); }));

    new Setting(el).setName("Font size").setDesc("Base font size of notes, in pixels.")
      .addExtraButton((b) => b.setIcon("lucide-rotate-ccw").setTooltip("Restore default").onClick(() => { void updateAppearance(app, { baseFontSize: undefined }).then(() => this.display()); }))
      .addSlider((s) => s.setLimits(12, 24, 1).setValue(Number(ap.baseFontSize) || 16).setDynamicTooltip().onChange((v) => { void updateAppearance(app, { baseFontSize: v }); }));

    new Setting(el).setName("Quick font size adjustment").setDesc("Adjust the font size of notes with Ctrl + scroll (Cmd + scroll on macOS).").addToggle((t) =>
      t.setValue(ap.baseFontSizeAction !== false).onChange((v) => { void updateAppearance(app, { baseFontSizeAction: v ? undefined : false }); }));

    const fonts: [string, string, string, string][] = [
      ["interfaceFontFamily", "Interface font", "Font used by the interface.", "System default"],
      ["textFontFamily", "Text font", "Font used in the editor and reading view.", "Theme default"],
      ["monospaceFontFamily", "Monospace font", "Font used for code and the source editor.", "Theme default"],
    ];
    for (const [key, name, desc, ph] of fonts) {
      new Setting(el).setName(name).setDesc(desc).addText((t) => t.setPlaceholder(ph).setValue(String(ap[key] ?? "")).onChange((v) => {
        void updateAppearance(app, { [key]: v.trim() || undefined });
      }));
    }

    new Setting(el).setName("Show inline title").setDesc("Show the note title above the content.").addToggle((t) =>
      t.setValue(app.vault.getConfig("showInlineTitle") !== false).onChange((v) => { commitConfig(app, "showInlineTitle", v); void applyAppearance(app); }));
    new Setting(el).setName("Show ribbon").setDesc("Show the ribbon of quick actions at the left edge.").addToggle((t) =>
      t.setValue(app.vault.getConfig("showRibbon") !== false).onChange((v) => commitConfig(app, "showRibbon", v)));
    new Setting(el).setName("Show tab title bar").setDesc("Show the title bar at the top of each tab.").addToggle((t) =>
      t.setValue(app.vault.getConfig("showViewHeader") !== false).onChange((v) => { commitConfig(app, "showViewHeader", v); void applyAppearance(app); }));

    // ----- Themes
    heading(el, "Themes");
    const css = app.customCss;
    const names = Object.keys(css.themes).sort((a, b) => a.localeCompare(b));
    new Setting(el).setName("Current theme").setDesc("Select the theme applied on top of the base colour scheme.")
      .addDropdown((d) => {
        d.addOption("", "Default");
        for (const n of names) d.addOption(n, n);
        d.setValue(css.theme && css.themes[css.theme] ? css.theme : "").onChange((v) => { void css.setTheme(v || "Default"); });
      })
      .addButton((b) => b.setButtonText("Browse").onClick(() => new ThemeBrowserModal(app, () => this.display()).open()));

    // ----- CSS snippets
    heading(el, "CSS snippets").addExtraButton((b) => b.setIcon("lucide-refresh-cw").setTooltip("Reload snippets").onClick(async () => {
      await css.requestLoadSnippets();
      await css.apply();
      this.display();
    }));
    if (!css.snippets.length) {
      new Setting(el).setDesc(`No CSS snippets found. Add .css files to ${app.vault.configDir}/snippets.`).setClass("setting-item-note");
    }
    for (const sn of css.snippets) {
      new Setting(el).setName(sn).addToggle((t) => t.setValue(css.enabledSnippets.has(sn)).onChange((v) => { void css.setCssEnabledStatus(sn, v); }));
    }
  }
}
