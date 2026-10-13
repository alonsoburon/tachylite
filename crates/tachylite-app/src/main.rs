//! Tachylite desktop shell. Exposes the Rust core (vault, metadata, search, plugin distribution)
//! to the webview over Tauri commands. The command signatures below are the contract the UI and the
//! Obsidian-API shim in `ui/` are written against.

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tachylite_core::{
    config::{core_plugin_state, CONFIG_DIR},
    path::normalize,
    search::{search, SearchHit},
    TrashMode, VaultFile, Workspace,
};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;

fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

#[derive(Default)]
struct App {
    ws: Mutex<Option<Workspace>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl App {
    fn with<T>(&self, f: impl FnOnce(&mut Workspace) -> Res<T>) -> Res<T> {
        let mut g = self.ws.lock().map_err(e)?;
        f(g.as_mut().ok_or("no vault open")?)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultInfo {
    name: String,
    path: String,
    files: Vec<VaultFile>,
    folders: Vec<String>,
}

fn info(ws: &Workspace) -> VaultInfo {
    VaultInfo {
        name: ws.vault.name(),
        path: ws.vault.root().to_string_lossy().into_owned(),
        files: ws.vault.files().cloned().collect(),
        folders: ws.vault.folders().to_vec(),
    }
}

// ---------- vault lifecycle ----------

fn recents_path(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(e)?;
    fs::create_dir_all(&dir).map_err(e)?;
    Ok(dir.join("vaults.json"))
}

fn read_recents(app: &AppHandle) -> Vec<String> {
    recents_path(app).ok().and_then(|p| fs::read_to_string(p).ok()).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

#[tauri::command]
fn vaults_recent(app: AppHandle) -> Vec<String> {
    read_recents(&app).into_iter().filter(|p| Path::new(p).is_dir()).collect()
}

#[tauri::command]
fn vault_open(app: AppHandle, state: State<App>, path: String) -> Res<VaultInfo> {
    let ws = Workspace::open(&path).map_err(e)?;
    let out = info(&ws);
    let mut recents = read_recents(&app);
    recents.retain(|p| *p != out.path);
    recents.insert(0, out.path.clone());
    recents.truncate(20);
    fs::write(recents_path(&app)?, serde_json::to_string_pretty(&recents).map_err(e)?).map_err(e)?;
    let root = ws.vault.root().to_path_buf();
    // Let the webview load local images/audio/video/pdf of this vault through the asset protocol.
    let _ = app.asset_protocol_scope().allow_directory(&root, true);
    *state.ws.lock().map_err(e)? = Some(ws);
    start_watcher(&app, &state, root)?;
    Ok(out)
}

/// Create an empty vault folder (with `.obsidian/`) and open it.
#[tauri::command]
fn vault_create(app: AppHandle, state: State<App>, path: String) -> Res<VaultInfo> {
    fs::create_dir_all(Path::new(&path).join(CONFIG_DIR)).map_err(e)?;
    vault_open(app, state, path)
}

#[tauri::command]
fn vault_info(state: State<App>) -> Res<VaultInfo> {
    state.with(|ws| Ok(info(ws)))
}

fn start_watcher(app: &AppHandle, state: &State<App>, root: PathBuf) -> Res<()> {
    let handle = app.clone();
    let root2 = root.clone();
    let mut w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        let Ok(ev) = ev else { return };
        // Reads (opening/listing a directory, e.g. our own re-index) raise Access events; reacting to them loops forever.
        if matches!(ev.kind, notify::EventKind::Access(_) | notify::EventKind::Other) {
            return;
        }
        for p in ev.paths {
            let Ok(rel) = p.strip_prefix(&root2) else { continue };
            let rel = normalize(&rel.to_string_lossy());
            if rel.is_empty() || rel.starts_with(".trash") {
                continue;
            }
            let state = handle.state::<App>();
            if rel == format!("{CONFIG_DIR}/app.json") {
                // Keep link-format / trash / ignore settings in sync with edits made by other tools.
                if let Ok(mut g) = state.ws.lock() {
                    if let Some(ws) = g.as_mut() {
                        reload_app_config(ws);
                    }
                }
            }
            let kind = if rel.starts_with(CONFIG_DIR) {
                "config-changed"
            } else if p.exists() {
                if matches!(ev.kind, notify::EventKind::Create(_)) {
                    "create"
                } else {
                    "modify"
                }
            } else {
                "delete"
            };
            if kind != "config-changed" {
                let Ok(mut g) = state.ws.lock() else { continue };
                let Some(ws) = g.as_mut() else { continue };
                if p.is_dir() {
                    let _ = ws.vault.reindex();
                } else if ws.vault.refresh(&rel).is_some() {
                    let vault = &ws.vault;
                    ws.meta.update_file(vault, &rel);
                } else {
                    ws.meta.remove_file(&rel);
                }
            }
            let _ = handle.emit("vault-event", json!({ "kind": kind, "path": rel }));
        }
    })
    .map_err(e)?;
    w.watch(&root, RecursiveMode::Recursive).map_err(e)?;
    *state.watcher.lock().map_err(e)? = Some(w);
    Ok(())
}

// ---------- files ----------

#[tauri::command]
fn fs_read(state: State<App>, path: String) -> Res<String> {
    state.with(|ws| ws.vault.read(&path).map_err(e))
}

#[tauri::command]
fn fs_read_binary(state: State<App>, path: String) -> Res<Response> {
    state.with(|ws| ws.vault.read_binary(&path).map(Response::new).map_err(e))
}

#[tauri::command]
fn fs_write(state: State<App>, path: String, data: String) -> Res<VaultFile> {
    state.with(|ws| ws.write(&path, &data).map_err(e))
}

#[tauri::command]
fn fs_write_binary(state: State<App>, path: String, data: Vec<u8>) -> Res<VaultFile> {
    state.with(|ws| {
        let f = ws.vault.write(&path, &data).map_err(e)?;
        let vault = &ws.vault;
        ws.meta.update_file(vault, &f.path);
        Ok(f)
    })
}

#[tauri::command]
fn fs_create(state: State<App>, path: String, data: String) -> Res<VaultFile> {
    state.with(|ws| ws.create(&path, &data).map_err(e))
}

#[tauri::command]
fn fs_mkdir(state: State<App>, path: String) -> Res<()> {
    state.with(|ws| ws.vault.create_folder(&path).map_err(e))
}

#[tauri::command]
fn fs_delete(state: State<App>, path: String) -> Res<TrashMode> {
    state.with(|ws| ws.delete(&path).map_err(e))
}

/// Returns the notes whose links were rewritten. `update_links`: `None` follows the vault's
/// `alwaysUpdateLinks`, `Some(false)` skips link rewriting, `Some(true)` forces it.
#[tauri::command]
fn fs_rename(state: State<App>, from: String, to: String, update_links: Option<bool>) -> Res<Vec<String>> {
    state.with(|ws| ws.rename_opt(&from, &to, update_links).map_err(e))
}

/// Delete with an explicit mode: `"system"` (OS trash; an error if it is unavailable), `"local"` (the vault's
/// `.trash`) or `"permanent"`/`"none"`. `None` follows the vault's `trashOption`, falling back from the OS
/// trash to `.trash` (like `fs_delete`). Returns where the file went.
#[tauri::command]
fn fs_trash(state: State<App>, path: String, mode: Option<String>) -> Res<TrashMode> {
    state.with(|ws| {
        match mode.as_deref() {
            None => ws.delete(&path),
            Some(m) => ws.delete_mode(&path, TrashMode::from_option(m)),
        }
        .map_err(e)
    })
}

// ---------- adapter (raw access, includes dot-folders like .obsidian) ----------

fn adapter_abs(ws: &Workspace, rel: &str) -> Res<PathBuf> {
    ws.vault.abs(rel).map_err(e)
}

#[tauri::command]
fn adapter_exists(state: State<App>, path: String) -> Res<bool> {
    state.with(|ws| Ok(adapter_abs(ws, &path)?.exists()))
}

#[tauri::command]
fn adapter_read(state: State<App>, path: String) -> Res<String> {
    state.with(|ws| fs::read_to_string(adapter_abs(ws, &path)?).map_err(e))
}

#[tauri::command]
fn adapter_read_binary(state: State<App>, path: String) -> Res<Response> {
    state.with(|ws| fs::read(adapter_abs(ws, &path)?).map(Response::new).map_err(e))
}

#[tauri::command]
fn adapter_write(state: State<App>, path: String, data: Vec<u8>) -> Res<()> {
    state.with(|ws| {
        let p = adapter_abs(ws, &path)?;
        if let Some(d) = p.parent() {
            fs::create_dir_all(d).map_err(e)?;
        }
        fs::write(p, data).map_err(e)
    })
}

#[tauri::command]
fn adapter_remove(state: State<App>, path: String, recursive: bool) -> Res<()> {
    state.with(|ws| {
        let p = adapter_abs(ws, &path)?;
        if p.is_dir() {
            if recursive { fs::remove_dir_all(p) } else { fs::remove_dir(p) }.map_err(e)
        } else {
            fs::remove_file(p).map_err(e)
        }
    })
}

#[derive(Serialize)]
struct AdapterStat {
    #[serde(rename = "type")]
    kind: &'static str,
    ctime: u64,
    mtime: u64,
    size: u64,
}

/// `null` when the path does not exist.
#[tauri::command]
fn adapter_stat(state: State<App>, path: String) -> Res<Option<AdapterStat>> {
    state.with(|ws| {
        let Ok(m) = fs::metadata(adapter_abs(ws, &path)?) else { return Ok(None) };
        let ms =
            |t: std::io::Result<std::time::SystemTime>| t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
        Ok(Some(AdapterStat { kind: if m.is_dir() { "folder" } else { "file" }, ctime: ms(m.created()), mtime: ms(m.modified()), size: m.len() }))
    })
}

#[tauri::command]
fn adapter_mkdir(state: State<App>, path: String) -> Res<()> {
    state.with(|ws| fs::create_dir_all(adapter_abs(ws, &path)?).map_err(e))
}

#[derive(Serialize)]
struct Listing {
    files: Vec<String>,
    folders: Vec<String>,
}

#[tauri::command]
fn adapter_list(state: State<App>, path: String) -> Res<Listing> {
    state.with(|ws| {
        let dir = adapter_abs(ws, &path)?;
        let base = normalize(&path);
        let mut out = Listing { files: vec![], folders: vec![] };
        for ent in fs::read_dir(dir).map_err(e)? {
            let ent = ent.map_err(e)?;
            let name = ent.file_name().to_string_lossy().into_owned();
            let full = if base.is_empty() { name } else { format!("{base}/{name}") };
            if ent.path().is_dir() {
                out.folders.push(full)
            } else {
                out.files.push(full)
            }
        }
        out.files.sort();
        out.folders.sort();
        Ok(out)
    })
}

// ---------- metadata & search ----------

#[tauri::command]
fn meta_get(state: State<App>, path: String) -> Res<Value> {
    state.with(|ws| serde_json::to_value(ws.meta.get(&path)).map_err(e))
}

/// Cached metadata of every note in one call (path -> CachedMetadata), for warming the UI cache.
#[tauri::command]
fn meta_all(state: State<App>) -> Res<Value> {
    state.with(|ws| {
        let mut out = serde_json::Map::new();
        for f in ws.vault.markdown_files() {
            if let Some(m) = ws.meta.get(&f.path) {
                out.insert(f.path.clone(), serde_json::to_value(m).map_err(e)?);
            }
        }
        Ok(Value::Object(out))
    })
}

#[tauri::command]
fn meta_links(state: State<App>) -> Res<Value> {
    state.with(|ws| Ok(json!({ "resolved": ws.meta.resolved_links, "unresolved": ws.meta.unresolved_links })))
}

#[tauri::command]
fn meta_backlinks(state: State<App>, path: String) -> Res<BTreeMap<String, usize>> {
    state.with(|ws| Ok(ws.meta.backlinks(&path)))
}

#[tauri::command]
fn meta_tags(state: State<App>) -> Res<BTreeMap<String, usize>> {
    state.with(|ws| Ok(ws.meta.tags()))
}

#[tauri::command]
fn meta_resolve(state: State<App>, link: String, source: String) -> Res<Option<String>> {
    state.with(|ws| Ok(ws.meta.first_linkpath_dest(&link, &source)))
}

#[tauri::command]
fn meta_linktext(state: State<App>, target: String, source: String, omit_md: bool) -> Res<String> {
    state.with(|ws| Ok(ws.meta.file_to_linktext(&ws.vault, &target, &source, omit_md)))
}

#[tauri::command]
fn vault_search(state: State<App>, query: String) -> Res<Vec<SearchHit>> {
    state.with(|ws| Ok(search(&ws.vault, &ws.meta, &query)))
}

// ---------- config (.obsidian/*.json) ----------

fn config_file(ws: &Workspace, name: &str) -> Res<PathBuf> {
    if name.contains('/') || name.contains("..") || !name.ends_with(".json") {
        return Err(format!("invalid config name: {name}"));
    }
    Ok(ws.vault.root().join(CONFIG_DIR).join(name))
}

/// Returns the parsed JSON file or `null` if it does not exist.
#[tauri::command]
fn config_read(state: State<App>, name: String) -> Res<Value> {
    state.with(|ws| match fs::read_to_string(config_file(ws, &name)?) {
        Ok(s) => serde_json::from_str(&s).map_err(e),
        Err(_) => Ok(Value::Null),
    })
}

#[tauri::command]
fn config_write(state: State<App>, name: String, value: Value) -> Res<()> {
    state.with(|ws| {
        let p = config_file(ws, &name)?;
        fs::create_dir_all(p.parent().unwrap()).map_err(e)?;
        fs::write(p, serde_json::to_string_pretty(&value).map_err(e)?).map_err(e)?;
        if name == "app.json" {
            reload_app_config(ws);
        }
        Ok(())
    })
}

/// Re-read `app.json` into the core (link updates, trash option, ignore filters) and re-index when the filters changed.
fn reload_app_config(ws: &mut Workspace) {
    let before = ws.vault.config.user_ignore_filters();
    ws.vault.config = tachylite_core::config::AppConfig::load(ws.vault.root());
    if ws.vault.config.user_ignore_filters() != before {
        let _ = ws.vault.reindex();
    }
}

#[tauri::command]
fn core_plugins(state: State<App>) -> Res<Vec<(String, bool)>> {
    state.with(|ws| Ok(core_plugin_state(ws.vault.root())))
}

// ---------- community plugins & themes ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginBundle {
    manifest: tachylite_plugins::Manifest,
    main_js: String,
    styles_css: Option<String>,
    dir: String,
}

fn root_of(state: &State<App>) -> Res<PathBuf> {
    state.with(|ws| Ok(ws.vault.root().to_path_buf()))
}

#[tauri::command]
fn plugins_installed(state: State<App>) -> Res<Vec<(tachylite_plugins::Manifest, bool)>> {
    Ok(tachylite_plugins::installed(&root_of(&state)?))
}

/// Source for one installed plugin, ready for the runtime to evaluate.
#[tauri::command]
fn plugin_bundle(state: State<App>, id: String) -> Res<PluginBundle> {
    let dir = tachylite_plugins::plugin_dir(&root_of(&state)?, &id);
    let manifest = serde_json::from_slice(&fs::read(dir.join("manifest.json")).map_err(e)?).map_err(e)?;
    Ok(PluginBundle {
        manifest,
        main_js: fs::read_to_string(dir.join("main.js")).map_err(e)?,
        styles_css: fs::read_to_string(dir.join("styles.css")).ok(),
        dir: format!("{CONFIG_DIR}/plugins/{id}"),
    })
}

#[tauri::command]
fn plugin_catalog() -> Res<Vec<tachylite_plugins::CatalogPlugin>> {
    tachylite_plugins::Registry::default().plugins().map_err(e)
}

#[tauri::command]
fn plugin_install(state: State<App>, id: String) -> Res<tachylite_plugins::Manifest> {
    tachylite_plugins::Registry::default().install_plugin(&root_of(&state)?, &id).map_err(e)
}

#[tauri::command]
fn plugin_set_enabled(state: State<App>, id: String, enabled: bool) -> Res<()> {
    tachylite_plugins::set_enabled(&root_of(&state)?, &id, enabled).map_err(e)
}

#[tauri::command]
fn plugin_uninstall(state: State<App>, id: String) -> Res<()> {
    tachylite_plugins::uninstall(&root_of(&state)?, &id).map_err(e)
}

#[tauri::command]
fn theme_catalog() -> Res<Vec<tachylite_plugins::CatalogTheme>> {
    tachylite_plugins::Registry::default().themes().map_err(e)
}

#[tauri::command]
fn theme_install(state: State<App>, name: String) -> Res<()> {
    tachylite_plugins::Registry::default().install_theme(&root_of(&state)?, &name).map_err(e)
}

// ---------- launch, diagnostics ----------

#[derive(Serialize)]
struct Launch {
    vault: Option<String>,
    /// Developer automation: a JS file to run in the webview after boot (`TACHYLITE_SCRIPT`).
    script: Option<String>,
}

/// Vault to open at start: `--vault <path>` (or `--vault=<path>`), else `TACHYLITE_VAULT`.
#[tauri::command]
fn launch_args() -> Launch {
    let args: Vec<String> = std::env::args().collect();
    let from_cli = args
        .iter()
        .position(|a| a == "--vault")
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| args.iter().find_map(|a| a.strip_prefix("--vault=").map(String::from)));
    let vault = from_cli.or_else(|| std::env::var("TACHYLITE_VAULT").ok()).filter(|p| !p.is_empty());
    let script = std::env::var("TACHYLITE_SCRIPT").ok().and_then(|p| fs::read_to_string(p).ok());
    Launch { vault, script }
}

/// Append a frontend log line to `$TACHYLITE_LOG` (default `/tmp/tachylite-frontend.log`).
#[tauri::command]
fn log_frontend(level: String, message: String) {
    use std::io::Write;
    let path = std::env::var("TACHYLITE_LOG").unwrap_or_else(|_| "/tmp/tachylite-frontend.log".into());
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{level}] {message}");
    }
}

/// Exit the application (called by the frontend once it has flushed pending saves).
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Open an http(s)/mailto link in the system browser.
#[tauri::command]
fn open_url(url: String) -> Res<()> {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err("unsupported url scheme".into());
    }
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(url).spawn().map(|_| ()).map_err(e)
}

/// Developer automation: render the webview to a PNG (Linux, debug builds, `TACHYLITE_DEV=1`).
/// Works on locked/headless desktops where grabbing the screen does not.
#[cfg(all(target_os = "linux", debug_assertions))]
#[tauri::command]
async fn dev_screenshot(window: tauri::WebviewWindow, path: String) -> Res<()> {
    if std::env::var("TACHYLITE_DEV").is_err() {
        return Err("dev_screenshot requires TACHYLITE_DEV=1".into());
    }
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            use webkit2gtk::WebViewExt;
            let view = wv.inner();
            view.snapshot(webkit2gtk::SnapshotRegion::FullDocument, webkit2gtk::SnapshotOptions::NONE, None::<&webkit2gtk::gio::Cancellable>, move |res| {
                let out = res.map_err(|e| e.to_string()).and_then(|surface| {
                    let img = cairo::ImageSurface::try_from(surface).map_err(|_| "snapshot is not an image surface".to_string())?;
                    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
                    img.write_to_png(&mut f).map_err(|e| e.to_string())
                });
                let _ = tx.send(out);
            });
        })
        .map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(20)).map_err(|e| e.to_string())?).await.map_err(e)?
}
#[cfg(not(all(target_os = "linux", debug_assertions)))]
#[tauri::command]
async fn dev_screenshot(_path: String) -> Res<()> {
    Err("dev_screenshot is only available in Linux debug builds".into())
}

// ---------- network (plugins' requestUrl; bypasses webview CORS) ----------

#[derive(serde::Deserialize)]
struct HttpReq {
    url: String,
    method: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    body: Option<Vec<u8>>,
}

#[derive(Serialize)]
struct HttpResp {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

#[tauri::command]
async fn http_request(req: HttpReq) -> Res<HttpResp> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(60)).build();
        let mut r = agent.request(req.method.as_deref().unwrap_or("GET"), &req.url);
        for (k, v) in req.headers.unwrap_or_default() {
            r = r.set(&k, &v);
        }
        let resp = match req.body {
            Some(b) => r.send_bytes(&b),
            None => r.call(),
        };
        // Non-2xx is a normal response for plugins (they inspect `status`).
        let resp = match resp {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(err) => return Err(err.to_string()),
        };
        let headers = resp.headers_names().into_iter().filter_map(|n| resp.header(&n).map(|v| (n.to_lowercase(), v.to_string()))).collect();
        let status = resp.status();
        let mut body = vec![];
        std::io::Read::read_to_end(&mut resp.into_reader(), &mut body).map_err(e)?;
        Ok(HttpResp { status, headers, body })
    })
    .await
    .map_err(e)?
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(App::default())
        .on_window_event(|window, event| {
            // Give the frontend a chance to flush unsaved notes and the layout; exit anyway if it does not answer.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.emit("close-requested", ());
                let handle = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    handle.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            vaults_recent,
            vault_open,
            vault_create,
            vault_info,
            fs_read,
            fs_read_binary,
            fs_write,
            fs_write_binary,
            fs_create,
            fs_mkdir,
            fs_delete,
            fs_rename,
            fs_trash,
            adapter_stat,
            meta_all,
            launch_args,
            log_frontend,
            open_url,
            quit_app,
            dev_screenshot,
            adapter_exists,
            adapter_read,
            adapter_read_binary,
            adapter_write,
            adapter_remove,
            adapter_mkdir,
            adapter_list,
            meta_get,
            meta_links,
            meta_backlinks,
            meta_tags,
            meta_resolve,
            meta_linktext,
            vault_search,
            config_read,
            config_write,
            core_plugins,
            plugins_installed,
            plugin_bundle,
            plugin_catalog,
            plugin_install,
            plugin_set_enabled,
            plugin_uninstall,
            theme_catalog,
            theme_install,
            http_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tachylite");
}
