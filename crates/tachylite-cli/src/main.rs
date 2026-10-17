use std::{env, path::PathBuf, process::ExitCode};
use tachylite_core::{search::search, Workspace};
use tachylite_plugins::{installed, set_enabled, uninstall, Registry};

const USAGE: &str = "tachy <vault> <command>

commands:
  files                         list indexed files
  meta <note>                   print cached metadata (JSON)
  links-json                    resolved and unresolved links of the whole vault, as JSON
  links <note>                  resolved and unresolved links of a note
  backlinks <note>              notes linking to <note>
  resolve <link> <from-note>    resolve a link the way the app does
  tags                          all tags with counts
  search <query>                search the vault
  rename <from> <to>            move a note, updating links
  core-plugins-json             core plugin ids and their enabled state, as JSON
  plugins                       installed community plugins
  plugin-search <query>         search the community catalog
  plugin-install <id>           download a community plugin
  plugin-enable|plugin-disable <id>
  plugin-remove <id>

Without a vault:
  parse-json                    read a note on stdin, print its metadata JSON";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    // `tachy parse-json`: note text on stdin, its metadata-cache JSON on stdout. The UI tests use this to run the real
    // parser instead of a JavaScript imitation of it.
    if args.first().map(String::as_str) == Some("parse-json") {
        use std::io::Read;
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text)?;
        println!("{}", serde_json::to_string(&tachylite_core::parse::parse(&text))?);
        return Ok(());
    }
    let [vault, cmd, rest @ ..] = args else {
        println!("{USAGE}");
        return Ok(());
    };
    let root = PathBuf::from(vault);
    let arg = |i: usize| rest.get(i).map(String::as_str).ok_or("missing argument");
    match cmd.as_str() {
        // The same list the desktop app's `core_plugins` command returns: every core plugin id with whether it is enabled.
        "core-plugins-json" => println!("{}", serde_json::to_string(&tachylite_core::config::core_plugin_state(&root))?),
        "plugins" => {
            for (m, on) in installed(&root) {
                println!("{}\t{}\t{}", if on { "on " } else { "off" }, m.id, m.version);
            }
        }
        "plugin-search" => {
            for p in Registry::default().search(arg(0)?)? {
                println!("{}\t{}\t{}", p.id, p.name, p.repo);
            }
        }
        "plugin-install" => {
            let m = Registry::default().install_plugin(&root, arg(0)?)?;
            println!("installed {} {}", m.id, m.version);
        }
        "plugin-enable" => set_enabled(&root, arg(0)?, true)?,
        "plugin-disable" => set_enabled(&root, arg(0)?, false)?,
        "plugin-remove" => uninstall(&root, arg(0)?)?,
        _ => {
            let mut ws = Workspace::open(&root)?;
            match cmd.as_str() {
                "files" => ws.vault.files().for_each(|f| println!("{}", f.path)),
                "meta" => println!("{}", serde_json::to_string_pretty(&ws.meta.get(arg(0)?))?),
                // The same JSON the desktop app's `meta_links` command returns; the UI tests use it for the whole vault.
                "links-json" => println!("{}", serde_json::json!({ "resolved": ws.meta.resolved_links, "unresolved": ws.meta.unresolved_links })),
                "links" => {
                    let n = arg(0)?;
                    println!("resolved:   {:?}", ws.meta.resolved_links.get(n));
                    println!("unresolved: {:?}", ws.meta.unresolved_links.get(n));
                }
                "backlinks" => ws.meta.backlinks(arg(0)?).iter().for_each(|(p, n)| println!("{n}\t{p}")),
                "resolve" => println!("{:?}", ws.meta.linkpath_dest(arg(0)?, arg(1)?)),
                "tags" => ws.meta.tags().iter().for_each(|(t, n)| println!("{n}\t{t}")),
                "search" => {
                    for h in search(&ws.vault, &ws.meta, arg(0)?) {
                        println!("{}", h.path);
                        h.lines.iter().take(3).for_each(|(n, l)| println!("  {}: {l}", n + 1));
                    }
                }
                "rename" => {
                    let changed = ws.rename(arg(0)?, arg(1)?, true)?;
                    println!("renamed; updated links in {} note(s): {changed:?}", changed.len());
                }
                _ => println!("{USAGE}"),
            }
        }
    }
    Ok(())
}
