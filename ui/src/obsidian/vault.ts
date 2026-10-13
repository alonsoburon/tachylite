// Vault, TFile tree and the DataAdapter, backed by the Rust core through ipc.
import { ipc, type VaultFileInfo, type VaultInfo, type Listing } from "../ipc";
import { Events } from "./events";
import { TAbstractFile, TFile, TFolder } from "./files";
import { normalizePath } from "./util";
import type { App } from "./app";

export interface Stat { type: "file" | "folder"; ctime: number; mtime: number; size: number }
export interface DataWriteOptions { ctime?: number; mtime?: number }
export interface ListedFiles { files: string[]; folders: string[] }

const enc = new TextEncoder();
const dec = new TextDecoder();

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "/" : path.slice(0, i);
}

export const DEFAULT_CONFIG: Record<string, any> = {
  showLineNumber: false, foldHeading: true, foldIndent: true, defaultViewMode: "source", livePreview: true,
  readableLineLength: true, strictLineBreaks: false, propertiesInDocument: "visible", showInlineTitle: true,
  tabSize: 4, useTab: true, spellcheck: true, vimMode: false, autoPairBrackets: true, autoPairMarkdown: true,
  smartIndentList: true, promptDelete: true, trashOption: "system", alwaysUpdateLinks: false,
  newFileLocation: "root", newFileFolderPath: "", attachmentFolderPath: "/", useMarkdownLinks: false,
  newLinkFormat: "shortest", showUnsupportedFiles: false, userIgnoreFilters: [], showViewHeader: true,
  theme: "system", cssTheme: "", enabledCssSnippets: [], baseFontSize: 16, nativeMenus: false,
};

/** FileSystemAdapter equivalent: raw access (including dot folders) through adapter_* commands. */
export class FileSystemAdapter {
  private known = new Map<string, Stat>();
  constructor(private vault: Vault) {}
  getName(): string { return this.vault.getName(); }
  getBasePath(): string { return this.vault.basePath; }
  getFullPath(p: string): string { return this.vault.basePath.replace(/\/$/, "") + "/" + normalizePath(p); }
  getFilePath(p: string): string { return this.getFullPath(p); }
  getResourcePath(p: string): string {
    p = normalizePath(p);
    const w = globalThis as any;
    const full = this.getFullPath(p);
    const conv = w.__TAURI__?.core?.convertFileSrc ?? w.__TAURI_INTERNALS__?.convertFileSrc;
    const base = conv ? conv(full) : "app://local/" + encodeURI(p);
    const f = this.vault.getFileByPath(p);
    return base + "?" + (f ? f.stat.mtime : Date.now());
  }
  async exists(p: string, _sensitive?: boolean): Promise<boolean> { return ipc.adapterExists(normalizePath(p)); }
  async stat(p: string): Promise<Stat | null> {
    p = normalizePath(p);
    const f = this.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) return { type: "file", ...f.stat };
    if (f instanceof TFolder) return { type: "folder", ctime: 0, mtime: 0, size: 0 };
    try {
      const st = await ipc.adapterStat(p);
      return st ? { type: st.type, ctime: st.ctime, mtime: st.mtime, size: st.size } : null;
    } catch { /* older backend: probe instead */ }
    if (!(await ipc.adapterExists(p))) return null;
    const k = this.known.get(p);
    if (k) return k;
    try { await ipc.adapterList(p); return { type: "folder", ctime: 0, mtime: 0, size: 0 }; } catch { /* not a dir */ }
    const size = (await ipc.adapterReadBinary(p)).byteLength;
    return { type: "file", ctime: 0, mtime: 0, size };
  }
  async list(p: string): Promise<ListedFiles> {
    const l: Listing = await ipc.adapterList(normalizePath(p) === "/" ? "" : normalizePath(p));
    return { files: l.files, folders: l.folders };
  }
  read(p: string): Promise<string> { return ipc.adapterRead(normalizePath(p)); }
  readBinary(p: string): Promise<ArrayBuffer> { return ipc.adapterReadBinary(normalizePath(p)); }
  private async put(p: string, data: Uint8Array): Promise<void> {
    p = normalizePath(p);
    await ipc.adapterWrite(p, data);
    const now = Date.now();
    this.known.set(p, { type: "file", ctime: this.known.get(p)?.ctime ?? now, mtime: now, size: data.byteLength });
    if (!p.startsWith(this.vault.configDir + "/")) this.vault.scheduleSync();
  }
  write(p: string, data: string, _o?: DataWriteOptions): Promise<void> { return this.put(p, enc.encode(data)); }
  writeBinary(p: string, data: ArrayBuffer, _o?: DataWriteOptions): Promise<void> { return this.put(p, new Uint8Array(data)); }
  async append(p: string, data: string, o?: DataWriteOptions): Promise<void> {
    const cur = (await this.exists(p)) ? await this.read(p) : "";
    await this.write(p, cur + data, o);
  }
  async appendBinary(p: string, data: ArrayBuffer, o?: DataWriteOptions): Promise<void> {
    const cur = (await this.exists(p)) ? new Uint8Array(await this.readBinary(p)) : new Uint8Array(0);
    const add = new Uint8Array(data);
    const out = new Uint8Array(cur.length + add.length);
    out.set(cur); out.set(add, cur.length);
    await this.writeBinary(p, out.buffer as ArrayBuffer, o);
  }
  async process(p: string, fn: (d: string) => string, o?: DataWriteOptions): Promise<string> {
    const out = fn(await this.read(p));
    await this.write(p, out, o);
    return out;
  }
  async mkdir(p: string): Promise<void> { await ipc.adapterMkdir(normalizePath(p)); this.vault.scheduleSync(); }
  async rmdir(p: string, recursive: boolean): Promise<void> { await ipc.adapterRemove(normalizePath(p), recursive); this.vault.scheduleSync(); }
  async remove(p: string): Promise<void> {
    p = normalizePath(p);
    await ipc.adapterRemove(p, false);
    this.known.delete(p);
    this.vault.scheduleSync();
  }
  /** Move to the OS trash; `false` (nothing moved) when the system trash is unavailable or fails. */
  async trashSystem(p: string): Promise<boolean> {
    p = normalizePath(p);
    try { await ipc.fsTrash(p, "system"); } catch (e) { console.warn(`system trash failed for ${p}`, e); return false; }
    this.known.delete(p);
    this.vault.scheduleSync();
    return true;
  }
  /** Move into the vault's `.trash` folder. */
  async trashLocal(p: string): Promise<void> {
    p = normalizePath(p);
    await ipc.fsTrash(p, "local");
    this.known.delete(p);
    this.vault.scheduleSync();
  }
  async copy(from: string, to: string): Promise<void> {
    from = normalizePath(from); to = normalizePath(to);
    const st = await this.stat(from);
    if (!st) throw new Error(`ENOENT: no such file or directory, copy '${from}'`);
    if (st.type === "file") { await this.writeBinary(to, await this.readBinary(from)); return; }
    await this.mkdir(to);
    const l = await this.list(from);
    for (const f of l.files) await this.copy(f, to + "/" + f.slice(f.lastIndexOf("/") + 1));
    for (const d of l.folders) await this.copy(d, to + "/" + d.slice(d.lastIndexOf("/") + 1));
  }
  async rename(from: string, to: string): Promise<void> {
    from = normalizePath(from); to = normalizePath(to);
    const f = this.vault.getAbstractFileByPath(from);
    if (f) { await this.vault.rename(f, to); return; }
    await this.copy(from, to);
    await ipc.adapterRemove(from, true);
    this.known.delete(from);
    this.vault.scheduleSync();
  }
}
export { FileSystemAdapter as DataAdapterImpl };
export type DataAdapter = FileSystemAdapter;

export class Vault extends Events {
  adapter: FileSystemAdapter;
  configDir = ".obsidian";
  basePath = "";
  name = "";
  fileMap: Record<string, TAbstractFile> = {};
  root: TFolder;
  config: Record<string, any> = {};
  private readCache = new Map<string, { mtime: number; size: number; data: string }>();
  private syncing: Promise<void> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncQueued = false;

  constructor(public app: App, info?: VaultInfo) {
    super();
    this.root = new TFolder(this, "/");
    this.fileMap["/"] = this.root;
    this.adapter = new FileSystemAdapter(this);
    if (info) this.load(info);
  }

  /** (Re)build the file tree from the backend index without firing events. */
  load(info: VaultInfo): void {
    this.name = info.name;
    this.basePath = info.path;
    this.fileMap = { "/": this.root };
    this.root.children = [];
    for (const d of info.folders) this.ensureFolder(normalizePath(d));
    for (const f of info.files) this.addFile(f);
  }

  // ----- queries
  getName(): string { return this.name; }
  getRoot(): TFolder { return this.root; }
  getAbstractFileByPath(path: string): TAbstractFile | null { return this.fileMap[path] ?? this.fileMap[normalizePath(path)] ?? null; }
  /** Internal API (Excalidraw): exact match first, else the first path equal ignoring case. */
  getAbstractFileByPathInsensitive(path: string): TAbstractFile | null {
    const exact = this.getAbstractFileByPath(path);
    if (exact) return exact;
    const lc = normalizePath(path).toLowerCase();
    return Object.values(this.fileMap).find((f) => f.path.toLowerCase() === lc) ?? null;
  }
  getFileByPath(path: string): TFile | null { const f = this.getAbstractFileByPath(path); return f instanceof TFile ? f : null; }
  getFolderByPath(path: string): TFolder | null { const f = this.getAbstractFileByPath(path); return f instanceof TFolder ? f : null; }
  getAllLoadedFiles(): TAbstractFile[] { return Object.values(this.fileMap); }
  getAllFolders(includeRoot = false): TFolder[] {
    return Object.values(this.fileMap).filter((f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()));
  }
  getFiles(): TFile[] { return Object.values(this.fileMap).filter((f): f is TFile => f instanceof TFile); }
  getMarkdownFiles(): TFile[] { return this.getFiles().filter((f) => f.extension === "md"); }
  static recurseChildren(root: TFolder, cb: (f: TAbstractFile) => any): void {
    for (const c of root.children.slice()) { cb(c); if (c instanceof TFolder) Vault.recurseChildren(c, cb); }
  }
  getResourcePath(file: TFile): string { return this.adapter.getResourcePath(file.path); }

  // ----- config (.obsidian/app.json)
  async loadConfig(): Promise<void> {
    const v = await ipc.configRead("app.json");
    this.config = v && typeof v === "object" ? v : {};
  }
  getConfig(key: string): any { return key in this.config ? this.config[key] : DEFAULT_CONFIG[key]; }
  setConfig(key: string, value: any): void {
    if (value === undefined || value === null) delete this.config[key]; else this.config[key] = value;
    void ipc.configWrite("app.json", this.config).catch((e) => console.error("setConfig failed", e));
  }
  getConfigFile(name: string): string { return `${this.configDir}/${name}.json`; }

  // ----- tree maintenance
  private ensureFolder(path: string): TFolder {
    if (path === "/" || path === "") return this.root;
    const hit = this.fileMap[path];
    if (hit instanceof TFolder) return hit;
    const folder = new TFolder(this, path);
    const parent = this.ensureFolder(parentOf(path));
    folder.parent = parent;
    parent.children.push(folder);
    this.fileMap[path] = folder;
    return folder;
  }
  private addFile(info: VaultFileInfo): TFile {
    const path = normalizePath(info.path);
    const file = new TFile(this, path);
    file.stat = { ...info.stat };
    const parent = this.ensureFolder(parentOf(path));
    file.parent = parent;
    parent.children.push(file);
    this.fileMap[path] = file;
    return file;
  }
  private detach(f: TAbstractFile): void {
    if (f.parent) f.parent.children = f.parent.children.filter((c) => c !== f);
    delete this.fileMap[f.path];
    if (f instanceof TFolder) for (const c of f.children.slice()) this.detach(c);
  }

  // ----- events with metadata coupling
  private fireCreate(f: TAbstractFile): void {
    this.trigger("create", f);
    if (f instanceof TFile) void this.app.metadataCache.onFileChanged(f, true);
  }
  private fireModify(f: TFile, data?: string): void {
    this.readCache.delete(f.path);
    this.trigger("modify", f);
    void this.app.metadataCache.onFileChanged(f, false, data);
  }
  private fireDelete(f: TAbstractFile): void {
    const kids = f instanceof TFolder ? f.children.slice() : [];
    for (const c of kids) this.fireDelete(c);
    this.detach(f);
    this.readCache.delete(f.path);
    this.trigger("delete", f);
    if (f instanceof TFile) this.app.metadataCache.onFileDeleted(f);
  }

  // ----- sync with backend index (external changes / adapter writes)
  scheduleSync(delay = 30): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => { this.syncTimer = null; this.sync().catch((e) => console.warn("vault sync failed", e)); }, delay);
  }
  /** Cancel timers (app shutdown). */
  dispose(): void { if (this.syncTimer) clearTimeout(this.syncTimer); this.syncTimer = null; this.disposed = true; }
  private disposed = false;
  /** Re-read the backend index and fire create/modify/delete for differences. */
  sync(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.syncing) { this.syncQueued = true; return this.syncing; }
    this.syncing = (async () => {
      try {
        do {
          this.syncQueued = false;
          await this.syncOnce();
        } while (this.syncQueued);
      } finally { this.syncing = null; }
    })();
    return this.syncing;
  }
  private async syncOnce(): Promise<void> {
    const info = await ipc.vaultInfo();
    const seen = new Set<string>();
    for (const d of info.folders) {
      const p = normalizePath(d);
      seen.add(p);
      if (!this.fileMap[p]) this.fireCreate(this.ensureFolder(p));
    }
    for (const fi of info.files) {
      const p = normalizePath(fi.path);
      seen.add(p);
      const cur = this.fileMap[p];
      if (!cur) { this.fireCreate(this.addFile(fi)); continue; }
      if (cur instanceof TFile && (cur.stat.mtime !== fi.stat.mtime || cur.stat.size !== fi.stat.size)) {
        cur.stat = { ...fi.stat };
        this.fireModify(cur);
      }
    }
    for (const [p, f] of Object.entries(this.fileMap)) {
      if (p !== "/" && !seen.has(p) && this.fileMap[p] === f) this.fireDelete(f);
    }
  }
  /** Feed a `vault-event` from the Rust watcher (see ipc.listen). */
  handleBackendEvent(ev: { kind: string; path: string }): void {
    if (ev.kind === "config-changed") return; // handled by App
    this.scheduleSync(50);
  }

  // ----- file operations
  private assertFree(path: string): void {
    if (this.fileMap[path]) throw new Error(this.fileMap[path] instanceof TFolder ? "Folder already exists." : "File already exists.");
  }
  async create(path: string, data: string, _o?: DataWriteOptions): Promise<TFile> {
    path = normalizePath(path);
    this.assertFree(path);
    const info = await ipc.fsCreate(path, data);
    const file = this.addFile(info);
    this.fireCreate(file);
    return file;
  }
  async createBinary(path: string, data: ArrayBuffer, _o?: DataWriteOptions): Promise<TFile> {
    path = normalizePath(path);
    this.assertFree(path);
    const info = await ipc.fsWriteBinary(path, data);
    const file = this.addFile(info);
    this.fireCreate(file);
    return file;
  }
  async createFolder(path: string): Promise<TFolder> {
    path = normalizePath(path);
    this.assertFree(path);
    await ipc.fsMkdir(path);
    const folder = this.ensureFolder(path);
    this.fireCreate(folder);
    return folder;
  }
  read(file: TFile): Promise<string> { return ipc.fsRead(file.path); }
  async cachedRead(file: TFile): Promise<string> {
    const c = this.readCache.get(file.path);
    if (c && c.mtime === file.stat.mtime && c.size === file.stat.size) return c.data;
    const data = await ipc.fsRead(file.path);
    this.readCache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, data });
    return data;
  }
  readBinary(file: TFile): Promise<ArrayBuffer> { return ipc.fsReadBinary(file.path); }
  async modify(file: TFile, data: string, _o?: DataWriteOptions): Promise<void> {
    const info = await ipc.fsWrite(file.path, data);
    file.stat = { ...info.stat };
    this.fireModify(file, data);
  }
  async modifyBinary(file: TFile, data: ArrayBuffer, _o?: DataWriteOptions): Promise<void> {
    const info = await ipc.fsWriteBinary(file.path, data);
    file.stat = { ...info.stat };
    this.fireModify(file);
  }
  async append(file: TFile, data: string, o?: DataWriteOptions): Promise<void> {
    await this.modify(file, (await this.read(file)) + data, o);
  }
  async appendBinary(file: TFile, data: ArrayBuffer, o?: DataWriteOptions): Promise<void> {
    const cur = new Uint8Array(await this.readBinary(file)), add = new Uint8Array(data);
    const out = new Uint8Array(cur.length + add.length);
    out.set(cur); out.set(add, cur.length);
    await this.modifyBinary(file, out.buffer as ArrayBuffer, o);
  }
  async process(file: TFile, fn: (data: string) => string, o?: DataWriteOptions): Promise<string> {
    const out = fn(await this.read(file));
    await this.modify(file, out, o);
    return out;
  }
  /** Permanently delete (the plugin API's `Vault.delete`). */
  async delete(file: TAbstractFile, _force?: boolean): Promise<void> {
    await ipc.fsTrash(file.path, "permanent");
    this.fireDelete(file);
  }
  /** Move to the OS trash (`system`), falling back to the vault's `.trash` when that fails, or to `.trash` directly.
   *  Resolves to where the file went. */
  async trash(file: TAbstractFile, system: boolean): Promise<"system" | "local"> {
    let where: "system" | "local" = "local";
    if (system) {
      try { await ipc.fsTrash(file.path, "system"); where = "system"; }
      catch (e) { console.warn(`system trash failed for ${file.path}; using .trash`, e); this.lastTrashError = String((e as Error)?.message ?? e); }
    }
    if (where === "local") await ipc.fsTrash(file.path, "local");
    this.fireDelete(file);
    return where;
  }
  /** Why the last `trash(file, true)` had to fall back to `.trash` (shown to the user by `FileManager.trashFile`). */
  lastTrashError: string | null = null;
  /** Permanently remove a file, whatever the vault's trash option says. */
  async deletePermanently(file: TAbstractFile): Promise<void> {
    await ipc.fsTrash(file.path, "permanent");
    this.fireDelete(file);
  }
  async rename(file: TAbstractFile, newPath: string): Promise<void> {
    newPath = normalizePath(newPath);
    const oldPath = file.path;
    if (newPath === oldPath) return;
    if (this.fileMap[newPath]) throw new Error("Destination file already exists!");
    const np = parentOf(newPath);
    if (np !== "/" && !this.fileMap[np]) await ipc.fsMkdir(np);
    await ipc.fsRename(oldPath, newPath);
    this.applyRename(file, newPath);
    this.scheduleSync(10); // picks up notes whose links were rewritten by the core
  }
  /** Local part of rename: move in the tree and fire events. */
  applyRename(file: TAbstractFile, newPath: string): void {
    const oldPath = file.path;
    const moved: [TAbstractFile, string][] = [];
    const collect = (f: TAbstractFile) => {
      moved.push([f, f.path]);
      if (f instanceof TFolder) f.children.forEach(collect);
    };
    collect(file);
    for (const [f, p] of moved) delete this.fileMap[p];
    if (file.parent) file.parent.children = file.parent.children.filter((c) => c !== file);
    for (const [f, p] of moved) {
      f._setPath(newPath + p.slice(oldPath.length));
      this.fileMap[f.path] = f;
      this.readCache.delete(p);
    }
    const parent = this.ensureFolder(parentOf(newPath));
    file.parent = parent;
    parent.children.push(file);
    for (const [f, p] of moved) {
      this.trigger("rename", f, p);
      if (f instanceof TFile) this.app.metadataCache.onFileRenamed(f, p);
    }
  }
  async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
    newPath = normalizePath(newPath);
    if (file instanceof TFile) return (await this.createBinary(newPath, await this.readBinary(file))) as unknown as T;
    const folder = await this.createFolder(newPath);
    for (const c of (file as unknown as TFolder).children) await this.copy(c, newPath + "/" + c.name);
    return folder as unknown as T;
  }
}
export { TAbstractFile, TFile, TFolder };
