// Option tabs of core plugins ("Core plugins" group of the settings dialog), saved to .obsidian/<id>.json.
import { SettingTab, type App } from "../../obsidian";
import { ipc } from "../../ipc";
import { whileCoreEnabled } from "./util";

/** A settings tab bound to a core plugin; `corePluginId` puts it in the "Core plugins" navigation group. */
export abstract class CorePluginSettingTab extends SettingTab {
  corePluginId: string;
  constructor(app: App, id: string, name: string) {
    super(app);
    this.id = id;
    this.name = name;
    this.corePluginId = id;
  }
  /** The plugin's options object (`internalPlugins.plugins[id].instance.options`). */
  get options(): Record<string, any> {
    const inst = this.app.internalPlugins.plugins[this.corePluginId]?.instance;
    if (!inst) return {};
    return (inst.options ??= {});
  }
  getControlValue(key: string): unknown { return this.options[key]; }
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.options[key]; else this.options[key] = value;
    await saveCoreOptions(this.app, this.corePluginId);
  }
}

export function saveCoreOptions(app: App, id: string): Promise<void> {
  return ipc.configWrite(`${id}.json`, app.internalPlugins.plugins[id]?.instance.options ?? {});
}

/** Add a tab to the settings dialog; returns its remover. */
export function showCoreSettingTab(app: App, tab: SettingTab): () => void {
  const s = app.setting;
  s.settingTabs.push(tab);
  s.refreshNav();
  return () => {
    if (s.activeTab === tab && s.settingTabs[0]) s.openTab(s.settingTabs[0]);
    s.settingTabs = s.settingTabs.filter((t) => t !== tab);
    s.refreshNav();
  };
}

/** Show `make()` in the settings dialog while core plugin `id` is enabled. */
export function coreSettingTab(app: App, id: string, make: () => SettingTab): () => void {
  return whileCoreEnabled(app, id, () => showCoreSettingTab(app, make()));
}
