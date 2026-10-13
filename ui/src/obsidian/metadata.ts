// MetadataCache (cache shape computed by the Rust core) and FileManager.
import { ipc } from "../ipc";
import { Events } from "./events";
import { TAbstractFile, TFile, TFolder } from "./files";
import { type CachedMetadata, getFrontMatterInfo, normalizePath, parseFrontMatterTags, parseYaml, stringifyYaml, parseLinktext } from "./util";
import type { App } from "./app";

function lc(s: string): string { return s.toLowerCase(); }
function dirOf(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }

function resolveRel(base: string, rel: string): string {
  const parts = (base ? base.split("/") : []).concat(rel.split("/"));
  const out: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return out.join("/");
}

export class MetadataCache extends Events {
  resolvedLinks: Record<string, Record<string, number>> = {};
  unresolvedLinks: Record<string, Record<string, number>> = {};
  fileCache: Record<string, { mtime: number; size: number }> = {};
  private cache = new Map<string, CachedMetadata>();
  private byName: Map<string, TFile[]> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  initialized = false;

  constructor(public app: App) {
    super();
    const dirty = () => { this.byName = null; };
    app.vault.on("create", dirty);
    app.vault.on("delete", dirty);
    app.vault.on("rename", dirty);
  }

  /** Fetch metadata for every markdown note (the cache API is synchronous, so it must be warm). */
  async initialize(concurrency = 16): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    try {
      const all = await ipc.metaAll();
      if (all && typeof all === "object") {
        for (const f of files) { const m = all[f.path]; if (m) { this.cache.set(f.path, m); this.fileCache[f.path] = { mtime: f.stat.mtime, size: f.stat.size }; } }
        await this.refreshLinks();
        this.initialized = true;
        this.trigger("resolved");
        return;
      }
    } catch { /* older backend: fall back to per-file requests */ }
    let i = 0;
    const worker = async () => {
      while (i < files.length) {
        const f = files[i++];
        try {
          const m = await ipc.metaGet(f.path);
          if (m) { this.cache.set(f.path, m); this.fileCache[f.path] = { mtime: f.stat.mtime, size: f.stat.size }; }
        } catch (e) { console.warn("meta_get failed for", f.path, e); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
    await this.refreshLinks();
    this.initialized = true;
    this.trigger("resolved");
  }

  async refreshLinks(): Promise<void> {
    const l = await ipc.metaLinks();
    const assign = (target: Record<string, Record<string, number>>, src: Record<string, Record<string, number>>) => {
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, src ?? {});
    };
    assign(this.resolvedLinks, l.resolved);
    assign(this.unresolvedLinks, l.unresolved);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const p = this.chain.then(fn, fn).catch((e) => console.error("metadata update failed", e));
    this.chain = p;
    return p as Promise<void>;
  }

  /** Called by Vault after a create/modify. */
  onFileChanged(file: TFile, _created: boolean, data?: string): Promise<void> {
    // Canvases have no file cache but their cards count as links (resolvedLinks), computed by the core.
    if (file.extension === "canvas") return this.enqueue(async () => { await this.refreshLinks(); this.trigger("resolved"); });
    if (file.extension !== "md") return Promise.resolve();
    return this.enqueue(async () => {
      const m = await ipc.metaGet(file.path);
      if (!m) return;
      this.cache.set(file.path, m);
      this.fileCache[file.path] = { mtime: file.stat.mtime, size: file.stat.size };
      await this.refreshLinks();
      let text = data;
      if (text === undefined && this._["changed"]?.length) {
        try { text = await this.app.vault.cachedRead(file); } catch { text = ""; }
      }
      this.trigger("changed", file, text ?? "", m);
      this.trigger("resolve", file);
      this.trigger("resolved");
    });
  }
  onFileDeleted(file: TFile): void {
    const prev = this.cache.get(file.path) ?? null;
    this.cache.delete(file.path);
    delete this.fileCache[file.path];
    delete this.resolvedLinks[file.path];
    delete this.unresolvedLinks[file.path];
    this.trigger("deleted", file, prev);
    void this.enqueue(async () => { await this.refreshLinks(); this.trigger("resolved"); });
  }
  onFileRenamed(file: TFile, oldPath: string): void {
    const c = this.cache.get(oldPath);
    if (c) { this.cache.delete(oldPath); this.cache.set(file.path, c); }
    const fc = this.fileCache[oldPath];
    if (fc) { delete this.fileCache[oldPath]; this.fileCache[file.path] = fc; }
    void this.enqueue(async () => { await this.refreshLinks(); this.trigger("resolved"); });
  }
  /** Wait for pending metadata work (tests, shutdown). */
  async flush(): Promise<void> { await this.chain; }

  getFileCache(file: TFile): CachedMetadata | null { return this.cache.get(file.path) ?? null; }
  getCache(path: string): CachedMetadata | null { return this.cache.get(normalizePath(path)) ?? null; }
  isUserIgnored(_path: string): boolean { return false; }
  /** Paths of all files with cached metadata (internal API used by several plugins). */
  getCachedFiles(): string[] { return [...this.cache.keys()]; }
  getLinks(): Record<string, any[]> { const o: Record<string, any[]> = {}; for (const [k, c] of this.cache) o[k] = c.links ?? []; return o; }

  // ---- link resolution (synchronous, local)
  private index(): Map<string, TFile[]> {
    if (this.byName) return this.byName;
    const m = new Map<string, TFile[]>();
    for (const f of this.app.vault.getFiles()) {
      const k = lc(f.name);
      (m.get(k) ?? m.set(k, []).get(k)!).push(f);
    }
    return (this.byName = m);
  }

  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    let lp = parseLinktext(linkpath).path.trim();
    if (!lp) return null;
    const vault = this.app.vault;
    const exact = (p: string): TFile | null => {
      const f = vault.getFileByPath(p);
      if (f) return f;
      for (const [k, v] of Object.entries(vault.fileMap)) if (v instanceof TFile && lc(k) === lc(p)) return v;
      return null;
    };
    const hasExt = /\.[A-Za-z0-9]+$/.test(lp.slice(lp.lastIndexOf("/") + 1));
    const forms = hasExt ? [lp, lp + ".md"] : [lp + ".md", lp];
    if (lp.startsWith("/")) {
      const t = lp.replace(/^\/+/, "");
      for (const f of hasExt ? [t, t + ".md"] : [t + ".md"]) { const r = exact(f); if (r) return r; }
    }
    const srcDir = dirOf(sourcePath);
    if (lp.startsWith("./") || lp.startsWith("../")) {
      for (const f of forms) { const r = exact(resolveRel(srcDir, f)); if (r) return r; }
    }
    if (lp.includes("/")) for (const f of forms) { const r = exact(resolveRel("", f)); if (r) return r; }
    // by name / path suffix
    const cands = new Set<TFile>();
    for (const form of forms) {
      const norm = resolveRel("", form);
      const name = norm.slice(norm.lastIndexOf("/") + 1);
      for (const f of this.index().get(lc(name)) ?? []) {
        if (!norm.includes("/") || lc(f.path).endsWith("/" + lc(norm))) cands.add(f);
      }
      if (cands.size && !hasExt) break; // prefer .md over other extensions
    }
    if (!cands.size) return null;
    const share = (p: string) => { let n = 0; const a = p.split("/"), b = srcDir.split("/"); while (n < a.length - 1 && n < b.length && a[n] === b[n]) n++; return n; };
    return [...cands].sort((a, b) => share(b.path) - share(a.path) || a.path.split("/").length - b.path.split("/").length || (a.path < b.path ? -1 : 1))[0];
  }

  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const strip = (p: string) => (omitMdExtension && file.extension === "md" ? p.replace(/\.md$/i, "") : p);
    const segs = file.path.split("/");
    for (let n = 1; n <= segs.length; n++) {
      const cand = segs.slice(-n).join("/");
      const hit = this.getFirstLinkpathDest(cand, sourcePath);
      if (hit === file) return strip(cand);
    }
    return strip(file.path);
  }

  getTags(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.cache.values()) {
      const seen = [...(c.tags ?? []).map((t) => t.tag), ...(parseFrontMatterTags(c.frontmatter) ?? [])];
      for (const t of seen) out[t] = (out[t] ?? 0) + 1;
    }
    return out;
  }

  getBacklinksForFile(file: TFile): { data: Map<string, any[]>; get(p: string): any[] | null; keys(): string[] } {
    const data = new Map<string, any[]>();
    for (const [src, targets] of Object.entries(this.resolvedLinks)) {
      if (!targets[file.path]) continue;
      const refs = [...(this.cache.get(src)?.links ?? []), ...(this.cache.get(src)?.embeds ?? [])].filter(
        (l) => this.getFirstLinkpathDest(parseLinktext(l.link).path, src) === file,
      );
      data.set(src, refs);
    }
    return { data, get: (p) => data.get(p) ?? null, keys: () => [...data.keys()] };
  }
}

const EMBED_EXT = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif", "mp3", "wav", "ogg", "flac", "m4a", "webm", "mp4", "mov", "mkv", "ogv", "pdf", "3gp", "opus"]);

export class FileManager {
  constructor(public app: App) {}

  getNewFileParent(sourcePath: string, _newFilePath?: string): TFolder {
    const v = this.app.vault;
    const mode = v.getConfig("newFileLocation");
    if (mode === "current") {
      const src = v.getAbstractFileByPath(sourcePath);
      if (src?.parent) return src.parent;
    } else if (mode === "folder") {
      const f = v.getFolderByPath(v.getConfig("newFileFolderPath") || "/");
      if (f) return f;
    }
    return v.getRoot();
  }
  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    await this.app.vault.rename(file, newPath);
  }
  async trashFile(file: TAbstractFile): Promise<void> {
    await this.app.vault.trash(file, true);
  }
  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    if (this.app.vault.getConfig("promptDelete") && typeof confirm === "function" && !confirm(`Are you sure you want to delete '${file.name}'?`)) return false;
    await this.trashFile(file);
    return true;
  }
  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
    const v = this.app.vault;
    const useMd = !!v.getConfig("useMarkdownLinks");
    const fmt = v.getConfig("newLinkFormat") ?? "shortest";
    const isMd = file.extension === "md";
    const embed = !isMd && EMBED_EXT.has(file.extension.toLowerCase()) ? "!" : "";
    const sub = subpath ?? "";
    if (useMd) {
      let target = fmt === "absolute" ? file.path : fmt === "relative" ? relPath(sourcePath, file.path) : this.app.metadataCache.fileToLinktext(file, sourcePath, false);
      target = target.split("/").map((s) => encodeURIComponent(s).replace(/%2C/gi, ",")).join("/");
      const text = alias ?? (isMd ? file.basename : file.name);
      const subEnc = sub ? encodeURI(sub).replace(/#/g, "#") : "";
      return `${embed}[${text}](${target}${subEnc})`;
    }
    const omit = true;
    let lt = fmt === "absolute" ? (omit && isMd ? file.path.replace(/\.md$/, "") : file.path)
      : fmt === "relative" ? (omit && isMd ? relPath(sourcePath, file.path).replace(/\.md$/, "") : relPath(sourcePath, file.path))
      : this.app.metadataCache.fileToLinktext(file, sourcePath, omit);
    lt += sub;
    return `${embed}[[${lt}${alias ? "|" + alias : ""}]]`;
  }
  async processFrontMatter(file: TFile, fn: (frontmatter: any) => void, _o?: { ctime?: number; mtime?: number }): Promise<void> {
    const text = await this.app.vault.read(file);
    const info = getFrontMatterInfo(text);
    const fm = info.exists ? parseYaml(info.frontmatter) ?? {} : {};
    if (typeof fm !== "object" || Array.isArray(fm)) throw new Error("Frontmatter is not a YAML mapping");
    fn(fm);
    const empty = Object.keys(fm).length === 0;
    let out: string;
    if (info.exists) {
      const body = text.slice(info.contentStart);
      out = empty ? body : `---\n${stringifyYaml(fm)}---\n${body}`;
    } else {
      if (empty) return;
      out = `---\n${stringifyYaml(fm)}---\n${text}`;
    }
    if (out !== text) await this.app.vault.modify(file, out);
  }
  async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const v = this.app.vault;
    const cfg: string = v.getConfig("attachmentFolderPath") ?? "/";
    let folder: string;
    if (cfg === "/") folder = "";
    else if (cfg === "./") folder = dirOf(sourcePath ?? "");
    else if (cfg.startsWith("./")) folder = resolveRel(dirOf(sourcePath ?? ""), cfg.slice(2));
    else folder = normalizePath(cfg) === "/" ? "" : normalizePath(cfg);
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename, ext = dot > 0 ? filename.slice(dot) : "";
    let n = 0, path: string;
    do {
      path = (folder ? folder + "/" : "") + base + (n ? ` ${n}` : "") + ext;
      n++;
    } while (v.getAbstractFileByPath(path));
    return path;
  }
}

function relPath(from: string, to: string): string {
  const a = dirOf(from).split("/").filter(Boolean), b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/** app.metadataTypeManager: property (frontmatter) types, persisted in .obsidian/types.json. */
export class MetadataTypeManager extends Events {
  types: Record<string, string> = {};
  constructor(public app: App) { super(); }
  async load(): Promise<void> {
    try {
      const v = await ipc.configRead("types.json");
      this.types = v && typeof v === "object" && v.types ? { ...v.types } : {};
    } catch { this.types = {}; }
  }
  private async save(): Promise<void> { await ipc.configWrite("types.json", { types: this.types }); }
  /** Lowercased property name -> info, from every note's frontmatter plus explicit types. */
  getAllProperties(): Record<string, { name: string; type: string; occurrences: number }> {
    const out: Record<string, { name: string; type: string; occurrences: number }> = {};
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      for (const k of Object.keys(fm ?? {})) {
        const key = k.toLowerCase();
        (out[key] ??= { name: k, type: this.getAssignedWidget(k), occurrences: 0 }).occurrences++;
      }
    }
    for (const [k, t] of Object.entries(this.types)) out[k] ??= { name: k, type: t, occurrences: 0 };
    return out;
  }
  getPropertyInfo(name: string): { name: string; type: string; occurrences: number } | undefined { return this.getAllProperties()[name.toLowerCase()]; }
  getAssignedWidget(name: string): string {
    const t = this.types[name.toLowerCase()];
    if (t) return t;
    return name.toLowerCase() === "tags" ? "tags" : name.toLowerCase() === "aliases" ? "aliases" : "text";
  }
  getTypeInfo(name: string): { type: string } { return { type: this.getAssignedWidget(name) }; }
  async setType(name: string, type: string): Promise<void> {
    this.types[name.toLowerCase()] = type;
    await this.save();
    this.trigger("changed", name.toLowerCase());
  }
  async unsetType(name: string): Promise<void> { delete this.types[name.toLowerCase()]; await this.save(); this.trigger("changed", name.toLowerCase()); }
}
