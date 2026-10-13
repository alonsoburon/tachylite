// "Files & links" settings tab.
import { Setting, SettingTab, type App } from "../../obsidian";
import { commitConfig, heading } from "./util";

type AttachMode = "root" | "folder" | "same" | "subfolder";

export function parseAttachment(v: string | undefined): { mode: AttachMode; text: string } {
  const s = v ?? "/";
  if (s === "/" || s === "") return { mode: "root", text: "" };
  if (s === "./") return { mode: "same", text: "" };
  if (s.startsWith("./")) return { mode: "subfolder", text: s.slice(2) };
  return { mode: "folder", text: s };
}
export function serializeAttachment(mode: AttachMode, text: string): string {
  switch (mode) {
    case "root": return "/";
    case "same": return "./";
    case "subfolder": return "./" + text.replace(/^\/+/, "");
    default: return text.trim().replace(/^\/+|\/+$/g, "") || "/";
  }
}

export class FilesSettingTab extends SettingTab {
  id = "file";
  name = "Files and links";
  icon = "lucide-file";
  constructor(app: App) { super(app); }

  private toggle(name: string, desc: string, key: string, invert = false): void {
    new Setting(this.containerEl).setName(name).setDesc(desc).addToggle((t) =>
      t.setValue(invert ? !this.app.vault.getConfig(key) : !!this.app.vault.getConfig(key)).onChange((v) => commitConfig(this.app, key, invert ? !v : v)));
  }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const app = this.app;
    const cfg = (k: string) => app.vault.getConfig(k);

    heading(el, "Links");
    new Setting(el).setName("New link format").setDesc("What kind of path internal links use when they are created.").addDropdown((d) =>
      d.addOptions({ shortest: "Shortest path when possible", relative: "Relative path from note", absolute: "Absolute path in vault" })
        .setValue(cfg("newLinkFormat") ?? "shortest").onChange((v) => commitConfig(app, "newLinkFormat", v)));
    this.toggle("Use [[Wikilinks]]", "Create links in the [[Wikilink]] format. When off, links are standard Markdown links.", "useMarkdownLinks", true);
    this.toggle("Automatically update internal links", "Update links in other notes when a file is renamed or moved.", "alwaysUpdateLinks");

    heading(el, "Files");
    const nf = new Setting(el).setName("Default location for new notes").setDesc("Where new notes are created.");
    let folderText!: Setting;
    nf.addDropdown((d) => d.addOptions({ root: "Vault folder", current: "Same folder as current file", folder: "In the folder specified below" })
      .setValue(cfg("newFileLocation") ?? "root").onChange((v) => { commitConfig(app, "newFileLocation", v); folderText.setVisibility(v === "folder"); }));
    folderText = new Setting(el).setName("Folder for new notes").setDesc("Notes are created here when the location above is set to a folder.").addText((t) =>
      t.setPlaceholder("Example: folder1/folder2").setValue(cfg("newFileFolderPath") ?? "").onChange((v) => commitConfig(app, "newFileFolderPath", v.trim())));
    folderText.setVisibility(cfg("newFileLocation") === "folder");

    const att = parseAttachment(cfg("attachmentFolderPath"));
    let attText!: Setting;
    const writeAttach = () => commitConfig(app, "attachmentFolderPath", serializeAttachment(att.mode, att.text));
    new Setting(el).setName("Default location for new attachments").setDesc("Where pasted or dropped attachments are stored.").addDropdown((d) =>
      d.addOptions({ root: "Vault folder", folder: "In the folder specified below", same: "Same folder as current file", subfolder: "In subfolder under current folder" })
        .setValue(att.mode).onChange((v) => { att.mode = v as AttachMode; attText.setVisibility(att.mode === "folder" || att.mode === "subfolder"); writeAttach(); }));
    attText = new Setting(el).setName("Attachment folder path").setDesc("Folder (or subfolder name) used by the location above.").addText((t) =>
      t.setPlaceholder("Example: attachments").setValue(att.text).onChange((v) => { att.text = v; writeAttach(); }));
    attText.setVisibility(att.mode === "folder" || att.mode === "subfolder");

    new Setting(el).setName("Deleted files").setDesc("What happens to files you delete.").addDropdown((d) =>
      d.addOptions({ system: "Move to system trash", local: "Move to Obsidian trash (.trash folder)", none: "Permanently delete" })
        .setValue(cfg("trashOption") ?? "system").onChange((v) => commitConfig(app, "trashOption", v)));
    this.toggle("Confirm file deletion", "Ask for confirmation before deleting a file.", "promptDelete");
    this.toggle("Detect all file extensions", "Show files with unsupported extensions in the file list and quick switcher.", "showUnsupportedFiles");
    new Setting(el).setName("Excluded files").setDesc("Files matching these patterns are hidden from search and links. One pattern per line.").addTextArea((t) => {
      t.setValue(((cfg("userIgnoreFilters") as string[] | undefined) ?? []).join("\n")).setPlaceholder("Example: private/\n\\.tmp$");
      t.onChange((v) => {
        commitConfig(app, "userIgnoreFilters", v.split("\n").map((x) => x.trim()).filter(Boolean));
        (app.vault as any).scheduleSync?.();
      });
    });
    new Setting(el).setDesc("Changes to excluded files may need a vault reload to take full effect.").setClass("setting-item-note");
  }
}
