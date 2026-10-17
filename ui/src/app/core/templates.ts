// Core plugin "Templates" (templates.json: folder, dateFormat, timeFormat). Behaviour per help.obsidian.md: insert a
// template from the template folder at the cursor, expand {{title}}/{{date}}/{{time}}, merge its properties into the note.
import moment from "moment";
import { FuzzySuggestModal, MarkdownView, Notice, Setting, TFile, TFolder, getFrontMatterInfo, type App, type Editor } from "../../obsidian";
import {
  CoreOptionsTab, DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT, coreOptions, coreRibbon, expandVariables, folderOption, frontmatterBlock, mergeProperties, splitFrontmatter, whileCoreTab,
} from "./options";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";

const ID = "templates";

/** Template variables with the user's Templates date/time formats. */
export function expandTemplate(app: App, text: string, title: string, when?: moment.Moment): string {
  const o = coreOptions(app, ID);
  return expandVariables(text, { title }, { dateFormat: o.dateFormat, timeFormat: o.timeFormat }, when);
}

/** Markdown files under the template folder (recursively, sorted by path); null + notice when the folder is unusable. */
export function templateFiles(app: App, notify = true): TFile[] | null {
  const raw = coreOptions(app, ID).folder;
  const say = (m: string) => { if (notify) new Notice(m); return null; };
  if (typeof raw !== "string" || !raw.trim()) return say("Template folder is not set. Set it in Settings > Templates.");
  const path = folderOption(raw);
  const folder = path ? app.vault.getFolderByPath(path) : null;
  if (!path) return say("The vault root can't be the template folder. Choose a folder in Settings > Templates.");
  if (!folder) return say(`Template folder "${raw}" not found.`);
  const out: TFile[] = [];
  const walk = (f: TFolder) => { for (const c of f.children) { if (c instanceof TFolder) walk(c); else if (c instanceof TFile && c.extension === "md") out.push(c); } };
  walk(folder);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function activeEditor(app: App): { editor: Editor; view: MarkdownView } | null {
  const v = app.workspace.getActiveViewOfType(MarkdownView) ?? (app.workspace.activeEditor instanceof MarkdownView ? app.workspace.activeEditor : null);
  return v?.editor ? { editor: v.editor, view: v } : null;
}

/**
 * Insert `tpl` into the editor: at the very start of the note the expanded text goes in verbatim; elsewhere the body
 * replaces the selection and the template's properties are merged into the note's own.
 */
export async function insertTemplateFile(app: App, tpl: TFile, editor: Editor, file: TFile | null): Promise<void> {
  const text = expandTemplate(app, await app.vault.cachedRead(tpl), file?.basename ?? "");
  const from = editor.getCursor("from");
  if (from.line === 0 && from.ch === 0) { editor.replaceSelection(text); return; }
  let tplParts: ReturnType<typeof splitFrontmatter>;
  try { tplParts = splitFrontmatter(text); } catch { new Notice("The template's properties are not valid YAML."); return; }
  editor.replaceSelection(tplParts.body);
  if (!Object.keys(tplParts.props).length) return;
  const cur = editor.getValue();
  let note: ReturnType<typeof splitFrontmatter>;
  try { note = splitFrontmatter(cur); } catch { new Notice("This note's properties are not valid YAML; the template's properties were not added."); return; }
  const merged = frontmatterBlock(mergeProperties(note.props, tplParts.props));
  const end = note.exists ? getFrontMatterInfo(cur).contentStart : 0;
  editor.replaceRange(merged, editor.offsetToPos(0), editor.offsetToPos(end));
}

class TemplatePickerModal extends FuzzySuggestModal<TFile> {
  constructor(app: App, private files: TFile[], private folder: string, private onPick: (f: TFile) => void) {
    super(app);
    this.emptyStateText = "No templates found.";
    this.setPlaceholder("Type to search templates...");
    this.setInstructions([{ command: "↑↓", purpose: "to navigate" }, { command: "↵", purpose: "to insert" }, { command: "esc", purpose: "to dismiss" }]);
    this.modalEl.addClass("mod-template-picker");
  }
  getItems(): TFile[] { return this.files; }
  getItemText(f: TFile): string { return f.path.replace(/\.md$/i, "").slice(this.folder.length + 1); }
  onChooseItem(f: TFile): void { this.onPick(f); }
}

/** "Insert template": pick a template and insert it into the active editor. */
export function openTemplatePicker(app: App): void {
  const target = activeEditor(app);
  if (!target) { new Notice("Open a note to insert a template."); return; }
  const files = templateFiles(app);
  if (!files) return;
  const folder = folderOption(coreOptions(app, ID).folder);
  new TemplatePickerModal(app, files, folder, (f) => {
    void insertTemplateFile(app, f, target.editor, target.view.file).then(() => target.editor.focus());
  }).open();
}

/** Insert text at the cursor (not replacing the selection) and put the cursor after it. */
function insertAtHead(editor: Editor, text: string): void {
  const head = editor.getCursor("head");
  editor.transaction({ changes: [{ text, from: head }], selection: { from: { line: head.line, ch: head.ch + text.length } } });
}

class TemplatesTab extends CoreOptionsTab {
  constructor(app: App) { super(app, ID, "Templates", "lucide-files"); }
  render(el: HTMLElement): void {
    const o = this.options;
    new Setting(el).setName("Template folder location").setDesc("Files in this folder will be available as templates.").addText((t) =>
      t.setPlaceholder("Example: folder/subfolder").setValue(o.folder ?? "").onChange((v) => { o.folder = v.trim(); void this.save(); }));
    const fmt = (name: string, key: "dateFormat" | "timeFormat", def: string) => {
      const s = new Setting(el).setName(name);
      const sample = createEl("b", { cls: "u-pop" });
      s.descEl.appendText(`Default ${key === "dateFormat" ? "{{date}}" : "{{time}}"} format (Moment.js syntax). Your current syntax looks like this: `);
      s.descEl.appendChild(sample);
      s.addMomentFormat((m) => m.setDefaultFormat(def).setSampleEl(sample).setValue(o[key] ?? "").onChange((v) => { o[key] = v.trim(); void this.save(); }));
    };
    fmt("Date format", "dateFormat", DEFAULT_DATE_FORMAT);
    fmt("Time format", "timeFormat", DEFAULT_TIME_FORMAT);
  }
}

export const templates: CoreModule = {
  id: ID,
  install(app) {
    const tab = new TemplatesTab(app);
    const offTab = whileCoreTab(app, tab);
    const off = whileCoreEnabled(app, ID, () => {
      const o = () => coreOptions(app, ID);
      const offs = [
        coreRibbon(app, ID, "lucide-files", "Insert template", () => openTemplatePicker(app)),
        addCommand(app, { id: "insert-template", name: "Templates: Insert template", icon: "lucide-copy", callback: () => openTemplatePicker(app) }),
        addCommand(app, { id: "insert-current-date", name: "Templates: Insert current date", icon: "lucide-calendar-days", editorCallback: (e) => insertAtHead(e, moment().format(o().dateFormat || DEFAULT_DATE_FORMAT)) }),
        addCommand(app, { id: "insert-current-time", name: "Templates: Insert current time", icon: "lucide-clock", editorCallback: (e) => insertAtHead(e, moment().format(o().timeFormat || DEFAULT_TIME_FORMAT)) }),
      ];
      return () => offs.forEach((f) => f());
    });
    return () => { off(); offTab(); };
  },
};
