//! Popout windows. The main webview calls `window.open(POPOUT_URL#...)`; we answer the request with a new
//! OS window whose webview is *related* to the opener (same web process / environment / configuration), so the
//! opener receives a scriptable `WindowProxy` on a same-origin `about:blank` document and builds the popout's DOM
//! itself, as Electron popouts do. The UI owns everything inside; this module only creates, tracks and destroys
//! the OS windows and reports their geometry and close requests back to the main window.

use serde::Serialize;
use std::time::Duration;
use tauri::{webview::NewWindowFeatures, AppHandle, Emitter, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

/// Label of the main window (the only one with IPC permissions, see capabilities/default.json).
pub const MAIN: &str = "main";
const PREFIX: &str = "popout-";
/// Fragment marker the UI puts on `about:blank` so we can tell its popouts from plugins' `window.open` calls.
const MARK: &str = "tachylite-popout";

/// Requested popout: label plus optional logical geometry, parsed from `about:blank#tachylite-popout?label=..&x=..`.
#[derive(Debug, Default, PartialEq)]
pub struct Request {
    pub label: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub maximize: bool,
}

pub fn parse_request(url: &str) -> Option<Request> {
    let rest = url.strip_prefix("about:blank#")?.strip_prefix(MARK)?;
    let query = rest.strip_prefix('?').unwrap_or("");
    let mut r = Request::default();
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let num = || v.parse::<f64>().ok().filter(|n| n.is_finite());
        match k {
            "label" => r.label = v.to_string(),
            "x" => r.x = num(),
            "y" => r.y = num(),
            "width" => r.width = num().filter(|n| *n >= 100.0),
            "height" => r.height = num().filter(|n| *n >= 100.0),
            "maximize" => r.maximize = v == "1" || v == "true",
            _ => {}
        }
    }
    let ok = r
        .label
        .strip_prefix(PREFIX)
        .is_some_and(|id| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    ok.then_some(r)
}

pub fn is_popout(label: &str) -> bool {
    label.starts_with(PREFIX)
}

/// Handler for `window.open` in the main webview: our popouts get a related window; web links (plugins call
/// `window.open(url)`) open in the system browser; anything else is denied.
pub fn on_new_window<R: Runtime>(app: &AppHandle<R>, url: Url, features: NewWindowFeatures) -> tauri::webview::NewWindowResponse<R> {
    use tauri::webview::NewWindowResponse;
    let Some(req) = parse_request(url.as_str()) else {
        if matches!(url.scheme(), "http" | "https" | "mailto") {
            let _ = crate::open_url(url.to_string());
        }
        return NewWindowResponse::Deny;
    };
    if app.get_webview_window(&req.label).is_some() {
        return NewWindowResponse::Deny;
    }
    // `window_features` links the new webview to the opener: same WebKitGTK web process (related view), same
    // WebView2 environment, same WKWebView configuration. That is what makes the returned WindowProxy scriptable.
    let mut b = WebviewWindowBuilder::new(app, &req.label, WebviewUrl::External("about:blank".parse().expect("static url")))
        .window_features(features)
        .title("Tachylite")
        .min_inner_size(320.0, 240.0)
        .inner_size(req.width.unwrap_or(800.0), req.height.unwrap_or(600.0))
        .on_document_title_changed(|w, title| {
            let _ = w.set_title(if title.is_empty() { "Tachylite" } else { &title });
        });
    if let (Some(x), Some(y)) = (req.x, req.y) {
        b = b.position(x, y);
    }
    if req.maximize {
        b = b.maximized(true);
    }
    match b.build() {
        Ok(window) => NewWindowResponse::Create { window },
        Err(err) => {
            eprintln!("popout window failed: {err}");
            NewWindowResponse::Deny
        }
    }
}

/// The main page (re)loads (vault switch, "Reload app"): popouts belong to the old page's realm and can no longer
/// be driven, so destroy them; the new page restores them from workspace.json.
pub fn on_main_page_load<R: Runtime>(app: &AppHandle<R>, event: tauri::webview::PageLoadEvent) {
    if event != tauri::webview::PageLoadEvent::Started {
        return;
    }
    for (label, w) in app.webview_windows() {
        if is_popout(&label) {
            let _ = w.destroy();
        }
    }
}

/// Logical outer position and inner size, as the UI persists them in workspace.json (`x`, `y`, `width`, `height`).
#[derive(Serialize, Clone)]
pub struct Geometry {
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    maximize: bool,
}

fn geometry<R: Runtime>(w: &Window<R>) -> Option<Geometry> {
    let scale = w.scale_factor().ok()?;
    let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
    let size = w.inner_size().ok()?.to_logical::<f64>(scale);
    Some(Geometry { label: w.label().to_string(), x: pos.x, y: pos.y, width: size.width, height: size.height, maximize: w.is_maximized().unwrap_or(false) })
}

/// Window events of popouts. Returns true when handled.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) -> bool {
    let label = window.label().to_string();
    if !is_popout(&label) {
        return false;
    }
    let app = window.app_handle().clone();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            // The UI saves and detaches the window's leaves, then calls `popout_close`; destroy anyway if it does not.
            api.prevent_close();
            let _ = app.emit_to(MAIN, "popout-close-requested", &label);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.destroy();
                }
            });
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(g) = geometry(window) {
                let _ = app.emit_to(MAIN, "popout-geometry", g);
            }
        }
        WindowEvent::Focused(true) => {
            let _ = app.emit_to(MAIN, "popout-focus", &label);
        }
        WindowEvent::Destroyed => {
            let _ = app.emit_to(MAIN, "popout-destroyed", &label);
        }
        _ => {}
    }
    true
}

fn popout<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<WebviewWindow<R>, String> {
    if !is_popout(label) {
        return Err(format!("not a popout window: {label}"));
    }
    app.get_webview_window(label).ok_or_else(|| format!("no window {label}"))
}

/// Destroy a popout (after the UI closed its leaves). Unknown labels are not an error: the window may be gone already.
#[tauri::command]
pub fn popout_close(app: AppHandle, label: String) -> Result<(), String> {
    match popout(&app, &label) {
        Ok(w) => w.destroy().map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    }
}

#[tauri::command]
pub fn popout_focus(app: AppHandle, label: String) -> Result<(), String> {
    let w = if label == MAIN { app.get_webview_window(MAIN).ok_or("no main window")? } else { popout(&app, &label)? };
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())
}

/// Current geometry of a popout (the UI also caches the `popout-geometry` events).
#[tauri::command]
pub fn popout_geometry(app: AppHandle, label: String) -> Result<Option<Geometry>, String> {
    Ok(geometry(&popout(&app, &label)?.as_ref().window()))
}

/// WebKitGTK blocks `window.open` outside a user gesture unless told otherwise; popouts are restored at startup
/// and opened from commands, so allow it for the main webview. (WKWebView on macOS and WebView2 allow it already.)
pub fn allow_script_windows<R: Runtime>(main: &WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    let _ = main.with_webview(|wv| {
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(s) = WebViewExt::settings(&wv.inner()) {
            s.set_javascript_can_open_windows_automatically(true);
        }
    });
    #[cfg(not(target_os = "linux"))]
    let _ = main;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_popout_requests() {
        let r = parse_request("about:blank#tachylite-popout?label=popout-ab12&x=10&y=-20.5&width=900&height=700&maximize=1").unwrap();
        assert_eq!(r, Request { label: "popout-ab12".into(), x: Some(10.0), y: Some(-20.5), width: Some(900.0), height: Some(700.0), maximize: true });
        let r = parse_request("about:blank#tachylite-popout?label=popout-x").unwrap();
        assert_eq!((r.x, r.width, r.maximize), (None, None, false));
        // tiny or junk sizes are ignored
        assert_eq!(parse_request("about:blank#tachylite-popout?label=popout-x&width=5&height=NaN").unwrap().width, None);
    }

    #[test]
    fn rejects_foreign_urls() {
        for u in [
            "https://example.com/",
            "about:blank",
            "about:blank#other?label=popout-a",
            "about:blank#tachylite-popout?label=main",
            "about:blank#tachylite-popout?label=popout-",
            "about:blank#tachylite-popout?label=popout-a/b",
        ] {
            assert!(parse_request(u).is_none(), "{u}");
        }
    }
}
