// End-to-end (fake backend) checks of the Templates, Daily notes, Note composer, Slash commands, Random note and Word
// count core plugins: their surface disappears when toggled off, options persist in .obsidian/<id>.json with
// Obsidian's keys, and the behaviour works through the real session (editor, modals, settings tabs).
import fs from "node:fs";
import path from "node:path";
import moment from "moment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { readJson, row, type as typeIn, clickToggle, pick } from "./helpers/settings";
import type { App } from "../src/obsidian/app";

let v: FakeVault;
let session: Session | null = null;
const q = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];
const read = (rel: string) => fs.readFileSync(path.join(v.root, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(v.root, rel));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const ribbon = (title: string) => q(`.side-dock-ribbon-action[aria-label="${title}"]`);
const key = (el: Element, k: string, mods: KeyboardEventInit = {}) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...mods }));

const FILES: Record<string, string> = {
  "Note.md": "---\ntags: [a]\n---\nfirst line\nsecond line\n",
  "Templates/Meeting.md": "---\ntags: [meeting]\nstatus: draft\n---\n## {{title}} on {{date:YYYY}}\n",
  "Templates/Daily.md": "# {{title}}\ncreated {{date}} {{time}}\n",
  "Templates/sub/Other.md": "other",
  "B.md": "# B\nbody of b\n",
  "Target.md": "# Target\nexisting\n",
  "Links.md": "see [[B]] and [[B#B|bee]] and [[Other]]\n", // (the fake metadata parser knows wikilinks only)
};

function backend(): void {
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
}
async function boot(): Promise<Session> {
  const host = document.body.appendChild(document.createElement("div"));
  host.id = "app";
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session;
}
const plugin = (app: App, id: string) => app.internalPlugins.getPluginById(id)!;
const cmd = (app: App, id: string) => app.commands.findCommand(id);
async function open(app: App, name: string) {
  await app.workspace.openLinkText(name, "", false);
  const view = app.workspace.activeLeaf!.view as any;
  await vi.waitFor(() => expect(view.file?.basename).toBe(name));
  return { view, cm: view.editor.cm, editor: view.editor };
}
const coreNav = () => qa(".vertical-tab-header-group").find((g) => g.querySelector(".vertical-tab-header-group-title")?.textContent === "Core plugins");
function openCoreTab(app: App, id: string): HTMLElement {
  app.setting.openTabById(id);
  return app.setting.activeTab!.containerEl;
}

beforeEach(() => { document.body.innerHTML = ""; localStorage.clear(); v = makeVault(FILES); backend(); });
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

describe("Templates", () => {
  it("options tab persists templates.json keys; the picker inserts at the cursor and merges properties; off removes the surface", async () => {
    const { app } = await boot();
    expect(cmd(app, "templates:insert-template")).toBeTruthy();
    expect(ribbon("Insert template")).toBeTruthy();
    app.setting.open();
    expect(coreNav()?.textContent).toContain("Templates");
    const el = openCoreTab(app, "templates");
    typeIn(row(el, "Template folder location").querySelector("input")!, "Templates");
    typeIn(row(el, "Date format").querySelector("input")!, "DD.MM.YYYY");
    typeIn(row(el, "Time format").querySelector("input")!, "HH:mm:ss");
    expect(row(el, "Date format").querySelector(".u-pop")!.textContent).toBe(moment().format("DD.MM.YYYY"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/templates.json")).toEqual({ folder: "Templates", dateFormat: "DD.MM.YYYY", timeFormat: "HH:mm:ss" }));
    app.setting.close();

    const { cm, editor } = await open(app, "Note");
    editor.focus = () => {}; // happy-dom re-enters CodeMirror's update on DOM selection changes of a focused editor
    const end = cm.state.doc.length;
    cm.dispatch({ selection: { anchor: end } });
    app.commands.executeCommandById("templates:insert-template");
    const modal = await vi.waitFor(() => { const m = q(".modal.mod-template-picker"); if (!m) throw new Error("no picker"); return m; });
    expect(qa(".suggestion-item", modal).map((e) => e.textContent)).toEqual(["Daily", "Meeting", "sub/Other"]);
    const input = q<HTMLInputElement>(".prompt-input", modal)!;
    typeIn(input, "meet");
    await tick();
    expect(qa(".suggestion-item", modal).map((e) => e.textContent)).toEqual(["Meeting"]);
    key(input, "Enter");
    await vi.waitFor(() => expect(editor.getValue()).toContain("## Note on"));
    expect(editor.getValue()).toBe(`---\ntags:\n  - a\n  - meeting\nstatus: draft\n---\nfirst line\nsecond line\n## Note on ${moment().format("YYYY")}\n`);

    cm.dispatch({ selection: { anchor: 0 } });
    // at the very start the template text goes in verbatim
    app.commands.executeCommandById("templates:insert-template");
    const m2 = await vi.waitFor(() => { const m = q(".modal.mod-template-picker"); if (!m) throw new Error("no picker"); return m; });
    typeIn(q<HTMLInputElement>(".prompt-input", m2)!, "other");
    await tick();
    key(q(".prompt-input", m2)!, "Enter");
    await vi.waitFor(() => expect(editor.getValue().startsWith("other---")).toBe(true));

    cm.dispatch({ selection: { anchor: cm.state.doc.length } });
    app.commands.executeCommandById("templates:insert-current-date");
    app.commands.executeCommandById("templates:insert-current-time");
    expect(editor.getValue()).toMatch(new RegExp(`\\n${moment().format("DD\\.MM\\.YYYY")}\\d\\d:\\d\\d:\\d\\d$`)); // date then time with seconds
    expect(editor.getCursor().ch).toBe(editor.getLine(editor.lastLine()).length);

    await plugin(app, "templates").disable();
    expect(cmd(app, "templates:insert-template")).toBeUndefined();
    expect(cmd(app, "templates:insert-current-date")).toBeUndefined();
    expect(ribbon("Insert template")).toBeNull();
    expect(app.setting.settingTabs.some((t) => t.id === "templates")).toBe(false);
    await plugin(app, "templates").enable();
    expect(cmd(app, "templates:insert-template")).toBeTruthy();
  });

  it("explains a missing template folder", async () => {
    const { app } = await boot();
    await open(app, "Note");
    app.commands.executeCommandById("templates:insert-template");
    expect(q(".modal.mod-template-picker")).toBeNull();
    expect(q(".notice")?.textContent).toMatch(/Template folder is not set/);
  });
});

describe("Daily notes", () => {
  it("creates today's note from the template in the folder, navigates prev/next, persists daily-notes.json; off removes it", async () => {
    v.cleanup();
    v = makeVault({ ...FILES, "Daily/2020-01-01.md": "old", "Daily/2030-01-01.md": "future", "Daily/not a date.md": "x" });
    backend();
    const { app } = await boot();
    expect(cmd(app, "daily-notes")).toBeUndefined(); // off by default in the fake backend
    expect(ribbon("Open today's daily note")).toBeNull();
    await plugin(app, "daily-notes").enable();
    expect(ribbon("Open today's daily note")).toBeTruthy();
    app.setting.open();
    const el = openCoreTab(app, "daily-notes");
    expect(coreNav()?.textContent).toContain("Daily notes");
    typeIn(row(el, "Date format").querySelector("input")!, "YYYY-MM-DD");
    typeIn(row(el, "New file location").querySelector("input")!, "Daily");
    typeIn(row(el, "Template file location").querySelector("input")!, "Templates/Daily");
    expect(row(el, "Date format").querySelector(".u-pop")!.textContent).toBe(moment().format("YYYY-MM-DD"));
    clickToggle(row(el, "Open daily note on startup"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/daily-notes.json")).toEqual({ format: "YYYY-MM-DD", folder: "Daily", template: "Templates/Daily" }));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/app.json")?.openBehavior).toBe("daily"));
    app.setting.close();

    const today = moment().format("YYYY-MM-DD");
    app.commands.executeCommandById("daily-notes");
    await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe(`Daily/${today}.md`));
    expect(read(`Daily/${today}.md`)).toMatch(new RegExp(`^# ${today}\\ncreated ${today} \\d\\d:\\d\\d\\n$`));
    // existing note is opened, not recreated
    fs.writeFileSync(path.join(v.root, `Daily/${today}.md`), "edited");
    ribbon("Open today's daily note")!.click();
    await tick(50);
    expect(read(`Daily/${today}.md`)).toBe("edited");

    expect(app.commands.canExecute(cmd(app, "daily-notes:goto-prev")!)).toBe(true);
    app.commands.executeCommandById("daily-notes:goto-prev");
    await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe("Daily/2020-01-01.md"));
    app.commands.executeCommandById("daily-notes:goto-next");
    await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe(`Daily/${today}.md`));
    app.commands.executeCommandById("daily-notes:goto-next");
    await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe("Daily/2030-01-01.md"));
    await open(app, "Note");
    expect(app.commands.canExecute(cmd(app, "daily-notes:goto-prev")!)).toBe(false); // not a daily note

    // plugins read the same options object (Calendar / Periodic Notes)
    expect((app as any).internalPlugins.getPluginById("daily-notes").instance.options).toMatchObject({ folder: "Daily", format: "YYYY-MM-DD", template: "Templates/Daily" });
    // ...and copy a template's folds onto the note they create
    const tf = app.vault.getFileByPath("Templates/Daily.md")!;
    expect(app.foldManager.load(tf)).toBeNull();
    app.foldManager.save(tf, { folds: [{ from: 0, to: 1 }], lines: 2 });
    expect(app.foldManager.load(tf)).toEqual({ folds: [{ from: 0, to: 1 }], lines: 2 });

    await plugin(app, "daily-notes").disable();
    for (const id of ["daily-notes", "daily-notes:goto-prev", "daily-notes:goto-next"]) expect(cmd(app, id)).toBeUndefined();
    expect(ribbon("Open today's daily note")).toBeNull();
    expect(app.setting.settingTabs.some((t) => t.id === "daily-notes")).toBe(false);
  });

  it("migrates the legacy autorun flag and opens the daily note on startup", async () => {
    v.cleanup();
    v = makeVault({ ...FILES, ".obsidian/daily-notes.json": JSON.stringify({ autorun: true, folder: "", format: "" }) });
    backend();
    // the fake backend has daily-notes off by default; turn it on through core-plugins.json-equivalent
    const base = v.backend;
    setBackend(async (c, a) => (c === "core_plugins" ? ((await base(c, a)) as [string, boolean][]).map(([id, on]) => [id, on || id === "daily-notes"]) : c === "launch_args" ? { vault: null, script: null } : c === "log_frontend" || c === "vault_search" ? (c === "vault_search" ? [] : null) : c === "meta_backlinks" || c === "meta_tags" ? {} : base(c, a)));
    const { app } = await boot();
    const today = moment().format("YYYY-MM-DD");
    await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe(`${today}.md`));
    expect(readJson(v, ".obsidian/app.json").openBehavior).toBe("daily");
    expect(readJson(v, ".obsidian/daily-notes.json")).toEqual({ folder: "", format: "" });
  });
});

describe("Note composer", () => {
  it("merges with confirmation, re-points links, honours 'don't ask again' and the template", async () => {
    const { app } = await boot();
    app.setting.open();
    const el = openCoreTab(app, "note-composer");
    pick(row(el, "Text after extraction"), "embed");
    typeIn(row(el, "Template file location").querySelector("input")!, "Templates/Composer");
    await vi.waitFor(() => expect(readJson(v, ".obsidian/note-composer.json")).toEqual({ replacementText: "embed", template: "Templates/Composer" }));
    app.setting.close();
    await app.vault.create("Templates/Composer.md", "from {{fromTitle}} to {{newTitle}}:\n{{content}}");

    await open(app, "B");
    await vi.waitFor(() => expect(app.metadataCache.resolvedLinks["Links.md"]?.["B.md"]).toBeTruthy());
    app.commands.executeCommandById("note-composer:merge-file");
    const modal = await vi.waitFor(() => { const m = q(".modal.mod-note-composer"); if (!m) throw new Error("no modal"); return m; });
    const input = q<HTMLInputElement>(".prompt-input", modal)!;
    typeIn(input, "Target");
    await tick();
    expect(qa(".suggestion-item .suggestion-title", modal)[0].textContent).toBe("Target");
    key(input, "Enter");
    const confirm = await vi.waitFor(() => { const m = q(".modal.mod-confirmation"); if (!m) throw new Error("no confirm"); return m; });
    expect(confirm.textContent).toContain('merge "B" into "Target"');
    (q<HTMLInputElement>("input[type=checkbox]", confirm)!).click();
    qa("button", confirm).find((b) => b.textContent === "Merge")!.click();
    await vi.waitFor(() => expect(exists("B.md")).toBe(false));
    expect(read("Target.md")).toBe("# Target\nexisting\n\nfrom B to Target:\n# B\nbody of b\n");
    expect(read("Links.md")).toBe("see [[Target]] and [[Target#B|bee]] and [[Other]]\n");
    await vi.waitFor(() => expect(app.workspace.getActiveFile()?.path).toBe("Target.md"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/note-composer.json").askBeforeMerging).toBe(false));
  });

  it("extracts a selection (embed left behind, Shift+Enter prepends) and a heading into a new note; off removes commands", async () => {
    v.cleanup();
    v = makeVault({ ...FILES, "Src.md": "# Src\nintro [[#Part]]\n## Part\npart text [[Note]]\n## End\nend\n", "Ref.md": "[[Src#Part]]\n", ".obsidian/note-composer.json": JSON.stringify({ replacementText: "embed", askBeforeMerging: true }) });
    backend();
    const { app } = await boot();
    const { cm, editor } = await open(app, "Src");
    await vi.waitFor(() => expect(app.metadataCache.getFileCache(app.vault.getFileByPath("Src.md")!)?.headings?.length).toBe(3));
    // Extract this heading: only on a heading line
    editor.setCursor({ line: 1, ch: 0 });
    expect(app.commands.canExecute(cmd(app, "note-composer:extract-heading")!)).toBe(false);
    editor.setCursor({ line: 2, ch: 3 });
    app.commands.executeCommandById("note-composer:extract-heading");
    const modal = await vi.waitFor(() => { const m = q(".modal.mod-note-composer"); if (!m) throw new Error("no modal"); return m; });
    const input = q<HTMLInputElement>(".prompt-input", modal)!;
    expect(input.value).toBe("Part");
    key(input, "Enter", { ctrlKey: true }); // Mod+Enter: new note named after the input
    await vi.waitFor(() => expect(exists("Part.md")).toBe(true));
    await vi.waitFor(() => expect(read("Src.md")).toBe("# Src\nintro [[Part#Part]]\n![[Part]]\n## End\nend\n"));
    expect(read("Part.md")).toBe("## Part\npart text [[Note]]");
    await vi.waitFor(() => expect(read("Ref.md")).toBe("[[Part#Part]]\n"));
    await vi.waitFor(() => expect(editor.getValue()).toBe(read("Src.md")));

    // Extract current selection, prepended into an existing note
    const sel = editor.getValue().indexOf("end\n");
    cm.dispatch({ selection: { anchor: sel, head: sel + 3 } });
    app.commands.executeCommandById("note-composer:split-file");
    const m2 = await vi.waitFor(() => { const m = q(".modal.mod-note-composer"); if (!m) throw new Error("no modal"); return m; });
    const in2 = q<HTMLInputElement>(".prompt-input", m2)!;
    typeIn(in2, "Target");
    await tick();
    key(in2, "Enter", { shiftKey: true });
    await vi.waitFor(() => expect(read("Target.md")).toBe("end\n\n# Target\nexisting\n"));
    await vi.waitFor(() => expect(read("Src.md")).toBe("# Src\nintro [[Part#Part]]\n![[Part]]\n## End\n![[Target]]\n"));

    await plugin(app, "note-composer").disable();
    for (const id of ["note-composer:merge-file", "note-composer:split-file", "note-composer:extract-heading"]) expect(cmd(app, id)).toBeUndefined();
    expect(app.setting.settingTabs.some((t) => t.id === "note-composer")).toBe(false);
  });
});

describe("Slash commands", () => {
  it("'/' at line start or after a space opens a fuzzy command list; Enter removes the query and runs the command", async () => {
    const { app } = await boot();
    app.commands.addCommand({ id: "demo:stamp", name: "Demo: Insert stamp", editorCallback: (e) => e.replaceSelection("STAMP") });
    const { cm, editor } = await open(app, "B");
    const typeAt = (text: string) => cm.dispatch({ changes: { from: cm.state.selection.main.head, insert: text }, selection: { anchor: cm.state.selection.main.head + text.length } });
    cm.dispatch({ selection: { anchor: cm.state.doc.length } });
    typeAt("/stmp");
    await tick(20);
    expect(q(".suggestion-container.mod-slash-command")).toBeNull(); // plugin off by default

    await plugin(app, "slash-command").enable();
    typeAt("x");
    cm.dispatch({ changes: { from: cm.state.doc.length - 6, to: cm.state.doc.length }, selection: { anchor: cm.state.doc.length - 6 } });
    typeAt("word /");
    await vi.waitFor(() => expect(q(".suggestion-container.mod-slash-command")).toBeTruthy());
    typeAt("stmp");
    await vi.waitFor(() => expect(qa(".mod-slash-command .suggestion-item")[0]?.textContent).toContain("Insert stamp"));
    expect(q(".mod-slash-command .suggestion-item .suggestion-prefix")?.textContent).toBe("Demo");
    key(cm.contentDOM, "Enter");
    await vi.waitFor(() => expect(editor.getValue()).toBe("# B\nbody of b\nword STAMP"));
    expect(q(".suggestion-container.mod-slash-command")).toBeNull();
    typeAt("a/b"); // no trigger inside a word
    await tick(20);
    expect(q(".suggestion-container.mod-slash-command")).toBeNull();

    await plugin(app, "slash-command").disable();
    typeAt(" /");
    await tick(20);
    expect(q(".suggestion-container.mod-slash-command")).toBeNull();
  });
});

describe("Random note and Word count", () => {
  it("random note opens another note and is removed when off", async () => {
    const { app } = await boot();
    expect(cmd(app, "random-note")).toBeUndefined();
    await plugin(app, "random-note").enable();
    await open(app, "B");
    for (let i = 0; i < 5; i++) {
      const before = app.workspace.getActiveFile();
      app.commands.executeCommandById("random-note");
      await vi.waitFor(() => expect(app.workspace.getActiveFile()).not.toBe(before));
    }
    expect(ribbon("Open random note")).toBeTruthy();
    await plugin(app, "random-note").disable();
    expect(cmd(app, "random-note")).toBeUndefined();
    expect(ribbon("Open random note")).toBeNull();
  });

  it("word count shows words and characters of the note or the selection; off removes the status bar item", async () => {
    const { app } = await boot();
    const { cm } = await open(app, "Note");
    const item = () => q(".status-bar .plugin-word-count");
    const segs = () => qa(".status-bar .plugin-word-count .status-bar-item-segment").map((e) => e.textContent);
    await vi.waitFor(() => expect(segs()).toEqual(["4 words", "23 characters"]));
    cm.dispatch({ selection: { anchor: cm.state.doc.toString().indexOf("first"), head: cm.state.doc.toString().indexOf("first") + 5 } });
    await vi.waitFor(() => expect(segs()).toEqual(["1 word", "5 characters"]));
    cm.dispatch({ selection: { anchor: 0 } });
    await vi.waitFor(() => expect(segs()).toEqual(["4 words", "23 characters"]));
    await plugin(app, "word-count").disable();
    expect(item()).toBeNull();
    await plugin(app, "word-count").enable();
    await vi.waitFor(() => expect(segs()).toEqual(["4 words", "23 characters"]));
  });
});

describe("Core plugins settings list", () => {
  it("shows an options cog for enabled plugins with a tab", async () => {
    const { app } = await boot();
    app.setting.openTabById("core-plugins");
    const el = app.setting.activeTab!.containerEl;
    const tpl = q(`.core-plugin-item[data-plugin-id="templates"]`, el)!;
    expect(q(".extra-setting-button, .clickable-icon", tpl)).toBeTruthy();
    q<HTMLElement>(".extra-setting-button, .clickable-icon", tpl)!.click();
    expect(app.setting.activeTab?.id).toBe("templates");
    expect(q(`.core-plugin-item[data-plugin-id="daily-notes"] .clickable-icon`, (app.setting.openTabById("core-plugins"), app.setting.activeTab!.containerEl))).toBeNull();
  });
});
