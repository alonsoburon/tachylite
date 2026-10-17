// Compares Tachylite with a dump from a real Obsidian: commands and default hotkeys, core plugins, config defaults and
// menus. The metadata-cache half is a Rust test (crates/tachylite-core/tests/reference.rs).
// Skipped unless compat/obsidian-reference.json exists; see tools/obsidian-dump/README.md for how to produce it.
// Prints the report and writes compat/reference-report.txt. Set TACHYLITE_STRICT_REFERENCE=1 to fail on any difference.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { diffCommands, diffConfig, diffCorePlugins, diffMenus, formatReport, type Reference, type RefCommand } from "./helpers/reference";
import { buildFileMenu } from "../src/app/files";
import { prettyHotkey } from "../src/obsidian/events";
import { DEFAULT_CONFIG } from "../src/obsidian/vault";

const REF = path.join(__dirname, "../../compat/obsidian-reference.json");
const REPORT = path.join(__dirname, "../../compat/reference-report.txt");
const present = fs.existsSync(REF);

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "# Heading\n#tag text\n", "Folder/Other.md": "x\n" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

/** Titles (and "---" for separators) of the menu that is currently open, then close it. */
function readOpenMenu(): string[] | null {
  const menus = [...document.querySelectorAll(".menu")];
  const menu = menus[menus.length - 1];
  if (!menu) return null;
  const out = [...menu.querySelectorAll(".menu-item, .menu-separator")].map((e) => (e.classList.contains("menu-separator") ? "---" : e.querySelector(".menu-item-title")?.textContent ?? ""));
  document.querySelectorAll(".menu").forEach((m) => m.remove());
  return out;
}
const capture = (open: () => void) => { document.querySelectorAll(".menu").forEach((m) => m.remove()); try { open(); } catch { return null; } return readOpenMenu(); };

describe.skipIf(!present)("Tachylite against the Obsidian reference dump", () => {
  it("lists every difference", async () => {
    const ref = JSON.parse(fs.readFileSync(REF, "utf8")) as Reference;
    session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
    const app = session.app as any;
    await app.workspace.openLinkText("Note", "", false);
    const view = app.workspace.activeLeaf.view;
    await vi.waitFor(() => expect(view.file?.basename).toBe("Note"));

    const hm = app.hotkeyManager;
    const ours: RefCommand[] = app.commands.listCommands().map((c: any) => ({ id: c.id, name: c.name, hotkeys: (hm.getDefaultHotkeys(c.id) ?? []).map((h: any) => ({ modifiers: [...h.modifiers], key: h.key })) }));
    const corePlugins = Object.values(app.internalPlugins.plugins).map((p: any) => ({ id: p.id, name: p.name }));

    const file = app.vault.getFileByPath("Note.md");
    const pos = { x: 80, y: 80 };
    const menus: Record<string, string[] | null> = {
      fileMenu: capture(() => buildFileMenu(app, file, "file-explorer").showAtPosition(pos)),
      folderMenu: capture(() => buildFileMenu(app, app.vault.getFolderByPath("Folder"), "file-explorer").showAtPosition(pos)),
      tabHeaderMenu: capture(() => (session as any).shell.tabMenu(app.workspace.activeLeaf, new MouseEvent("contextmenu"))),
      moreOptionsMenu: capture(() => view.showMoreMenu(new MouseEvent("click"))),
      editorMenu: capture(() => view.editor.cm.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))),
      ribbonMenu: capture(() => app.workspace.leftRibbon.showMenu(new MouseEvent("contextmenu"))),
    };

    const report = formatReport([
      [`Commands and default hotkeys (Obsidian API ${ref.apiVersion ?? "?"})`, diffCommands(ref.commands ?? [], ours)],
      ["Core plugins", diffCorePlugins(ref.corePlugins ?? [], corePlugins)],
      ["Config defaults", diffConfig(ref.config ?? {}, (k) => app.vault.getConfig(k), Object.keys(DEFAULT_CONFIG))],
      ["Menus", diffMenus(ref.menus ?? {}, menus)],
    ]);
    fs.writeFileSync(REPORT, report + "\n");
    console.log("\n" + report + `\n\n(written to compat/reference-report.txt; hotkeys shown like ${prettyHotkey({ modifiers: ["Mod"], key: "p" })})`);
    if (process.env.TACHYLITE_STRICT_REFERENCE === "1") expect(report).toMatch(/^0 differences in total$/m);
  });
});
