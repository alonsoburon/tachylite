// EditorSuggest + the manager that watches editors and drives registered suggesters.
import { Prec, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Editor, EditorPosition } from "./editor";
import type { TFile } from "./files";
import { PopoverSuggest, type Instruction } from "./ui";
import type { App } from "./app";
import type { MarkdownView } from "./views";

export interface EditorSuggestTriggerInfo { start: EditorPosition; end: EditorPosition; query: string }
export interface EditorSuggestContext extends EditorSuggestTriggerInfo { editor: Editor; file: TFile }

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
  context: EditorSuggestContext | null = null;
  limit = 100;
  instructionsEl: HTMLElement | null = null;
  constructor(app: App) {
    super(app);
    const self = this;
    this.suggestions.owner = {
      renderSuggestion: (v, el) => self.renderSuggestion(v, el),
      selectSuggestion: (v, evt) => { self.selectSuggestion(v, evt); self.close(); },
    };
  }
  setInstructions(instructions: Instruction[]): void {
    this.instructionsEl ??= this.suggestEl.createDiv({ cls: "prompt-instructions" });
    this.instructionsEl.empty();
    for (const i of instructions) {
      const row = this.instructionsEl.createDiv({ cls: "prompt-instruction" });
      row.createSpan({ cls: "prompt-instruction-command", text: i.command });
      row.createSpan({ text: i.purpose });
    }
  }
  close(): void { super.close(); this.context = null; }
  abstract onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null;
  abstract getSuggestions(context: EditorSuggestContext): T[] | Promise<T[]>;
}

export class EditorSuggestManager {
  suggests: EditorSuggest<any>[] = [];
  private current: EditorSuggest<any> | null = null;
  private token = 0;
  constructor(public app: App) {}
  add(s: EditorSuggest<any>): void { this.suggests.push(s); }
  remove(s: EditorSuggest<any>): void {
    this.suggests = this.suggests.filter((x) => x !== s);
    if (this.current === s) { s.close(); this.current = null; }
  }
  get isOpen(): boolean { return !!this.current?.isOpen; }

  /** CodeMirror extension that lets an open suggester consume navigation keys. */
  extension(): Extension {
    return Prec.highest(EditorView.domEventHandlers({
      keydown: (e) => {
        const cur = this.current;
        if (!cur || !cur.isOpen) return false;
        const list = cur.suggestions;
        if (e.key === "ArrowDown") { list.moveSelection(1); e.preventDefault(); return true; }
        if (e.key === "ArrowUp") { list.moveSelection(-1); e.preventDefault(); return true; }
        if (e.key === "Enter" || e.key === "Tab") { if (list.useSelectedItem(e)) { e.preventDefault(); return true; } return false; }
        if (e.key === "Escape") { cur.close(); this.current = null; e.preventDefault(); return true; }
        return false;
      },
    }));
  }

  async update(view: MarkdownView): Promise<void> {
    if (!this.suggests.length) return;
    const editor = view.editor, file = view.file, cursor = editor.getCursor();
    const my = ++this.token;
    const candidates = this.current ? [this.current, ...this.suggests.filter((s) => s !== this.current)] : this.suggests;
    for (const s of candidates) {
      let info: EditorSuggestTriggerInfo | null = null;
      try { info = s.onTrigger(cursor, editor, file); } catch (e) { console.error(e); }
      if (!info) { if (s === this.current) { s.close(); this.current = null; } continue; }
      const ctx: EditorSuggestContext = { ...info, editor, file: file as TFile };
      s.context = ctx;
      let res: any[] = [];
      try { res = await s.getSuggestions(ctx); } catch (e) { console.error(e); }
      if (my !== this.token) return;
      res = (res ?? []).slice(0, s.limit);
      if (!res.length) { if (s === this.current) { s.close(); this.current = null; } continue; }
      if (this.current && this.current !== s) this.current.close();
      this.current = s;
      s.suggestions.setSuggestions(res);
      s.context = ctx;
      if (!s.isOpen) s.open();
      const cm = (editor as any).cm as EditorView | undefined;
      const coords = cm?.coordsAtPos(editor.posToOffset(ctx.start));
      s.suggestEl.style.position = "absolute";
      s.suggestEl.style.left = `${coords?.left ?? 0}px`;
      s.suggestEl.style.top = `${coords?.bottom ?? 0}px`;
      return;
    }
  }
}
