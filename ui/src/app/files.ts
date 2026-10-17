// File-level operations shared by the explorer, commands and views (create / rename / delete / move / menus).
import { ipc } from "../ipc";
import { FuzzySuggestModal, MarkdownView, Menu, Notice, Platform, TFile, TFolder, type App, type TAbstractFile } from "../obsidian";
import { confirmDialog, promptText } from "./dialogs";

const ILLEGAL = /[\\/:*?"<>|]/;
export function validateName(name: string): string | null {
  if (!name.trim()) return "Name cannot be empty.";
  if (ILLEGAL.test(name)) return 'A name cannot contain any of the following characters: \\ / : * ? " < > |';
  if (name.startsWith(".")) return "A name cannot start with a dot.";
  return null;
}

export function joinPath(folder: TFolder | string | null | undefined, name: string): string {
  const p = typeof folder === "string" ? folder : folder?.path ?? "/";
  return !p || p === "/" ? name : `${p}/${name}`;
}

/** First free `base`, `base 1`, `base 2`... in `folder`. */
export function uniqueName(app: App, folder: TFolder | null, base: string, ext = ""): string {
  let n = 0, name: string;
  do {
    name = `${base}${n ? ` ${n}` : ""}${ext ? "." + ext : ""}`;
    n++;
  } while (app.vault.getAbstractFileByPath(joinPath(folder, name)));
  return name;
}

/** Folder a new note should land in, honouring "Default location for new notes". */
export function defaultNewNoteFolder(app: App): TFolder {
  const active = app.workspace.getActiveFile();
  return app.fileManager.getNewFileParent(active?.path ?? "");
}

export interface NewNoteOptions { folder?: TFolder; name?: string; content?: string; open?: boolean | "tab" | "split"; rename?: boolean }

/** Create "Untitled" (or `name`) and open it. With `rename` the inline title is focused for naming. */
export async function newNote(app: App, o: NewNoteOptions = {}): Promise<TFile> {
  const folder = o.folder ?? defaultNewNoteFolder(app);
  const name = uniqueName(app, folder, o.name ?? "Untitled", "md");
  const file = await app.vault.create(joinPath(folder, name), o.content ?? "");
  if (o.open !== false) {
    const leaf = app.workspace.getLeaf(o.open === "tab" ? "tab" : o.open === "split" ? "split" : false);
    await leaf.openFile(file, { active: true, state: { mode: "source" } });
    if (o.rename !== false && !o.name) (app as any).tachylite?.focusInlineTitle?.(leaf);
  }
  return file;
}

export async function newFolder(app: App, parent?: TFolder): Promise<TFolder | null> {
  const folder = parent ?? defaultNewNoteFolder(app);
  const name = await promptText(app, { title: "New folder", value: uniqueName(app, folder, "Untitled folder"), cta: "Create", validate: (v) => validateName(v) ?? (app.vault.getAbstractFileByPath(joinPath(folder, v)) ? "A file or folder with that name already exists." : null) });
  if (name === null) return null;
  return app.vault.createFolder(joinPath(folder, name));
}

/** Rename keeping the extension when the user typed a bare name. Rejects with a readable message on conflicts. */
export async function renameTo(app: App, file: TAbstractFile, newName: string): Promise<void> {
  let name = newName.trim();
  const bad = validateName(name);
  if (bad) throw new Error(bad);
  if (file instanceof TFile && file.extension && !name.toLowerCase().endsWith("." + file.extension.toLowerCase())) name += "." + file.extension;
  const dest = joinPath(file.parent, name);
  if (dest === file.path) return;
  const clash = app.vault.getAbstractFileByPath(dest);
  if (clash && clash !== file && dest.toLowerCase() !== file.path.toLowerCase()) throw new Error("A file or folder with that name already exists.");
  await app.fileManager.renameFile(file, dest);
}

export async function promptRename(app: App, file: TAbstractFile): Promise<void> {
  const base = file instanceof TFile ? file.basename : file.name;
  const v = await promptText(app, { title: file instanceof TFile ? "Rename file" : "Rename folder", value: base, cta: "Rename", validate: validateName });
  if (v === null || v === base) return;
  try { await renameTo(app, file, v); } catch (e) { new Notice((e as Error).message); }
}

export async function deleteWithPrompt(app: App, file: TAbstractFile): Promise<boolean> {
  const what = file instanceof TFolder ? `folder '${file.name}' and its contents` : `'${file.name}'`;
  if (app.vault.getConfig("promptDelete") !== false) {
    const ok = await confirmDialog(app, { title: `Delete ${file instanceof TFolder ? "folder" : "file"}`, message: `Are you sure you want to delete ${what}?`, cta: "Delete", warning: true });
    if (!ok) return false;
  }
  try { await app.fileManager.trashFile(file); }
  catch (e) { new Notice(`Couldn't delete "${file.name}": ${(e as Error)?.message ?? e}`); return false; }
  return true;
}

export async function moveInto(app: App, file: TAbstractFile, folder: TFolder): Promise<void> {
  if (file.parent === folder) return;
  if (file instanceof TFolder && (folder === file || folder.path.startsWith(file.path + "/"))) throw new Error("Cannot move a folder into itself.");
  const dest = joinPath(folder, file.name);
  if (app.vault.getAbstractFileByPath(dest)) throw new Error(`"${file.name}" already exists in the destination folder.`);
  await app.fileManager.renameFile(file, dest);
}

export async function duplicateFile(app: App, file: TFile): Promise<TFile> {
  const name = uniqueName(app, file.parent, file.basename + " copy", file.extension);
  return app.vault.copy(file, joinPath(file.parent, name));
}

export function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
}

/** Picker behind "Move file to...": every folder, the vault root first. */
export class FolderPicker extends FuzzySuggestModal<TFolder> {
  constructor(app: App, private file: TAbstractFile) { super(app); this.setPlaceholder(file instanceof TFolder ? "Move folder to..." : "Move file to..."); }
  getItems(): TFolder[] {
    // A folder can't move into itself or its own subfolders.
    const own = this.file instanceof TFolder ? this.file.path : null;
    return this.app.vault.getAllFolders(true).filter((f) => !own || (f.path !== own && !f.path.startsWith(own + "/")));
  }
  getItemText(f: TFolder): string { return f.isRoot() ? "/" : f.path; }
  onChooseItem(f: TFolder): void { void moveInto(this.app, this.file, f).catch((e) => new Notice(String(e?.message ?? e))); }
}

/** Reveal the active/selected file in the file explorer. */
export function revealInExplorer(app: App, file: TAbstractFile): void {
  void app.workspace.ensureSideLeaf("file-explorer", "left", { reveal: true, active: false }).then((leaf) => (leaf.view as any).reveal?.(file));
}

/** Standard file/folder context menu; plugins extend it through the `file-menu` workspace event. */
/** The file entries of the tab header and "More options" menus, in the order Obsidian 1.14.4 lists them (compat/obsidian-reference.json). */
function buildViewFileMenu(app: App, file: TFile, source: string, menu: Menu): Menu {
  const run = (id: string) => () => { app.commands.executeCommandById(id); };
  menu.addItem((i) => i.setSection("action").setTitle("Rename...").setIcon("lucide-pencil").onClick(() => { void promptRename(app, file); }));
  menu.addItem((i) => i.setSection("action").setTitle("Move file to...").setIcon("lucide-folder-tree").onClick(() => new FolderPicker(app, file).open()));
  // Plugins (Bookmarks, Note composer) add their entries here, between Move and Add file property.
  app.workspace.trigger("file-menu", menu, file, source, app.workspace.activeLeaf);
  menu.addItem((i) => i.setSection("action").setTitle("Add file property").setIcon("lucide-archive").onClick(run("markdown:add-metadata-property")));
  const editing = app.workspace.getActiveViewOfType(MarkdownView)?.getMode() === "source";
  if (editing) {
    menu.addItem((i) => i.setSection("find").setTitle("Find...").setIcon("lucide-search").onClick(run("editor:open-search")));
    menu.addItem((i) => i.setSection("find").setTitle("Replace...").setIcon("lucide-replace").onClick(run("editor:open-search-replace")));
  }
  copyPathItem(app, file, menu);
  const sys = (reveal: boolean) => () => { void ipc.openInSystem(file.path, reveal).catch((e) => new Notice(String(e?.message ?? e))); };
  menu.addItem((i) => i.setSection("system").setTitle("Open in default app").setIcon("lucide-external-link").onClick(sys(false)));
  menu.addItem((i) => i.setSection("system").setTitle(Platform.isMacOS ? "Reveal in Finder" : "Show in system explorer").setIcon("lucide-folder-open").onClick(sys(true)));
  menu.addItem((i) => i.setSection("system").setTitle("Reveal file in navigation").setIcon("lucide-folder-search").onClick(() => revealInExplorer(app, file)));
  menu.addItem((i) => i.setSection("danger").setTitle("Delete file").setIcon("lucide-trash-2").setWarning(true).onClick(() => { void deleteWithPrompt(app, file).catch((e) => new Notice(String(e.message ?? e))); }));
  return menu;
}

/** "Copy path" with its submenu: from the vault folder, from the system root, and the Obsidian URL. */
function copyPathItem(app: App, file: TAbstractFile, menu: Menu): void {
  menu.addItem((i) => {
    i.setSection("copy").setTitle("Copy path").setIcon("lucide-clipboard");
    const sub = i.setSubmenu();
    sub.addItem((j) => j.setTitle("Copy path from vault folder").onClick(() => copyText(file.path)));
    sub.addItem((j) => j.setTitle("Copy path from system root").onClick(() => copyText(app.vault.adapter.getFullPath(file.path))));
    sub.addItem((j) => j.setTitle("Copy Obsidian URL").onClick(() => copyText(`obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=${encodeURIComponent(file instanceof TFile && file.extension === "md" ? file.path.replace(/\.md$/, "") : file.path)}`)));
  });
}

export function buildFileMenu(app: App, file: TAbstractFile, source: string, menu = new Menu()): Menu {
  const isFile = file instanceof TFile;
  if (isFile && (source === "tab-header" || source === "more-options")) return buildViewFileMenu(app, file, source, menu);
  if (isFile && source !== "more-options") {
    menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => { void app.workspace.getLeaf("tab").openFile(file, { active: true }); }));
    menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => { void app.workspace.getLeaf("split").openFile(file, { active: true }); }));
  } else if (!isFile) {
    menu.addItem((i) => i.setSection("action").setTitle("New note").setIcon("lucide-edit").onClick(() => { void newNote(app, { folder: file as TFolder }); }));
    menu.addItem((i) => i.setSection("action").setTitle("New folder").setIcon("lucide-folder-plus").onClick(() => { void newFolder(app, file as TFolder); }));
  }
  if (isFile && source !== "tab-header") menu.addItem((i) => i.setSection("open").setTitle("Open in new window").setIcon("lucide-app-window").onClick(() => { void app.workspace.openPopoutLeaf().openFile(file, { active: true }); }));
  if (isFile) menu.addItem((i) => i.setSection("action").setTitle("Make a copy").setIcon("lucide-copy").onClick(() => { void duplicateFile(app, file).catch((e) => new Notice(String(e.message ?? e))); }));
  menu.addItem((i) => i.setSection("action").setTitle(isFile ? "Move file to..." : "Move folder to...").setIcon("lucide-folder-tree").onClick(() => new FolderPicker(app, file).open()));
  if (!isFile) {
    menu.addItem((i) => i.setSection("action").setTitle("Search in folder").setIcon("lucide-search").onClick(() => {
      void app.workspace.ensureSideLeaf("search", "left", { active: true, reveal: true }).then((leaf) => (leaf.view as any).setQuery?.(`path:"${file.path}"`));
    }));
  }
  copyPathItem(app, file, menu);
  const sys = (reveal: boolean) => () => { void ipc.openInSystem(file.path, reveal).catch((e) => new Notice(String(e?.message ?? e))); };
  if (isFile) menu.addItem((i) => i.setSection("system").setTitle("Open in default app").setIcon("lucide-external-link").onClick(sys(false)));
  menu.addItem((i) => i.setSection("system").setTitle(Platform.isMacOS ? "Reveal in Finder" : "Show in system explorer").setIcon("lucide-folder-open").onClick(sys(true)));
  if (source !== "file-explorer") menu.addItem((i) => i.setSection("system").setTitle("Reveal file in navigation").setIcon("lucide-folder-search").onClick(() => revealInExplorer(app, file)));
  menu.addItem((i) => i.setSection("danger").setTitle("Rename...").setIcon("lucide-pencil").onClick(() => { void promptRename(app, file); }));
  const inView = source === "tab-header" || source === "more-options";
  menu.addItem((i) => i.setSection("danger").setTitle(isFile && inView ? "Delete file" : "Delete").setIcon("lucide-trash-2").setWarning(true).onClick(() => { void deleteWithPrompt(app, file).catch((e) => new Notice(String(e.message ?? e))); }));
  app.workspace.trigger("file-menu", menu, file, source, app.workspace.activeLeaf);
  return menu;
}
