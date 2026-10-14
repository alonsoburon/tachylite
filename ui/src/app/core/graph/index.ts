// Graph view core plugin ("graph"): the global graph and the local graph of the active file.
import type { App } from "../../../obsidian";
import { addCommand, addRibbon, whileCoreEnabled, type CoreModule } from "../util";
import { GRAPH_VIEW, GraphView, LOCAL_GRAPH_VIEW, LocalGraphView, openGraph, openLocalGraph } from "./view";

export * from "./model";
export * from "./sim";
export * from "./view";

export const graph: CoreModule = {
  id: "graph",
  install(app: App) {
    app.viewRegistry.registerView(GRAPH_VIEW, (leaf) => new GraphView(leaf));
    app.viewRegistry.registerView(LOCAL_GRAPH_VIEW, (leaf) => new LocalGraphView(leaf));
    const stop = whileCoreEnabled(app, "graph", () => {
      const offs = [
        addCommand(app, { id: "graph:open", name: "Graph view: Open graph view", icon: "lucide-git-fork", hotkeys: [{ modifiers: ["Mod"], key: "g" }], callback: () => { void openGraph(app); } }),
        addCommand(app, { id: "graph:open-local", name: "Graph view: Open local graph", icon: "lucide-git-fork", checkCallback: (checking) => {
          if (!app.workspace.getActiveFile()) return false;
          if (!checking) void openLocalGraph(app);
          return true;
        } }),
        addRibbon(app, "lucide-git-fork", "Open graph view", () => { void openGraph(app); }),
      ];
      return () => { offs.forEach((o) => o()); app.workspace.detachLeavesOfType(GRAPH_VIEW); app.workspace.detachLeavesOfType(LOCAL_GRAPH_VIEW); };
    });
    return () => { stop(); app.viewRegistry.unregisterView(GRAPH_VIEW); app.viewRegistry.unregisterView(LOCAL_GRAPH_VIEW); };
  },
};
