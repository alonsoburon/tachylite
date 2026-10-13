// Core plugin "Daily notes" (daily-notes.json: folder, format, template). Opens or creates the note named after a
// date; "Open daily note on startup" is app.json `openBehavior: "daily"` (older vaults stored `autorun: true` here).
// Community plugins (Calendar, Periodic Notes) read the same `instance.options` object.
import moment from "moment";
import { Keymap, Notice, Setting, TFile, TFolder, type App } from "../../obsidian";
import { CoreOptionsTab, DEFAULT_DATE_FORMAT, coreOptions, coreRibbon, expandVariables, folderOption, resolveTemplateOption, saveOptions, whileCoreTab } from "./options";
import { addCommand, coreEnabled, whileCoreEnabled, type CoreModule } from "./util";

const ID = "daily-notes";

export function dailyNoteFormat(app: App): string {
  const f = coreOptions(app, ID).format;
  return typeof f === "string" && f.trim() ? f.trim() : DEFAULT_DATE_FORMAT;
}

/** The configured folder ("" = none set), and the folder daily notes are searched in (root when none is set). */
function dailyFolder(app: App): { setting: string; folder: TFolder | null } {
  const setting = folderOption(coreOptions(app, ID).folder);
  return { setting, folder: setting ? app.vault.getFolderByPath(setting) : app.vault.getRoot() };
}

/** Vault path of the daily note for `when`, or null when the configured folder does not exist. */
export function dailyNotePath(app: App, when = moment()): string | null {
  const name = when.format(dailyNoteFormat(app)).trim();
  const { setting } = dailyFolder(app);
  let dir: string;
  if (setting) {
    if (!app.vault.getFolderByPath(setting)) return null;
    dir = setting;
  } else {
    const p = app.fileManager.getNewFileParent("");
    dir = p.isRoot() ? "" : p.path;
  }
  return `${dir ? dir + "/" : ""}${name}.md`;
}

/** Find or create the daily note for `when` (expanding the template on creation). */
export async function getDailyNote(app: App, when = moment()): Promise<TFile | null> {
  const path = dailyNotePath(app, when);
  if (!path) { new Notice(`Failed to find the daily notes folder "${coreOptions(app, ID).folder}". Create it or change it in Settings > Daily notes.`); return null; }
  const hit = app.vault.getAbstractFileByPathInsensitive(path);
  if (hit) return hit instanceof TFile ? hit : null;
  let content = "";
  const tplOpt = coreOptions(app, ID).template;
  const tpl = resolveTemplateOption(app, tplOpt, "Daily note template");
  if (tpl === null) return null;
  const title = when.format(dailyNoteFormat(app)).trim(); // the formatted name, subfolders included
  if (tpl) content = expandVariables(await app.vault.cachedRead(tpl), { title });
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  try {
    if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
    return await app.vault.create(path, content);
  } catch (e) { new Notice(String(e)); return null; }
}

export async function openDailyNote(app: App, evt?: MouseEvent | KeyboardEvent | null, when = moment()): Promise<TFile | null> {
  const f = await getDailyNote(app, when);
  if (f) await app.workspace.getLeaf(evt ? Keymap.isModEvent(evt) : false).openFile(f, { active: true });
  return f;
}

/** Timestamp of a daily note (its path below the daily notes folder parsed strictly with the format), else null. */
export function dailyNoteDate(app: App, file: TFile): number | null {
  const { folder } = dailyFolder(app);
  if (!folder || file.extension !== "md") return null;
  const prefix = folder.isRoot() ? "" : folder.path + "/";
  if (prefix && !file.path.startsWith(prefix)) return null;
  const rel = file.path.slice(prefix.length, -(file.extension.length + 1));
  const m = moment(rel, dailyNoteFormat(app), true);
  return m.isValid() ? m.valueOf() : null;
}

/** Every existing daily note with its timestamp. */
export function allDailyNotes(app: App): { file: TFile; time: number }[] {
  const { folder } = dailyFolder(app);
  if (!folder) return [];
  const out: { file: TFile; time: number }[] = [];
  const walk = (f: TFolder) => {
    for (const c of f.children) {
      if (c instanceof TFolder) walk(c);
      else if (c instanceof TFile) { const t = dailyNoteDate(app, c); if (t !== null) out.push({ file: c, time: t }); }
    }
  };
  walk(folder);
  return out;
}

async function gotoAdjacent(app: App, from: number, dir: -1 | 1): Promise<void> {
  let best: { file: TFile; time: number } | null = null;
  for (const n of allDailyNotes(app)) {
    if (dir < 0 ? n.time < from && (!best || n.time > best.time) : n.time > from && (!best || n.time < best.time)) best = n;
  }
  if (!best) { new Notice(dir < 0 ? "No previous daily note." : "No next daily note."); return; }
  await app.workspace.getLeaf(false).openFile(best.file, { active: true });
}

function currentDate(app: App): number | null {
  const f = app.workspace.getActiveFile();
  return f ? dailyNoteDate(app, f) : null;
}

/** Validation message for a date format ("" when fine). */
export function dateFormatProblem(fmt: string): string {
  if (!fmt) return "";
  if (fmt.startsWith("/")) return "The format can't start with a slash.";
  const sample = moment().format(fmt);
  if (/[\\:*?"<>|]/.test(sample.slice(sample.lastIndexOf("/") + 1))) return "The resulting file name contains characters that are not allowed.";
  return moment(sample, fmt, true).isValid() ? "" : "This format can't be read back into a date.";
}

class DailyNotesTab extends CoreOptionsTab {
  constructor(app: App) { super(app, ID, "Daily notes", "lucide-calendar"); }
  render(el: HTMLElement): void {
    const o = this.options;
    const fmt = new Setting(el).setName("Date format");
    const sample = createEl("b", { cls: "u-pop" });
    const problem = createDiv({ cls: "mod-warning" });
    fmt.descEl.appendText("Moment.js syntax; slashes create subfolders. Your current syntax looks like this: ");
    fmt.descEl.appendChild(sample);
    fmt.descEl.appendChild(problem);
    fmt.addMomentFormat((m) => m.setDefaultFormat(DEFAULT_DATE_FORMAT).setSampleEl(sample).setValue(o.format ?? "").onChange((v) => {
      problem.setText(dateFormatProblem(v.trim()));
      o.format = v.trim(); void this.save();
    }));
    problem.setText(dateFormatProblem(String(o.format ?? "")));
    new Setting(el).setName("New file location").setDesc("New daily notes will be placed here.").addText((t) =>
      t.setPlaceholder("Example: folder 1/folder 2").setValue(o.folder ?? "").onChange((v) => { o.folder = v.trim(); void this.save(); }));
    new Setting(el).setName("Template file location").setDesc("Choose the file to use as a template.").addText((t) =>
      t.setPlaceholder("Example: folder/note").setValue(o.template ?? "").onChange((v) => { o.template = v.trim(); void this.save(); }));
    new Setting(el).setName("Open daily note on startup").setDesc("Open your daily note automatically whenever you open this vault.").addToggle((t) =>
      t.setValue(this.app.vault.getConfig("openBehavior") === "daily").onChange((v) => this.app.vault.setConfig("openBehavior", v ? "daily" : "")));
  }
}

export const dailyNotes: CoreModule = {
  id: ID,
  install(app) {
    // Legacy `autorun` moves to app.json's openBehavior (only when the user has not chosen another startup file).
    if (coreOptions(app, ID).autorun) {
      if (!app.vault.getConfig("openBehavior")) app.vault.setConfig("openBehavior", "daily");
      delete coreOptions(app, ID).autorun;
      void saveOptions(app, ID);
    }
    app.workspace.onLayoutReady(() => {
      if (coreEnabled(app, ID) && app.vault.getConfig("openBehavior") === "daily") void openDailyNote(app);
    });
    const offTab = whileCoreTab(app, new DailyNotesTab(app));
    const off = whileCoreEnabled(app, ID, () => {
      const nav = (dir: -1 | 1) => (checking: boolean) => {
        const t = currentDate(app);
        if (t === null) return false;
        if (!checking) void gotoAdjacent(app, t, dir);
        return true;
      };
      const offs = [
        coreRibbon(app, ID, "lucide-calendar", "Open today's daily note", (e) => { void openDailyNote(app, e); }),
        addCommand(app, { id: "daily-notes", name: "Daily notes: Open today's daily note", icon: "lucide-calendar-days", callback: () => { void openDailyNote(app); } }),
        addCommand(app, { id: "daily-notes:goto-prev", name: "Daily notes: Open previous daily note", icon: "lucide-calendar-minus", checkCallback: nav(-1) }),
        addCommand(app, { id: "daily-notes:goto-next", name: "Daily notes: Open next daily note", icon: "lucide-calendar-plus", checkCallback: nav(1) }),
      ];
      return () => offs.forEach((f) => f());
    });
    return () => { off(); offTab(); };
  },
};
