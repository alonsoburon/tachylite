// Core plugin "canvas": .canvas files (JSON Canvas) open in the canvas view, embed as previews, and can be created
// from the ribbon, the command palette and folder menus. Cards follow renamed files, also in canvases that are closed.
import { Menu, Notice, TFile, TFolder, type App, type TAbstractFile, type WorkspaceLeaf } from "../../obsidian";
import { CanvasEmbed } from "../../canvas/embed";
import { parseCanvas, serializeCanvas } from "../../canvas/model";
import { CANVAS_VIEW, CanvasView, setCanvasUrlOpener } from "../../canvas/view";
import { openExternal } from "../bridge";
import { joinPath, uniqueName } from "../files";
import { addCommand, addRibbon, whileCoreEnabled, type CoreModule } from "./util";

/** Folder for a new canvas: the plugin's own location option (.obsidian/canvas.json), else the new-note location. */
function newCanvasFolder(app: App, options: Record<string, any>): TFolder {
  const v = app.vault;
  const active = app.workspace.getActiveFile();
  if (options.newFileLocation === "current" && active?.parent) return active.parent;
  if (options.newFileLocation === "folder") { const f = v.getFolderByPath(options.newFileFolderPath || "/"); if (f) return f; }
  if (options.newFileLocation === "root") return v.getRoot();
  return app.fileManager.getNewFileParent(active?.path ?? "");
}

/** Create "Untitled.canvas" (empty, like a fresh Obsidian canvas) and open it. */
export async function newCanvas(app: App, folder?: TFolder, leaf: WorkspaceLeaf = app.workspace.getLeaf(false)): Promise<TFile> {
  const options = app.internalPlugins.getPluginById("canvas")?.instance.options ?? {};
  const dir = folder ?? newCanvasFolder(app, options);
  const file = await app.vault.create(joinPath(dir, uniqueName(app, dir, "Untitled", "canvas")), "");
  await leaf.openFile(file, { active: true });
  return file;
}

/** Rewrite file-card paths (and group backgrounds) in canvases that are not open in a view. */
async function followRenames(app: App, renames: Map<string, string>): Promise<void> {
  const open = new Set(app.workspace.getLeavesOfType(CANVAS_VIEW).map((l) => (l.view as CanvasView).file?.path));
  const map = (p: unknown) => (typeof p === "string" ? renames.get(p) : undefined);
  for (const f of app.vault.getFiles()) {
    if (f.extension !== "canvas" || open.has(f.path)) continue;
    try {
      const text = await app.vault.read(f);
      if (![...renames.keys()].some((old) => text.includes(JSON.stringify(old).slice(1, -1)))) continue;
      const data = parseCanvas(text);
      let changed = false;
      for (const n of data.nodes) {
        const a = n.type === "file" ? map(n.file) : undefined, b = n.type === "group" ? map(n.background) : undefined;
        if (a) { (n as any).file = a; changed = true; }
        if (b) { (n as any).background = b; changed = true; }
      }
      if (changed) await app.vault.modify(f, serializeCanvas(data));
    } catch (e) { console.warn("canvas: could not update links in", f.path, e); }
  }
}

export const canvas: CoreModule = {
  id: "canvas",
  install(app: App) {
    app.viewRegistry.registerView(CANVAS_VIEW, (leaf) => new CanvasView(leaf));
    setCanvasUrlOpener(openExternal);
    // Plugins build headless canvases through the core plugin (Excalidraw: `plugins.canvas.views.canvas(leaf).canvas`).
    const wrapper = app.internalPlugins.getPluginById("canvas") as any;
    if (wrapper) wrapper.views = { canvas: (leaf: WorkspaceLeaf) => new CanvasView(leaf) };

    const pending = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = whileCoreEnabled(app, "canvas", () => {
      const reg = app.viewRegistry;
      const ownExt = !reg.getTypeByExtension("canvas");
      if (ownExt) reg.registerExtensions(["canvas"], CANVAS_VIEW);
      app.embedRegistry.registerExtension("canvas", (ctx, file, subpath) => new CanvasEmbed(ctx, file, subpath));
      const create = (folder?: TFolder) => { void newCanvas(app, folder).catch((e) => new Notice(String(e.message ?? e))); };
      const menuRef = app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) menu.addItem((i) => i.setSection("action-primary").setTitle("New canvas").setIcon("lucide-layout-dashboard").onClick(() => create(file)));
      });
      const renameRef = app.vault.on("rename", (f: TAbstractFile, old: string) => {
        if (!(f instanceof TFile)) return;
        pending.set(old, f.path);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; const r = new Map(pending); pending.clear(); void followRenames(app, r); }, 50);
      });
      const offs = [
        addCommand(app, { id: "canvas:new-file", name: "Canvas: Create new canvas", icon: "lucide-layout-dashboard", callback: () => create() }),
        addRibbon(app, "lucide-layout-dashboard", "Create new canvas", () => create()),
      ];
      return () => {
        offs.forEach((o) => o());
        app.workspace.offref(menuRef);
        app.vault.offref(renameRef);
        if (timer) { clearTimeout(timer); timer = null; }
        app.embedRegistry.unregisterExtension("canvas");
        if (ownExt) reg.unregisterExtensions(["canvas"]);
        app.workspace.detachLeavesOfType(CANVAS_VIEW);
      };
    });
    return () => { stop(); app.viewRegistry.unregisterView(CANVAS_VIEW); if (wrapper) delete wrapper.views; };
  },
};
