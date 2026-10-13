// Typed wrappers over the Tauri backend commands (crates/tachylite-app/src/main.rs).
// Tauri converts snake_case Rust argument names to camelCase on the JS side.

export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface FileStat { ctime: number; mtime: number; size: number }
export interface VaultFileInfo { path: string; name: string; basename: string; extension: string; stat: FileStat }
export interface VaultInfo { name: string; path: string; files: VaultFileInfo[]; folders: string[] }
export interface Listing { files: string[]; folders: string[] }
export interface Manifest {
  id: string; name: string; version: string; minAppVersion?: string; description?: string;
  author?: string; authorUrl?: string | null; isDesktopOnly?: boolean; [k: string]: unknown;
}
export interface PluginBundle { manifest: Manifest; mainJs: string; stylesCss: string | null; dir: string }
export interface SearchHit { [k: string]: unknown }
export interface CatalogPlugin { [k: string]: unknown }
export interface CatalogTheme { [k: string]: unknown }
export interface HttpReq { url: string; method?: string; headers?: Record<string, string>; body?: number[] | null }
export interface HttpResp { status: number; headers: Record<string, string>; body: number[] }
export type TrashMode = "system" | "local" | "permanent";
/** Node bridge (crates/tachylite-app/src/bridge.rs): platform facts handed out only while the bridge is active. */
export interface BridgeInfo { platform: string; arch: string; cwd: string; homedir: string; tmpdir: string; hostname: string; username: string; env: Record<string, string>; pid: number; syncUrl: string; token: string }
export interface BridgeSpawnReq { id: number; file: string; args: string[]; cwd?: string; env?: Record<string, string>; stdio?: string[]; windowsVerbatimArguments?: boolean }
export type VaultEventKind = "create" | "modify" | "delete" | "config-changed";
export interface VaultEvent { kind: VaultEventKind; path: string }

function tauriInvoke(): InvokeFn {
  const w = globalThis as any;
  const f = w.__TAURI__?.core?.invoke ?? w.__TAURI_INTERNALS__?.invoke;
  if (!f) throw new Error("Tauri backend not available (window.__TAURI__ missing)");
  return f;
}

export type ListenFn = (event: string, cb: (payload: unknown) => void) => Promise<() => void>;

let backend: InvokeFn = (cmd, args) => tauriInvoke()(cmd, args);
let listenBackend: ListenFn = async (event, cb) => {
  const w = globalThis as any;
  const l = w.__TAURI__?.event?.listen;
  if (!l) return () => {};
  return await l(event, (e: { payload: unknown }) => cb(e.payload));
};

/** Synchronous channel of the Node bridge (`fs.*Sync`, `execSync`): a sync XHR in the app, a plain function in tests. */
export type SyncFn = (req: Record<string, unknown>) => { ok?: unknown; err?: string };
let syncBackend: SyncFn | null = null;
export function setSyncBackend(fn: SyncFn | null): void { syncBackend = fn; }
export function getSyncBackend(): SyncFn | null { return syncBackend; }

/** Replace the backend (vitest / storybook). */
export function setBackend(fn: InvokeFn): void { backend = fn; }
export function setListenBackend(fn: ListenFn): void { listenBackend = fn; }

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return (await backend(cmd, args)) as T;
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
}

/** Tauri serialises `Vec<u8>` arguments from plain number arrays. */
export function bytes(data: ArrayBuffer | ArrayBufferView | number[]): number[] {
  if (Array.isArray(data)) return data;
  const u8 = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  return Array.from(u8);
}

/** Binary responses come back as ArrayBuffer (Tauri `Response`); tolerate arrays / typed arrays in mocks. */
export function toArrayBuffer(x: unknown): ArrayBuffer {
  if (x instanceof ArrayBuffer) return x;
  if (ArrayBuffer.isView(x)) return x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer;
  if (Array.isArray(x)) return new Uint8Array(x).buffer as ArrayBuffer;
  // Cross-realm ArrayBuffer (jsdom/happy-dom)
  if (x && Object.prototype.toString.call(x) === "[object ArrayBuffer]") return x as ArrayBuffer;
  throw new Error("unexpected binary payload from backend");
}

export const ipc = {
  // vault lifecycle
  vaultsRecent: () => call<string[]>("vaults_recent"),
  vaultOpen: (path: string) => call<VaultInfo>("vault_open", { path }),
  vaultCreate: (path: string) => call<VaultInfo>("vault_create", { path }),
  vaultInfo: () => call<VaultInfo>("vault_info"),
  // files
  fsRead: (path: string) => call<string>("fs_read", { path }),
  fsReadBinary: async (path: string) => toArrayBuffer(await call<unknown>("fs_read_binary", { path })),
  fsWrite: (path: string, data: string) => call<VaultFileInfo>("fs_write", { path, data }),
  fsWriteBinary: (path: string, data: ArrayBuffer | ArrayBufferView) => call<VaultFileInfo>("fs_write_binary", { path, data: bytes(data) }),
  fsCreate: (path: string, data: string) => call<VaultFileInfo>("fs_create", { path, data }),
  fsMkdir: (path: string) => call<void>("fs_mkdir", { path }),
  /** Delete following the vault's trashOption (OS trash falls back to .trash); returns where the file went. */
  fsDelete: (path: string) => call<TrashMode>("fs_delete", { path }),
  /** Returns the paths of notes whose links were rewritten. */
  fsRename: (from: string, to: string, updateLinks?: boolean) => call<string[]>("fs_rename", updateLinks === undefined ? { from, to } : { from, to, updateLinks }),
  /** mode: "system" (OS trash; rejects if unavailable) | "local" (the vault's .trash) | "permanent"; omitted = follow the vault setting. */
  fsTrash: (path: string, mode?: TrashMode) => call<TrashMode>("fs_trash", mode === undefined ? { path } : { path, mode }),
  // adapter (raw, includes dot folders)
  adapterExists: (path: string) => call<boolean>("adapter_exists", { path }),
  adapterRead: (path: string) => call<string>("adapter_read", { path }),
  adapterReadBinary: async (path: string) => toArrayBuffer(await call<unknown>("adapter_read_binary", { path })),
  adapterWrite: (path: string, data: ArrayBuffer | ArrayBufferView | number[]) => call<void>("adapter_write", { path, data: bytes(data) }),
  adapterRemove: (path: string, recursive: boolean) => call<void>("adapter_remove", { path, recursive }),
  adapterStat: (path: string) => call<{ type: "file" | "folder"; ctime: number; mtime: number; size: number } | null>("adapter_stat", { path }),
  adapterMkdir: (path: string) => call<void>("adapter_mkdir", { path }),
  adapterList: (path: string) => call<Listing>("adapter_list", { path }),
  // metadata
  metaGet: (path: string) => call<any | null>("meta_get", { path }),
  metaAll: () => call<Record<string, any>>("meta_all"),
  metaLinks: () => call<{ resolved: Record<string, Record<string, number>>; unresolved: Record<string, Record<string, number>> }>("meta_links"),
  metaBacklinks: (path: string) => call<Record<string, number>>("meta_backlinks", { path }),
  metaTags: () => call<Record<string, number>>("meta_tags"),
  metaResolve: (link: string, source: string) => call<string | null>("meta_resolve", { link, source }),
  metaLinktext: (target: string, source: string, omitMd: boolean) => call<string>("meta_linktext", { target, source, omitMd }),
  vaultSearch: (query: string) => call<SearchHit[]>("vault_search", { query }),
  // config (.obsidian/*.json); null when missing
  configRead: (name: string) => call<any | null>("config_read", { name }),
  configWrite: (name: string, value: unknown) => call<void>("config_write", { name, value }),
  corePlugins: () => call<[string, boolean][]>("core_plugins"),
  // community plugins & themes
  pluginsInstalled: () => call<[Manifest, boolean][]>("plugins_installed"),
  pluginBundle: (id: string) => call<PluginBundle>("plugin_bundle", { id }),
  pluginCatalog: () => call<CatalogPlugin[]>("plugin_catalog"),
  pluginInstall: (id: string) => call<Manifest>("plugin_install", { id }),
  pluginSetEnabled: (id: string, enabled: boolean) => call<void>("plugin_set_enabled", { id, enabled }),
  pluginUninstall: (id: string) => call<void>("plugin_uninstall", { id }),
  themeCatalog: () => call<CatalogTheme[]>("theme_catalog"),
  themeInstall: (name: string) => call<void>("theme_install", { name }),
  // launch / diagnostics
  launchArgs: () => call<{ vault: string | null; script: string | null }>("launch_args"),
  quitApp: () => call<void>("quit_app"),
  openUrl: (url: string) => call<void>("open_url", { url }),
  logFrontend: (level: string, message: string) => call<void>("log_frontend", { level, message }),
  // popout windows (crates/tachylite-app/src/popout.rs); the windows themselves are opened with window.open
  popoutClose: (label: string) => call<void>("popout_close", { label }),
  popoutFocus: (label: string) => call<void>("popout_focus", { label }),
  popoutGeometry: (label: string) => call<{ label: string; x: number; y: number; width: number; height: number; maximize: boolean } | null>("popout_geometry", { label }),
  // network
  httpRequest: (req: HttpReq) => call<HttpResp>("http_request", { req }),
  // Node bridge for desktop plugins (gated in Rust; see bridge.rs)
  bridgeStatus: () => call<{ enabled: boolean; active: boolean }>("bridge_status"),
  bridgeActivate: (active: boolean) => call<BridgeInfo | null>("bridge_activate", { active }),
  bridgeSetEnabled: (enabled: boolean) => call<BridgeInfo | null>("bridge_set_enabled", { enabled }),
  bridgeFs: (op: Record<string, unknown>) => call<any>("bridge_fs", { op }),
  bridgeSpawn: (req: BridgeSpawnReq) => call<{ pid?: number; error?: any }>("bridge_spawn", { req }),
  bridgeSpawnSync: (req: Record<string, unknown>) => call<any>("bridge_spawn_sync", { req }),
  bridgeStdin: (id: number, data: string | null, end: boolean) => call<void>("bridge_stdin", { id, data, end }),
  bridgeKill: (id: number, signal: string) => call<boolean>("bridge_kill", { id, signal }),
  bridgeWatch: (id: number, path: string, recursive: boolean) => call<void>("bridge_watch", { id, path, recursive }),
  bridgeUnwatch: (id: number) => call<void>("bridge_unwatch", { id }),
  bridgeOpenPath: (path: string, reveal: boolean) => call<void>("bridge_open_path", { path, reveal }),
};

/** Subscribe to filesystem events emitted by the Rust watcher. Returns an unlisten function. */
export function listen(event: "vault-event", cb: (ev: VaultEvent) => void): Promise<() => void>;
export function listen(event: string, cb: (payload: any) => void): Promise<() => void>;
export function listen(event: string, cb: (payload: any) => void): Promise<() => void> {
  return listenBackend(event, cb);
}
