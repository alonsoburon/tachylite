// workspace:toggle-stacked-tabs. Obsidian's command is a checkCallback available when the active leaf sits in a tab group.
import type { Command, Workspace } from "../obsidian";
import { WorkspaceTabs } from "../obsidian";

export function registerStackedTabs(add: (c: Command) => void, ws: Workspace): void {
  add({ id: "workspace:toggle-stacked-tabs", name: "Toggle stacked tabs", checkCallback: (checking) => {
    const tabs = ws.activeLeaf?.parent;
    if (!(tabs instanceof WorkspaceTabs)) return false;
    if (!checking) tabs.toggleStacked();
    return true;
  } });
}
