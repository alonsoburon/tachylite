// `tachylite://` URIs: parsing (same shapes and decoding as Obsidian's `obsidian://` URIs), vault matching and
// the built-in actions (open, new, search, daily, choose-vault), then `Plugin.registerObsidianProtocolHandler`.
import { ipc, listen } from "../ipc";
import { Notice, normalizePath, parseLinktext, Platform, TFile, TFolder, type App, type PaneType } from "../obsidian";
import { openVaultSwitcher } from "./commands";
import { joinPath, uniqueName } from "./files";
import { openDailyNote } from "./core/dailyNotes";

/** Schemes the parser understands. Only `tachylite` is registered with the OS; see docs/platform.md. */
export const URI_SCHEMES = ["tachylite", "obsidian"];

export type UriParams = Record<string, string> & { action: string };

/**
 * `tachylite://action?k=v&flag#hash` -> `{ action, k: "v", flag: "true", hash }` (values URI-decoded), plus the two
 * shorthands: `tachylite://vault/<vault>/<file path>` and `tachylite:///absolute/path` (an `open` by path).
 */
export function parseUri(url: string, windows = false): UriParams | null {
  const m = /^([a-z][a-z0-9+.-]*):(?:\/\/)?/i.exec(url);
  if (!m || !URI_SCHEMES.includes(m[1].toLowerCase())) return null;
  let rest = url.slice(m[0].length);
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  if (rest.startsWith("/")) {
    let p = rest;
    try { p = decodeURI(rest); } catch { /* keep raw */ }
    return { action: "open", path: windows && /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p };
  }
  if (rest.startsWith("vault/")) {
    const parts = rest.slice(6).split("/").map(dec);
    return { action: "open", vault: parts[0], file: parts.slice(1).join("/") };
  }
  const out: Record<string, string> = {};
  const q = rest.indexOf("?");
  const h = rest.indexOf("#", Math.max(0, q));
  if (h >= 0) { out.hash = rest.slice(h + 1); rest = rest.slice(0, h); }
  let query = "";
  if (q >= 0) { query = rest.slice(q + 1); rest = rest.slice(0, q); }
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    if (k) out[dec(k)] = eq < 0 ? "true" : dec(pair.slice(eq + 1));
  }
  return { ...out, action: rest.replace(/\/+$/, "") };
}

/** `tachylite://open?vault=...&file=...` for a file (Markdown files without the extension). */
export function uriForFile(app: App, file: TFile): string { return app.getObsidianUrl(file); }

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const caseFold = (p: string, insensitive: boolean) => (insensitive ? p.toLowerCase() : p);

/** Vault-relative path of `abs` inside the vault rooted at `base`, or null. */
export function relativeTo(base: string, abs: string, insensitive: boolean): string | null {
  const b = caseFold(slashes(base), insensitive), a = slashes(abs);
  if (caseFold(a, insensitive) === b) return "";
  return caseFold(a, insensitive).startsWith(b + "/") ? a.slice(b.length + 1) : null;
}

export interface VaultMatch { current: boolean; path?: string }

/**
 * Which vault a URI targets: `path` (the vault containing it, longest root wins), else `vault` (name, or a full
 * path, case-insensitive), else the open one. Rewrites `params` (`path` becomes `file`, `vault` is dropped).
 * `null` when the named vault is unknown.
 */
export function matchVault(params: UriParams, current: { name: string; path: string }, recents: string[], insensitive: boolean): VaultMatch | null {
  const name = (p: string) => slashes(p).split("/").pop() ?? "";
  if (params.path) {
    let best: { root: string; rel: string } | null = null;
    for (const root of [current.path, ...recents]) {
      const rel = relativeTo(root, params.path, insensitive);
      if (rel !== null && (!best || slashes(root).length > slashes(best.root).length)) best = { root, rel };
    }
    if (!best) return null;
    params.file = best.rel;
    delete (params as Record<string, string>).path;
    return best.root === current.path ? { current: true } : { current: false, path: best.root };
  }
  if (params.vault !== undefined) {
    const want = params.vault.toLowerCase();
    delete (params as Record<string, string>).vault;
    const same = (root: string) => name(root).toLowerCase() === want || slashes(root).toLowerCase() === slashes(want);
    if (current.name.toLowerCase() === want || same(current.path)) return { current: true };
    const hit = recents.find(same);
    return hit ? { current: false, path: hit } : null;
  }
  return { current: true };
}

const paneOf = (p?: string): PaneType | false => (p === "tab" || p === "split" || p === "window" ? p : false);

async function actionOpen(app: App, p: UriParams): Promise<void> {
  if (!p.file) return;
  const { path, subpath } = parseLinktext(p.file);
  const file = app.metadataCache.getFirstLinkpathDest(normalizePath(path), "") ?? app.vault.getFileByPath(normalizePath(path));
  if (!file) { new Notice(`File not found: ${p.file}`); return; }
  await app.workspace.getLeaf(paneOf(p.paneType)).openFile(file, { active: true, eState: subpath ? { subpath } : {} });
}

async function actionNew(app: App, p: UriParams): Promise<void> {
  const into = !!(p.append || p.prepend || p.overwrite);
  let file: TFile | null = null;
  if (p.file) {
    if (/\.\.[/\\]/.test(p.file)) return;
    const path = normalizePath(p.file.endsWith(".md") ? p.file : p.file + ".md");
    if (into) file = app.metadataCache.getFirstLinkpathDest(p.file, "") ?? (app.vault.getAbstractFileByPathInsensitive(path) as TFile | null);
    if (!(file instanceof TFile)) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
      const folder = dir ? app.vault.getFolderByPath(dir) : app.vault.getRoot();
      const base = path.slice(dir ? dir.length + 1 : 0, -3);
      file = await app.vault.create(joinPath(folder, uniqueName(app, folder, base, "md")), "");
    }
  } else {
    const name = (p.name || "Untitled").replace(/[/\\]/g, "");
    if (into) file = app.metadataCache.getFirstLinkpathDest(name, "");
    if (!file) {
      const folder: TFolder = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "", name);
      file = await app.vault.create(joinPath(folder, uniqueName(app, folder, name, "md")), "");
    }
  }
  let content = p.content;
  if (p.clipboard) content = await navigator.clipboard.readText().catch(() => content);
  if (content) {
    if (p.append || p.prepend) {
      await app.vault.process(file, (cur) => {
        if (!cur) return content;
        if (p.prepend) return content + (content.endsWith("\n") ? "" : "\n") + cur;
        return cur + (cur.endsWith("\n") ? "" : "\n") + content;
      });
    } else await app.vault.modify(file, content);
  }
  if (!p.silent) await app.workspace.getLeaf(paneOf(p.paneType)).openFile(file, { active: true, state: { mode: "source" } });
}

async function actionSearch(app: App, p: UriParams): Promise<void> {
  if (!app.internalPlugins.getEnabledPluginById("global-search")) return;
  const leaf = await app.workspace.ensureSideLeaf("search", "left", { active: true, reveal: true });
  (leaf.view as any).setQuery?.(p.query ?? "");
}

const BUILT_IN: Record<string, (app: App, p: UriParams) => unknown> = {
  open: actionOpen,
  new: actionNew,
  search: actionSearch,
  daily: (app) => { if (app.internalPlugins.getEnabledPluginById("daily-notes")) return openDailyNote(app); new Notice("Daily notes is turned off."); },
  "choose-vault": () => openVaultSwitcher(),
};

/** Run an already-parsed URI against `app` (the right vault). Built-in actions first, then plugin handlers. */
export async function dispatchUri(app: App, params: UriParams): Promise<boolean> {
  const { action } = params;
  if (!action || (action === "open" && Object.keys(params).length === 1)) return true;
  const run = BUILT_IN[action] ? (p: UriParams) => BUILT_IN[action](app, p) : app.protocolHandlers[action];
  if (!run) { new Notice(`Unknown Tachylite URI action "${action}".`); return false; }
  try { await run(params); return true; }
  catch (e) { console.error(`URI action ${action} failed`, e); new Notice(String((e as Error).message ?? e)); return false; }
}

/** Session key that carries URIs (JSON array) across the reload that switches to the vault they name. */
export const PENDING_URI_KEY = "tachylite-uri";
export function carryUris(urls: string[]): void {
  const prev: string[] = JSON.parse(sessionStorage.getItem(PENDING_URI_KEY) ?? "[]");
  sessionStorage.setItem(PENDING_URI_KEY, JSON.stringify([...prev, ...urls]));
}
function takeCarried(): string[] {
  const raw = sessionStorage.getItem(PENDING_URI_KEY);
  sessionStorage.removeItem(PENDING_URI_KEY);
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

/** The vault a launch URI names among the recent vaults (used when nothing else says which vault to open). */
export function vaultForUri(url: string, recents: string[]): string | null {
  const params = parseUri(url, Platform.isWin);
  if (!params || (!params.path && params.vault === undefined)) return null;
  const m = matchVault(params, { name: "\0", path: "\0" }, recents, !Platform.isLinux);
  return m?.path ?? null;
}

/** Full handling of one URL: parse, find the vault (switching vaults reloads the window), dispatch. */
export async function handleUri(app: App, url: string, switchVault: (path: string, url: string) => void = defaultSwitch): Promise<boolean> {
  const params = parseUri(url, Platform.isWin);
  if (!params) return false;
  const insensitive = !Platform.isLinux;
  const recents = await ipc.vaultsRecent().catch(() => [] as string[]);
  const m = matchVault(params, { name: app.vault.getName(), path: app.vault.adapter.getBasePath() }, recents, insensitive);
  if (!m) { new Notice(`Vault not found for ${url}`); return false; }
  if (!m.current && m.path) { switchVault(m.path, url); return true; }
  return dispatchUri(app, params);
}

function defaultSwitch(path: string, url: string): void {
  carryUris([url]);
  sessionStorage.setItem("tachylite-open", path);
  location.reload();
}

/** Handle URIs that arrived before the session was ready, then every new one. Returns an unlisten function. */
export function installUriHandling(app: App): () => void {
  let off: (() => void) | null = null, stopped = false;
  const queue = takeCarried();
  let busy = Promise.resolve();
  const run = (urls: string[]) => { for (const u of urls) busy = busy.then(() => handleUri(app, u).then(() => undefined, (e) => console.error("URI", u, e))); };
  void (async () => {
    off = await listen("open-url", () => { void ipc.deepLinkTake().then(run, () => {}); });
    if (stopped) { off(); return; }
    const pending = await ipc.deepLinkTake().catch(() => [] as string[]);
    app.workspace.onLayoutReady(() => run([...queue, ...pending]));
  })();
  return () => { stopped = true; off?.(); };
}
