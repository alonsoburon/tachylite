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
import { nodeBridge } from "../src/obsidian/nodeBridge";

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
  { id: "obsidian-excalidraw-plugin", dir: dirOf("obsidian-excalidraw-plugin"), minCommands: 1, settingsTab: true, allowErrors: /reading .(document|canvas)./ /* iframe.contentWindow (happy-dom); core Canvas plugin not implemented */ },
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

let v: FakeVault | undefined, app: App | undefined;
const git = (root: string, ...args: string[]) => cp.execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const initRepo = (root: string) => { git(root, "init", "-q", "-b", "main"); git(root, "config", "user.name", "t"); git(root, "config", "user.email", "t@t"); git(root, "add", "-A"); git(root, "commit", "-qm", "initial"); };
afterEach(async () => { await app?.stop(); v?.cleanup(); nodeBridge.reset(); document.body.innerHTML = ""; document.head.innerHTML = ""; v = app = undefined; });

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
      app = await makeApp(v);
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
