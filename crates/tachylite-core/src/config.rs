//! `.obsidian/` configuration files. Unknown keys are preserved on write so a vault
//! stays compatible with other Obsidian-format tools.

use serde_json::{Map, Value};
use std::{fs, io, path::Path};

pub const CONFIG_DIR: &str = ".obsidian";

/// Core plugin ids and their enabled-by-default state (as written to `core-plugins.json`).
pub const CORE_PLUGINS: &[(&str, bool)] = &[
    ("file-explorer", true),
    ("global-search", true),
    ("switcher", true),
    ("graph", true),
    ("backlink", true),
    ("canvas", true),
    ("outgoing-link", true),
    ("tag-pane", true),
    ("properties", false),
    ("page-preview", true),
    ("daily-notes", true),
    ("templates", true),
    ("note-composer", true),
    ("command-palette", true),
    ("slash-command", false),
    ("editor-status", true),
    ("bookmarks", true),
    ("markdown-importer", false),
    ("zk-prefixer", false),
    ("random-note", false),
    ("outline", true),
    ("word-count", true),
    ("slides", false),
    ("audio-recorder", false),
    ("workspaces", false),
    ("file-recovery", true),
    ("publish", false),
    ("sync", false),
    ("bases", true),
    ("webviewer", false),
];

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn write_json(path: &Path, v: &Value) -> io::Result<()> {
    if let Some(d) = path.parent() {
        fs::create_dir_all(d)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string_pretty(v).map_err(io::Error::other)?)?;
    fs::rename(tmp, path)
}

/// A JSON config file under `.obsidian/` with preserved unknown keys.
#[derive(Debug, Clone)]
pub struct ConfigFile {
    path: std::path::PathBuf,
    pub data: Value,
}

impl ConfigFile {
    pub fn load(vault_root: &Path, name: &str, default: Value) -> Self {
        let path = vault_root.join(CONFIG_DIR).join(name);
        let data = read_json(&path).unwrap_or(default);
        ConfigFile { path, data }
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.data.get(key)
    }
    pub fn set(&mut self, key: &str, v: Value) {
        if !self.data.is_object() {
            self.data = Value::Object(Map::new());
        }
        self.data[key] = v;
    }
    pub fn save(&self) -> io::Result<()> {
        write_json(&self.path, &self.data)
    }
}

/// Effective app settings with Obsidian defaults filled in.
#[derive(Debug, Clone)]
pub struct AppConfig {
    pub file: ConfigFile,
}

impl AppConfig {
    pub fn load(root: &Path) -> Self {
        AppConfig { file: ConfigFile::load(root, "app.json", Value::Object(Map::new())) }
    }
    fn bool(&self, k: &str, d: bool) -> bool {
        self.file.get(k).and_then(Value::as_bool).unwrap_or(d)
    }
    fn str(&self, k: &str, d: &str) -> String {
        self.file.get(k).and_then(Value::as_str).unwrap_or(d).to_string()
    }
    /// `shortest` (default), `relative` or `absolute`.
    pub fn new_link_format(&self) -> String {
        self.str("newLinkFormat", "shortest")
    }
    pub fn use_markdown_links(&self) -> bool {
        self.bool("useMarkdownLinks", false)
    }
    pub fn always_update_links(&self) -> bool {
        self.bool("alwaysUpdateLinks", false)
    }
    /// `/` means vault root.
    pub fn new_file_folder_path(&self) -> String {
        self.str("newFileFolderPath", "/")
    }
    pub fn new_file_location(&self) -> String {
        self.str("newFileLocation", "root")
    }
    pub fn attachment_folder_path(&self) -> String {
        self.str("attachmentFolderPath", "/")
    }
    /// `local` (vault `.trash`), `system` (OS trash, default) or `none` (permanent); see `TrashMode`.
    pub fn trash_option(&self) -> String {
        self.str("trashOption", "system")
    }
    pub fn user_ignore_filters(&self) -> Vec<String> {
        self.file
            .get("userIgnoreFilters")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default()
    }
}

/// `core-plugins.json` is an object `{id: bool}` in current vaults (older vaults store an array of enabled ids).
pub fn core_plugin_state(root: &Path) -> Vec<(String, bool)> {
    let saved = read_json(&root.join(CONFIG_DIR).join("core-plugins.json"));
    match saved {
        Some(Value::Object(m)) => CORE_PLUGINS.iter().map(|(id, d)| ((*id).to_string(), m.get(*id).and_then(Value::as_bool).unwrap_or(*d))).collect(),
        Some(Value::Array(a)) => {
            let on: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
            CORE_PLUGINS.iter().map(|(id, _)| ((*id).to_string(), on.contains(id))).collect()
        }
        _ => CORE_PLUGINS.iter().map(|(id, d)| ((*id).to_string(), *d)).collect(),
    }
}

/// Enabled community plugin ids, in file order (`community-plugins.json`).
pub fn enabled_community_plugins(root: &Path) -> Vec<String> {
    match read_json(&root.join(CONFIG_DIR).join("community-plugins.json")) {
        Some(Value::Array(a)) => a.into_iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        _ => vec![],
    }
}

pub fn set_enabled_community_plugins(root: &Path, ids: &[String]) -> io::Result<()> {
    write_json(&root.join(CONFIG_DIR).join("community-plugins.json"), &Value::Array(ids.iter().cloned().map(Value::String).collect()))
}
