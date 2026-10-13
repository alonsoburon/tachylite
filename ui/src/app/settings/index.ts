import type { App } from "../../obsidian";
import { AboutSettingTab } from "./about";
import { applyAppearance, disposeAppearance } from "./appearanceApply";
import { AppearanceSettingTab } from "./appearance";
import { CommunityPluginsSettingTab } from "./community";
import { CorePluginsSettingTab } from "./corePlugins";
import { EditorSettingTab } from "./editor";
import { FilesSettingTab } from "./files";
import { HotkeysSettingTab } from "./hotkeys";

export { applyAppearance };

/** Install the settings tabs on `app.setting`; returns a disposer. */
export function installSettings(app: App): () => void {
  const tabs = [
    new EditorSettingTab(app), new FilesSettingTab(app), new AppearanceSettingTab(app), new HotkeysSettingTab(app),
    new CorePluginsSettingTab(app), new CommunityPluginsSettingTab(app), new AboutSettingTab(app),
  ];
  // Core plugins may already have added their option tabs.
  app.setting.settingTabs = [...tabs, ...app.setting.settingTabs.filter((t) => !tabs.includes(t))];
  return () => {
    for (const t of tabs) t.hide();
    app.setting.settingTabs = app.setting.settingTabs.filter((t) => !tabs.includes(t));
    disposeAppearance(app);
  };
}
