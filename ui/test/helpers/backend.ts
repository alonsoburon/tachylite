// A fake Tauri backend over a real temp directory (node fs), implementing the commands in crates/tachylite-app.
import cproc from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { setBackend, setListenBackend, setSyncBackend } from "../../src/ipc";

/** Node bridge emulation state (bridge.rs): `consent` is the persisted per-vault choice, `active` the session gate. */
export interface FakeBridge { consent: boolean; active: boolean; opened: { path: string; reveal: boolean }[]; procs: Map<number, cproc.ChildProcess> }
export interface FakeVault {
  root: string; /** where "system" trash moves files; set `systemTrashFails` to simulate an unavailable OS trash */ systemTrash: string; systemTrashFails: boolean;
  calls: { cmd: string; args: any }[]; emit(ev: { kind: string; path: string }): void; emitEvent(name: string, payload: unknown): void;
  cleanup(): void; write(rel: string, data: string): void; backend: (cmd: string, args?: any) => Promise<unknown>; bridge: FakeBridge;
}

const BRIDGE_DISABLED = "ERR_BRIDGE_DISABLED: plugins are not allowed to run programs or access files outside the vault";
/** Node error -> the JSON string bridge.rs returns. */
function nodeErrJson(e: any): string {
  const m = /^[A-Z]+: (.*?), /.exec(String(e?.message ?? ""));
  return JSON.stringify({ code: e.code, errno: e.errno, message: m ? m[1] : String(e?.message), syscall: e.syscall, path: e.path, dest: e.dest });
}
const kindOf = (d: fs.Dirent | fs.Stats) => (d.isSymbolicLink() ? "symlink" : d.isDirectory() ? "dir" : d.isFile() ? "file" : "other");
/** bridge.rs `fs_op` on top of node:fs (same op names and result shapes). */
export function fakeFsOp(op: any): unknown {
  const b = (d: string) => Buffer.from(d, "base64");
  try {
    switch (op.op) {
      case "readFile": return fs.readFileSync(op.path).toString("base64");
      case "writeFile": fs.writeFileSync(op.path, b(op.data), { flag: op.flag ?? "w", mode: op.mode }); return null;
      case "readdir": return fs.readdirSync(op.path, { withFileTypes: true }).map((d) => ({ name: d.name, kind: kindOf(d) })).sort((x, y) => (x.name < y.name ? -1 : 1));
      case "stat": { const s = op.lstat ? fs.lstatSync(op.path) : fs.statSync(op.path); return { kind: kindOf(s), dev: s.dev, ino: s.ino, mode: s.mode, nlink: s.nlink, uid: s.uid, gid: s.gid, rdev: s.rdev, size: s.size, blksize: s.blksize, blocks: s.blocks, atimeMs: s.atimeMs, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs }; }
      case "exists": return fs.existsSync(op.path);
      case "access": fs.accessSync(op.path, op.mode ?? 0); return null;
      case "mkdir": return fs.mkdirSync(op.path, { recursive: !!op.recursive }) ?? null;
      case "rm": fs.rmSync(op.path, { recursive: !!op.recursive, force: !!op.force }); return null;
      case "rmdir": if (op.recursive) fs.rmSync(op.path, { recursive: true }); else fs.rmdirSync(op.path); return null;
      case "unlink": fs.unlinkSync(op.path); return null;
      case "rename": fs.renameSync(op.from, op.to); return null;
      case "copyFile": fs.copyFileSync(op.from, op.to, op.excl ? fs.constants.COPYFILE_EXCL : 0); return null;
      case "cp": fs.cpSync(op.from, op.to, { recursive: !!op.recursive, force: op.force !== false }); return null;
      case "realpath": return fs.realpathSync(op.path);
      case "readlink": return fs.readlinkSync(op.path);
      case "symlink": fs.symlinkSync(op.target, op.path); return null;
      case "chmod": fs.chmodSync(op.path, op.mode); return null;
      case "truncate": fs.truncateSync(op.path, op.len ?? 0); return null;
      case "utimes": fs.utimesSync(op.path, op.atime, op.mtime); return null;
      case "mkdtemp": return fs.mkdtempSync(op.prefix);
      default: throw new Error(`fake bridge: unknown fs op ${op.op}`);
    }
  } catch (e: any) { throw e?.code ? nodeErrJson(e) : e; }
}
function fakeSpawnSync(r: any, root: string): unknown {
  const res = cproc.spawnSync(r.file, r.args ?? [], { cwd: r.cwd ? path.resolve(root, r.cwd) : root, env: r.env, input: r.input ? Buffer.from(r.input, "base64") : undefined, timeout: r.timeout, killSignal: r.killSignal, maxBuffer: r.maxBuffer, stdio: r.stdio as any });
  const err: any = res.error;
  return { pid: res.pid, status: res.status, signal: res.signal, stdout: (res.stdout ?? Buffer.alloc(0)).toString("base64"), stderr: (res.stderr ?? Buffer.alloc(0)).toString("base64"), error: err ? { code: err.code, errno: err.errno, message: "", syscall: err.syscall } : null };
}

function walk(root: string, rel = "", out: { files: any[]; folders: string[] } = { files: [], folders: [] }) {
  for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) { out.folders.push(r); walk(root, r, out); }
    else {
      const st = fs.statSync(path.join(root, r));
      const dot = ent.name.lastIndexOf(".");
      out.files.push({ path: r, name: ent.name, basename: dot > 0 ? ent.name.slice(0, dot) : ent.name, extension: dot > 0 ? ent.name.slice(dot + 1) : "", stat: { ctime: Math.floor(st.birthtimeMs), mtime: Math.floor(st.mtimeMs), size: st.size } });
    }
  }
  return out;
}

function pos(text: string, offset: number) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, col: offset - (before.lastIndexOf("\n") + 1), offset };
}

export function parseMeta(text: string): any {
  const meta: any = {};
  let body = text, base = 0;
  const fm = /^---\n(?:([\s\S]*?)\n)?---(\n|$)/.exec(text);
  if (fm) {
    try { meta.frontmatter = (fm[1] ?? "").trim() ? yaml.load(fm[1]) ?? {} : {}; } catch { /* ignore */ }
    meta.frontmatterPosition = { start: pos(text, 0), end: pos(text, fm[0].length) };
    base = fm[0].length;
  }
  body = text.slice(base);
  const each = (re: RegExp, cb: (m: RegExpExecArray) => void) => { let m; while ((m = re.exec(body))) cb(m); };
  each(/(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (m) => {
    const item: any = { link: m[2], original: m[0], displayText: m[3] ?? m[2], position: { start: pos(text, base + m.index), end: pos(text, base + m.index + m[0].length) } };
    (m[1] ? (meta.embeds ??= []) : (meta.links ??= [])).push(item);
  });
  each(/(?:^|\s)(#[\w/-]+)/g, (m) => { (meta.tags ??= []).push({ tag: m[1], position: { start: pos(text, base + m.index), end: pos(text, base + m.index + m[0].length) } }); });
  each(/\s\^([\w-]+)$/gm, (m) => { (meta.blocks ??= {})[m[1].toLowerCase()] = { id: m[1], position: { start: pos(text, base + m.index + 1), end: pos(text, base + m.index + m[0].length) } }; });
  each(/^(#{1,6})\s+(.*)$/gm, (m) => { (meta.headings ??= []).push({ heading: m[2], level: m[1].length, position: { start: pos(text, base + m.index), end: pos(text, base + m.index + m[0].length) } }); });
  parseFootnotes(text, base, meta);
  return meta;
}

/** `footnotes` (definitions, single-line here, and inline `^[...]` content) and `footnoteRefs`, like the Rust parser. */
function parseFootnotes(text: string, base: number, meta: any): void {
  const body = text.slice(base);
  const at = (a: number, b: number) => ({ start: pos(text, base + a), end: pos(text, base + b) });
  const defs = new Set<string>();
  const labels = new Set<number>();
  const fns: any[] = [];
  for (const m of body.matchAll(/^ {0,3}\[\^([^\]\s]+)\]:.*$/gm)) {
    const from = m.index! + m[0].indexOf("[");
    defs.add(m[1].toLowerCase());
    labels.add(from);
    fns.push({ id: m[1].toLowerCase(), position: at(from, m.index! + m[0].length) });
  }
  for (const m of body.matchAll(/\^\[([^\]\n]+)\]/g)) fns.push({ id: "", position: at(m.index! + 2, m.index! + m[0].length - 1) });
  const refs = [...body.matchAll(/\[\^([^\]\s]+)\]/g)].filter((m) => !labels.has(m.index!) && defs.has(m[1].toLowerCase()))
    .map((m) => ({ id: m[1].toLowerCase(), position: at(m.index!, m.index! + m[0].length) }));
  if (fns.length) meta.footnotes = fns.sort((a, b) => a.position.start.offset - b.position.start.offset);
  if (refs.length) meta.footnoteRefs = refs;
}

/** Links a canvas contributes (crates/tachylite-core/src/canvas.rs): file cards by path, links inside text cards. */
function canvasMeta(text: string): any {
  let d: any;
  try { d = JSON.parse(text || "{}"); } catch { return {}; }
  const links: any[] = [];
  for (const n of Array.isArray(d?.nodes) ? d.nodes : []) {
    if (n?.type === "file" && typeof n.file === "string" && n.file) links.push({ link: n.file });
    if (n?.type === "text" && typeof n.text === "string") { const m = parseMeta(n.text); links.push(...(m.links ?? []), ...(m.embeds ?? [])); }
  }
  return { links };
}

export function makeVault(files: Record<string, string> = {}, opts: { plugins?: Record<string, { manifest?: any; main: string; styles?: string; data?: any }>; enabled?: string[]; root?: string; copyFrom?: string; bridgeConsent?: boolean } = {}): FakeVault {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "tachy-"));
  if (opts.copyFrom) fs.cpSync(opts.copyFrom, root, { recursive: true });
  const readJson = (rel: string): any => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8")); } catch { return null; } };
  const write = (rel: string, data: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
  for (const [p, d] of Object.entries(files)) write(p, d);
  fs.mkdirSync(path.join(root, ".obsidian"), { recursive: true });
  for (const [id, pl] of Object.entries(opts.plugins ?? {})) {
    write(`.obsidian/plugins/${id}/manifest.json`, JSON.stringify(pl.manifest ?? { id, name: id, version: "1.0.0", minAppVersion: "0.15.0", description: "", author: "t" }));
    write(`.obsidian/plugins/${id}/main.js`, pl.main);
    if (pl.styles) write(`.obsidian/plugins/${id}/styles.css`, pl.styles);
    if (pl.data) write(`.obsidian/plugins/${id}/data.json`, JSON.stringify(pl.data));
  }
  if (opts.enabled) write(".obsidian/community-plugins.json", JSON.stringify(opts.enabled));
  const calls: { cmd: string; args: any }[] = [];
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emitEvent = (name: string, payload: unknown) => listeners.get(name)?.forEach((l) => l(payload));
  const bridge: FakeBridge = { consent: !!opts.bridgeConsent, active: false, opened: [], procs: new Map() };
  const gate = () => { if (!bridge.active) throw BRIDGE_DISABLED; };
  const bridgeInfo = () => ({
    platform: process.platform, arch: process.arch, cwd: root, homedir: os.homedir(), tmpdir: os.tmpdir(), hostname: os.hostname(), username: os.userInfo().username,
    env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")), pid: process.pid, syncUrl: "fake-bridge://", token: "fake",
  });
  const watchers = new Map<number, fs.FSWatcher>();
  const abs = (rel: string) => {
    const p = path.join(root, rel === "/" ? "" : rel);
    if (!p.startsWith(root)) throw new Error("outside vault");
    return p;
  };
  const info = (rel: string) => {
    const f = walk(root).files.find((x) => x.path === rel);
    if (f) return f;
    const st = fs.statSync(abs(rel));
    const name = path.basename(rel), dot = name.lastIndexOf(".");
    return { path: rel, name, basename: dot > 0 ? name.slice(0, dot) : name, extension: dot > 0 ? name.slice(dot + 1) : "", stat: { ctime: Math.floor(st.birthtimeMs), mtime: Math.floor(st.mtimeMs), size: st.size } };
  };
  const vaultInfo = () => ({ name: path.basename(root), path: root, ...(() => { const w = walk(root); return { files: w.files, folders: w.folders }; })() });
  const links = () => {
    const resolved: any = {}, unresolved: any = {};
    const all = walk(root).files;
    for (const f of all.filter((x) => x.extension === "md" || x.extension === "canvas")) {
      const m = f.extension === "md" ? parseMeta(fs.readFileSync(abs(f.path), "utf8")) : canvasMeta(fs.readFileSync(abs(f.path), "utf8"));
      resolved[f.path] = {}; unresolved[f.path] = {};
      for (const l of [...(m.links ?? []), ...(m.embeds ?? [])]) {
        const lp = l.link.split("#")[0];
        const hit = all.find((x) => x.path === lp || x.path === lp + ".md" || x.name === lp || x.name === lp + ".md" || x.path.toLowerCase().endsWith("/" + lp.toLowerCase() + ".md"));
        const tgt = hit ? resolved[f.path] : unresolved[f.path];
        const key = hit ? hit.path : lp;
        tgt[key] = (tgt[key] ?? 0) + 1;
      }
      if (!Object.keys(resolved[f.path]).length) delete resolved[f.path];
      if (!Object.keys(unresolved[f.path]).length) delete unresolved[f.path];
    }
    return { resolved, unresolved };
  };
  const bytes = (a: number[] | Uint8Array) => Buffer.from(a as any);
  const backend = async (cmd: string, a: any = {}): Promise<unknown> => {
    calls.push({ cmd, args: a });
    switch (cmd) {
      case "vault_info": case "vault_open": return vaultInfo();
      case "fs_read": return fs.readFileSync(abs(a.path), "utf8");
      case "fs_read_binary": { const b = fs.readFileSync(abs(a.path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      case "fs_write": write(a.path, a.data); return info(a.path);
      case "fs_write_binary": write(a.path, bytes(a.data)); return info(a.path);
      case "fs_create": if (fs.existsSync(abs(a.path))) throw new Error("exists"); write(a.path, a.data); return info(a.path);
      case "fs_mkdir": fs.mkdirSync(abs(a.path), { recursive: true }); return null;
      case "fs_delete": case "fs_trash": {
        const opt = a.mode ?? (fs.existsSync(abs(".obsidian/app.json")) ? JSON.parse(fs.readFileSync(abs(".obsidian/app.json"), "utf8")).trashOption : undefined) ?? "system";
        const mode = opt === "none" || opt === "permanent" ? "permanent" : opt === "local" || opt === "trash" ? "local" : "system";
        if (!fs.existsSync(abs(a.path))) throw new Error(`${a.path}: not found`);
        const moveTo = (dir: string) => {
          fs.mkdirSync(dir, { recursive: true });
          const name = path.basename(a.path), dot = name.lastIndexOf(".");
          let dest = path.join(dir, name);
          for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`);
          fs.renameSync(abs(a.path), dest);
        };
        if (mode === "permanent") { fs.rmSync(abs(a.path), { recursive: true }); return "permanent"; }
        if (mode === "system" && !fake.systemTrashFails) { moveTo(fake.systemTrash); return "system"; }
        if (mode === "system" && a.mode) throw new Error("could not move to the system trash: unavailable");
        moveTo(abs(".trash"));
        return "local";
      }
      case "fs_rename": fs.mkdirSync(path.dirname(abs(a.to)), { recursive: true }); fs.renameSync(abs(a.from), abs(a.to)); return [];
      case "adapter_exists": return fs.existsSync(abs(a.path));
      case "adapter_read": return fs.readFileSync(abs(a.path), "utf8");
      case "adapter_read_binary": { const b = fs.readFileSync(abs(a.path)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      case "adapter_write": write(a.path, bytes(a.data)); return null;
      case "adapter_remove": fs.rmSync(abs(a.path), { recursive: !!a.recursive, force: false }); return null;
      case "adapter_mkdir": fs.mkdirSync(abs(a.path), { recursive: true }); return null;
      case "adapter_list": {
        const base = a.path.replace(/^\/+|\/+$/g, "");
        const out = { files: [] as string[], folders: [] as string[] };
        for (const e of fs.readdirSync(abs(a.path))) { const full = base ? `${base}/${e}` : e; (fs.statSync(path.join(abs(a.path), e)).isDirectory() ? out.folders : out.files).push(full); }
        out.files.sort(); out.folders.sort();
        return out;
      }
      case "meta_get": return fs.existsSync(abs(a.path)) ? parseMeta(fs.readFileSync(abs(a.path), "utf8")) : null;
      case "meta_links": return links();
      case "config_read": { const p = abs(`.obsidian/${a.name}`); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; }
      case "config_write": write(`.obsidian/${a.name}`, JSON.stringify(a.value, null, 2)); return null;
      case "core_plugins": { const saved = readJson(".obsidian/core-plugins.json") ?? {}; return ["file-explorer", "global-search", "switcher", "graph", "backlink", "canvas", "outgoing-link", "tag-pane", "properties", "page-preview", "daily-notes", "templates", "note-composer", "command-palette", "slash-command", "editor-status", "bookmarks", "markdown-importer", "zk-prefixer", "random-note", "outline", "word-count", "slides", "audio-recorder", "workspaces", "file-recovery", "publish", "sync", "bases", "webviewer"].map((id) => [id, !["properties", "slash-command", "markdown-importer", "zk-prefixer", "random-note", "slides", "audio-recorder", "workspaces", "publish", "sync", "webviewer", "daily-notes"].includes(id)]).map(([id, on]: any) => [id, typeof saved[id] === "boolean" ? saved[id] : on]); }
      case "plugins_installed": {
        const dir = abs(".obsidian/plugins");
        if (!fs.existsSync(dir)) return [];
        const en = fs.existsSync(abs(".obsidian/community-plugins.json")) ? JSON.parse(fs.readFileSync(abs(".obsidian/community-plugins.json"), "utf8")) : [];
        return fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "manifest.json"))).map((d) => { const m = JSON.parse(fs.readFileSync(path.join(dir, d, "manifest.json"), "utf8")); return [m, en.includes(m.id)]; });
      }
      case "plugin_bundle": {
        const d = `.obsidian/plugins/${a.id}`;
        const manifest = JSON.parse(fs.readFileSync(abs(`${d}/manifest.json`), "utf8"));
        return { manifest, mainJs: fs.readFileSync(abs(`${d}/main.js`), "utf8"), stylesCss: fs.existsSync(abs(`${d}/styles.css`)) ? fs.readFileSync(abs(`${d}/styles.css`), "utf8") : null, dir: d };
      }
      case "plugin_set_enabled": {
        const p = abs(".obsidian/community-plugins.json");
        let ids: string[] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : [];
        ids = ids.filter((i) => i !== a.id);
        if (a.enabled) ids.push(a.id);
        write(".obsidian/community-plugins.json", JSON.stringify(ids));
        return null;
      }
      case "http_request": {
        // node:http (not fetch): happy-dom's fetch enforces CORS, the Rust command does not.
        const http = await import("node:http");
        return await new Promise((resolve, reject) => {
          const req = http.request(a.req.url, { method: a.req.method, headers: a.req.headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), String(v)])), body: Array.from(Buffer.concat(chunks)) }));
          });
          req.on("error", reject);
          if (a.req.body) req.write(Buffer.from(a.req.body));
          req.end();
        });
      }
      case "bridge_status": return { enabled: bridge.consent, active: bridge.active };
      case "bridge_activate": bridge.active = !!a.active && bridge.consent; if (!bridge.active) bridge.procs.forEach((p) => p.kill("SIGKILL")); return bridge.active ? bridgeInfo() : null;
      case "bridge_set_enabled": bridge.consent = bridge.active = !!a.enabled; return bridge.active ? bridgeInfo() : null;
      case "bridge_fs": gate(); return fakeFsOp(a.op);
      case "bridge_spawn_sync": gate(); return fakeSpawnSync(a.req, root);
      case "bridge_spawn": {
        gate();
        const r = a.req, id = r.id;
        const child = cproc.spawn(r.file, r.args, { cwd: r.cwd ? path.resolve(root, r.cwd) : root, env: r.env, stdio: (r.stdio ?? ["pipe", "pipe", "pipe"]) as any, windowsVerbatimArguments: r.windowsVerbatimArguments });
        return await new Promise((resolve) => {
          child.once("error", (e: any) => resolve({ error: { code: e.code, errno: e.errno, message: "", syscall: e.syscall, path: e.path } }));
          child.once("spawn", () => {
            bridge.procs.set(id, child);
            child.stdout?.on("data", (d: Buffer) => emitEvent("bridge-process", { kind: "stdout", id, data: d.toString("base64") }));
            child.stderr?.on("data", (d: Buffer) => emitEvent("bridge-process", { kind: "stderr", id, data: d.toString("base64") }));
            child.on("exit", (code, signal) => emitEvent("bridge-process", { kind: "exit", id, code, signal }));
            child.on("close", (code, signal) => { bridge.procs.delete(id); emitEvent("bridge-process", { kind: "close", id, code, signal }); });
            resolve({ pid: child.pid });
          });
        });
      }
      case "bridge_stdin": {
        gate();
        const c = bridge.procs.get(a.id);
        if (!c?.stdin) throw "no such process";
        if (a.data) await new Promise<void>((res, rej) => c.stdin!.write(Buffer.from(a.data, "base64"), (e) => (e ? rej(String(e)) : res())));
        if (a.end) c.stdin.end();
        return null;
      }
      case "bridge_kill": gate(); return bridge.procs.get(a.id)?.kill(a.signal as NodeJS.Signals) ?? false;
      case "bridge_watch": {
        gate();
        const w = fs.watch(a.path, { recursive: !!a.recursive }, (eventType, filename) => emitEvent("bridge-watch", { id: a.id, eventType, filename }));
        watchers.set(a.id, w);
        return null;
      }
      case "bridge_unwatch": watchers.get(a.id)?.close(); watchers.delete(a.id); return null;
      case "bridge_open_path": gate(); bridge.opened.push({ path: a.path, reveal: !!a.reveal }); return null;
      default: throw new Error(`fake backend: unhandled command ${cmd}`);
    }
  };
  setBackend(backend);
  setListenBackend(async (e, cb) => {
    if (!listeners.has(e)) listeners.set(e, new Set());
    listeners.get(e)!.add(cb);
    return () => listeners.get(e)?.delete(cb);
  });
  setSyncBackend((req: any) => {
    if (!bridge.active) return { err: BRIDGE_DISABLED };
    try { return { ok: req.call === "fs" ? fakeFsOp(req.op) : fakeSpawnSync(req.req, root) }; } catch (e) { return { err: typeof e === "string" ? e : String(e) }; }
  });
  const systemTrash = fs.mkdtempSync(path.join(os.tmpdir(), "tachy-trash-"));
  const fake: FakeVault = {
    root, calls, backend, write, bridge, emitEvent, systemTrash, systemTrashFails: false,
    emit: (ev) => emitEvent("vault-event", ev),
    cleanup: () => { bridge.procs.forEach((p) => p.kill("SIGKILL")); watchers.forEach((w) => w.close()); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(systemTrash, { recursive: true, force: true }); },
  };
  return fake;
}

export async function makeApp(v: FakeVault, opts: { start?: boolean; onCoreReady?: (app: any) => void } = {}) {
  const { App } = await import("../../src/obsidian/app");
  await import("../../src/obsidian/index"); // installs DOM helpers + registers the obsidian module
  const info = (await v.backend("vault_info")) as any;
  const app: InstanceType<typeof App> = new App({ info, installGlobalHandlers: false, onCoreReady: opts.onCoreReady ? () => opts.onCoreReady!(app) : undefined });
  if (opts.start !== false) await app.start();
  return app;
}
