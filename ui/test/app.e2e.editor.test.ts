// End-to-end editor features against the fake backend: code highlighting in both views, plugin code blocks in Live
// Preview through the real bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { getCM, Vim } from "../src/editor";
import { clickToggle, readJson, row, show } from "./helpers/settings";
import fs from "node:fs";
import path from "node:path";

let v: FakeVault;
let session: Session | null = null;
const q = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s);
const qa = (s: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(s)];

const PLUGIN_MAIN = `
const { Plugin, MarkdownRenderChild } = require("obsidian");
module.exports = class Blocks extends Plugin {
  async onload() {
    window.__blockEvents = [];
    this.registerMarkdownCodeBlockProcessor("shout", (src, el, ctx) => {
      const child = new MarkdownRenderChild(el);
      child.onload = () => { window.__blockEvents.push("load"); el.createEl("b", { text: src.toUpperCase() }); };
      child.onunload = () => window.__blockEvents.push("unload");
      ctx.addChild(child);
      window.__blockEvents.push("section:" + JSON.stringify(ctx.getSectionInfo(el) && [ctx.getSectionInfo(el).lineStart, ctx.getSectionInfo(el).lineEnd]));
    });
  }
};`;

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  v = makeVault(
    { "Code.md": "# Code\n\n```js\nconst x = 1 // c\n```\n\n```shout\nhello\n```\n\nend\n" },
    { plugins: { blocks: { manifest: { id: "blocks", name: "Blocks", version: "1.0.0", minAppVersion: "0.15.0" }, main: PLUGIN_MAIN } }, enabled: ["blocks"] },
  );
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

async function boot(): Promise<Session> {
  const host = document.body.appendChild(document.createElement("div"));
  host.id = "app";
  session = await startSession((await v.backend("vault_info")) as any, host);
  return session;
}

describe("editor features (fake backend)", () => {
  it("highlights code and renders plugin code blocks in Live Preview and reading view", async () => {
    const s = await boot();
    s.app.saveLocalStorage("enable-plugin", true);
    await s.app.plugins.turnOnCommunityPlugins();
    await vi.waitFor(() => expect(s.app.plugins.getPlugin("blocks")).toBeTruthy());
    await s.app.workspace.openLinkText("Code", "", false);
    const view = s.app.workspace.activeLeaf!.view as any;
    const cm = view.editor.cm;
    cm.dispatch({ selection: { anchor: cm.state.doc.length } });
    await vi.waitFor(() => expect(q(".cm-preview-code-block.cm-lang-shout b")?.textContent).toBe("HELLO"));
    expect((window as any).__blockEvents).toEqual(["load", "section:[6,8]"]);
    expect(qa(".markdown-source-view .cm-keyword").map((e) => e.textContent)).toContain("const");
    // cursor into the block: raw source, child unloaded
    cm.dispatch({ selection: { anchor: cm.state.doc.toString().indexOf("hello") } });
    expect(q(".cm-preview-code-block")).toBeNull();
    expect((window as any).__blockEvents).toContain("unload");

    s.app.commands.executeCommandById("markdown:toggle-preview");
    await view.previewMode.whenRendered();
    await vi.waitFor(() => expect(qa(".markdown-reading-view pre code span.token").map((e) => `${e.className}|${e.textContent}`)).toEqual(expect.arrayContaining(["token keyword|const", "token comment|// c", "token number|1"])));
    expect(q(".markdown-reading-view .block-language-shout b")?.textContent).toBe("HELLO");
  });

  it("turns Vim key bindings on from Settings > Editor in open editors; :w saves the note", async () => {
    const s = await boot();
    await s.app.workspace.openLinkText("Code", "", false);
    const view = s.app.workspace.activeLeaf!.view as any;
    const cm = view.editor.cm;
    expect(getCM(cm)).toBeNull();
    expect((window as any).CodeMirrorAdapter.Vim).toBe(Vim);
    const tab = await show(s.app, "editor");
    clickToggle(row(tab.containerEl, "Vim key bindings"));
    await vi.waitFor(() => expect(readJson(v, ".obsidian/app.json")?.vimMode).toBe(true));
    expect(getCM(cm)).not.toBeNull();
    cm.dispatch({ selection: { anchor: 0 } });
    Vim.handleKey(getCM(cm) as any, "x", "user"); // deletes the "#"
    expect(view.editor.getValue().startsWith(" Code")).toBe(true);
    Vim.handleEx(getCM(cm) as any, "w");
    await vi.waitFor(() => expect(fs.readFileSync(path.join(v.root, "Code.md"), "utf8").startsWith(" Code")).toBe(true));
    clickToggle(row(tab.containerEl, "Vim key bindings"));
    await vi.waitFor(() => expect(getCM(cm)).toBeNull());
  });
});
