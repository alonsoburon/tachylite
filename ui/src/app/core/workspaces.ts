// "Workspaces" core plugin: named window layouts saved in .obsidian/workspaces.json ({ workspaces: {name: layout}, active }).
import { FuzzySuggestModal, Modal, Notice, setIcon, type App } from "../../obsidian";
import { ipc } from "../../ipc";
import { addCommand, addRibbon, whileCoreEnabled, type CoreModule } from "./util";
import { naturalCompare } from "./panel";

export class Workspaces {
  workspaces: Record<string, any> = {};
  activeWorkspace = "";
  constructor(public app: App) {
    const o = app.internalPlugins.plugins["workspaces"]?.instance.options ?? {};
    this.workspaces = o.workspaces && typeof o.workspaces === "object" ? o.workspaces : {};
    this.activeWorkspace = typeof o.active === "string" ? o.active : "";
  }
  names(): string[] { return Object.keys(this.workspaces).sort(naturalCompare); }
  async saveData(): Promise<void> {
    const data = { workspaces: this.workspaces, active: this.activeWorkspace };
    const inst = this.app.internalPlugins.plugins["workspaces"]?.instance;
    if (inst) inst.options = data;
    await ipc.configWrite("workspaces.json", data);
  }
  /** Store the current layout under `name` (replacing it) and make it active. */
  async saveWorkspace(name: string): Promise<void> {
    const layout: any = JSON.parse(JSON.stringify(this.app.workspace.getLayout()));
    delete layout.lastOpenFiles;
    this.workspaces[name] = layout;
    this.activeWorkspace = name;
    await this.saveData();
    this.app.workspace.trigger("layout-change");
  }
  async loadWorkspace(name: string): Promise<boolean> {
    const layout = this.workspaces[name];
    if (!layout) { new Notice(`Workspace "${name}" not found.`); return false; }
    const ws = this.app.workspace, last = ws.getLastOpenFiles();
    await ws.changeLayout({ ...JSON.parse(JSON.stringify(layout)), lastOpenFiles: last });
    (this.app as any).tachylite?.shell?.decorate?.();
    this.activeWorkspace = name;
    await this.saveData();
    ws.requestSaveLayout();
    return true;
  }
  async deleteWorkspace(name: string): Promise<void> {
    delete this.workspaces[name];
    if (this.activeWorkspace === name) this.activeWorkspace = "";
    await this.saveData();
  }
  setActiveWorkspace(name: string): Promise<void> { this.activeWorkspace = name; return this.saveData(); }
}

class WorkspacePicker extends FuzzySuggestModal<string> {
  constructor(app: App, private plugin: Workspaces, private saveFirst: boolean) {
    super(app);
    this.setPlaceholder("Type the name of a workspace layout to load...");
    this.emptyStateText = "No workspace layouts saved yet.";
  }
  getItems(): string[] { return this.plugin.names(); }
  getItemText(n: string): string { return n; }
  async onChooseItem(n: string): Promise<void> {
    if (this.saveFirst && this.plugin.activeWorkspace) await this.plugin.saveWorkspace(this.plugin.activeWorkspace);
    await this.plugin.loadWorkspace(n);
  }
}

export class WorkspacesModal extends Modal {
  private listEl!: HTMLElement;
  inputEl!: HTMLInputElement;
  constructor(app: App, private plugin: Workspaces) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("mod-workspaces");
    this.setTitle("Manage workspace layouts");
    const row = this.contentEl.createDiv({ cls: "workspaces-save-row" });
    this.inputEl = row.createEl("input", { type: "text", attr: { placeholder: "Name of workspace layout", spellcheck: "false" } });
    this.inputEl.value = this.plugin.activeWorkspace;
    const save = row.createEl("button", { cls: "mod-cta", text: "Save" });
    const doSave = async () => {
      const name = this.inputEl.value.trim();
      if (!name) { new Notice("Enter a name for the workspace layout."); return; }
      await this.plugin.saveWorkspace(name);
      new Notice(`Saved workspace layout "${name}".`);
      this.render();
    };
    save.addEventListener("click", () => void doSave());
    this.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); void doSave(); } });
    this.listEl = this.contentEl.createDiv({ cls: "workspaces-list" });
    this.render();
    setTimeout(() => this.inputEl.focus(), 0);
  }
  render(): void {
    const el = this.listEl;
    el.empty();
    const names = this.plugin.names();
    if (!names.length) { el.createDiv({ cls: "pane-empty", text: "No workspace layouts saved yet." }); return; }
    for (const n of names) {
      const active = n === this.plugin.activeWorkspace;
      const item = el.createDiv({ cls: "workspace-item" + (active ? " is-active" : ""), attr: { "data-workspace": n } });
      item.createDiv({ cls: "workspace-item-name", text: n });
      if (active) item.createDiv({ cls: "workspace-item-active-flair", text: "Active" });
      item.createEl("button", { cls: "mod-load", text: "Load" }).addEventListener("click", async () => { if (await this.plugin.loadWorkspace(n)) this.close(); });
      const del = item.createDiv({ cls: "clickable-icon mod-delete", attr: { "aria-label": "Delete layout" } });
      setIcon(del, "lucide-trash-2");
      del.addEventListener("click", async () => { await this.plugin.deleteWorkspace(n); this.render(); });
    }
  }
}

export const workspaces: CoreModule = {
  id: "workspaces",
  install(app: App) {
    return whileCoreEnabled(app, "workspaces", () => {
      const w = new Workspaces(app);
      const inst = app.internalPlugins.plugins["workspaces"]!.instance as any;
      // Obsidian's instance exposes the data and the operations; plugins read them.
      Object.defineProperty(inst, "workspaces", { get: () => w.workspaces, configurable: true });
      Object.defineProperty(inst, "activeWorkspace", { get: () => w.activeWorkspace, configurable: true });
      Object.assign(inst, { saveWorkspace: (n: string) => w.saveWorkspace(n), loadWorkspace: (n: string) => w.loadWorkspace(n), deleteWorkspace: (n: string) => w.deleteWorkspace(n), setActiveWorkspace: (n: string) => w.setActiveWorkspace(n) });
      const manage = () => new WorkspacesModal(app, w).open();
      const offs = [
        addRibbon(app, "lucide-layout", "Manage workspace layouts", manage),
        addCommand(app, { id: "workspaces:open-modal", name: "Workspaces: Manage workspace layouts", icon: "lucide-layout", callback: manage }),
        addCommand(app, { id: "workspaces:load", name: "Workspaces: Load workspace layout", icon: "lucide-layout", callback: () => new WorkspacePicker(app, w, false).open() }),
        addCommand(app, { id: "workspaces:save", name: "Workspaces: Save current workspace layout", icon: "lucide-save", callback: () => {
          if (!w.activeWorkspace) { manage(); return; }
          void w.saveWorkspace(w.activeWorkspace).then(() => new Notice(`Saved workspace layout "${w.activeWorkspace}".`));
        } }),
        addCommand(app, { id: "workspaces:save-and-load", name: "Workspaces: Save and load another workspace layout", icon: "lucide-layout", callback: () => new WorkspacePicker(app, w, true).open() }),
      ];
      return () => {
        offs.forEach((o) => o());
        for (const k of ["workspaces", "activeWorkspace", "saveWorkspace", "loadWorkspace", "deleteWorkspace", "setActiveWorkspace"]) delete inst[k];
      };
    });
  },
};
