// Helpers shared by the core views ("core plugins"), which are built only on the public API.
import { ItemView, Keymap, TFile, WorkspaceLeaf, type App, type Command } from "../../obsidian";

/** Contract every module under app/core/ implements. */
export interface CoreModule {
  /** Core plugin id as used in core-plugins.json ("file-explorer", "global-search", ...). */
  id: string;
  /** Register the view type, ribbon icons and commands. Called once per vault session. */
  install(app: App): void | (() => void);
}

export function coreEnabled(app: App, id: string): boolean {
  return !!app.internalPlugins.plugins[id]?.enabled;
}

/**
 * Run `setup` while the core plugin `id` is enabled (now and after later toggles); the cleanup it returns
 * runs when the plugin is disabled. Use it for ribbon items and commands, not for registerView.
 */
export function whileCoreEnabled(app: App, id: string, setup: () => void | (() => void)): () => void {
  let cleanup: void | (() => void);
  let on = false;
  const sync = () => {
    const want = coreEnabled(app, id);
    if (want && !on) { on = true; cleanup = setup(); }
    else if (!want && on) { on = false; try { cleanup?.(); } catch (e) { console.error(e); } cleanup = undefined; }
  };
  sync();
  const ref = app.internalPlugins.on("change", (pid: string) => { if (pid === id) sync(); });
  return () => { app.internalPlugins.offref(ref); if (on) { try { cleanup?.(); } catch (e) { console.error(e); } } };
}

/** Add a command and return a function that removes it again. */
export function addCommand(app: App, cmd: Command): () => void {
  app.commands.addCommand(cmd);
  return () => app.commands.removeCommand(cmd.id);
}

/** Add a left-ribbon button and return a remover. */
export function addRibbon(app: App, icon: string, title: string, cb: (evt: MouseEvent) => void): () => void {
  const el = app.workspace.leftRibbon.addRibbonItemButton(`core:${title}`, icon, title, cb);
  return () => app.workspace.leftRibbon.removeRibbonItemButton(el);
}

/** Show (creating if needed) the single leaf of a sidebar view type. */
export function activateView(app: App, type: string, side: "left" | "right" = "left", opts: { toggle?: boolean } = {}): Promise<WorkspaceLeaf> {
  const existing = app.workspace.getLeavesOfType(type)[0];
  if (existing && opts.toggle) {
    const dock = existing.getRoot() === app.workspace.rightSplit ? app.workspace.rightSplit : app.workspace.leftSplit;
    const tabs = existing.parent as any;
    if (!dock.collapsed && tabs?.children?.[tabs.currentTab] === existing) { dock.collapse(); return Promise.resolve(existing); }
  }
  return app.workspace.ensureSideLeaf(type, side, { active: true, reveal: true });
}

/** Open a file honouring modifier keys on the triggering event (Ctrl/Cmd = new tab, +Alt = split). */
export function openFile(app: App, file: TFile, evt?: MouseEvent | KeyboardEvent | null, state?: Record<string, unknown>): Promise<void> {
  const mod = evt ? Keymap.isModEvent(evt) : false;
  const leaf = app.workspace.getLeaf(mod || false);
  return leaf.openFile(file, { active: true, ...(state ? { eState: state } : {}) });
}

/** Open a file and put the cursor on a 0-based line. */
export async function openAtLine(app: App, file: TFile, line: number, evt?: MouseEvent | KeyboardEvent | null): Promise<void> {
  await openFile(app, file, evt, { line });
}

/** ItemView helper: re-render when the vault/metadata changes, debounced. */
export abstract class PanelView extends ItemView {
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Schedule `refresh()` (coalesces bursts of events). */
  requestRefresh(delay = 120): void {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => { this._refreshTimer = null; try { this.refresh(); } catch (e) { console.error(e); } }, delay);
  }
  abstract refresh(): void;
  onunload(): void { if (this._refreshTimer) clearTimeout(this._refreshTimer); super.onunload(); }
}
