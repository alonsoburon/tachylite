// File-level operations shared by the explorer, commands and views (create / rename / delete / move / menus).
import { Menu, Notice, TFile, TFolder, type App, type TAbstractFile } from "../obsidian";
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
  await app.fileManager.trashFile(file);
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

/** Reveal the active/selected file in the file explorer. */
export function revealInExplorer(app: App, file: TAbstractFile): void {
  void app.workspace.ensureSideLeaf("file-explorer", "left", { reveal: true, active: false }).then((leaf) => (leaf.view as any).reveal?.(file));
}

/** Standard file/folder context menu; plugins extend it through the `file-menu` workspace event. */
export function buildFileMenu(app: App, file: TAbstractFile, source: string, menu = new Menu()): Menu {
  const isFile = file instanceof TFile;
  if (isFile) {
    menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("lucide-file-plus").onClick(() => { void app.workspace.getLeaf("tab").openFile(file, { active: true }); }));
    menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("lucide-separator-vertical").onClick(() => { void app.workspace.getLeaf("split").openFile(file, { active: true }); }));
  } else {
    menu.addItem((i) => i.setSection("action").setTitle("New note").setIcon("lucide-edit").onClick(() => { void newNote(app, { folder: file as TFolder }); }));
    menu.addItem((i) => i.setSection("action").setTitle("New folder").setIcon("lucide-folder-plus").onClick(() => { void newFolder(app, file as TFolder); }));
  }
  if (isFile) menu.addItem((i) => i.setSection("action").setTitle("Make a copy").setIcon("lucide-copy").onClick(() => { void duplicateFile(app, file).catch((e) => new Notice(String(e.message ?? e))); }));
  menu.addItem((i) => i.setSection("system").setTitle("Copy path from vault folder").setIcon("lucide-clipboard").onClick(() => copyText(file.path)));
  if (source !== "file-explorer") menu.addItem((i) => i.setSection("system").setTitle("Reveal file in navigation").setIcon("lucide-folder-search").onClick(() => revealInExplorer(app, file)));
  menu.addItem((i) => i.setSection("danger").setTitle("Rename...").setIcon("lucide-pencil").onClick(() => { void promptRename(app, file); }));
  menu.addItem((i) => i.setSection("danger").setTitle("Delete").setIcon("lucide-trash-2").setWarning(true).onClick(() => { void deleteWithPrompt(app, file).catch((e) => new Notice(String(e.message ?? e))); }));
  app.workspace.trigger("file-menu", menu, file, source, app.workspace.activeLeaf);
  return menu;
}
