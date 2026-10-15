// "Editor" settings tab: writes Obsidian-compatible keys into .obsidian/app.json.
import { Setting, SettingTab, type App } from "../../obsidian";
import { commitConfig, heading } from "./util";

export class EditorSettingTab extends SettingTab {
  id = "editor";
  name = "Editor";
  icon = "lucide-pencil";
  constructor(app: App) { super(app); }

  private toggle(name: string, desc: string, key: string): void {
    new Setting(this.containerEl).setName(name).setDesc(desc).addToggle((t) =>
      t.setValue(!!this.app.vault.getConfig(key)).onChange((v) => commitConfig(this.app, key, v)));
  }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const app = this.app;
    heading(el, "Editing");
    new Setting(el).setName("Default editing mode").setDesc("Whether new notes open in the editing view or the reading view.").addDropdown((d) =>
      d.addOptions({ source: "Editing view", preview: "Reading view" }).setValue(app.vault.getConfig("defaultViewMode") === "preview" ? "preview" : "source")
        .onChange((v) => commitConfig(app, "defaultViewMode", v)));
    new Setting(el).setName("Live Preview").setDesc("Render Markdown while editing. When off, the editing view shows the plain source.").addToggle((t) =>
      t.setValue(app.vault.getConfig("livePreview") !== false).onChange((v) => commitConfig(app, "livePreview", v)));
    this.toggle("Readable line length", "Limit the width of lines in notes to make them easier to read.", "readableLineLength");
    this.toggle("Strict line breaks", "Treat single line breaks as hard breaks, as in the editor, instead of joining the lines.", "strictLineBreaks");
    this.toggle("Show inline title", "Show the note title above the content.", "showInlineTitle");
    new Setting(el).setName("Properties in document").setDesc("Choose how properties are displayed at the top of notes. Select \"source\" to show properties as raw YAML.").addDropdown((d) =>
      d.addOptions({ visible: "Visible", hidden: "Hidden", source: "Source" }).setValue(app.vault.getConfig("propertiesInDocument") ?? "visible")
        .onChange((v) => commitConfig(app, "propertiesInDocument", v)));
    this.toggle("Spellcheck", "Underline misspelled words while typing.", "spellcheck");

    heading(el, "Display");
    this.toggle("Show line numbers", "Show line numbers in the gutter of the editor.", "showLineNumber");
    this.toggle("Right-to-left (RTL) direction", "Display text right to left, for languages such as Arabic and Hebrew.", "rightToLeft");
    this.toggle("Fold heading", "Allow folding sections below headings.", "foldHeading");
    this.toggle("Fold indent", "Allow folding nested lists and indented blocks.", "foldIndent");

    heading(el, "Behavior");
    this.toggle("Indent using tabs", "Insert a tab character when pressing Tab instead of spaces.", "useTab");
    new Setting(el).setName("Tab indent size").setDesc("Number of spaces a tab is worth.").addDropdown((d) =>
      d.addOptions({ "2": "2", "4": "4", "8": "8" }).setValue(String(app.vault.getConfig("tabSize") ?? 4))
        .onChange((v) => commitConfig(app, "tabSize", Number(v))));
    this.toggle("Auto pair brackets", "Type the closing bracket or quote automatically.", "autoPairBrackets");
    this.toggle("Auto pair Markdown syntax", "Type the closing mark for emphasis, code and similar syntax automatically.", "autoPairMarkdown");
    this.toggle("Smart indent lists", "Keep the indentation of list items when pressing Enter.", "smartIndentList");
    this.toggle("Vim key bindings", "Use Vim key bindings when editing.", "vimMode");
    new Setting(el).setName("Always focus new tabs").setDesc("When opening a link in a new tab, switch to it right away.").addToggle((t) =>
      t.setValue(app.vault.getConfig("focusNewTab") !== false).onChange((v) => commitConfig(app, "focusNewTab", v)));
  }
}
