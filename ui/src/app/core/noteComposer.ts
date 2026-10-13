// Core plugin "Note composer" (note-composer.json: template, replacementText, askBeforeMerging). Per help.obsidian.md:
// merge a note into another (Enter appends, Shift+Enter prepends, Mod+Enter creates a new note; the source is deleted
// and links to it now point at the destination), and extract a selection or a heading's section into another note,
// leaving a link, an embed or nothing behind. The template sees {{content}}, {{fromTitle}}, {{newTitle}}, {{date}}.
import {
  ConfirmationModal, Menu, Notice, Setting, SuggestModal, TAbstractFile, TFile,
  parseLinktext, prepareFuzzySearch, renderResults, resolveSubpath, sortSearchResults,
  type App, type CachedMetadata, type Editor, type SearchResult,
} from "../../obsidian";
import { CoreOptionsTab, coreOptions, expandVariables, frontmatterBlock, mergeProperties, resolveTemplateOption, saveOptions, splitFrontmatter, whileCoreTab } from "./options";
import { addCommand, whileCoreEnabled, type CoreModule } from "./util";

const ID = "note-composer";
type Where = "append" | "prepend";
interface Edit { start: number; end: number; text: string }

const opts = (app: App) => coreOptions(app, ID);

/** Apply non-overlapping edits (offsets into `text`). */
export function applyEdits(text: string, edits: Edit[]): string {
  for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

/** Wrap content in the composer template; a template without {{content}} gets it appended after a blank line. */
export async function applyComposerTemplate(app: App, content: string, fromTitle: string, newTitle: string): Promise<string> {
  const tf = resolveTemplateOption(app, opts(app).template, "Note composer template");
  if (!tf) return content;
  let tpl = await app.vault.cachedRead(tf);
  if (!tpl) return content;
  if (!tpl.includes("{{content}}")) tpl += "\n\n{{content}}";
  return expandVariables(tpl, { fromTitle, newTitle, content });
}

/** Join `text` into `existing` (append or prepend) with a blank line between, merging both property blocks. */
export function joinNoteText(existing: string, text: string, where: Where): string {
  let a: ReturnType<typeof splitFrontmatter>, b: ReturnType<typeof splitFrontmatter>;
  try { a = splitFrontmatter(existing); } catch { a = { props: {}, body: existing, exists: false }; new Notice("Invalid properties were kept as text."); }
  try { b = splitFrontmatter(text); } catch { b = { props: {}, body: text, exists: false }; new Notice("Invalid properties were kept as text."); }
  const [first, second] = where === "prepend" ? [b.body, a.body] : [a.body, b.body];
  let body: string;
  if (first && second && !(first.slice(-2) + second.slice(0, 2)).includes("\n\n")) body = first.endsWith("\n") || second.startsWith("\n") ? `${first}\n${second}` : `${first}\n\n${second}`;
  else body = first + second;
  return frontmatterBlock(mergeProperties(a.props, b.props)) + body;
}

/** Re-target one cached link to `linktext` (path + subpath), keeping its style, embed flag and display text. */
export function relink(ref: { original: string }, linktext: string): string {
  const o = ref.original;
  const wiki = /^(!?)\[\[([^\]|]*)(\|[\s\S]*)?\]\]$/.exec(o);
  if (wiki) return `${wiki[1]}[[${linktext}${wiki[3] ?? ""}]]`;
  const md = /^(!?)\[([\s\S]*?)\]\(\s*(<[^>]*>|[^\s)]*)([^)]*)\)$/.exec(o);
  if (md) {
    const angled = md[3].startsWith("<");
    const target = angled ? `<${linktext}>` : linktext.split("/").map((s) => encodeURI(s).replace(/#/g, "%23")).join("/").replace(/%23(?=[^/]*$)/, "#");
    return `${md[1]}[${md[2]}](${target}${md[4]})`;
  }
  return o;
}

/** Wikilinks omit ".md"; Markdown links keep it. */
const omitMd = (ref: { original: string }) => /^!?\[\[/.test(ref.original);
const refsOf = (c: CachedMetadata | null) => [...(c?.links ?? []), ...(c?.embeds ?? [])];

/** Save open, modified editors of `files` (and wait for their metadata) so disk reads and offsets match the editor. */
async function flushEditors(app: App, files: TFile[]): Promise<void> {
  for (const l of app.workspace.getLeavesOfType("markdown")) {
    const v = l.view as unknown as { file: TFile | null; save?: () => Promise<void>; dirty?: boolean };
    if (!v.file || !files.includes(v.file) || !v.dirty) continue;
    const file = v.file;
    const indexed = new Promise<void>((res) => {
      const ref = app.metadataCache.on("changed", (f: TFile) => { if (f === file) { app.metadataCache.offref(ref); res(); } });
      setTimeout(() => { app.metadataCache.offref(ref); res(); }, 1500);
    });
    await v.save?.();
    await indexed;
  }
}

/** Edits in other notes: links resolving to `from` (optionally only those whose subpath lands in [start, end]) now go to `to`. */
function backlinkEdits(app: App, from: TFile, to: TFile, range?: { start: number; end: number; cache: CachedMetadata }): Map<string, Edit[]> {
  const mc = app.metadataCache, out = new Map<string, Edit[]>();
  for (const [src, targets] of Object.entries(mc.resolvedLinks)) {
    if (src === from.path || !targets[from.path]) continue;
    const f = app.vault.getFileByPath(src);
    if (!f) continue;
    const edits: Edit[] = [];
    for (const r of refsOf(mc.getFileCache(f))) {
      const { path, subpath } = parseLinktext(r.link);
      if (!path || mc.getFirstLinkpathDest(path, src) !== from) continue;
      if (range) {
        const hit = subpath ? resolveSubpath(range.cache, subpath) : null;
        if (!hit || hit.start.offset < range.start || hit.start.offset > range.end) continue;
      }
      const text = relink(r, mc.fileToLinktext(to, src, omitMd(r)) + subpath);
      if (text !== r.original) edits.push({ start: r.position.start.offset, end: r.position.end.offset, text });
    }
    if (edits.length) out.set(src, edits);
  }
  return out;
}

async function applyFileEdits(app: App, edits: Map<string, Edit[]>): Promise<void> {
  for (const [p, list] of edits) {
    const f = app.vault.getFileByPath(p);
    if (f) await app.vault.process(f, (d) => applyEdits(d, list));
  }
}

export async function insertIntoFile(app: App, file: TFile, text: string, where: Where = "append"): Promise<void> {
  await app.vault.process(file, (d) => joinNoteText(d, text, where));
}

/** Merge `from` into `into`, delete `from` and point the links to it at `into`. */
export async function mergeFile(app: App, into: TFile, from: TFile, where: Where = "append"): Promise<void> {
  await flushEditors(app, [into, from]);
  const text = await applyComposerTemplate(app, await app.vault.read(from), from.basename, into.basename);
  const edits = backlinkEdits(app, from, into);
  await insertIntoFile(app, into, text, where);
  await applyFileEdits(app, edits);
  await app.fileManager.trashFile(from);
}

/**
 * Move [start, end) of `from` into `to`. Links inside the moved text are rewritten so they still resolve from the
 * destination; links (here and in other notes) to headings/blocks inside the range now point at `to`.
 */
export async function extractSection(app: App, from: TFile, to: TFile, start: number, end: number, where: Where = "append"): Promise<void> {
  await flushEditors(app, [from, to]);
  const mc = app.metadataCache;
  const original = await app.vault.read(from);
  const cache = mc.getFileCache(from);
  let moved = original.slice(start, end);
  const sourceEdits: Edit[] = [];
  if (cache) {
    const inner: Edit[] = [];
    for (const r of refsOf(cache)) {
      const s = r.position.start.offset, e = r.position.end.offset;
      const { path, subpath } = parseLinktext(r.link);
      const target = path ? mc.getFirstLinkpathDest(path, from.path) : from;
      if (s >= start && e <= end) {
        if (!target) continue;
        let lt: string;
        if (target !== from) lt = mc.fileToLinktext(target, to.path, omitMd(r)) + subpath;
        else {
          if (!subpath) continue;
          const hit = resolveSubpath(cache, subpath);
          if (!hit) continue;
          lt = hit.start.offset >= start && hit.start.offset <= end ? subpath : mc.fileToLinktext(from, to.path, omitMd(r)) + subpath;
        }
        if (lt !== r.link) inner.push({ start: s - start, end: e - start, text: relink(r, lt) });
      } else if (target === from && subpath) {
        const hit = resolveSubpath(cache, subpath);
        if (hit && hit.start.offset >= start && hit.start.offset <= end) sourceEdits.push({ start: s, end: e, text: relink(r, mc.fileToLinktext(to, from.path, omitMd(r)) + subpath) });
      }
    }
    moved = applyEdits(moved, inner);
  }
  const text = await applyComposerTemplate(app, moved, from.basename, to.basename);
  const mode = opts(app).replacementText;
  const link = app.fileManager.generateMarkdownLink(to, from.path);
  const replacement = mode === "none" ? "" : mode === "embed" ? (link.startsWith("!") ? link : "!" + link) : link;
  const others = cache ? backlinkEdits(app, from, to, { start, end, cache }) : new Map<string, Edit[]>();
  await insertIntoFile(app, to, text, where);
  await app.vault.process(from, (d) => (d !== original ? d : applyEdits(d, [{ start, end, text: replacement }, ...sourceEdits])));
  await applyFileEdits(app, others);
}

/** Section of the heading on `line`: from the heading to the next heading of the same or a higher level. */
export function headingRange(cache: CachedMetadata | null, line: number, text: string): { heading: string; start: number; end: number } | null {
  const hs = cache?.headings ?? [];
  const i = hs.findIndex((h) => h.position.start.line === line);
  if (i < 0) return null;
  const h = hs[i];
  const next = hs.slice(i + 1).find((x) => x.level <= h.level);
  let end = next ? next.position.start.offset : text.length;
  if (text.charAt(end - 1) === "\n") end--;
  return { heading: h.heading.trim(), start: h.position.start.offset, end };
}

/** Create a note for typed link text next to `sourcePath` (per "Default location for new notes"). */
async function createFromLinktext(app: App, linktext: string, sourcePath: string): Promise<TFile> {
  const name = parseLinktext(linktext.trim()).path.replace(/\.md$/i, "").replace(/[\\:*?"<>|]/g, " ").trim() || "Untitled";
  let dir: string;
  if (name.includes("/")) dir = "";
  else { const p = app.fileManager.getNewFileParent(sourcePath, name); dir = p.isRoot() ? "" : p.path; }
  const base = (dir ? dir + "/" : "") + name;
  let path = `${base}.md`;
  for (let n = 1; app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder && !app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
  return app.vault.create(path, "");
}

type Choice = { kind: "file"; file: TFile; match: SearchResult } | { kind: "new"; name: string };

/** File picker shared by merge and extract: Enter = append, Shift+Enter = prepend, Mod+Enter = new note named after the query. */
abstract class ComposerModal extends SuggestModal<Choice> {
  constructor(app: App, protected current: TFile, placeholder: string, enterPurpose: string, shiftPurpose: string) {
    super(app);
    this.modalEl.addClass("mod-note-composer");
    this.emptyStateText = "No files found.";
    this.setPlaceholder(placeholder);
    const mod = navigator.platform.toLowerCase().includes("mac") ? "cmd ↵" : "ctrl ↵";
    this.setInstructions([
      { command: "↑↓", purpose: "to navigate" }, { command: "↵", purpose: enterPurpose },
      { command: mod, purpose: "to create new file" }, { command: "shift ↵", purpose: shiftPurpose }, { command: "esc", purpose: "to dismiss" },
    ]);
    this.scope.register(["Shift"], "Enter", (e) => { this.selectActiveSuggestion(e); return false; });
    this.scope.register(["Mod"], "Enter", (e) => { this.close(); void this.choose({ kind: "new", name: this.inputEl.value }, e); return false; });
  }
  getSuggestions(query: string): Choice[] {
    const search = prepareFuzzySearch(query);
    const out: (Choice & { kind: "file" })[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f === this.current) continue;
      const m = search(f.path.replace(/\.md$/, ""));
      if (m) out.push({ kind: "file", file: f, match: m });
    }
    if (query.trim()) sortSearchResults(out); else out.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
    const q = query.trim();
    const exact = q && out.some((c) => c.file.basename.toLowerCase() === q.toLowerCase() || c.file.path.replace(/\.md$/, "").toLowerCase() === q.toLowerCase());
    return q && !exact ? [...out, { kind: "new", name: q }] : out;
  }
  renderSuggestion(c: Choice, el: HTMLElement): void {
    el.addClass("mod-complex");
    const content = el.createDiv({ cls: "suggestion-content" });
    const title = content.createDiv({ cls: "suggestion-title" });
    if (c.kind === "new") {
      title.setText(c.name);
      el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair", text: "Create new note" });
      return;
    }
    renderResults(title, c.file.basename, c.match, c.file.path.length - 3 - c.file.basename.length);
    if (c.file.parent && !c.file.parent.isRoot()) content.createDiv({ cls: "suggestion-note", text: c.file.parent.path });
  }
  onChooseSuggestion(c: Choice, evt: MouseEvent | KeyboardEvent): void { void this.choose(c, evt); }
  protected async target(c: Choice): Promise<TFile | null> {
    if (c.kind === "file") return c.file;
    if (!c.name.trim()) return null;
    try { return await createFromLinktext(this.app, c.name, this.current.path); } catch (e) { new Notice(String(e)); return null; }
  }
  protected abstract choose(c: Choice, evt: MouseEvent | KeyboardEvent): Promise<void>;
}

export class MergeFileModal extends ComposerModal {
  constructor(app: App, current: TFile) { super(app, current, "Select file to merge into...", "to merge", "to merge at top"); }
  protected async choose(c: Choice, evt: MouseEvent | KeyboardEvent): Promise<void> {
    const into = await this.target(c);
    const from = this.current;
    if (!into || into === from) return;
    const where: Where = evt.shiftKey ? "prepend" : "append";
    const run = async () => {
      try { await mergeFile(this.app, into, from, where); await this.app.workspace.getLeaf(false).openFile(into, { active: true }); }
      catch (e) { console.error(e); new Notice(`Merge failed: ${(e as Error).message ?? e}`); }
    };
    if (opts(this.app).askBeforeMerging === false) { await run(); return; }
    let dontAsk = false;
    const m = new ConfirmationModal(this.app).addClass("mod-note-composer-confirm");
    m.titleEl.setText("Merge file");
    m.contentEl.createEl("p", { text: `Are you sure you want to merge "${from.basename}" into "${into.basename}"? "${from.basename}" will be deleted.` });
    m.addCheckbox("Don't ask again", (v) => { dontAsk = v; });
    m.addButton((b) => b.setButtonText("Merge").setDestructive().setCta().onClick(async () => {
      m.close();
      if (dontAsk) { opts(this.app).askBeforeMerging = false; await saveOptions(this.app, ID); }
      await run();
    }));
    m.addCancelButton();
    m.open();
  }
}

export class ExtractModal extends ComposerModal {
  private initial: string;
  constructor(app: App, current: TFile, private editor: Editor, initial?: string) {
    super(app, current, "Select file to merge into...", "to append", "to prepend");
    this.initial = initial ?? cleanTitle(editor.getSelection().split("\n")[0] ?? "");
  }
  onOpen(): void { this.inputEl.value = this.initial; super.onOpen(); this.inputEl.select(); }
  protected async choose(c: Choice, evt: MouseEvent | KeyboardEvent): Promise<void> {
    const ed = this.editor;
    const start = ed.posToOffset(ed.getCursor("from")), end = ed.posToOffset(ed.getCursor("to"));
    const to = await this.target(c);
    if (!to || to === this.current) return;
    try { await extractSection(this.app, this.current, to, start, end, evt.shiftKey ? "prepend" : "append"); }
    catch (e) { console.error(e); new Notice(`Extract failed: ${(e as Error).message ?? e}`); }
  }
}

/** A selection's first line as a note title: heading/list/quote markers and link brackets removed. */
export function cleanTitle(line: string): string {
  return line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[.\]\s+)?|\d+[.)]\s+|>\s*)+/, "").replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
}

function extractHeading(app: App, file: TFile, editor: Editor): void {
  const r = headingRange(app.metadataCache.getFileCache(file), editor.getCursor().line, editor.getValue());
  if (!r) { new Notice("Couldn't find the heading at the cursor."); return; }
  editor.setSelection(editor.offsetToPos(r.start), editor.offsetToPos(r.end));
  new ExtractModal(app, file, editor, cleanTitle(r.heading)).open();
}

class NoteComposerTab extends CoreOptionsTab {
  constructor(app: App) { super(app, ID, "Note composer", "lucide-git-merge"); }
  render(el: HTMLElement): void {
    const o = this.options;
    new Setting(el).setName("Text after extraction").setDesc("What to leave in the original note after extracting a selection.").addDropdown((d) =>
      d.addOptions({ link: "Link to new file", embed: "Embed new file", none: "None" }).setValue(o.replacementText || "link").onChange((v) => { o.replacementText = v; void this.save(); }));
    new Setting(el).setName("Template file location").setDesc("Template for merged and extracted content: {{content}}, {{fromTitle}}, {{newTitle}}, {{date}}, {{date:FORMAT}}.").addText((t) =>
      t.setPlaceholder("Example: folder/note").setValue(o.template ?? "").onChange((v) => { o.template = v.trim(); void this.save(); }));
    new Setting(el).setName("Confirm file merge").setDesc("Ask before merging files. File recovery can restore a merged note.").addToggle((t) =>
      t.setValue(o.askBeforeMerging !== false).onChange((v) => { o.askBeforeMerging = v; void this.save(); }));
  }
}

export const noteComposer: CoreModule = {
  id: ID,
  install(app) {
    const offTab = whileCoreTab(app, new NoteComposerTab(app));
    const off = whileCoreEnabled(app, ID, () => {
      const menuRef = app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, source: string) => {
        if (source === "link-context-menu" || !(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((i) => i.setSection("action").setTitle("Merge entire file with...").setIcon("lucide-git-merge").onClick(() => new MergeFileModal(app, file).open()));
      });
      const offs = [
        addCommand(app, {
          id: "note-composer:merge-file", name: "Note composer: Merge current file with another file...", icon: "lucide-git-merge",
          checkCallback: (checking) => {
            const f = app.workspace.getActiveFile();
            if (!f || f.extension !== "md") return false;
            if (!checking) new MergeFileModal(app, f).open();
            return true;
          },
        }),
        addCommand(app, {
          id: "note-composer:split-file", name: "Note composer: Extract current selection...", icon: "lucide-scissors",
          editorCheckCallback: (checking, editor, ctx) => {
            if (!ctx.file || !editor.getSelection().trim()) return false;
            if (!checking) new ExtractModal(app, ctx.file, editor).open();
            return true;
          },
        }),
        addCommand(app, {
          id: "note-composer:extract-heading", name: "Note composer: Extract this heading...", icon: "lucide-scissors",
          editorCheckCallback: (checking, editor, ctx) => {
            if (!ctx.file || !/^ {0,3}#{1,6}(\s|$)/.test(editor.getLine(editor.getCursor().line))) return false;
            if (!checking) extractHeading(app, ctx.file, editor);
            return true;
          },
        }),
      ];
      return () => { app.workspace.offref(menuRef); offs.forEach((f) => f()); };
    });
    return () => { off(); offTab(); };
  },
};
