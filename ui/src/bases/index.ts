// Core plugin "bases": `.base` file view, embeds, ```base code blocks, commands and the built-in view types.
import { MarkdownView, SuggestModal, type App, type Menu, type TAbstractFile, TFile, TFolder } from "../obsidian";
import { MarkdownPreviewRenderer } from "../obsidian/markdown";
import { whileCoreEnabled, type CoreModule } from "../app/core/util";
import { joinPath, uniqueName } from "../app/files";
import type { BasesController } from "./host";
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

/** "Bases: Change view": pick one of the base's views by name; the current one carries an "Active" badge. */
class ViewSuggestModal extends SuggestModal<number> {
  constructor(app: App, private controller: BasesController) {
    super(app);
    this.setInstructions([{ command: "↑↓", purpose: "to navigate" }, { command: "↵", purpose: "to use" }, { command: "esc", purpose: "to dismiss" }]);
  }
  private name(i: number): string { const v = this.controller.config!.views[i]; return v.name || v.type; }
  getSuggestions(query: string): number[] {
    const q = query.trim().toLowerCase();
    return this.controller.config!.views.map((_, i) => i).filter((i) => !q || this.name(i).toLowerCase().includes(q));
  }
  renderSuggestion(i: number, el: HTMLElement): void {
    el.setText(this.name(i));
    if (i === this.controller.viewIndex) el.createSpan({ cls: "flair toolbar-badge", text: "Active" });
  }
  onChooseSuggestion(i: number): void { this.controller.selectView(i); }
}

/** Commands that need the active base view (checkCallback keeps them out of the palette elsewhere). */
function viewCommands(app: App): string[] {
  const ctl = () => app.workspace.getActiveViewOfType(BasesFileView)?.controller ?? null;
  const defs: { id: string; name: string; icon: string; run: (c: BasesController) => void }[] = [
    { id: "bases:add-item", name: "Bases: Add item", icon: "lucide-plus", run: (c) => { if (c.view) void c.createFile(c.view); } },
    { id: "bases:change-view", name: "Bases: Change view", icon: "lucide-table", run: (c) => new ViewSuggestModal(app, c).open() },
    { id: "bases:copy-table", name: "Bases: Copy table to clipboard", icon: "lucide-copy", run: (c) => { void c.copyTable(); } },
  ];
  for (const d of defs) {
    app.commands.addCommand({ id: d.id, name: d.name, icon: d.icon, checkCallback: (checking) => {
      const c = ctl();
      if (!c?.config) return false;
      if (!checking) d.run(c);
      return true;
    } });
  }
  return defs.map((d) => d.id);
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
      const viewIds = viewCommands(app);
      cleanups.push(() => { for (const id of ["bases:new-file", "bases:insert", "bases:add-view", ...viewIds]) app.commands.removeCommand(id); });
      const rib = app.workspace.leftRibbon.addRibbonItemButton("bases", "lucide-table", "Create new base", () => { void createBase(app).then(open); });
      cleanups.push(() => app.workspace.leftRibbon.removeRibbonItemButton(rib));
      const ref = app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((i) => i.setSection("action-primary").setTitle("New base").setIcon("lucide-table").onClick(() => { void createBase(app, file).then(open); }));
      });
      cleanups.push(() => app.workspace.offref(ref));
      return () => { for (const c of cleanups.reverse()) c(); };
    });
    return () => { off(); app.viewRegistry.unregisterView(BASES_VIEW_TYPE); };
  },
};

export { BasesController } from "./host";
export { BasesFileView, BaseEmbed } from "./fileView";
