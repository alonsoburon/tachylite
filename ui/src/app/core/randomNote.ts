// Core plugin "Random note": open a random Markdown note (another one than the active note when there is a choice).
import { Keymap, Notice, type App } from "../../obsidian";
import { coreRibbon } from "./options";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";

const ID = "random-note";

export async function openRandomNote(app: App, evt?: MouseEvent | KeyboardEvent | null, rand = Math.random): Promise<void> {
  const all = app.vault.getMarkdownFiles();
  if (!all.length) { new Notice("There are no notes in this vault."); return; }
  const active = app.workspace.getActiveFile();
  const pool = all.length > 1 ? all.filter((f) => f !== active) : all;
  const f = pool[Math.floor(rand() * pool.length)];
  const e = evt ?? (app.lastEvent as MouseEvent | KeyboardEvent | null);
  await app.workspace.getLeaf(e ? Keymap.isModEvent(e) : false).openFile(f, { active: true });
}

export const randomNote: CoreModule = {
  id: ID,
  install(app) {
    return whileCoreEnabled(app, ID, () => {
      const offs = [
        coreRibbon(app, ID, "dice", "Open random note", (e) => { void openRandomNote(app, e); }),
        addCommand(app, { id: "random-note", name: "Random note: Open random note", icon: "dice-glyph", callback: () => { void openRandomNote(app, null); } }),
      ];
      return () => offs.forEach((f) => f());
    });
  },
};
