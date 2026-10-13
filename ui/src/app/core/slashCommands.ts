// Core plugin "Slash commands": typing "/" at the start of a line or after whitespace opens a fuzzy list of the
// commands that can run now; Enter removes the "/query" text and runs the chosen command. A space ends the query.
import {
  EditorSuggest, prepareFuzzySearch, renderResults, sortSearchResults, type App, type Command, type Editor, type EditorPosition,
  type EditorSuggestContext, type EditorSuggestTriggerInfo, type SearchResult, type TFile,
} from "../../obsidian";
import { prettyHotkey } from "../settings/hotkeys";
import { whileCoreEnabled, type CoreModule } from "./util";

const ID = "slash-command";
const TRIGGER = /(^|\s)\/([^\s/]*)$/;

interface Item { item: Command; match: SearchResult }

export class SlashCommandSuggest extends EditorSuggest<Item> {
  constructor(app: App) {
    super(app);
    this.suggestEl.addClass("mod-slash-command");
  }
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) return null;
    const m = TRIGGER.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
    if (!m) return null;
    return { start: { line: cursor.line, ch: m.index + m[1].length }, end: cursor, query: m[2] };
  }
  getSuggestions(ctx: EditorSuggestContext): Item[] {
    const search = prepareFuzzySearch(ctx.query);
    const out: Item[] = [];
    for (const c of this.app.commands.listCommands()) {
      if (!this.app.commands.canExecute(c)) continue;
      const match = search(c.name);
      if (match) out.push({ item: c, match });
    }
    if (ctx.query) sortSearchResults(out);
    else out.sort((a, b) => a.item.name.localeCompare(b.item.name));
    return out;
  }
  renderSuggestion(v: Item, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createSpan({ cls: "suggestion-content" });
    const aux = el.createSpan({ cls: "suggestion-aux" });
    const title = content.createDiv({ cls: "suggestion-title" });
    const name = v.item.name, i = name.indexOf(": ");
    if (i >= 0) {
      renderResults(title.createSpan({ cls: "suggestion-prefix" }), name.slice(0, i), v.match);
      renderResults(title.createSpan(), name.slice(i + 2), v.match, i + 2); // our renderMatches subtracts the offset
    } else renderResults(title.createSpan(), name, v.match);
    for (const h of this.app.hotkeyManager.getHotkeys(v.item.id)) aux.createEl("kbd", { cls: "suggestion-hotkey", text: prettyHotkey(h) });
  }
  selectSuggestion(v: Item, evt: MouseEvent | KeyboardEvent): void {
    const ctx = this.context;
    this.close();
    if (!ctx) return;
    this.app.lastEvent = evt as any;
    ctx.editor.replaceRange("", ctx.start, ctx.end);
    this.app.commands.executeCommand(v.item);
  }
}

export const slashCommands: CoreModule = {
  id: ID,
  install(app) {
    return whileCoreEnabled(app, ID, () => {
      const s = new SlashCommandSuggest(app);
      const m = app.workspace.editorSuggestManager!;
      m.add(s);
      return () => m.remove(s);
    });
  },
};
