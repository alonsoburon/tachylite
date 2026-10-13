// Daily notes, templates and random note (the "core plugins" whose behaviour lives outside the panels).
import moment from "moment";
import { FuzzySuggestModal, MarkdownView, Notice, TFile, type App, type Editor } from "../obsidian";
import { joinPath, newNote } from "./files";

function opts(app: App, id: string): Record<string, any> {
  return app.internalPlugins.getPluginById(id)?.instance.options ?? {};
}

/** Expand {{title}}, {{date}}, {{time}} (with optional :FORMAT) like the core Templates plugin. */
export function expandTemplate(app: App, text: string, title: string, when = moment()): string {
  const t = opts(app, "templates");
  const dateFmt = t.dateFormat || "YYYY-MM-DD", timeFmt = t.timeFormat || "HH:mm";
  return text
    .replace(/\{\{\s*title\s*\}\}/g, title)
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_m, f?: string) => when.format((f ?? dateFmt).trim()))
    .replace(/\{\{\s*time(?::([^}]+))?\s*\}\}/g, (_m, f?: string) => when.format((f ?? timeFmt).trim()));
}

export function dailyNotePath(app: App, when = moment()): string {
  const o = opts(app, "daily-notes");
  const fmt: string = o.format || "YYYY-MM-DD";
  const folder: string = (o.folder ?? "").replace(/^\/+|\/+$/g, "");
  return `${folder ? folder + "/" : ""}${when.format(fmt)}.md`;
}

export async function openDailyNote(app: App, when = moment()): Promise<TFile> {
  const path = dailyNotePath(app, when);
  let file = app.vault.getFileByPath(path);
  if (!file) {
    const o = opts(app, "daily-notes");
    let content = "";
    if (o.template) {
      const tp = String(o.template).replace(/\.md$/, "") + ".md";
      const tf = app.vault.getFileByPath(tp) ?? app.metadataCache.getFirstLinkpathDest(String(o.template), "");
      if (tf) content = expandTemplate(app, await app.vault.read(tf), when.format(o.format || "YYYY-MM-DD"), when);
      else new Notice(`Daily note template "${o.template}" not found.`);
    }
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !app.vault.getFolderByPath(dir)) await app.vault.createFolder(dir);
    file = await app.vault.create(path, content);
  }
  await app.workspace.getLeaf(false).openFile(file, { active: true });
  return file;
}

class TemplateModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private files: TFile[], private onPick: (f: TFile) => void) { super(app); this.setPlaceholder("Select a template..."); }
  getItems(): TFile[] { return this.files; }
  getItemText(f: TFile): string { return f.basename; }
  onChooseItem(f: TFile): void { this.onPick(f); }
}

export function templateFiles(app: App): TFile[] {
  const folder = String(opts(app, "templates").folder ?? "").replace(/^\/+|\/+$/g, "");
  const all = app.vault.getMarkdownFiles();
  return folder ? all.filter((f) => f.path.startsWith(folder + "/")) : all;
}

export function insertTemplate(app: App, editor: Editor, view: MarkdownView): void {
  const files = templateFiles(app);
  if (!files.length) { new Notice("No templates found. Set the template folder in Settings > Core plugins > Templates."); return; }
  new TemplateModal(app, files, async (f) => {
    const text = expandTemplate(app, await app.vault.read(f), view.file?.basename ?? "");
    editor.replaceSelection(text);
    editor.focus();
  }).open();
}

export async function openRandomNote(app: App): Promise<void> {
  const active = app.workspace.getActiveFile();
  const pool = app.vault.getMarkdownFiles().filter((f) => f !== active);
  if (!pool.length) { new Notice("No other notes to open."); return; }
  const f = pool[Math.floor(Math.random() * pool.length)];
  await app.workspace.getLeaf(false).openFile(f, { active: true });
}

export { joinPath, newNote };
