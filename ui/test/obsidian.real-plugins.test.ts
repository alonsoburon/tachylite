// Smoke tests against real community plugin bundles. Opt-in: `TACHYLITE_REAL_PLUGINS=1 npx vitest run` downloads the
// releases pinned in scripts/real-plugins.mjs into ui/.cache/real-plugins/ (test/setup/realPlugins.ts) and runs these;
// without the variable they are skipped.
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeApp, makeVault, type FakeVault } from "./helpers/backend";
import type { App } from "../src/obsidian/app";
import { MarkdownPreviewRenderer } from "../src/obsidian/markdown";
import { CACHE_DIR } from "../scripts/real-plugins.mjs";
import { canvas as canvasCore } from "../src/app/core/canvas";
import { nodeBridge } from "../src/obsidian/nodeBridge";
import { pagePreview } from "../src/app/core/pagePreview";
import { installBridge } from "../src/app/bridge";

const ENABLED = process.env.TACHYLITE_REAL_PLUGINS === "1";
const dirOf = (id: string) => path.join(CACHE_DIR, id);

// happy-dom has no Worker; the real webview does. Plugins that spawn workers only need the constructor to succeed.
(globalThis as any).Worker ??= class { onmessage: unknown = null; onerror: unknown = null; postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} };

// happy-dom's StyleSheetList lacks item(); real browsers have it (style-settings iterates document.styleSheets).
if (!(document.styleSheets as any).item) Object.defineProperty(document, "styleSheets", { get: () => Object.assign([], { item(i: number) { return null; } }), configurable: true });

// happy-dom lacks the Option() constructor (kanban's settings use it).
(globalThis as any).Option ??= function Option(text = "", value?: string, _d?: boolean, selected = false) {
  const o = document.createElement("option"); o.textContent = text; if (value !== undefined) o.value = value; if (selected) o.selected = true; return o;
};

interface Spec { id: string; dir: string; minCommands?: number; settingsTab?: boolean; views?: number; openViews?: string[]; minPostProcessors?: number; /** errors that are inherent to a webview (no Node runtime) */ allowErrors?: RegExp; /** Node bridge allowed + the vault is a git repo */ bridge?: boolean }
const PLUGINS: Spec[] = [
  { id: "dataview", dir: dirOf("dataview"), minCommands: 3, settingsTab: true, minPostProcessors: 1 },
  { id: "obsidian-git", dir: dirOf("obsidian-git"), settingsTab: true, openViews: ["git-view"], bridge: true, allowErrors: /AbortError/ /* it aborts its fs.promises.watch on unload; Node rejects the iterator with AbortError and the plugin logs it */ },
  { id: "calendar", dir: dirOf("calendar"), settingsTab: true, views: 1 },
  { id: "templater-obsidian", dir: dirOf("templater-obsidian"), minCommands: 1, settingsTab: true },
  { id: "obsidian-tasks-plugin", dir: dirOf("obsidian-tasks-plugin"), minCommands: 1, settingsTab: true, minPostProcessors: 1 },
  { id: "obsidian-excalidraw-plugin", dir: dirOf("obsidian-excalidraw-plugin"), minCommands: 1, settingsTab: true, allowErrors: /reading .document./ /* iframe.contentWindow (happy-dom) */ },
  { id: "quickadd", dir: dirOf("quickadd"), minCommands: 1, settingsTab: true },
  { id: "obsidian-kanban", dir: dirOf("obsidian-kanban"), minCommands: 1, settingsTab: true, views: 1 },
  { id: "various-complements", dir: dirOf("various-complements"), minCommands: 1, settingsTab: true },
  { id: "obsidian-style-settings", dir: dirOf("obsidian-style-settings"), settingsTab: true },
  { id: "omnisearch", dir: dirOf("omnisearch"), settingsTab: true, allowErrors: /apiHttpServer|reading .close./ /* node http server not available */ },
  { id: "periodic-notes", dir: dirOf("periodic-notes"), settingsTab: true },
  { id: "table-editor-obsidian", dir: dirOf("table-editor-obsidian"), minCommands: 1, settingsTab: true },
  { id: "obsidian-completr", dir: dirOf("obsidian-completr"), settingsTab: true },
  { id: "buttons", dir: dirOf("buttons"), settingsTab: false },
  { id: "obsidian-banners", dir: dirOf("obsidian-banners"), settingsTab: true },
];

// More plugins: only "loads, renders its settings, unloads, no console errors" is asserted.
for (const id of ["nldates-obsidian", "obsidian-outliner", "obsidian-linter", "obsidian-latex-suite", "tag-wrangler", "obsidian-emoji-toolbar", "recent-files-obsidian", "cmdr", "obsidian-day-planner", "better-word-count", "obsidian-folder-note-plugin", "obsidian-minimal-settings", "mysnippets-plugin", "obsidian42-brat", "obsidian-hover-editor", "text-extractor", "obsidian-codemirror-options"]) {
  PLUGINS.push({ id, dir: dirOf(id), ...(id === "obsidian-latex-suite" ? { allowErrors: /dynamic import callback/ /* node vm limitation; fine in a webview */ } : {}), ...(id === "obsidian-outliner" ? {} : {}) });
}

let v: FakeVault | undefined, app: App | undefined, offCanvas: (() => void) | undefined;
const git = (root: string, ...args: string[]) => cp.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const initRepo = (root: string) => { git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "t"); git(root, "config", "user.email", "t@t"); git(root, "add", "-A"); git(root, "commit", "-qm", "initial"); };
afterEach(async () => { offCanvas?.(); offCanvas = undefined; await app?.stop(); v?.cleanup(); nodeBridge.reset(); document.body.innerHTML = ""; document.head.innerHTML = ""; v = app = undefined; });

for (const spec of PLUGINS) {
  const have = fs.existsSync(path.join(spec.dir, "main.js")) && fs.existsSync(path.join(spec.dir, "manifest.json"));
  describe.skipIf(!ENABLED || !have)(`real plugin: ${spec.id}`, () => {
    it("loads through the real loader, registers its surface, and unloads cleanly", async () => {
      const read = (f: string) => (fs.existsSync(path.join(spec.dir, f)) ? fs.readFileSync(path.join(spec.dir, f), "utf8") : undefined);
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
      const onRej = (e: PromiseRejectionEvent | any) => errors.push(["unhandledrejection", e?.reason ?? e]);
      process.on("unhandledRejection", onRej);
      v = makeVault(
        { "Home.md": "---\ntitle: Home\ntags: [a]\n---\n# Home\n- [ ] task one\nSee [[Note]]\n```dataview\nLIST\n```\n", "Note.md": "# Note\nhello #tag", "Daily/2024-01-01.md": "daily" },
        { plugins: { [spec.id]: { manifest: JSON.parse(read("manifest.json")!), main: read("main.js")!, styles: read("styles.css") } }, enabled: [spec.id], bridgeConsent: !!spec.bridge },
      );
      if (spec.bridge) initRepo(v.root);
      // The Canvas core plugin is installed as in the app (Excalidraw builds headless canvases through it).
      app = await makeApp(v, { onCoreReady: (a) => { offCanvas = canvasCore.install(a) || undefined; } });
      document.body.appendChild(app.dom.appContainerEl); // the shell mounts this; plugins query .app-container
      const err = app.plugins.loadErrors[spec.id];
      const detail = app.plugins.loadErrorDetails[spec.id] as Error | undefined;
      expect(err ? `${err}\n${detail?.stack?.split("\n").slice(0, 6).join("\n")}` : undefined, `load error for ${spec.id}`).toBeUndefined();
      const plugin = app.plugins.getPlugin(spec.id);
      expect(plugin, "plugin instance").not.toBeNull();
      const listCmds = () => Object.keys(app!.commands.commands).filter((c) => c.startsWith(spec.id + ":"));
      // some plugins register commands after an un-awaited async onload
      if (spec.minCommands) await vi.waitFor(() => expect(listCmds().length).toBeGreaterThanOrEqual(spec.minCommands!), { timeout: 3000 });
      const cmds = listCmds();
      const tabs = app.setting.pluginTabs.length;
      const pps = MarkdownPreviewRenderer.getPostProcessors().length;
      const viewTypes = Object.keys(app.viewRegistry.viewByType).filter((t) => t !== "markdown");
      console.log(`[smoke] ${spec.id}: commands=${cmds.length} settingsTabs=${tabs} views=${viewTypes.length} (${viewTypes.slice(0, 4).join(",")}) styles=${!!document.head.querySelector(`style[data-tachylite-plugin="${spec.id}"]`)} ribbon=${app.workspace.leftRibbon.items.length} statusbar=${app.statusBarEl.childElementCount} editorExt=${app.workspace.editorExtensions.length - 1} postProcessors=${pps}`);
      if (spec.minCommands) expect(cmds.length).toBeGreaterThanOrEqual(spec.minCommands);
      if (spec.minPostProcessors) expect(pps).toBeGreaterThanOrEqual(spec.minPostProcessors);
      if (spec.settingsTab) expect(tabs).toBeGreaterThanOrEqual(1);
      if (spec.views) expect(viewTypes.length).toBeGreaterThanOrEqual(spec.views);
      // the settings tab must render without throwing
      for (const t of app.setting.pluginTabs) { t.display(); expect(t.containerEl.childElementCount).toBeGreaterThan(0); t.hide(); }
      // give async onload work (layout-ready callbacks, timers) a moment
      await new Promise((r) => setTimeout(r, 300));
      // open a note so editor extensions / views get instantiated
      await app.workspace.getLeaf(false).openFile(app.vault.getFileByPath("Home.md")!, { active: true });
      await new Promise((r) => setTimeout(r, 100));
      for (const t of spec.openViews ?? viewTypes) {
        const leaf = app.workspace.getRightLeaf(false)!;
        await leaf.setViewState({ type: t });
        expect(leaf.view.getViewType(), `view ${t} instantiated`).toBe(t);
        expect(leaf.view.constructor.name).not.toBe("DeferredView");
      }
      // obsidian-git retries its askpass watcher 5 s after unloading (a plugin quirk, same in Obsidian); keep it out of later tests.
      const gm = (app.plugins.getPlugin(spec.id) as any)?.gitManager;
      if (gm?.askpass) gm.askpass = async () => {};
      await app.plugins.disablePlugin(spec.id);
      expect(Object.keys(app.commands.commands).filter((c) => c.startsWith(spec.id + ":"))).toEqual([]);
      expect(app.setting.pluginTabs).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 150)); // let async teardown errors surface inside this test
      spy.mockRestore();
      process.off("unhandledRejection", onRej);
      const real = errors.filter((e) => !/Failed to load|ResizeObserver/.test(String((e as any[])[0])) && !(spec.allowErrors && spec.allowErrors.test(JSON.stringify((e as any[]).map((x) => String((x as Error)?.message ?? x))))));
      expect(real.map((e) => (e as any[]).map((x) => (x instanceof Error ? x.stack : String(x))).join(" ").slice(0, 400)), "console errors / unhandled rejections").toEqual([]);
    }, 60_000);
  });
}

// Live Preview with the real Dataview bundle and the real editor (bridge): ```dataview blocks render as widgets through the
// code-block processor, inline `= ...` / `$= ...` queries through Dataview's own CM6 extension (needs our token classes).
const dvDir = dirOf("dataview");

/** In-process stand-in for a blob-URL Web Worker (happy-dom has none): runs the script with its own `onmessage`/`postMessage`. */
function installInlineWorkers(): () => void {
  const g = globalThis as any;
  const blobs = new Map<string, Blob>();
  const origUrl = URL.createObjectURL, origWorker = g.Worker;
  let n = 0;
  URL.createObjectURL = ((b: Blob) => { const u = `blob:inline-${n++}`; blobs.set(u, b); return u; }) as typeof URL.createObjectURL;
  g.Worker = class {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    private handler: Promise<((e: { data: unknown }) => unknown) | undefined>;
    constructor(url: string) {
      this.handler = blobs.get(url)!.text().then((code) => {
        const post = (data: unknown) => setTimeout(() => this.onmessage?.({ data: structuredClone(data) }));
        return new Function("postMessage", "self", `var onmessage;\n${code}\nreturn onmessage;`)(post, g);
      });
    }
    postMessage(data: unknown) { void this.handler.then((h) => h?.({ data: structuredClone(data) })); }
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
  return () => { URL.createObjectURL = origUrl; g.Worker = origWorker; };
}
describe.skipIf(!ENABLED || !fs.existsSync(path.join(dvDir, "main.js")))("real plugin: dataview in Live Preview", () => {
  it("renders query blocks and inline queries in the editor, raw text under the cursor", async () => {
    const { installBridge } = await import("../src/app/bridge");
    const read = (f: string) => fs.readFileSync(path.join(dvDir, f), "utf8");
    const home = "# Home\nName: `= this.file.name`\nJS: `$= dv.current().file.name`\n\n```dataview\nLIST FROM \"Notes\"\n```\n\nend\n";
    v = makeVault(
      { "Home.md": home, "Notes/Alpha.md": "a", "Notes/Beta.md": "b" },
      { plugins: { dataview: { manifest: JSON.parse(read("manifest.json")), main: read("main.js"), styles: read("styles.css"), data: { enableDataviewJs: true, enableInlineDataviewJs: true } } }, enabled: ["dataview"] },
    );
    const undoWorkers = installInlineWorkers();
    app = await makeApp(v);
    const undo = installBridge(app);
    try {
      document.body.appendChild(app.dom.appContainerEl);
      const dv = app.plugins.getPlugin("dataview") as any;
      await vi.waitFor(() => expect(dv?.index?.initialized).toBe(true), { timeout: 5000 });
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Home.md")!, { active: true });
      const cm = (leaf.view as any).editor.cm as import("@codemirror/view").EditorView;
      cm.dispatch({ selection: { anchor: cm.state.doc.length } }); // Dataview (re)scans on selection changes
      await vi.waitFor(() => {
        const inline = [...cm.contentDOM.querySelectorAll(".dataview-inline")].map((e) => e.textContent);
        expect(inline).toEqual(["Home", "Home"]);
        const items = [...cm.dom.querySelectorAll(".cm-preview-code-block.cm-lang-dataview .block-language-dataview li")].map((e) => e.textContent);
        expect(items.join(",")).toMatch(/Alpha.*Beta/);
      }, { timeout: 5000 });
      // cursor inside the inline query -> raw source; inside the block -> raw fence
      cm.dispatch({ selection: { anchor: home.indexOf("this.file") } });
      expect(cm.contentDOM.textContent).toContain("`= this.file.name`");
      expect(cm.contentDOM.querySelectorAll(".dataview-inline").length).toBe(1);
      cm.dispatch({ selection: { anchor: home.indexOf("LIST") } });
      expect(cm.dom.querySelector(".cm-lang-dataview")).toBeNull();
      expect(cm.contentDOM.textContent).toContain('LIST FROM "Notes"');
      // reading view: the inline post-processor's render children are loaded (preview mode is a child of the view)
      (leaf.view as any).setMode("preview");
      const reading = (leaf.view as any).previewEl as HTMLElement;
      await vi.waitFor(() => {
        expect(reading.textContent).toContain("Name: Home");
        expect(reading.textContent).toContain("JS: Home");
        expect(reading.querySelectorAll(".block-language-dataview li").length).toBe(2);
      }, { timeout: 5000 });
    } finally { undo(); undoWorkers(); }
  }, 30_000);
});

const gitDir = dirOf("obsidian-git");
describe.skipIf(!ENABLED || !fs.existsSync(path.join(gitDir, "main.js")))("real plugin: obsidian-git through the Node bridge", () => {
  it("sees the repository, lists changes and commits them with git", async () => {
    const read = (f: string) => fs.readFileSync(path.join(gitDir, f), "utf8");
    v = makeVault({ "Note.md": "# Note\n" }, { plugins: { "obsidian-git": { manifest: JSON.parse(read("manifest.json")), main: read("main.js"), styles: read("styles.css") } }, enabled: ["obsidian-git"], bridgeConsent: true });
    fs.writeFileSync(path.join(v.root, ".gitignore"), ".obsidian/\n");
    initRepo(v.root);
    app = await makeApp(v);
    document.body.appendChild(app.dom.appContainerEl);
    const plugin: any = app.plugins.getPlugin("obsidian-git");
    await vi.waitFor(() => expect(plugin.gitReady).toBe(true), { timeout: 10_000 });
    fs.writeFileSync(path.join(v.root, "Note.md"), "# Note\nedited\n");
    const status = await plugin.gitManager.status();
    expect(status.changed.map((f: any) => f.vaultPath ?? f.path)).toContain("Note.md");
    expect(app.commands.executeCommandById("obsidian-git:commit")).toBe(true);
    await vi.waitFor(() => expect(git(v!.root, "rev-list", "--count", "HEAD").trim()).toBe("2"), { timeout: 10_000 });
    expect(git(v.root, "show", "--stat", "--format=", "HEAD")).toContain("Note.md");
    plugin.gitManager.askpass = async () => {}; // see above: no retry after unload
  }, 60_000);
});

const heDir = dirOf("obsidian-hover-editor");
describe.skipIf(!ENABLED || !fs.existsSync(path.join(heDir, "main.js")))("real plugin: obsidian-hover-editor on the page preview core plugin", () => {
  it("replaces the page preview with an editable hover editor showing the linked note", async () => {
    const read = (f: string) => fs.readFileSync(path.join(heDir, f), "utf8");
    v = makeVault({ "Home.md": "See [[Note]]\n", "Note.md": "# Note\nhello from note" }, { plugins: { "obsidian-hover-editor": { manifest: JSON.parse(read("manifest.json")), main: read("main.js"), styles: read("styles.css") } }, enabled: ["obsidian-hover-editor"] });
    const h: { undo?: () => void; off?: () => void } = {};
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a); });
    try {
      app = await makeApp(v, { onCoreReady: (a) => { h.undo = installBridge(a); h.off = pagePreview.install(a) || undefined; } });
      document.body.appendChild(app.dom.appContainerEl);
      expect(app.plugins.loadErrors["obsidian-hover-editor"]).toBeUndefined();
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getFileByPath("Home.md")!, { active: true });
      const view = leaf.view as any;
      view.setMode("preview");
      await view.previewMode.whenRendered();
      view.previewEl.querySelector("a.internal-link")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await vi.waitFor(() => {
        const pop = document.querySelector(".popover.hover-popover.hover-editor");
        expect(pop?.textContent).toContain("hello from note");
      }, { timeout: 5000 });
      expect(errors.map((e) => String((e as any[])[0]))).toEqual([]);
    } finally { spy.mockRestore(); h.off?.(); h.undo?.(); }
  }, 30_000);
});
