// One vault session: builds the App, installs the shell, core views, commands and settings, restores the layout.
import { ipc, type VaultInfo } from "../ipc";
import { App, Notice, MarkdownView, type WorkspaceLeaf } from "../obsidian";
import { refreshBlocks } from "../editor";
import { editorHandles, installBridge } from "./bridge";
import { installCommands } from "./commands";
import { coreModules } from "./core";
import { History } from "./history";
import { installMarkdownView } from "./markdownView";
import { applyAppearance, installSettings } from "./settings";
import { Shell } from "./shell";
import { installStatusBar } from "./statusbar";
import { installMenuCommands } from "./platform";
import { installUriHandling } from "./uri";
import { TachyMarkdownView } from "./markdownView";

export interface Session {
  app: App;
  shell: Shell;
  history: History;
  stop(): Promise<void>;
}

/** Reflect app.json options that are plain CSS/DOM switches (and push editor options into open editors). */
export function applyConfigToBody(app: App): void {
  const b = document.body;
  b.classList.toggle("show-inline-title", app.vault.getConfig("showInlineTitle") !== false);
  b.classList.toggle("show-view-header", app.vault.getConfig("showViewHeader") !== false);
  b.classList.toggle("is-readable-line-width", app.vault.getConfig("readableLineLength") !== false);
  b.classList.toggle("show-line-numbers", !!app.vault.getConfig("showLineNumber"));
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const v = leaf.view as MarkdownView;
    editorHandles.get(v.cm)?.reconfigure({
      tabSize: app.vault.getConfig("tabSize"), useTabs: app.vault.getConfig("useTab"), spellcheck: app.vault.getConfig("spellcheck"),
      showLineNumbers: !!app.vault.getConfig("showLineNumber"), foldHeading: app.vault.getConfig("foldHeading"), foldIndent: app.vault.getConfig("foldIndent"),
      strictLineBreaks: !!app.vault.getConfig("strictLineBreaks"), vimMode: !!app.vault.getConfig("vimMode"),
    });
    v.cm.dispatch({ effects: refreshBlocks.of(null) });
    if (v.getMode() === "preview") v.previewMode.rerender(true);
  }
}

async function defaultLayout(app: App): Promise<void> {
  const ws = app.workspace;
  const mk = async (type: string, side: "left" | "right", split = false) => {
    const leaf = side === "left" ? ws.getLeftLeaf(split) : ws.getRightLeaf(split);
    if (leaf) await leaf.setViewState({ type });
  };
  const has = (id: string) => app.internalPlugins.plugins[id]?.enabled;
  if (has("file-explorer")) await mk("file-explorer", "left");
  if (has("global-search")) await mk("search", "left");
  if (has("bookmarks")) await mk("bookmarks", "left");
  if (has("backlink")) await mk("backlink", "right");
  if (has("outgoing-link")) await mk("outgoing-link", "right");
  if (has("tag-pane")) await mk("tag", "right");
  if (has("outline")) await mk("outline", "right");
  for (const dock of [ws.leftSplit, ws.rightSplit]) {
    const tabs = dock.children[0] as any;
    if (tabs?.children?.length) tabs.selectTab(tabs.children[0]);
  }
  ws.leftSplit.expand();
  ws.rightSplit.expand();
}

export async function startSession(info: VaultInfo, host: HTMLElement, opts: { script?: string | null } = {}): Promise<Session> {
  host.replaceChildren();
  let shell!: Shell;
  let history!: History;
  const disposers: (() => void)[] = [];

  const app: App = new App({
    info,
    installGlobalHandlers: true,
    onCoreReady: () => {
      disposers.push(installBridge(app));
      disposers.push(installMarkdownView(app));
      for (const m of coreModules) {
        try { const d = m.install(app); if (typeof d === "function") disposers.push(d); }
        catch (e) { console.error(`core module ${m.id} failed`, e); }
      }
      disposers.push(installCommands(app, history));
      disposers.push(installSettings(app));
      disposers.push(installStatusBar(app));
      disposers.push(installMenuCommands(app));
      app.internalPlugins.on("change", (id: string, on: boolean) => { if (!on) { const t = ({ "file-explorer": "file-explorer", "global-search": "search", backlink: "backlink", "outgoing-link": "outgoing-link", "tag-pane": "tag", outline: "outline", bookmarks: "bookmarks", graph: "graph" } as Record<string, string>)[id]; if (t) app.workspace.detachLeavesOfType(t); } });
    },
    restoreLayout: async () => {
      const layout = await ipc.configRead("workspace.json").catch(() => null);
      if (layout && layout.main) await app.workspace.changeLayout(layout);
      else await defaultLayout(app);
      shell.decorate();
      history.updateButtons();
    },
  });
  app.plugins.restrictedMode = !app.loadLocalStorage("enable-plugin");
  shell = new Shell(app);
  history = new History(app);
  disposers.push(() => history.dispose());
  shell.mount(host);

  (app as any).tachylite = {
    shell, history,
    focusInlineTitle(leaf: WorkspaceLeaf) { setTimeout(() => (leaf.view as TachyMarkdownView).focusInlineTitle?.(), 50); },
  };
  (globalThis as any).__tachylite = { app, shell, ipc };

  await applyAppearance(app).catch((e) => console.warn("appearance", e));
  const cfgRef = app.workspace.on("config-changed", () => applyConfigToBody(app));
  const cssRef = app.workspace.on("css-change", () => { void applyAppearance(app); });
  applyConfigToBody(app);
  disposers.push(installUriHandling(app));
  await app.start();
  applyConfigToBody(app);
  void applyAppearance(app);
  shell.onActiveLeafChange(app.workspace.activeLeaf);

  if (app.plugins.restrictedMode && Object.keys(app.plugins.manifests).length) {
    new Notice("Community plugins are in restricted mode. Turn them on in Settings > Community plugins.", 8000);
  }
  if (opts.script) {
    // Developer automation (TACHYLITE_SCRIPT): the file's text runs once the vault is ready.
    try { await new Function("app", "shell", "ipc", `return (async () => {\n${opts.script}\n})();`)(app, shell, ipc); }
    catch (e) { console.error("TACHYLITE_SCRIPT failed", e); }
  }
  return {
    app, shell, history,
    async stop() {
      shell.flush();
      app.workspace.offref(cfgRef);
      app.workspace.offref(cssRef);
      for (const d of disposers.splice(0).reverse()) { try { d(); } catch (e) { console.error(e); } }
      shell.dispose();
      await app.stop();
    },
  };
}
