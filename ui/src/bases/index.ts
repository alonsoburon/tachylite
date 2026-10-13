// Core plugin "bases": `.base` file view, embeds, ```base code blocks, commands and the built-in view types.
import { MarkdownView, type App, type Menu, type TAbstractFile, TFile, TFolder } from "../obsidian";
import { MarkdownPreviewRenderer } from "../obsidian/markdown";
import { whileCoreEnabled, type CoreModule } from "../app/core/util";
import { joinPath, uniqueName } from "../app/files";
import { BASES_VIEW_TYPE, BaseEmbed, BasesFileView, renderBaseCodeBlock } from "./fileView";
import { CORE_VIEWS } from "./views";

export const NEW_BASE_CONTENT = "views:\n  - type: table\n    name: Table\n";

/** Create `Untitled.base` (or `Untitled 1.base`, ...) in `folder`, or next to the active file. */
export async function createBase(app: App, folder?: TFolder | null): Promise<TFile> {
  const active = app.workspace.getActiveFile();
  const parent = folder ?? active?.parent ?? app.fileManager.getNewFileParent(active?.path ?? "");
  const name = uniqueName(app, parent, "Untitled", "base");
  return app.vault.create(joinPath(parent, name), NEW_BASE_CONTENT);
}

export const bases: CoreModule = {
  id: "bases",
  install(app: App) {
    for (const [id, reg] of Object.entries(CORE_VIEWS)) app.basesViews[id] ??= reg;
    app.viewRegistry.registerView(BASES_VIEW_TYPE, (leaf) => new BasesFileView(leaf));
    const off = whileCoreEnabled(app, "bases", () => {
      const cleanups: (() => void)[] = [];
      if (!app.viewRegistry.isExtensionRegistered("base")) {
        app.viewRegistry.registerExtensions(["base"], BASES_VIEW_TYPE);
        cleanups.push(() => app.viewRegistry.unregisterExtensions(["base"]));
      }
      app.embedRegistry.registerExtension("base", (ctx, file, subpath) => new BaseEmbed(ctx, file, subpath));
      cleanups.push(() => app.embedRegistry.unregisterExtension("base"));
      const pp = MarkdownPreviewRenderer.createCodeBlockPostProcessor("base", (src, el, ctx) => renderBaseCodeBlock(app, src, el, ctx));
      MarkdownPreviewRenderer.registerPostProcessor(pp);
      cleanups.push(() => MarkdownPreviewRenderer.unregisterPostProcessor(pp));

      const open = async (f: TFile) => { await app.workspace.getLeaf(false).openFile(f, { active: true }); };
      app.commands.addCommand({ id: "bases:new-file", name: "Bases: Create new base", icon: "lucide-table", callback: () => { void createBase(app).then(open); } });
      app.commands.addCommand({
        id: "bases:insert", name: "Bases: Insert new base", icon: "lucide-table",
        editorCallback: (editor, view) => {
          void createBase(app).then((f) => {
            const src = (view as MarkdownView).file?.path ?? "";
            editor.replaceSelection(`![[${app.metadataCache.fileToLinktext(f, src, false)}]]\n`);
          });
        },
      });
      app.commands.addCommand({
        id: "bases:add-view", name: "Bases: Add view",
        checkCallback: (checking) => {
          const v = app.workspace.getActiveViewOfType(BasesFileView);
          if (!v?.controller?.config) return false;
          if (!checking) v.controller.addView();
          return true;
        },
      });
      cleanups.push(() => { for (const id of ["bases:new-file", "bases:insert", "bases:add-view"]) app.commands.removeCommand(id); });
      const rib = app.workspace.leftRibbon.addRibbonItemButton("bases", "lucide-table", "Create new base", () => { void createBase(app).then(open); });
      cleanups.push(() => app.workspace.leftRibbon.removeRibbonItemButton(rib));
      const ref = app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((i) => i.setSection("action").setTitle("New base").setIcon("lucide-table").onClick(() => { void createBase(app, file).then(open); }));
      });
      cleanups.push(() => app.workspace.offref(ref));
      return () => { for (const c of cleanups.reverse()) c(); };
    });
    return () => { off(); app.viewRegistry.unregisterView(BASES_VIEW_TYPE); };
  },
};

export { BasesController } from "./host";
export { BasesFileView, BaseEmbed } from "./fileView";
