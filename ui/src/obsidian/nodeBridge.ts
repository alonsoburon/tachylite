// Node.js bridge for desktop community plugins (crates/tachylite-app/src/bridge.rs): real `fs`, `child_process`
// and the platform facts behind `os` / `process`. Only active while community plugins are on AND the user allowed
// "run programs and access files outside the vault" for this vault; otherwise shims.ts stays vault-confined.
//
// Paths: relative paths resolve against `process.cwd()`, which is the vault root while the bridge is active (also
// the default cwd of child processes). Obsidian's own cwd is unrelated to the vault, so plugins that work there
// already use absolute paths (`FileSystemAdapter.getBasePath()`); the vault root is the least surprising base.
import { Buffer } from "buffer";
import EventEmitter from "events";
import pathPosix from "path-browserify";
import { getSyncBackend, ipc, listen, type BridgeInfo } from "../ipc";

let info: BridgeInfo | null = null;
/** Stable object handed out as `process.env` (real environment while active, empty otherwise). */
const env: Record<string, string> = {};

function setInfo(i: BridgeInfo | null): boolean {
  info = i ?? null;
  for (const k of Object.keys(env)) delete env[k];
  if (info) Object.assign(env, info.env);
  return !!info;
}

export const nodeBridge = {
  get active(): boolean { return info !== null; },
  get info(): BridgeInfo | null { return info; },
  env,
  /** Session activation (community plugins on/off). Resolves whether the bridge is active; never throws. */
  async activate(on: boolean): Promise<boolean> { return setInfo(await ipc.bridgeActivate(on).catch(() => null)); },
  /** Persist the user's choice for this vault (only after the warning was accepted) and apply it. */
  async setEnabled(on: boolean): Promise<boolean> { return setInfo(await ipc.bridgeSetEnabled(on)); },
  async status(): Promise<{ enabled: boolean; active: boolean }> { return ipc.bridgeStatus().catch(() => ({ enabled: false, active: false })); },
  /** Tests: forget the session state and the event subscriptions (each test installs a new fake backend). */
  reset(): void {
    setInfo(null);
    for (const p of [procReady, watchReady]) void p?.then((off) => off());
    procReady = watchReady = null;
    procs.clear(); watchers.clear();
  },
};

// ------------------------------------------------------------------ errors, paths, channels
const DISABLED = "ERR_BRIDGE_DISABLED";
function disabledError(what: string): Error {
  const e: any = new Error(`${DISABLED}: ${what} needs "Allow plugins to run programs and access files outside the vault" (Settings > Community plugins)`);
  e.code = DISABLED;
  return e;
}

/** Node-shaped error from a bridge failure (JSON `{code, errno, message, syscall, path, dest}` or a plain string). */
export function toNodeError(raw: unknown): Error {
  const s = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : JSON.stringify(raw);
  const j: any = typeof raw === "object" && raw && !(raw instanceof Error) ? raw : s.startsWith("{") ? (() => { try { return JSON.parse(s); } catch { return null; } })() : null;
  if (j?.code) {
    const spawn = /^spawn/.test(j.syscall ?? "");
    const msg = spawn ? `${j.syscall} ${j.code}` : `${j.code}: ${j.message}, ${j.syscall}${j.path !== undefined && j.path !== null ? ` '${j.path}'` : ""}${j.dest ? ` -> '${j.dest}'` : ""}`;
    const e: any = new Error(msg);
    e.errno = j.errno; e.code = j.code; e.syscall = j.syscall;
    if (j.path !== undefined && j.path !== null) e.path = j.path;
    if (j.dest) e.dest = j.dest;
    return e;
  }
  const e: any = raw instanceof Error ? raw : new Error(s);
  const m = /^(ERR_[A-Z_]+): /.exec(s);
  if (m) e.code = m[1];
  return e;
}

const isWin = () => info?.platform === "win32";
export const cwd = (): string => info?.cwd ?? "/";

/** Absolute path for a Node path-like (string, Buffer, file: URL), relative ones resolved against `process.cwd()`. */
export function resolvePath(p: unknown): string {
  let s: string;
  if (p instanceof URL || (typeof p === "string" && p.startsWith("file:"))) {
    const u = new URL(String(p));
    s = decodeURIComponent(u.pathname);
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
  } else if (p instanceof Uint8Array) s = Buffer.from(p).toString("utf8");
  else if (typeof p === "string") s = p;
  else {
    const e: any = new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? "null" : typeof p}`);
    e.code = "ERR_INVALID_ARG_TYPE";
    throw e;
  }
  if (isWin()) return /^([A-Za-z]:[\\/]|\\\\)/.test(s) ? s : `${cwd().replace(/[\\/]+$/, "")}\\${s}`;
  return s.startsWith("/") ? pathPosix.normalize(s) : pathPosix.resolve(cwd(), s);
}

/** One synchronous round trip (sync XHR to the bridge URI scheme; a plain function in tests). */
function syncCall(req: Record<string, unknown>): any {
  if (!info) throw disabledError("synchronous file and process access");
  const fn = getSyncBackend();
  let res: { ok?: unknown; err?: string };
  if (fn) res = fn(req);
  else {
    const x = new XMLHttpRequest();
    x.open("POST", info.syncUrl, false);
    x.send(JSON.stringify({ token: info.token, ...req }));
    if (x.status !== 200) throw new Error(`Tachylite sync bridge failed (HTTP ${x.status})`);
    res = JSON.parse(x.responseText);
  }
  if (res.err !== undefined) throw toNodeError(res.err);
  return res.ok;
}

async function asyncFs(op: Record<string, unknown>): Promise<any> {
  if (!info) throw disabledError(`fs.${op.op}`);
  try { return await ipc.bridgeFs(op); } catch (e) { throw toNodeError(e); }
}

const b64 = (d: unknown, enc?: string | null): string => {
  if (typeof d === "string") return Buffer.from(d, (enc && enc !== "buffer" ? enc : "utf8") as BufferEncoding).toString("base64");
  if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength).toString("base64");
  if (d instanceof ArrayBuffer) return Buffer.from(d).toString("base64");
  const e: any = new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView`);
  e.code = "ERR_INVALID_ARG_TYPE";
  throw e;
};
const encOf = (o: unknown): string | null => (typeof o === "string" ? o : (o as any)?.encoding ?? null);
const decode = (b: Buffer, enc: string | null): any => (enc && enc !== "buffer" ? b.toString(enc as BufferEncoding) : b);

// ------------------------------------------------------------------ fs
const S_IFMT = 0o170000;
export class Stats {
  dev = 0; ino = 0; mode = 0; nlink = 0; uid = 0; gid = 0; rdev = 0; size = 0; blksize = 0; blocks = 0;
  atimeMs = 0; mtimeMs = 0; ctimeMs = 0; birthtimeMs = 0;
  atime: Date; mtime: Date; ctime: Date; birthtime: Date;
  private kind: string;
  constructor(r: any) {
    Object.assign(this, { dev: r.dev, ino: r.ino, mode: r.mode, nlink: r.nlink, uid: r.uid, gid: r.gid, rdev: r.rdev, size: r.size, blksize: r.blksize, blocks: r.blocks, atimeMs: r.atimeMs, mtimeMs: r.mtimeMs, ctimeMs: r.ctimeMs, birthtimeMs: r.birthtimeMs });
    this.kind = r.kind;
    this.atime = new Date(r.atimeMs); this.mtime = new Date(r.mtimeMs); this.ctime = new Date(r.ctimeMs); this.birthtime = new Date(r.birthtimeMs);
    Object.defineProperty(this, "kind", { enumerable: false });
  }
  isFile(): boolean { return this.kind === "file"; }
  isDirectory(): boolean { return this.kind === "dir"; }
  isSymbolicLink(): boolean { return this.kind === "symlink"; }
  isBlockDevice(): boolean { return this.kind === "other" && (this.mode & S_IFMT) === 0o060000; }
  isCharacterDevice(): boolean { return this.kind === "other" && (this.mode & S_IFMT) === 0o020000; }
  isFIFO(): boolean { return this.kind === "other" && (this.mode & S_IFMT) === 0o010000; }
  isSocket(): boolean { return this.kind === "other" && (this.mode & S_IFMT) === 0o140000; }
}
export class Dirent {
  constructor(public name: string, private kind: string, public parentPath: string) { Object.defineProperty(this, "kind", { enumerable: false }); }
  get path(): string { return this.parentPath; }
  isFile(): boolean { return this.kind === "file"; }
  isDirectory(): boolean { return this.kind === "dir"; }
  isSymbolicLink(): boolean { return this.kind === "symlink"; }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }
}

type Spec = { op: Record<string, unknown>; map?: (r: any) => any };
const seconds = (t: unknown): number => (t instanceof Date ? t.getTime() / 1000 : typeof t === "string" ? Number(t) : Number(t));
const modeNum = (m: unknown): number => (typeof m === "string" ? parseInt(m, 8) : Number(m));
/** Every fs call, described once: the bridge op plus how to shape its result. */
const SPECS: Record<string, (...a: any[]) => Spec> = {
  readFile: (p, o) => ({ op: { op: "readFile", path: resolvePath(p) }, map: (r) => decode(Buffer.from(r, "base64"), encOf(o)) }),
  writeFile: (p, d, o) => ({ op: { op: "writeFile", path: resolvePath(p), data: b64(d, encOf(o)), flag: (o as any)?.flag ?? "w", mode: (o as any)?.mode } }),
  appendFile: (p, d, o) => ({ op: { op: "writeFile", path: resolvePath(p), data: b64(d, encOf(o)), flag: (o as any)?.flag ?? "a", mode: (o as any)?.mode } }),
  readdir: (p, o) => {
    const dir = resolvePath(p);
    return { op: { op: "readdir", path: dir }, map: (r: { name: string; kind: string }[]) => (o?.withFileTypes ? r.map((x) => new Dirent(x.name, x.kind, dir)) : r.map((x) => (encOf(o) === "buffer" ? Buffer.from(x.name) : x.name))) };
  },
  stat: (p, _o) => ({ op: { op: "stat", path: resolvePath(p) }, map: (r) => new Stats(r) }),
  lstat: (p, _o) => ({ op: { op: "stat", path: resolvePath(p), lstat: true }, map: (r) => new Stats(r) }),
  access: (p, mode) => ({ op: { op: "access", path: resolvePath(p), mode: typeof mode === "number" ? mode : 0 }, map: () => undefined }),
  mkdir: (p, o) => ({ op: { op: "mkdir", path: resolvePath(p), recursive: typeof o === "object" && !!o?.recursive }, map: (r) => r ?? undefined }),
  rm: (p, o) => ({ op: { op: "rm", path: resolvePath(p), recursive: !!o?.recursive, force: !!o?.force }, map: () => undefined }),
  rmdir: (p, o) => ({ op: { op: "rmdir", path: resolvePath(p), recursive: !!o?.recursive }, map: () => undefined }),
  unlink: (p) => ({ op: { op: "unlink", path: resolvePath(p) }, map: () => undefined }),
  rename: (a, b) => ({ op: { op: "rename", from: resolvePath(a), to: resolvePath(b) }, map: () => undefined }),
  copyFile: (a, b, mode) => ({ op: { op: "copyFile", from: resolvePath(a), to: resolvePath(b), excl: ((Number(mode) || 0) & 1) !== 0 }, map: () => undefined }),
  cp: (a, b, o) => ({ op: { op: "cp", from: resolvePath(a), to: resolvePath(b), recursive: !!o?.recursive, force: o?.force !== false }, map: () => undefined }),
  realpath: (p, o) => ({ op: { op: "realpath", path: resolvePath(p) }, map: (r) => (encOf(o) === "buffer" ? Buffer.from(r) : r) }),
  readlink: (p, o) => ({ op: { op: "readlink", path: resolvePath(p) }, map: (r) => (encOf(o) === "buffer" ? Buffer.from(r) : r) }),
  symlink: (target, p) => ({ op: { op: "symlink", target: String(target), path: resolvePath(p) }, map: () => undefined }),
  chmod: (p, mode) => ({ op: { op: "chmod", path: resolvePath(p), mode: modeNum(mode) }, map: () => undefined }),
  truncate: (p, len) => ({ op: { op: "truncate", path: resolvePath(p), len: typeof len === "number" ? len : 0 }, map: () => undefined }),
  utimes: (p, at, mt) => ({ op: { op: "utimes", path: resolvePath(p), atime: seconds(at), mtime: seconds(mt) }, map: () => undefined }),
  mkdtemp: (prefix, o) => ({ op: { op: "mkdtemp", prefix: resolvePath(prefix) }, map: (r) => (encOf(o) === "buffer" ? Buffer.from(r) : r) }),
};

let nextId = Date.now() * 1000;
const newId = () => ++nextId;

/** Readable side of a pipe (child stdout/stderr, createReadStream): flowing on 'data'/resume/pipe, buffered while paused. */
export class BridgeReadable extends EventEmitter {
  readable = true; readableEnded = false; destroyed = false;
  private flowing: boolean | null = null;
  private queue: (Buffer | null)[] = [];
  private enc: string | null = null;
  private decoder: TextDecoder | null = null;
  constructor() {
    super();
    this.on("newListener", (ev: string) => { if (ev === "data" && this.flowing !== false) queueMicrotask(() => this.resume()); });
  }
  setEncoding(enc: string): this {
    this.enc = enc;
    this.decoder = /^utf-?8$/i.test(enc) ? new TextDecoder("utf-8") : null;
    return this;
  }
  push(chunk: Buffer | null): boolean {
    if (this.destroyed || this.readableEnded) return false;
    if (this.flowing) this.deliver(chunk); else this.queue.push(chunk);
    return true;
  }
  private deliver(chunk: Buffer | null): void {
    if (chunk === null) {
      if (this.readableEnded) return;
      this.readableEnded = true; this.readable = false;
      const tail = this.decoder?.decode();
      if (tail) this.emit("data", tail);
      this.emit("end");
      this.emit("close");
      return;
    }
    this.emit("data", !this.enc ? chunk : this.decoder ? this.decoder.decode(chunk, { stream: true }) : chunk.toString(this.enc as BufferEncoding));
  }
  resume(): this {
    this.flowing = true;
    while (this.queue.length && this.flowing) this.deliver(this.queue.shift()!);
    return this;
  }
  pause(): this { this.flowing = false; return this; }
  isPaused(): boolean { return this.flowing === false; }
  read(): null { return null; }
  pipe<T extends { write(c: unknown): unknown; end?(): unknown; emit?(ev: string, ...a: unknown[]): unknown }>(dest: T, o?: { end?: boolean }): T {
    this.on("data", (c) => dest.write(c));
    if (o?.end !== false) this.on("end", () => dest.end?.());
    dest.emit?.("pipe", this);
    return dest;
  }
  unpipe(): this { this.removeAllListeners("data"); return this; }
  destroy(err?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true; this.queue = [];
    if (err && this.listenerCount("error")) this.emit("error", err);
    this.emit("close");
    return this;
  }
  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const buf: unknown[] = [];
    let wake: (() => void) | null = null, done = false;
    this.on("data", (c) => { buf.push(c); wake?.(); });
    this.on("end", () => { done = true; wake?.(); });
    this.on("close", () => { done = true; wake?.(); });
    return {
      next: async () => {
        while (!buf.length && !done) await new Promise<void>((r) => (wake = r));
        return buf.length ? { value: buf.shift(), done: false } : { value: undefined, done: true };
      },
      return: async () => { done = true; return { value: undefined, done: true }; },
    };
  }
}

/** Writable side (child stdin, createWriteStream): writes are sent in order; errors only surface to 'error' listeners. */
export class BridgeWritable extends EventEmitter {
  writable = true; writableEnded = false; writableFinished = false; destroyed = false;
  constructor(private send: (data: Buffer | null, end: boolean) => Promise<void>) { super(); }
  private fail(e: unknown): void { if (this.listenerCount("error")) this.emit("error", e); else console.warn("[tachylite] stream write failed", e); }
  write(chunk: unknown, enc?: unknown, cb?: (e?: unknown) => void): boolean {
    if (typeof enc === "function") { cb = enc as typeof cb; enc = undefined; }
    if (this.writableEnded) { const e: any = new Error("write after end"); e.code = "ERR_STREAM_WRITE_AFTER_END"; queueMicrotask(() => { cb?.(e); this.fail(e); }); return false; }
    const b = typeof chunk === "string" ? Buffer.from(chunk, (enc as BufferEncoding) ?? "utf8") : Buffer.from(chunk as Uint8Array);
    this.send(b, false).then(() => cb?.(), (e) => { cb?.(e); this.fail(e); });
    return true;
  }
  end(chunk?: unknown, enc?: unknown, cb?: () => void): this {
    if (typeof chunk === "function") { cb = chunk as () => void; chunk = undefined; }
    if (typeof enc === "function") { cb = enc as () => void; enc = undefined; }
    if (this.writableEnded) { if (cb) queueMicrotask(cb); return this; }
    if (chunk !== undefined && chunk !== null) this.write(chunk, enc);
    this.writableEnded = true; this.writable = false;
    this.send(null, true).then(() => { this.writableFinished = true; this.emit("finish"); this.emit("close"); cb?.(); }, (e) => this.fail(e));
    return this;
  }
  destroy(): this { if (!this.writableEnded) this.end(); this.destroyed = true; return this; }
  cork(): void {}
  uncork(): void {}
  setDefaultEncoding(): this { return this; }
}

/** FSWatcher over `bridge_watch` (notify in Rust): 'change' (eventType, filename) events until close(). */
class FSWatcher extends EventEmitter {
  private closed = false;
  constructor(public id: number) { super(); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    watchers.delete(this.id);
    void ipc.bridgeUnwatch(this.id).catch(() => {});
    this.emit("close");
  }
  ref(): this { return this; }
  unref(): this { return this; }
}
const watchers = new Map<number, FSWatcher>();
let watchReady: Promise<() => void> | null = null;
const ensureWatchListener = () => (watchReady ??= listen("bridge-watch", (ev: any) => watchers.get(ev?.id)?.emit("change", ev.eventType, ev.filename)));

function startWatch(p: unknown, o: any): FSWatcher {
  const path = resolvePath(p);
  const w = new FSWatcher(newId());
  watchers.set(w.id, w);
  void ensureWatchListener().then(() => ipc.bridgeWatch(w.id, path, !!o?.recursive)).catch((e) => {
    watchers.delete(w.id);
    const err = toNodeError(e);
    if (w.listenerCount("error")) w.emit("error", err); else console.warn("[tachylite] fs.watch failed", err);
  });
  return w;
}

/** Real (unconfined) `fs` for desktop plugins. */
export function createBridgeFs(): any {
  const promises: any = { constants: FS_CONSTANTS };
  const fs: any = { promises, constants: FS_CONSTANTS, Stats, Dirent, F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
  for (const [name, spec] of Object.entries(SPECS)) {
    promises[name] = async (...a: any[]) => { const s = spec(...a); return s.map ? s.map(await asyncFs(s.op)) : await asyncFs(s.op); };
    fs[name + "Sync"] = (...a: any[]) => { const s = spec(...a); const r = syncCall({ call: "fs", op: s.op }); return s.map ? s.map(r) : r; };
    fs[name] = (...a: any[]) => {
      const cb = a.pop();
      if (typeof cb !== "function") { const e: any = new TypeError(`The "cb" argument must be of type function. Received ${typeof cb}`); e.code = "ERR_INVALID_ARG_TYPE"; throw e; }
      let p: Promise<unknown>;
      try { p = promises[name](...a); } catch (e) { queueMicrotask(() => cb(e)); return; }
      p.then((v) => cb(null, v), (e) => cb(e));
    };
  }
  fs.exists = (p: unknown, cb: (b: boolean) => void) => { let path: string; try { path = resolvePath(p); } catch { queueMicrotask(() => cb(false)); return; } asyncFs({ op: "exists", path }).then((v) => cb(!!v), () => cb(false)); };
  fs.existsSync = (p: unknown) => { try { return !!syncCall({ call: "fs", op: { op: "exists", path: resolvePath(p) } }); } catch { return false; } };
  fs.watch = (p: unknown, o?: any, listener?: (ev: string, f: string) => void) => {
    if (typeof o === "function") { listener = o; o = {}; }
    if (!fs.existsSync(p)) throw toNodeError({ code: "ENOENT", errno: -2, message: "no such file or directory", syscall: "watch", path: String(p) });
    const w = startWatch(p, o);
    if (listener) w.on("change", listener);
    return w;
  };
  // Polling watchers are not implemented; they never fire (plugins use them as a fallback only).
  fs.watchFile = () => new EventEmitter();
  fs.unwatchFile = () => {};
  promises.watch = (p: unknown, o?: { signal?: AbortSignal; recursive?: boolean }) => {
    const queue: { eventType: string; filename: string }[] = [];
    let wake: (() => void) | null = null, w: FSWatcher | null = null, failure: unknown = null;
    const abortErr = () => { const e: any = new Error("The operation was aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; return e; };
    const start = () => {
      if (w) return;
      w = startWatch(p, o);
      w.on("change", (eventType: string, filename: string) => { queue.push({ eventType, filename }); wake?.(); });
      w.on("error", (e) => { failure = e; wake?.(); });
      o?.signal?.addEventListener("abort", () => { w?.close(); wake?.(); }, { once: true });
    };
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        start();
        for (;;) {
          if (failure) throw failure;
          if (o?.signal?.aborted) { w?.close(); throw abortErr(); }
          if (queue.length) return { value: queue.shift()!, done: false };
          await new Promise<void>((r) => (wake = r));
        }
      },
      async return() { w?.close(); return { value: undefined, done: true }; },
    };
  };
  fs.createReadStream = (p: unknown, o?: any) => {
    const r: any = new BridgeReadable();
    const enc = encOf(o);
    if (enc) r.setEncoding(enc);
    r.path = resolvePath(p);
    promises.readFile(p).then((b: Buffer) => {
      const start = o?.start ?? 0, end = o?.end === undefined ? b.length : o.end + 1;
      r.emit("open"); r.emit("ready");
      r.push(b.subarray(start, end)); r.push(null);
    }, (e: unknown) => r.destroy(e));
    return r;
  };
  fs.createWriteStream = (p: unknown, o?: any) => {
    const path = resolvePath(p);
    let flag = typeof o === "object" && o?.flags ? String(o.flags) : "w", chain: Promise<unknown> = Promise.resolve();
    const w: any = new BridgeWritable((data, end) => (chain = chain.then(async () => {
      if (data === null && !end) return;
      if (data === null) { if (flag !== "a") await promises.writeFile(path, Buffer.alloc(0), { flag }); return; }
      await promises.writeFile(path, data, { flag }); flag = "a";
    })) as Promise<void>);
    w.path = path;
    queueMicrotask(() => { w.emit("open"); w.emit("ready"); });
    return w;
  };
  const fdUnsupported = (n: string) => () => { const e: any = new Error(`fs.${n} (file descriptors) is not supported in Tachylite; use readFile/writeFile`); e.code = "ERR_NOT_SUPPORTED"; throw e; };
  for (const n of ["open", "openSync", "close", "closeSync", "read", "readSync", "write", "writeSync", "fstat", "fstatSync", "fsync", "fsyncSync", "opendir", "opendirSync"]) fs[n] = fdUnsupported(n);
  promises.open = fdUnsupported("promises.open");
  promises.opendir = fdUnsupported("promises.opendir");
  return fs;
}
export const FS_CONSTANTS = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, S_IFMT, S_IFREG: 0o100000, S_IFDIR: 0o40000, S_IFLNK: 0o120000 };

// ------------------------------------------------------------------ child_process
const procs = new Map<number, ChildProcess>();
let procReady: Promise<() => void> | null = null;
const ensureProcListener = () => (procReady ??= listen("bridge-process", (ev: any) => procs.get(ev?.id)?._handle(ev)));

function spawnError(j: any, file: string, args: string[]): Error {
  const e: any = toNodeError(j);
  e.path = file; e.spawnargs = args;
  return e;
}

export class ChildProcess extends EventEmitter {
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = false;
  connected = false;
  stdin: BridgeWritable | null;
  stdout: BridgeReadable | null;
  stderr: BridgeReadable | null;
  stdio: [BridgeWritable | null, BridgeReadable | null, BridgeReadable | null];
  /** @internal settles when the spawn request was answered; stdin writes and kill() queue behind it. */
  _chain: Promise<unknown> = Promise.resolve();
  private finished = false;
  constructor(public _id: number, stdio: string[], public spawnfile: string, public spawnargs: string[]) {
    super();
    this.stdin = stdio[0] === "pipe" ? new BridgeWritable((d, end) => (this._chain = this._chain.then(() => (this.finished ? undefined : ipc.bridgeStdin(this._id, d ? d.toString("base64") : null, end)))) as Promise<void>) : null;
    this.stdout = stdio[1] === "pipe" ? new BridgeReadable() : null;
    this.stderr = stdio[2] === "pipe" ? new BridgeReadable() : null;
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }
  kill(signal: string | number = "SIGTERM"): boolean {
    if (this.finished || this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this._chain = this._chain.then(() => ipc.bridgeKill(this._id, String(signal))).catch((e) => console.warn("[tachylite] kill failed", e));
    return true;
  }
  ref(): void {}
  unref(): void {}
  disconnect(): void {}
  send(): boolean { return false; }
  /** @internal one `bridge-process` event */
  _handle(ev: { kind: string; data?: string; code?: number | null; signal?: string | null }): void {
    if (ev.kind === "stdout") this.stdout?.push(Buffer.from(ev.data ?? "", "base64"));
    else if (ev.kind === "stderr") this.stderr?.push(Buffer.from(ev.data ?? "", "base64"));
    else if (ev.kind === "exit") {
      this.exitCode = ev.code ?? null; this.signalCode = ev.signal ?? null;
      this.emit("exit", this.exitCode, this.signalCode);
    } else if (ev.kind === "close") this._close(ev.code ?? null, ev.signal ?? null);
  }
  /** @internal */
  _close(code: number | null, signal: string | null): void {
    if (this.finished) return;
    this.finished = true;
    procs.delete(this._id);
    this.stdout?.push(null);
    this.stderr?.push(null);
    this.emit("close", code, signal);
  }
  /** @internal spawn failure: 'error' then 'close' with the negative errno, like Node. */
  _fail(e: any): void {
    if (this.listenerCount("error")) this.emit("error", e); else console.error("[tachylite] unhandled child process error", e);
    this._close(typeof e?.errno === "number" ? e.errno : -1, null);
  }
}

function normStdio(s: unknown): string[] {
  const one = (x: unknown) => (x === "ignore" || x === "inherit" ? x : "pipe");
  if (typeof s === "string") return [one(s), one(s), one(s)];
  if (Array.isArray(s)) return [0, 1, 2].map((i) => (s[i] === null || s[i] === undefined ? "pipe" : one(s[i])));
  return ["pipe", "pipe", "pipe"];
}
function envOf(e: unknown): Record<string, string> {
  const src = (e && typeof e === "object" ? e : env) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) if (v !== undefined) out[k] = String(v);
  return out;
}
/** Node's `shell` option: `/bin/sh -c` on Unix, `cmd.exe /d /s /c "..."` (verbatim) on Windows. */
function withShell(command: string, shell: unknown): { file: string; args: string[]; verbatim: boolean } {
  if (isWin()) {
    const file = typeof shell === "string" ? shell : env.ComSpec || "cmd.exe";
    if (/^(?:.*\\)?cmd(?:\.exe)?$/i.test(file)) return { file, args: ["/d", "/s", "/c", `"${command}"`], verbatim: true };
    return { file, args: ["-c", command], verbatim: false };
  }
  return { file: typeof shell === "string" ? shell : "/bin/sh", args: ["-c", command], verbatim: false };
}
function argsAndOptions(args: unknown, options: unknown): [string[], any] {
  if (!Array.isArray(args)) return [[], (args && typeof args === "object" ? args : options) ?? {}];
  return [args.map(String), options ?? {}];
}

function spawn(file: string, args?: unknown, options?: unknown): ChildProcess {
  const [a, o] = argsAndOptions(args, options);
  let f = String(file), argv = a, verbatim = !!o.windowsVerbatimArguments;
  if (o.shell) ({ file: f, args: argv, verbatim } = withShell([f, ...a].join(" "), o.shell));
  const stdio = normStdio(o.stdio);
  const cp = new ChildProcess(newId(), stdio, f, [f, ...argv]);
  if (!info) { queueMicrotask(() => cp._fail(disabledError("child_process.spawn"))); return cp; }
  procs.set(cp._id, cp);
  let cwdAbs: string | undefined;
  try { cwdAbs = o.cwd ? resolvePath(o.cwd) : undefined; } catch (e) { queueMicrotask(() => cp._fail(e)); return cp; }
  cp._chain = ensureProcListener()
    .then(() => ipc.bridgeSpawn({ id: cp._id, file: f, args: argv, cwd: cwdAbs, env: envOf(o.env), stdio, windowsVerbatimArguments: verbatim }))
    .then((r) => {
      if (r.error) cp._fail(spawnError(r.error, f, [f, ...argv]));
      else { cp.pid = r.pid; cp.emit("spawn"); }
    }, (e) => cp._fail(toNodeError(e)));
  if (o.timeout > 0) {
    const t = setTimeout(() => cp.kill(o.killSignal ?? "SIGTERM"), o.timeout);
    cp.once("close", () => clearTimeout(t));
  }
  if (o.signal) {
    const sig = o.signal as AbortSignal;
    const abort = () => { if (cp.kill(o.killSignal ?? "SIGTERM")) { const e: any = new Error("The operation was aborted"); e.name = "AbortError"; e.code = "ABORT_ERR"; if (cp.listenerCount("error")) cp.emit("error", e); } };
    if (sig.aborted) queueMicrotask(abort); else { sig.addEventListener("abort", abort, { once: true }); cp.once("close", () => sig.removeEventListener("abort", abort)); }
  }
  return cp;
}

type ExecCb = (err: any, stdout: any, stderr: any) => void;
function runBuffered(file: string, args: string[], o: any, cb: ExecCb | undefined, cmd: string): ChildProcess {
  const encoding = o.encoding === undefined ? "utf8" : o.encoding;
  const asBuffer = !encoding || encoding === "buffer" || !Buffer.isEncoding(encoding);
  const maxBuffer = o.maxBuffer ?? 1024 * 1024, killSignal = o.killSignal ?? "SIGTERM";
  const child = spawn(file, args, { ...o, timeout: undefined });
  const out: Buffer[] = [], err: Buffer[] = [];
  let outLen = 0, errLen = 0, ex: any = null, killed = false, done = false, timer: ReturnType<typeof setTimeout> | undefined;
  const kill = () => { killed = true; child.kill(killSignal); };
  const finish = (code: number | null, signal: string | null) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    const so = Buffer.concat(out), se = Buffer.concat(err);
    const stdout = asBuffer ? so : so.toString(encoding), stderr = asBuffer ? se : se.toString(encoding);
    if (!ex && code === 0 && signal === null) { cb?.(null, stdout, stderr); return; }
    if (!ex) {
      ex = new Error(`Command failed: ${cmd}\n${se.toString()}`);
      ex.code = code !== null && code < 0 ? errname(code) : code;
      ex.killed = child.killed || killed;
      ex.signal = signal;
    }
    ex.cmd = cmd;
    cb?.(ex, stdout, stderr);
  };
  const collect = (which: "stdout" | "stderr", bufs: Buffer[]) => (c: Buffer) => {
    const len = (which === "stdout" ? (outLen += c.length) : (errLen += c.length));
    if (len > maxBuffer) {
      if (!ex) { ex = new RangeError(`${which} maxBuffer length exceeded`); ex.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"; }
      bufs.push(c.subarray(0, c.length - (len - maxBuffer)));
      kill();
    } else bufs.push(c);
  };
  child.stdout?.on("data", collect("stdout", out));
  child.stderr?.on("data", collect("stderr", err));
  if (o.timeout > 0) timer = setTimeout(kill, o.timeout);
  child.on("close", finish);
  child.on("error", (e) => { ex = e; finish(null, null); });
  return child;
}
const ERRNAMES: Record<number, string> = { [-2]: "ENOENT", [-13]: "EACCES", [-1]: "EPERM", [-7]: "E2BIG", [-20]: "ENOTDIR" };
const errname = (n: number) => ERRNAMES[n] ?? String(n);

const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
function withPromisify<T extends (...a: any[]) => ChildProcess>(fn: T): T {
  Object.defineProperty(fn, promisifyCustom, {
    enumerable: false,
    value: (...args: any[]) => {
      let child: ChildProcess | undefined;
      const p: any = new Promise((res, rej) => {
        child = fn(...args, (err: any, stdout: unknown, stderr: unknown) => {
          if (err) { err.stdout = stdout; err.stderr = stderr; rej(err); } else res({ stdout, stderr });
        });
      });
      p.child = child;
      return p;
    },
  });
  return fn;
}

function spawnSync(file: string, args?: unknown, options?: unknown): any {
  const [a, o] = argsAndOptions(args, options);
  let f = String(file), argv = a, verbatim = !!o.windowsVerbatimArguments;
  if (o.shell) ({ file: f, args: argv, verbatim } = withShell([f, ...a].join(" "), o.shell));
  const input = o.input === undefined || o.input === null ? undefined : b64(o.input);
  const r = syncCall({ call: "spawnSync", req: {
    id: 0, file: f, args: argv, cwd: o.cwd ? resolvePath(o.cwd) : undefined, env: envOf(o.env), windowsVerbatimArguments: verbatim,
    stdio: input !== undefined || o.stdio ? normStdio(o.stdio) : undefined, input, timeout: o.timeout, killSignal: o.killSignal ? String(o.killSignal) : undefined, maxBuffer: o.maxBuffer ?? 1024 * 1024,
  } });
  const enc = o.encoding && o.encoding !== "buffer" ? o.encoding : null;
  const stdout = decode(Buffer.from(r.stdout ?? "", "base64"), enc), stderr = decode(Buffer.from(r.stderr ?? "", "base64"), enc);
  const res: any = { pid: r.pid, output: [null, stdout, stderr], stdout, stderr, status: r.status ?? null, signal: r.signal ?? null };
  if (r.error) res.error = spawnError(r.error, f, [f, ...argv]);
  return res;
}
function checkSync(r: any, cmd: string): void {
  let err: any = null;
  if (r.error) { err = r.error; Object.assign(err, { status: r.status, signal: r.signal, output: r.output, pid: r.pid, stdout: r.stdout, stderr: r.stderr }); }
  else if (r.status !== 0) {
    let msg = `Command failed: ${cmd}`;
    if (r.stderr && r.stderr.length) msg += `\n${r.stderr.toString()}`;
    err = new Error(msg);
    Object.assign(err, { status: r.status, signal: r.signal, output: r.output, pid: r.pid, stdout: r.stdout, stderr: r.stderr });
  }
  if (err) throw err;
}

/** Real `child_process` for desktop plugins. `pid` is set once the spawn request resolves (Node sets it synchronously). */
export function createBridgeChildProcess(): any {
  const exec = withPromisify((command: string, options?: any, callback?: ExecCb) => {
    if (typeof options === "function") { callback = options; options = undefined; }
    const o = { ...(options ?? {}) };
    o.shell = typeof o.shell === "string" ? o.shell : true;
    return runBuffered(String(command), [], o, callback, String(command));
  });
  const execFile = withPromisify((file: string, args?: any, options?: any, callback?: ExecCb) => {
    if (typeof args === "function") { callback = args; args = undefined; options = undefined; }
    else if (typeof options === "function") { callback = options; options = undefined; }
    const [a, o] = argsAndOptions(args, options);
    return runBuffered(String(file), a, { ...o }, callback, [file, ...a].join(" "));
  });
  const execSync = (command: string, options?: any) => {
    const o = { encoding: "buffer", ...(options ?? {}) };
    const r = spawnSync(command, [], { ...o, shell: typeof o.shell === "string" ? o.shell : true });
    checkSync(r, command);
    return r.stdout;
  };
  const execFileSync = (file: string, args?: any, options?: any) => {
    const [a, o] = argsAndOptions(args, options);
    const r = spawnSync(file, a, { encoding: "buffer", ...o });
    checkSync(r, [file, ...a].join(" "));
    return r.stdout;
  };
  const fork = () => { const e: any = new Error("child_process.fork is not supported in Tachylite (no Node.js runtime in the webview)"); e.code = "ERR_NOT_SUPPORTED"; throw e; };
  return { spawn, exec, execFile, spawnSync, execSync, execFileSync, fork, ChildProcess };
}

/** electron `shell.openPath` / `showItemInFolder` through the bridge. */
export async function openPath(p: string, reveal: boolean): Promise<string> {
  try { await ipc.bridgeOpenPath(resolvePath(p), reveal); return ""; } catch (e) { return toNodeError(e).message; }
}
