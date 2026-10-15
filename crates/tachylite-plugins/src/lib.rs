//! Community plugin/theme distribution, using the same public sources and layout Obsidian uses:
//!
//! * catalog: `obsidianmd/obsidian-releases` -> `community-plugins.json`, `community-css-themes.json`
//! * plugin files: `https://github.com/<repo>/releases/download/<version>/{manifest.json,main.js,styles.css}`
//! * minimum-version fallback: `<repo>/HEAD/versions.json`
//! * install location: `<vault>/.obsidian/plugins/<id>/`, enabled via `community-plugins.json`

use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tachylite_core::config::{enabled_community_plugins, set_enabled_community_plugins, CONFIG_DIR};
use thiserror::Error;

/// Obsidian API level that Tachylite implements. Plugins whose `minAppVersion` exceeds it are
/// resolved to an older compatible release (via `versions.json`) or refused.
pub const COMPAT_APP_VERSION: &str = "1.14.4";

const RAW: &str = "https://raw.githubusercontent.com/";
const GITHUB: &str = "https://github.com/";
const RELEASES_REPO: &str = "obsidianmd/obsidian-releases";

#[derive(Debug, Error)]
pub enum Error {
    #[error("http {0}: {1}")]
    Http(String, String),
    #[error("plugin `{0}` not in the community catalog")]
    NotInCatalog(String),
    #[error("plugin `{id}` has no release compatible with app version {app}")]
    Incompatible { id: String, app: String },
    #[error("invalid manifest: {0}")]
    Manifest(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

pub trait Http {
    fn get(&self, url: &str) -> Result<Vec<u8>>;
}

pub struct UreqHttp;
impl Http for UreqHttp {
    fn get(&self, url: &str) -> Result<Vec<u8>> {
        let mut resp = ureq::get(url).header("User-Agent", "tachylite").call().map_err(|e| Error::Http(url.into(), e.to_string()))?;
        // Plugin bundles and themes can be several MB; lift ureq's 10 MB default.
        resp.body_mut().with_config().limit(512 * 1024 * 1024).read_to_vec().map_err(|e| Error::Http(url.into(), e.to_string()))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPlugin {
    pub id: String,
    pub name: String,
    pub author: String,
    pub description: String,
    /// `owner/repo`
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTheme {
    pub name: String,
    pub author: String,
    pub repo: String,
    #[serde(default)]
    pub screenshot: String,
    #[serde(default)]
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub min_app_version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub author_url: Option<String>,
    #[serde(default)]
    pub is_desktop_only: bool,
}

fn raw_url(repo: &str, file: &str) -> String {
    format!("{RAW}{repo}/HEAD/{file}")
}
fn release_url(repo: &str, version: &str, file: &str) -> String {
    format!("{GITHUB}{repo}/releases/download/{version}/{file}")
}

pub struct Registry<H: Http = UreqHttp> {
    http: H,
}

impl Default for Registry<UreqHttp> {
    fn default() -> Self {
        Registry { http: UreqHttp }
    }
}

impl<H: Http> Registry<H> {
    pub fn with_http(http: H) -> Self {
        Registry { http }
    }

    pub fn plugins(&self) -> Result<Vec<CatalogPlugin>> {
        Ok(serde_json::from_slice(&self.http.get(&raw_url(RELEASES_REPO, "community-plugins.json"))?)?)
    }

    pub fn themes(&self) -> Result<Vec<CatalogTheme>> {
        Ok(serde_json::from_slice(&self.http.get(&raw_url(RELEASES_REPO, "community-css-themes.json"))?)?)
    }

    /// Plugin id -> deprecated-with-reason entries (`community-plugin-deprecation.json`).
    pub fn deprecations(&self) -> Result<serde_json::Value> {
        Ok(serde_json::from_slice(&self.http.get(&raw_url(RELEASES_REPO, "community-plugin-deprecation.json"))?)?)
    }

    pub fn search(&self, query: &str) -> Result<Vec<CatalogPlugin>> {
        let q = query.to_lowercase();
        Ok(self.plugins()?.into_iter().filter(|p| [&p.id, &p.name, &p.author, &p.description].iter().any(|s| s.to_lowercase().contains(&q))).collect())
    }

    /// Pick the release to install: the manifest at HEAD when compatible, otherwise the newest
    /// version in `versions.json` whose minimum app version is satisfied.
    pub fn resolve_version(&self, repo: &str, head: &Manifest, app_version: &str) -> Result<Option<String>> {
        if head.min_app_version.is_empty() || version_ge(app_version, &head.min_app_version) {
            return Ok(Some(head.version.clone()));
        }
        let Ok(bytes) = self.http.get(&raw_url(repo, "versions.json")) else { return Ok(None) };
        let map: std::collections::BTreeMap<String, String> = serde_json::from_slice(&bytes)?;
        let mut best: Option<String> = None;
        for (ver, min) in map {
            if version_ge(app_version, &min) && best.as_deref().is_none_or(|b| version_ge(&ver, b)) {
                best = Some(ver);
            }
        }
        Ok(best)
    }

    /// Download a community plugin into the vault. Does not enable it.
    pub fn install_plugin(&self, vault: &Path, id: &str) -> Result<Manifest> {
        let entry = self.plugins()?.into_iter().find(|p| p.id == id).ok_or_else(|| Error::NotInCatalog(id.into()))?;
        let head: Manifest = serde_json::from_slice(&self.http.get(&raw_url(&entry.repo, "manifest.json"))?)?;
        let version = self
            .resolve_version(&entry.repo, &head, COMPAT_APP_VERSION)?
            .ok_or_else(|| Error::Incompatible { id: id.into(), app: COMPAT_APP_VERSION.into() })?;
        let manifest_bytes = self.http.get(&release_url(&entry.repo, &version, "manifest.json"))?;
        let manifest: Manifest = serde_json::from_slice(&manifest_bytes)?;
        if manifest.id != id {
            return Err(Error::Manifest(format!("catalog id `{id}` != manifest id `{}`", manifest.id)));
        }
        let main = self.http.get(&release_url(&entry.repo, &version, "main.js"))?;
        // styles.css is optional.
        let styles = self.http.get(&release_url(&entry.repo, &version, "styles.css")).ok();
        let dir = plugin_dir(vault, id);
        fs::create_dir_all(&dir)?;
        fs::write(dir.join("manifest.json"), &manifest_bytes)?;
        fs::write(dir.join("main.js"), main)?;
        if let Some(s) = styles {
            fs::write(dir.join("styles.css"), s)?;
        }
        Ok(manifest)
    }

    /// Install a community theme (`theme.css` + `manifest.json`) into `.obsidian/themes/<name>/`.
    pub fn install_theme(&self, vault: &Path, name: &str) -> Result<()> {
        let entry = self.themes()?.into_iter().find(|t| t.name == name).ok_or_else(|| Error::NotInCatalog(name.into()))?;
        let css = self.http.get(&raw_url(&entry.repo, "theme.css"))?;
        let manifest = self.http.get(&raw_url(&entry.repo, "manifest.json"))?;
        let dir = vault.join(CONFIG_DIR).join("themes").join(name);
        fs::create_dir_all(&dir)?;
        fs::write(dir.join("theme.css"), css)?;
        fs::write(dir.join("manifest.json"), manifest)?;
        Ok(())
    }
}

pub fn plugin_dir(vault: &Path, id: &str) -> PathBuf {
    vault.join(CONFIG_DIR).join("plugins").join(id)
}

/// Plugins present on disk (have a readable `manifest.json`), with their enabled state.
pub fn installed(vault: &Path) -> Vec<(Manifest, bool)> {
    let enabled = enabled_community_plugins(vault);
    let Ok(rd) = fs::read_dir(vault.join(CONFIG_DIR).join("plugins")) else { return vec![] };
    let mut out: Vec<(Manifest, bool)> = rd
        .filter_map(|e| {
            let m: Manifest = serde_json::from_slice(&fs::read(e.ok()?.path().join("manifest.json")).ok()?).ok()?;
            let on = enabled.contains(&m.id);
            Some((m, on))
        })
        .collect();
    out.sort_by(|a, b| a.0.id.cmp(&b.0.id));
    out
}

pub fn set_enabled(vault: &Path, id: &str, on: bool) -> Result<()> {
    let mut ids = enabled_community_plugins(vault);
    ids.retain(|i| i != id);
    if on {
        ids.push(id.to_string());
    }
    Ok(set_enabled_community_plugins(vault, &ids)?)
}

pub fn uninstall(vault: &Path, id: &str) -> Result<()> {
    set_enabled(vault, id, false)?;
    let d = plugin_dir(vault, id);
    if d.exists() {
        fs::remove_dir_all(d)?;
    }
    Ok(())
}

fn parse_ver(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split(['.', '-', '+']).map_while(|p| p.parse().ok()).collect()
}

/// `a >= b` comparing dotted numeric versions.
pub fn version_ge(a: &str, b: &str) -> bool {
    let (a, b) = (parse_ver(a), parse_ver(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Mock(HashMap<String, Vec<u8>>);
    impl Http for Mock {
        fn get(&self, url: &str) -> Result<Vec<u8>> {
            self.0.get(url).cloned().ok_or_else(|| Error::Http(url.into(), "404".into()))
        }
    }

    fn mock() -> Mock {
        let mut m = HashMap::new();
        let put = |m: &mut HashMap<String, Vec<u8>>, k: String, v: &str| {
            m.insert(k, v.as_bytes().to_vec());
        };
        put(&mut m, raw_url(RELEASES_REPO, "community-plugins.json"), r#"[{"id":"demo","name":"Demo","author":"a","description":"d","repo":"a/demo"}]"#);
        put(&mut m, raw_url("a/demo", "manifest.json"), r#"{"id":"demo","name":"Demo","version":"3.0.0","minAppVersion":"99.0.0"}"#);
        put(&mut m, raw_url("a/demo", "versions.json"), r#"{"1.0.0":"0.15.0","2.0.0":"1.4.0","3.0.0":"99.0.0"}"#);
        put(&mut m, release_url("a/demo", "2.0.0", "manifest.json"), r#"{"id":"demo","name":"Demo","version":"2.0.0","minAppVersion":"1.4.0"}"#);
        put(&mut m, release_url("a/demo", "2.0.0", "main.js"), "module.exports={}");
        Mock(m)
    }

    #[test]
    fn falls_back_to_compatible_release_and_installs() {
        let dir = tempfile::tempdir().unwrap();
        let reg = Registry::with_http(mock());
        let m = reg.install_plugin(dir.path(), "demo").unwrap();
        assert_eq!(m.version, "2.0.0");
        assert!(plugin_dir(dir.path(), "demo").join("main.js").exists());
        assert!(!plugin_dir(dir.path(), "demo").join("styles.css").exists());
        set_enabled(dir.path(), "demo", true).unwrap();
        assert!(installed(dir.path())[0].1);
        uninstall(dir.path(), "demo").unwrap();
        assert!(installed(dir.path()).is_empty());
    }

    #[test]
    fn unknown_plugin_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(Registry::with_http(mock()).install_plugin(dir.path(), "nope"), Err(Error::NotInCatalog(_))));
    }

    #[test]
    fn version_order() {
        assert!(version_ge("1.14.4", "1.9.0") && !version_ge("1.2", "1.10") && version_ge("1.0", "1.0.0"));
    }
}
