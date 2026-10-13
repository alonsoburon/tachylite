// A fake Tauri backend over a real temp directory (node fs), implementing the commands in crates/tachylite-app.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { setBackend, setListenBackend } from "../../src/ipc";

export interface FakeVault { root: string; /** where "system" trash moves files; set `systemTrashFails` to simulate an unavailable OS trash */ systemTrash: string; systemTrashFails: boolean; calls: { cmd: string; args: any }[]; emit(ev: { kind: string; path: string }): void; cleanup(): void; write(rel: string, data: string): void; backend: (cmd: string, args?: any) => Promise<unknown> }

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
  const fm = /^---\n([\s\S]*?)\n---(\n|$)/.exec(text);
  if (fm) {
    try { meta.frontmatter = yaml.load(fm[1]) ?? {}; } catch { /* ignore */ }
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

export function makeVault(files: Record<string, string> = {}, opts: { plugins?: Record<string, { manifest?: any; main: string; styles?: string; data?: any }>; enabled?: string[]; root?: string; copyFrom?: string } = {}): FakeVault {
  const root = opts.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "tachy-"));
  if (opts.copyFrom) fs.cpSync(opts.copyFrom, root, { recursive: true });
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
  const listeners = new Set<(p: unknown) => void>();
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
      case "core_plugins": return ["file-explorer", "global-search", "switcher", "graph", "backlink", "canvas", "outgoing-link", "tag-pane", "properties", "page-preview", "daily-notes", "templates", "note-composer", "command-palette", "slash-command", "editor-status", "bookmarks", "markdown-importer", "zk-prefixer", "random-note", "outline", "word-count", "slides", "audio-recorder", "workspaces", "file-recovery", "publish", "sync", "bases", "webviewer"].map((id) => [id, !["properties", "slash-command", "markdown-importer", "zk-prefixer", "random-note", "slides", "audio-recorder", "workspaces", "publish", "sync", "webviewer", "daily-notes"].includes(id)]);
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
      default: throw new Error(`fake backend: unhandled command ${cmd}`);
    }
  };
  setBackend(backend);
  setListenBackend(async (_e, cb) => { listeners.add(cb); return () => listeners.delete(cb); });
  const systemTrash = fs.mkdtempSync(path.join(os.tmpdir(), "tachy-trash-"));
  const fake: FakeVault = {
    root, calls, backend, write, systemTrash, systemTrashFails: false,
    emit: (ev) => listeners.forEach((l) => l(ev)),
    cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(systemTrash, { recursive: true, force: true }); },
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
