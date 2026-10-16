// Core plugin "Unique note creator" (zk-prefixer.json: format, template): one command that creates a note named by a
// timestamp prefix (default YYYYMMDDHHmm), expanded from an optional template, in the default new-note location.
import moment from "moment";
import { Setting, type App, type TFile } from "../../obsidian";
import { newNote } from "../files";
import { CoreOptionsTab, coreOptions, expandVariables, resolveTemplateOption, whileCoreTab } from "./options";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";

const ID = "zk-prefixer";
export const DEFAULT_PREFIX_FORMAT = "YYYYMMDDHHmm";

/** Name of the next unique note (no extension), from the configured prefix format. */
export function uniqueNoteName(app: App, when = moment()): string {
  const fmt = String(coreOptions(app, ID).format ?? "").trim() || DEFAULT_PREFIX_FORMAT;
  // File names cannot contain path separators or the characters the vault rejects, whatever the format produces.
  return when.format(fmt).replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || when.format(DEFAULT_PREFIX_FORMAT);
}

export async function createUniqueNote(app: App, when = moment()): Promise<TFile | null> {
  const name = uniqueNoteName(app, when);
  const tpl = resolveTemplateOption(app, coreOptions(app, ID).template, "Unique note template");
  if (tpl === null) return null; // a template is configured but missing; the notice says so
  const content = tpl ? expandVariables(await app.vault.cachedRead(tpl), { title: name }, {}, when) : "";
  const leaf = app.workspace.activeLeaf;
  return newNote(app, { name, content, open: leaf && leaf.view.getViewType() === "empty" ? true : "tab", rename: false });
}

class UniqueNoteTab extends CoreOptionsTab {
  constructor(app: App) { super(app, ID, "Unique note creator", "lucide-folder-plus"); }
  render(el: HTMLElement): void {
    const o = this.options;
    const fmt = new Setting(el).setName("Unique note prefix format");
    const sample = createEl("b", { cls: "u-pop" });
    fmt.descEl.appendText("Moment.js syntax. Your current syntax looks like this: ");
    fmt.descEl.appendChild(sample);
    fmt.addMomentFormat((m) => m.setDefaultFormat(DEFAULT_PREFIX_FORMAT).setSampleEl(sample).setValue(o.format ?? "").onChange((v) => { o.format = v.trim(); void this.save(); }));
    new Setting(el).setName("Template file location").setDesc("Choose the file to use as a template for new unique notes.").addText((t) =>
      t.setPlaceholder("Example: folder/note").setValue(o.template ?? "").onChange((v) => { o.template = v.trim(); void this.save(); }));
  }
}

export const uniqueNote: CoreModule = {
  id: ID,
  install(app) {
    const offTab = whileCoreTab(app, new UniqueNoteTab(app));
    const off = whileCoreEnabled(app, ID, () => addCommand(app, {
      id: ID, name: "Unique note creator: Create new unique note", icon: "lucide-folder-plus", callback: () => { void createUniqueNote(app); },
    }));
    return () => { off(); offTab(); };
  },
};
