// More Obsidian editor commands: Toggle heading (a picker), Rename this heading..., Insert attachment, Download attachments
// for current file, and Toggle fold properties in current file.
import { FuzzySuggestModal, Notice, TFile, type App, type Command, type Editor } from "../obsidian";
import { ipc } from "../ipc";
import { saveAttachment } from "./bridge";
import { promptText } from "./dialogs";
import { stripHeading } from "../obsidian/util";

const HEADING_LINE = /^(\s{0,3})(#{1,6})\s+(.*?)(?:\s+#+\s*)?$/;

/** The heading text on the cursor's line, if it is an ATX heading. */
export function headingOnLine(line: string): { level: number; text: string } | null {
  const m = HEADING_LINE.exec(line);
  return m ? { level: m[2].length, text: m[3] } : null;
}

class HeadingPicker extends FuzzySuggestModal<string> {
  constructor(app: App, private run: (id: string) => void) { super(app); this.setPlaceholder("Set heading level..."); }
  getItems(): string[] { return ["Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6", "Remove heading"]; }
  getItemText(item: string): string { return item; }
  onChooseItem(item: string): void { this.run(item === "Remove heading" ? "editor:set-heading-0" : `editor:set-heading-${item.slice(-1)}`); }
}

/** Rewrite links such as `[[Note#Old]]` and `[[#Old]]` after a heading of `file` is renamed from `from` to `to`. */
export async function updateHeadingLinks(app: App, file: TFile, from: string, to: string): Promise<number> {
  const oldKey = stripHeading(from).toLowerCase();
  let changed = 0;
  for (const note of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(note);
    const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].filter((l) => {
      const [path, ...sub] = l.link.split("#");
      if (!sub.length) return false;
      const target = path ? app.metadataCache.getFirstLinkpathDest(path, note.path) : note;
      return target === file && sub.some((s: string) => stripHeading(s).toLowerCase() === oldKey);
    });
    if (!links.length) continue;
    await app.vault.process(note, (text) => {
      let out = text;
      for (const l of [...links].sort((a, b) => b.position.start.offset - a.position.start.offset)) {
        const at = l.position.start.offset;
        if (out.slice(at, at + l.original.length) !== l.original) continue;
        const [path, ...sub] = l.link.split("#");
        const next = [path, ...sub.map((s: string) => (stripHeading(s).toLowerCase() === oldKey ? to : s))].join("#");
        const alias = l.original.includes("|") ? l.original.slice(l.original.indexOf("|"), -2) : "";
        const open = l.original.startsWith("!") ? "![[" : "[[";
        // Only wikilinks carry the heading text verbatim; Markdown links are left to the user.
        if (!l.original.startsWith(open)) continue;
        out = out.slice(0, at) + open + next + alias + "]]" + out.slice(at + l.original.length);
      }
      changed += links.length;
      return out;
    });
  }
  return changed;
}

export function registerEditorExtras(app: App, add: (c: Command) => void): void {
  add({ id: "editor:set-heading", name: "Toggle heading", editorCallback: () => { new HeadingPicker(app, (id) => { app.commands.executeCommandById(id); }).open(); } });

  add({
    id: "editor:rename-heading", name: "Rename this heading...",
    editorCheckCallback: (checking, editor, ctx) => {
      const file = (ctx as { file?: TFile | null }).file;
      const line = editor.getCursor().line;
      const heading = file ? headingOnLine(editor.getLine(line)) : null;
      if (!file || !heading) return false;
      if (!checking) void renameHeading(app, editor, file, line, heading.text);
      return true;
    },
  });

  add({
    id: "editor:attach-file", name: "Insert attachment",
    editorCallback: (editor, ctx) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.addEventListener("change", () => {
        void (async () => {
          const src = (ctx as { file?: TFile | null }).file?.path ?? "";
          const links: string[] = [];
          for (const f of Array.from(input.files ?? [])) links.push(await saveAttachment(app, f, src, false));
          if (links.length) editor.replaceSelection(links.join("\n"));
        })().catch((e) => new Notice(String(e?.message ?? e)));
      });
      input.click();
    },
  });

  add({
    id: "editor:download-attachments", name: "Download attachments for current file",
    editorCallback: (editor, ctx) => { void downloadAttachments(app, editor, (ctx as { file?: TFile | null }).file?.path ?? ""); },
  });

  add({
    id: "editor:toggle-fold-properties", name: "Toggle fold properties in current file",
    checkCallback: (checking) => {
      const heading = app.workspace.activeLeaf?.view.containerEl.querySelector<HTMLElement>(".metadata-properties-heading");
      if (!heading) return false;
      if (!checking) heading.click();
      return true;
    },
  });
}

async function renameHeading(app: App, editor: Editor, file: TFile, line: number, oldText: string): Promise<void> {
  const next = await promptText(app, { title: "Rename heading", value: oldText, cta: "Rename", validate: (v) => (v.trim() ? null : "A heading cannot be empty.") });
  if (next === null || next.trim() === oldText) return;
  const text = editor.getLine(line);
  const m = HEADING_LINE.exec(text)!;
  const start = text.indexOf(m[3], m[1].length + m[2].length);
  editor.replaceRange(next.trim(), { line, ch: start }, { line, ch: start + m[3].length });
  await new Promise((r) => setTimeout(r, 50));
  const n = await updateHeadingLinks(app, file, oldText, next.trim());
  new Notice(n ? `Renamed heading and updated ${n} link${n === 1 ? "" : "s"}.` : "Renamed heading.");
}

const REMOTE_IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
const TYPE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif", "image/bmp": "bmp" };

/** Save the remote images a note links to into the vault and point the note at the copies. */
export async function downloadAttachments(app: App, editor: Editor, sourcePath: string): Promise<number> {
  const text = editor.getValue();
  const found = [...text.matchAll(REMOTE_IMAGE)];
  if (!found.length) { new Notice("No remote attachments to download."); return 0; }
  let done = 0;
  let out = text;
  for (const m of found) {
    try {
      const res = await ipc.httpRequest({ url: m[2] });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      const type = (res.headers["content-type"] ?? res.headers["Content-Type"] ?? "").split(";")[0].trim();
      const base = decodeURIComponent(new URL(m[2]).pathname.split("/").pop() || "image");
      const name = /\.[A-Za-z0-9]{2,5}$/.test(base) ? base : `${base}.${TYPE_EXT[type] ?? "png"}`;
      const file = new File([new Uint8Array(res.body)], name, { type });
      const link = await saveAttachment(app, file, sourcePath, false);
      out = out.replace(m[0], link.startsWith("!") ? link : "!" + link);
      done++;
    } catch (e) {
      new Notice(`Could not download ${m[2]}: ${String((e as Error)?.message ?? e)}`);
    }
  }
  if (done) editor.setValue(out);
  new Notice(`Downloaded ${done} of ${found.length} attachment${found.length === 1 ? "" : "s"}.`);
  return done;
}
