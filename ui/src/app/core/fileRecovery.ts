// "File recovery" core plugin: periodic snapshots of edited notes, kept outside the vault in the webview's IndexedDB
// (see docs/file-recovery.md), with a modal to browse, diff, copy and restore them.
import { Modal, Notice, Setting, TFile, moment, type App } from "../../obsidian";
import { CorePluginSettingTab, showCoreSettingTab } from "./settingTab";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";
import { fileLabel } from "./panel";

export const DEFAULT_OPTIONS = { intervalMinutes: 5, keepDays: 7 };
const EXTENSIONS = new Set(["md", "canvas"]);
const PENDING_CHECK_MS = 30_000;

export interface Snapshot { path: string; ts: number; data: string }

// ---------------------------------------------------------------- storage

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

/** One IndexedDB database per vault: store "backups" of { path, ts, data } with "path" and "ts" indexes. */
export class SnapshotStore {
  private db: IDBDatabase | null = null;
  constructor(public name: string) {}
  async open(): Promise<void> {
    if (this.db) return;
    const r = indexedDB.open(this.name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (db.objectStoreNames.contains("backups")) db.deleteObjectStore("backups");
      const st = db.createObjectStore("backups", { autoIncrement: true });
      st.createIndex("path", "path");
      st.createIndex("ts", "ts");
    };
    this.db = await req(r);
  }
  close(): void { this.db?.close(); this.db = null; }
  private store(mode: IDBTransactionMode): { tx: IDBTransaction; st: IDBObjectStore } {
    if (!this.db) throw new Error("File recovery database not available.");
    const tx = this.db.transaction("backups", mode);
    return { tx, st: tx.objectStore("backups") };
  }
  async add(s: Snapshot): Promise<void> { const { tx, st } = this.store("readwrite"); st.add(s); await done(tx); }
  /** Versions of a path, newest first. */
  async versions(path: string): Promise<Snapshot[]> {
    const { st } = this.store("readonly");
    const all = await req(st.index("path").getAll(path) as IDBRequest<Snapshot[]>);
    return all.sort((a, b) => b.ts - a.ts);
  }
  async last(path: string): Promise<Snapshot | null> { return (await this.versions(path))[0] ?? null; }
  /** Every path with snapshots and its newest timestamp. */
  async paths(): Promise<Map<string, number>> {
    const { st } = this.store("readonly");
    const out = new Map<string, number>();
    for (const s of await req(st.getAll() as IDBRequest<Snapshot[]>)) out.set(s.path, Math.max(out.get(s.path) ?? 0, s.ts));
    return out;
  }
  async prune(before: number): Promise<number> {
    const { tx, st } = this.store("readwrite");
    const keys = await req(st.index("ts").getAllKeys(IDBKeyRange.upperBound(before)));
    for (const k of keys) st.delete(k);
    await done(tx);
    return keys.length;
  }
  async movePath(from: string, to: string): Promise<void> {
    const { tx, st } = this.store("readwrite");
    const keys = await req(st.index("path").getAllKeys(from));
    for (const k of keys) { const v = await req(st.get(k) as IDBRequest<Snapshot>); st.put({ ...v, path: to }, k); }
    await done(tx);
  }
  async clear(): Promise<void> { const { tx, st } = this.store("readwrite"); st.clear(); await done(tx); }
}

// ---------------------------------------------------------------- line diff

export interface DiffLine { type: "same" | "add" | "remove"; text: string }
/** Line diff from `a` to `b` (common prefix/suffix trimmed, LCS on the rest; falls back to replace-all when huge). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n"), y = b.split("\n");
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const xm = x.slice(p, x.length - s), ym = y.slice(p, y.length - s);
  const mid: DiffLine[] = [];
  if (xm.length * ym.length > 4_000_000) {
    for (const t of xm) mid.push({ type: "remove", text: t });
    for (const t of ym) mid.push({ type: "add", text: t });
  } else {
    const n = xm.length, m = ym.length, w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = xm[i] === ym[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) { mid.push({ type: "same", text: xm[i] }); i++; j++; }
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) mid.push({ type: "remove", text: xm[i++] });
      else mid.push({ type: "add", text: ym[j++] });
    }
    while (i < n) mid.push({ type: "remove", text: xm[i++] });
    while (j < m) mid.push({ type: "add", text: ym[j++] });
  }
  return [...x.slice(0, p).map((t) => ({ type: "same" as const, text: t })), ...mid, ...x.slice(x.length - s).map((t) => ({ type: "same" as const, text: t }))];
}

// ---------------------------------------------------------------- plugin instance

export class FileRecovery {
  store: SnapshotStore;
  /** Newest snapshot time per path this session (avoids a DB read on every save). */
  private lastTs = new Map<string, number>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refs: any[] = [];
  private stopped = false;
  ready: Promise<void> = Promise.resolve();
  constructor(public app: App) { this.store = new SnapshotStore(`tachylite-backup:${(app.vault.adapter as any).getBasePath?.() ?? app.vault.getName()}`); }
  get options(): { intervalMinutes: number; keepDays: number } {
    const inst = this.app.internalPlugins.plugins["file-recovery"]?.instance;
    return { ...DEFAULT_OPTIONS, ...(inst?.options ?? {}) };
  }
  private get intervalMs(): number { const n = Number(this.options.intervalMinutes); return (Number.isFinite(n) && n >= 0 ? n : 5) * 60_000; }
  private get keepMs(): number { const n = Number(this.options.keepDays); return (Number.isFinite(n) && n >= 1 ? n : 7) * 86_400_000; }

  start(): void {
    this.ready = this.store.open().then(() => { void this.prune(); }).catch((e) => console.warn("file recovery unavailable", e));
    const v = this.app.vault;
    this.refs = [
      v.on("modify", (f: any) => { if (f instanceof TFile && EXTENSIONS.has(f.extension)) this.onModify(f).catch((e) => { if (!this.stopped) console.warn("snapshot failed", f.path, e); }); }),
      v.on("rename", (f: any, old: string) => { if (f instanceof TFile) { const t = this.lastTs.get(old); if (t) this.lastTs.set(f.path, t); void this.ready.then(() => this.store.movePath(old, f.path)).catch(() => {}); } }),
    ];
    this.timer = setInterval(() => { this.flushPending().catch((e) => console.warn("snapshot failed", e)); }, PENDING_CHECK_MS);
  }
  stop(): void {
    this.stopped = true;
    for (const r of this.refs) this.app.vault.offref(r);
    this.refs = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.ready.then(() => this.store.close());
  }
  async prune(): Promise<number> { return this.store.prune(Date.now() - this.keepMs); }

  /** Snapshot a file at most once per interval; later saves are remembered and taken when the interval has passed. */
  async onModify(file: TFile): Promise<void> {
    await this.ready;
    if (this.stopped) return;
    const now = Date.now();
    let last = this.lastTs.get(file.path);
    if (last === undefined) { last = (await this.store.last(file.path).catch(() => null))?.ts ?? 0; this.lastTs.set(file.path, last); }
    if (now - last < this.intervalMs) { this.pending.add(file.path); return; }
    await this.snapshot(file, now);
  }
  async flushPending(): Promise<void> {
    const now = Date.now();
    for (const p of [...this.pending]) {
      if (now - (this.lastTs.get(p) ?? 0) < this.intervalMs) continue;
      this.pending.delete(p);
      const f = this.app.vault.getFileByPath(p);
      if (f) await this.snapshot(f, now);
    }
  }
  /** Store the file's current content unless it equals the newest snapshot. */
  async snapshot(file: TFile, ts = Date.now()): Promise<boolean> {
    await this.ready;
    const data = await this.app.vault.read(file);
    const last = await this.store.last(file.path).catch(() => null);
    this.lastTs.set(file.path, ts);
    if (last && last.data === data) return false;
    await this.store.add({ path: file.path, ts, data });
    return true;
  }
  /** Overwrite (or recreate) the file with a snapshot, after saving the current content as one. */
  async restore(s: Snapshot): Promise<void> {
    const f = this.app.vault.getFileByPath(s.path);
    if (f) { await this.snapshot(f); await this.app.vault.modify(f, s.data); }
    else await this.app.vault.create(s.path, s.data);
  }
  openModal(path?: string): void { new FileRecoveryModal(this.app, this, path).open(); }
  clearData(): Promise<void> { this.lastTs.clear(); this.pending.clear(); return this.store.clear(); }
}

// ---------------------------------------------------------------- modal

export class FileRecoveryModal extends Modal {
  private filesEl!: HTMLElement;
  private versionsEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private paths: [string, number][] = [];
  private query = "";
  path: string | null;
  versions: Snapshot[] = [];
  selected: Snapshot | null = null;
  showChanges = false;
  constructor(app: App, public plugin: FileRecovery, path?: string) { super(app); this.path = path ?? null; }

  async onOpen(): Promise<void> {
    this.modalEl.addClass("mod-file-recovery");
    this.setTitle("File recovery");
    const c = this.contentEl;
    const left = c.createDiv({ cls: "file-recovery-files" });
    const search = left.createEl("input", { type: "search", attr: { placeholder: "Search files with snapshots..." } });
    search.addEventListener("input", () => { this.query = search.value.toLowerCase(); this.renderFiles(); });
    this.filesEl = left.createDiv();
    this.versionsEl = c.createDiv({ cls: "file-recovery-versions" });
    this.previewEl = c.createDiv({ cls: "file-recovery-preview" });
    await this.plugin.ready;
    try { this.paths = [...(await this.plugin.store.paths()).entries()].sort((a, b) => b[1] - a[1]); }
    catch (e) { this.filesEl.createDiv({ cls: "file-recovery-empty", text: `Snapshots are unavailable: ${(e as Error).message}` }); return; }
    this.renderFiles();
    if (this.path && this.paths.some(([p]) => p === this.path)) await this.selectFile(this.path);
    else if (this.path) this.previewEl.createDiv({ cls: "file-recovery-empty", text: `No snapshots of ${this.path} yet.` });
    else if (this.paths.length) await this.selectFile(this.paths[0][0]);
  }
  private renderFiles(): void {
    this.filesEl.empty();
    const list = this.paths.filter(([p]) => !this.query || p.toLowerCase().includes(this.query));
    if (!list.length) { this.filesEl.createDiv({ cls: "file-recovery-empty", text: "No snapshots found." }); return; }
    for (const [p, ts] of list) {
      const el = this.filesEl.createDiv({ cls: "file-recovery-list-item-header" + (p === this.path ? " is-active" : ""), attr: { "data-path": p } });
      const f = this.app.vault.getFileByPath(p);
      el.createDiv({ text: f ? fileLabel(f) : p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/, "") });
      el.createDiv({ cls: "file-recovery-list-item-note", text: `${p.includes("/") ? p.slice(0, p.lastIndexOf("/")) + " · " : ""}${f ? "" : "deleted · "}${moment(ts).fromNow()}` });
      el.addEventListener("click", () => void this.selectFile(p));
    }
  }
  async selectFile(path: string): Promise<void> {
    this.path = path;
    this.renderFiles();
    this.versions = await this.plugin.store.versions(path);
    this.versionsEl.empty();
    for (const v of this.versions) {
      const el = this.versionsEl.createDiv({ cls: "file-recovery-list-item-header", attr: { "data-ts": String(v.ts) } });
      el.createDiv({ text: moment(v.ts).format("YYYY-MM-DD HH:mm:ss") });
      el.createDiv({ cls: "file-recovery-list-item-note", text: `${v.data.length} characters` });
      el.addEventListener("click", () => this.selectVersion(v));
    }
    this.selectVersion(this.versions[0] ?? null);
  }
  selectVersion(v: Snapshot | null): void {
    this.selected = v;
    for (const el of Array.from(this.versionsEl.children)) el.toggleClass("is-active", el.getAttribute("data-ts") === String(v?.ts));
    this.renderPreview();
  }
  private renderPreview(): void {
    const p = this.previewEl, v = this.selected;
    p.empty();
    if (!v) { p.createDiv({ cls: "file-recovery-empty", text: "Select a version." }); return; }
    const bar = p.createDiv({ cls: "file-recovery-toolbar" });
    bar.createDiv({ cls: "file-recovery-title", text: moment(v.ts).format("YYYY-MM-DD HH:mm:ss"), attr: { "aria-label": v.path } });
    new Setting(bar).setName("Show changes").addToggle((t) => t.setValue(this.showChanges).onChange((on) => { this.showChanges = on; this.renderPreview(); })).settingEl.addClass("mod-toggle");
    const copy = bar.createEl("button", { text: "Copy" });
    copy.addEventListener("click", () => { void navigator.clipboard?.writeText(v.data).then(() => new Notice("Copied to clipboard.")); });
    const restore = bar.createEl("button", { cls: "mod-cta", text: "Restore" });
    restore.addEventListener("click", async () => {
      await this.plugin.restore(v);
      new Notice(`Restored ${v.path} to the version of ${moment(v.ts).format("YYYY-MM-DD HH:mm")}.`);
      this.close();
    });
    if (!this.showChanges) { p.createEl("pre", { cls: "file-recovery-text", text: v.data }); return; }
    // Changes since the previous (older) snapshot.
    const i = this.versions.indexOf(v), prev = this.versions[i + 1]?.data ?? "";
    const box = p.createDiv({ cls: "file-recovery-diff diff-view" });
    renderDiff(box, diffLines(prev, v.data));
  }
}

/** Draw a diff, folding long runs of unchanged lines. */
export function renderDiff(el: HTMLElement, lines: DiffLine[], context = 3): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "same") { el.createDiv({ cls: `diff-line diff-changed mod-${lines[i].type === "add" ? "added" : "removed"}`, text: lines[i].text }); i++; continue; }
    let j = i;
    while (j < lines.length && lines[j].type === "same") j++;
    const run = lines.slice(i, j), head = i === 0 ? 0 : context, tail = j === lines.length ? 0 : context;
    if (run.length > head + tail + 2) {
      for (const l of run.slice(0, head)) el.createDiv({ cls: "diff-line", text: l.text });
      el.createDiv({ cls: "diff-collapsed", text: `… ${run.length - head - tail} unchanged lines` });
      for (const l of run.slice(run.length - tail)) el.createDiv({ cls: "diff-line", text: l.text });
    } else for (const l of run) el.createDiv({ cls: "diff-line", text: l.text });
    i = j;
  }
}

class FileRecoverySettingTab extends CorePluginSettingTab {
  constructor(app: App, private plugin: FileRecovery) { super(app, "file-recovery", "File recovery"); }
  getSettingDefinitions(): any[] {
    return [
      { name: "Snapshot interval", desc: "Minimum minutes between two snapshots of the same file.", control: { type: "number", key: "intervalMinutes", min: 0, defaultValue: DEFAULT_OPTIONS.intervalMinutes } },
      { name: "History length", desc: "Days to keep snapshots before they are deleted.", control: { type: "number", key: "keepDays", min: 1, defaultValue: DEFAULT_OPTIONS.keepDays } },
      { name: "Snapshots", desc: "Browse the snapshots of your files and restore older versions.", render: (s: Setting) => s.addButton((b) => b.setButtonText("View").onClick(() => this.plugin.openModal())) },
      { name: "Clear history", desc: "Delete every snapshot of this vault.", render: (s: Setting) => s.addButton((b) => b.setButtonText("Clear").setWarning().onClick(() => {
        const m = new Modal(this.app).setTitle("Clear history");
        m.contentEl.createEl("p", { cls: "mod-warning", text: "This permanently deletes all snapshots. It can't be undone." });
        const bar = m.modalEl.createDiv({ cls: "modal-button-container" });
        bar.createEl("button", { cls: "mod-warning", text: "Clear history" }).addEventListener("click", () => { void this.plugin.clearData().then(() => new Notice("Snapshots deleted.")); m.close(); });
        bar.createEl("button", { text: "Cancel" }).addEventListener("click", () => m.close());
        m.open();
      })) },
    ];
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    const min = key === "keepDays" ? 1 : 0;
    if (value !== undefined && !(typeof value === "number" && Number.isFinite(value) && value >= min)) return;
    await super.setControlValue(key, value);
    if (key === "keepDays") void this.plugin.prune().catch(() => {});
  }
}

export const fileRecovery: CoreModule = {
  id: "file-recovery",
  install(app: App) {
    const stop = whileCoreEnabled(app, "file-recovery", () => {
      const fr = new FileRecovery(app);
      const inst = app.internalPlugins.plugins["file-recovery"]!.instance as any;
      inst.options = { ...DEFAULT_OPTIONS, ...(inst.options ?? {}) };
      Object.assign(inst, { plugin: fr, openModal: (p?: string) => fr.openModal(p), forceAdd: (f: TFile) => fr.snapshot(f), getHistory: (p: string) => fr.store.versions(p) });
      fr.start();
      const offs = [
        addCommand(app, { id: "file-recovery:open", name: "File recovery: Open local history", icon: "lucide-rotate-ccw", callback: () => fr.openModal(app.workspace.getActiveFile()?.path) }),
        showCoreSettingTab(app, new FileRecoverySettingTab(app, fr)),
      ];
      return () => { offs.forEach((o) => o()); fr.stop(); delete inst.plugin; };
    });
    return stop;
  },
};
