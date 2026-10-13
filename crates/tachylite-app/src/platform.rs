//! Operating-system integration: the native menu bar, `tachylite://` deep links with single-instance
//! forwarding, the OS name handed to the webview, and opening URLs in the default browser.

use serde_json::json;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuBuilder, MenuEvent, SubmenuBuilder},
    plugin::TauriPlugin,
    AppHandle, Builder, Emitter, Manager, Runtime,
};

type Res<T> = Result<T, String>;

/// The only URL scheme Tachylite claims by default (see docs/platform.md for `obsidian://`).
pub const SCHEME: &str = "tachylite";
/// Event the webview receives for every deep link that arrives while it runs.
const URL_EVENT: &str = "open-url";
/// Event carrying the command id of a clicked menu item.
const MENU_EVENT: &str = "menu-command";
/// Menu item ids that run a command are `cmd:<command id>`.
const CMD_PREFIX: &str = "cmd:";

/// Deep links received before the UI asked for them (launch URL, or links arriving while a vault loads).
#[derive(Default)]
pub struct Links(Mutex<Vec<String>>);

/// Deep links not yet handled by the UI; the queue is emptied. Called once the vault session is ready.
#[tauri::command]
pub fn deep_link_take(links: tauri::State<Links>) -> Vec<String> {
    links.0.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
}

fn accept_urls<R: Runtime>(app: &AppHandle<R>, urls: Vec<String>) {
    let urls: Vec<String> = urls.into_iter().filter(|u| is_our_url(u)).collect();
    if urls.is_empty() {
        return;
    }
    if let Ok(mut q) = app.state::<Links>().0.lock() {
        q.extend(urls.iter().cloned());
    }
    focus_main(app);
    let _ = app.emit_to("main", URL_EVENT, json!(urls));
}

fn has_scheme(u: &str, scheme: &str) -> bool {
    u.len() > scheme.len() + 1 && u.is_char_boundary(scheme.len()) && u[..scheme.len()].eq_ignore_ascii_case(scheme) && u[scheme.len()..].starts_with(':')
}

/// Extra schemes the user routes to Tachylite themselves (`TACHYLITE_URL_SCHEMES=obsidian`; see docs/platform.md).
fn extra_schemes() -> Vec<String> {
    std::env::var("TACHYLITE_URL_SCHEMES")
        .map(|v| v.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty() && s != SCHEME).collect())
        .unwrap_or_default()
}

fn is_our_url(u: &str) -> bool {
    has_scheme(u, SCHEME) || extra_schemes().iter().any(|s| has_scheme(u, s))
}

/// URLs in a command line (`args[0]` is the program) that the deep-link plugin does not pick up itself: it only
/// takes a lone `tachylite://` argument, so this returns opted-in extra schemes and URLs among other arguments.
fn extra_urls(args: &[String], extra: &[String]) -> Vec<String> {
    let rest = args.get(1..).unwrap_or_default();
    let plugin_took = rest.len() == 1 && has_scheme(&rest[0], SCHEME);
    rest.iter().filter(|a| (!plugin_took && has_scheme(a, SCHEME)) || extra.iter().any(|s| has_scheme(a, s))).cloned().collect()
}

fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Single-instance forwarding is on in release builds; debug builds (parallel dev/test runs) opt in with
/// `TACHYLITE_SINGLE_INSTANCE=1`, and any build opts out with `TACHYLITE_SINGLE_INSTANCE=0`.
fn single_instance_enabled() -> bool {
    match std::env::var("TACHYLITE_SINGLE_INSTANCE").as_deref() {
        Ok("1") | Ok("true") => true,
        Ok("0") | Ok("false") => false,
        _ => !cfg!(debug_assertions),
    }
}

/// The native menu bar is a macOS convention (and the only way the standard Edit shortcuts reach the webview
/// there). Linux and Windows get none, like Obsidian's default frame; `TACHYLITE_MENU=1` shows it anyway.
fn menu_enabled() -> bool {
    cfg!(target_os = "macos") || std::env::var("TACHYLITE_MENU").is_ok_and(|v| v == "1")
}

/// Internal plugin: its init script tells every webview the real OS before any page script runs
/// (`Platform.isMacOS` etc. read it synchronously; the user agent is only the fallback), and its setup hook
/// wires deep links (a plugin hook, so it does not take over `Builder::setup`).
fn platform_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("tachylite-platform")
        .js_init_script(format!("window.__TACHYLITE_OS__ = {:?};", std::env::consts::OS))
        .setup(|app, _api| {
            use tauri_plugin_deep_link::DeepLinkExt;
            app.manage(Links::default());
            let dl = app.deep_link();
            let mut urls: Vec<String> = dl.get_current().ok().flatten().unwrap_or_default().into_iter().map(String::from).collect();
            urls.extend(extra_urls(&std::env::args().collect::<Vec<_>>(), &extra_schemes()));
            if let Ok(mut q) = app.state::<Links>().0.lock() {
                q.extend(urls.into_iter().filter(|u| is_our_url(u)));
            }
            let handle = app.clone();
            dl.on_open_url(move |ev| accept_urls(&handle, ev.urls().into_iter().map(String::from).collect()));
            // A .deb/.rpm or the Windows installer registers the scheme; an AppImage has nobody to do it.
            #[cfg(target_os = "linux")]
            if std::env::var_os("APPIMAGE").is_some() || std::env::var("TACHYLITE_REGISTER_SCHEME").is_ok_and(|v| v == "1") {
                if let Err(err) = dl.register(SCHEME) {
                    eprintln!("tachylite: could not register the {SCHEME}:// scheme: {err}");
                }
            }
            Ok(())
        })
        .build()
}

/// Install everything above on the builder. Plugin order matters: single-instance first, then deep-link
/// (whose state the platform plugin's setup uses).
pub fn install<R: Runtime>(mut b: Builder<R>) -> Builder<R> {
    if single_instance_enabled() {
        b = b.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // With the `deep-link` feature the plugin already forwarded a lone `tachylite://` argument to
            // `on_open_url`; other URLs are ours to forward, and a plain second launch brings the window forward.
            accept_urls(app, extra_urls(&args, &extra_schemes()));
            focus_main(app);
        }));
    }
    b = b.plugin(tauri_plugin_deep_link::init()).plugin(platform_plugin());
    if menu_enabled() {
        b = b.menu(build_menu).on_menu_event(on_menu_event);
    }
    b
}

/// (menu item id, label) for the custom items, grouped by submenu. Ids map onto app command ids.
pub const MENU_ITEMS: &[(&str, &[(&str, &str)])] = &[
    (
        "File",
        &[
            ("cmd:file-explorer:new-file", "New Note"),
            ("cmd:workspace:new-tab", "New Tab"),
            ("cmd:app:open-vault-switcher", "Open Vault..."),
            ("-", ""),
            ("cmd:workspace:close", "Close Tab"),
        ],
    ),
    (
        "View",
        &[
            ("cmd:command-palette:open", "Command Palette"),
            ("cmd:app:toggle-left-sidebar", "Toggle Left Sidebar"),
            ("cmd:app:toggle-right-sidebar", "Toggle Right Sidebar"),
            ("cmd:markdown:toggle-preview", "Toggle Reading View"),
            ("-", ""),
            ("cmd:app:reload", "Reload"),
            ("devtools", "Developer Tools"),
        ],
    ),
    ("Help", &[("cmd:app:open-help", "Tachylite Help")]),
];

fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let custom = |title: &str| {
        let mut s = SubmenuBuilder::new(app, title);
        for (id, label) in MENU_ITEMS.iter().find(|(t, _)| *t == title).map_or(&[][..], |(_, items)| items) {
            s = match *id {
                "-" => s.separator(),
                "devtools" if !cfg!(debug_assertions) => s,
                _ => s.text(*id, *label),
            };
        }
        s
    };
    let app_menu = SubmenuBuilder::new(app, "Tachylite")
        .about(None)
        .separator()
        .text("cmd:app:open-settings", "Settings...")
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        // Not the predefined Quit: that would skip the close-requested flush of unsaved notes.
        .item(&tauri::menu::MenuItem::with_id(app, "quit", "Quit Tachylite", true, Some("CmdOrCtrl+Q"))?)
        .build()?;
    // Predefined items so Cmd+C/V/X/A/Z reach the webview on macOS (without them the shortcuts do nothing there).
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().fullscreen().separator().bring_all_to_front().build()?;
    let file = custom("File").build()?;
    let view = custom("View").build()?;
    let help = custom("Help").build()?;
    let mut m = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        m = m.item(&app_menu);
    }
    m.items(&[&file, &edit, &view, &window, &help]).build()
}

/// What a menu click does, by item id.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction<'a> {
    Command(&'a str),
    DevTools,
    Quit,
    None,
}

pub fn menu_action(id: &str) -> MenuAction<'_> {
    if let Some(cmd) = id.strip_prefix(CMD_PREFIX) {
        MenuAction::Command(cmd)
    } else {
        match id {
            "devtools" => MenuAction::DevTools,
            "quit" => MenuAction::Quit,
            _ => MenuAction::None,
        }
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, ev: MenuEvent) {
    let windows = app.webview_windows();
    let target = windows.values().find(|w| w.is_focused().unwrap_or(false)).or_else(|| windows.get("main"));
    match menu_action(ev.id().as_ref()) {
        MenuAction::Command(cmd) => {
            if let Some(w) = target {
                let _ = w.emit_to(w.label(), MENU_EVENT, cmd);
            }
        }
        #[cfg(debug_assertions)]
        MenuAction::DevTools => {
            if let Some(w) = target {
                w.open_devtools();
            }
        }
        // Closing the main window runs the usual flush-then-exit path in main.rs.
        MenuAction::Quit => match windows.get("main") {
            Some(w) => {
                let _ = w.close();
            }
            None => app.exit(0),
        },
        _ => {}
    }
}

// ---------- opening URLs ----------

/// Program and arguments that open `url` in the default handler, per OS. No shell is involved: on Windows
/// `cmd /c start` would interpret `&`, `^` and `%` inside the URL, so `rundll32 url.dll` gets it verbatim.
pub fn opener_command(os: &str, url: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec![url.into()]),
        "windows" => ("rundll32", vec!["url.dll,FileProtocolHandler".into(), url.into()]),
        _ => ("xdg-open", vec![url.into()]),
    }
}

/// Only web and mail links, without whitespace or control characters (they never appear in a valid URL
/// and could split it into several arguments for some openers).
pub fn openable_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) && !url.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// Open an http(s)/mailto link in the system browser.
#[tauri::command]
pub fn open_url(url: String) -> Res<()> {
    if !openable_url(&url) {
        return Err("unsupported url".into());
    }
    let (prog, args) = opener_command(std::env::consts::OS, &url);
    let mut child = std::process::Command::new(prog).args(args).spawn().map_err(|e| e.to_string())?;
    // Reap the opener so it does not linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openers_pass_the_url_as_one_argument() {
        let url = "https://example.com/a?x=1&y=%20#frag";
        assert_eq!(opener_command("macos", url), ("open", vec![url.to_string()]));
        assert_eq!(opener_command("linux", url), ("xdg-open", vec![url.to_string()]));
        assert_eq!(opener_command("windows", url), ("rundll32", vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()]));
    }

    #[test]
    fn only_web_and_mail_urls_open() {
        assert!(openable_url("https://obsidian.md"));
        assert!(openable_url("HTTP://EXAMPLE.COM"));
        assert!(openable_url("mailto:me@example.com"));
        assert!(!openable_url("file:///etc/passwd"));
        assert!(!openable_url("tachylite://open?vault=x"));
        assert!(!openable_url("https://a.com/\nrm -rf"));
        assert!(!openable_url("https://a.com/ b"));
    }

    #[test]
    fn deep_links_are_recognised_by_scheme_only() {
        assert!(is_our_url("tachylite://open?vault=v&file=a"));
        assert!(is_our_url("TACHYLITE://open"));
        assert!(!is_our_url("obsidian://open?vault=v"));
        assert!(!is_our_url("tachylite"));
        assert!(!is_our_url("tachylitex://open"));
    }

    #[test]
    fn command_line_urls_not_taken_by_the_plugin() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let extra = vec!["obsidian".to_string()];
        assert!(extra_urls(&a(&["tachylite", "tachylite://open?file=x"]), &extra).is_empty());
        assert_eq!(extra_urls(&a(&["tachylite", "--vault", "/v", "tachylite://open"]), &[]), a(&["tachylite://open"]));
        assert_eq!(extra_urls(&a(&["tachylite", "obsidian://open?vault=v"]), &extra), a(&["obsidian://open?vault=v"]));
        assert!(extra_urls(&a(&["tachylite", "obsidian://open?vault=v"]), &[]).is_empty());
        assert!(extra_urls(&a(&["tachylite"]), &extra).is_empty());
        assert!(!has_scheme("tachylité://x", "tachylite"));
    }

    #[test]
    fn menu_ids_map_onto_commands() {
        assert_eq!(menu_action("cmd:app:toggle-left-sidebar"), MenuAction::Command("app:toggle-left-sidebar"));
        assert_eq!(menu_action("devtools"), MenuAction::DevTools);
        assert_eq!(menu_action("quit"), MenuAction::Quit);
        assert_eq!(menu_action("other"), MenuAction::None);
        for (_, items) in MENU_ITEMS {
            for (id, label) in *items {
                assert!(*id == "-" || !label.is_empty());
                assert!(matches!(menu_action(id), MenuAction::Command(_) | MenuAction::DevTools) || *id == "-", "{id}");
            }
        }
    }
}
