// File recovery (IndexedDB snapshots, modal, settings), Workspaces (workspaces.json, modal, commands) and
// Outgoing links' unlinked mentions, against the fake backend with the full shell.
import "fake-indexeddb/auto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { diffLines, type FileRecovery } from "../src/app/core/fileRecovery";
import { findUnlinkedMentions } from "../src/app/core/links";
import type { OutgoingLinksView, BacklinksView } from "../src/app/core/links";

let v: FakeVault;
let s: Session;
const q = <T extends HTMLElement = HTMLElement>(sel: string, r: ParentNode = document) => r.querySelector<T>(sel);
const qa = (sel: string, r: ParentNode = document) => [...r.querySelectorAll<HTMLElement>(sel)];
const disk = (p: string) => fs.readFileSync(path.join(v.root, p), "utf8");
const json = (p: string) => JSON.parse(disk(p));
const btn = (text: string, r: ParentNode = document) => qa("button", r).find((b) => b.textContent?.trim() === text)!;

async function boot(files: Record<string, string>, core: Record<string, boolean> = {}): Promise<Session> {
  v = makeVault({ ...files, ".obsidian/core-plugins.json": JSON.stringify(core) });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
  s = await startSession((await v.backend("vault_info")) as any, document.body.createDiv());
  return s;
}
beforeEach(() => { document.body.innerHTML = ""; localStorage.clear(); });
afterEach(async () => { await s?.stop(); if (v) { v.cleanup(); indexedDB.deleteDatabase(`tachylite-backup:${v.root}`); } document.body.innerHTML = ""; });

describe("file recovery", () => {
  it("diffs lines", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { type: "same", text: "a" }, { type: "remove", text: "b" }, { type: "add", text: "x" }, { type: "same", text: "c" }, { type: "add", text: "d" },
    ]);
    expect(diffLines("same", "same")).toEqual([{ type: "same", text: "same" }]);
  });

  it("snapshots on save at most once per interval, prunes, restores and shows a diff", async () => {
    await boot({ "Note.md": "v1\n", ".obsidian/file-recovery.json": JSON.stringify({ intervalMinutes: 0, keepDays: 7 }) });
    const fr = (s.app.internalPlugins.getPluginById("file-recovery")!.instance as any).plugin as FileRecovery;
    await fr.ready;
    const f = s.app.vault.getFileByPath("Note.md")!;
    await s.app.vault.modify(f, "v1\nline two\n");
    await vi.waitFor(async () => expect(await fr.store.versions("Note.md")).toHaveLength(1));
    await s.app.vault.modify(f, "v1\nline 2\nthree\n");
    await vi.waitFor(async () => expect((await fr.store.versions("Note.md")).map((x) => x.data)).toEqual(["v1\nline 2\nthree\n", "v1\nline two\n"]));
    // identical content is not stored twice
    expect(await fr.snapshot(f)).toBe(false);
    // with a 5 minute interval a second save is only remembered
    fr.app.internalPlugins.plugins["file-recovery"].instance.options.intervalMinutes = 5;
    await s.app.vault.modify(f, "v1\nchanged soon\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(await fr.store.versions("Note.md")).toHaveLength(2);
    // modal: files list, versions, diff with the previous version, restore
    s.app.commands.executeCommandById("file-recovery:open");
    await vi.waitFor(() => expect(qa(".mod-file-recovery .file-recovery-files .file-recovery-list-item-header").map((e) => e.dataset.path)).toEqual(["Note.md"]));
    await vi.waitFor(() => expect(qa(".mod-file-recovery .file-recovery-versions .file-recovery-list-item-header")).toHaveLength(2));
    expect(q(".mod-file-recovery .file-recovery-text")!.textContent).toBe("v1\nline 2\nthree\n");
    const toggle = q(".mod-file-recovery .file-recovery-toolbar .checkbox-container")!;
    toggle.click();
    await vi.waitFor(() => expect(q(".mod-file-recovery .file-recovery-diff")).toBeTruthy());
    expect(qa(".file-recovery-diff .diff-line").map((d) => `${d.classList.contains("mod-added") ? "+" : d.classList.contains("mod-removed") ? "-" : " "}${d.textContent}`))
      .toEqual([" v1", "-line two", "+line 2", "+three", " "]);
    qa(".mod-file-recovery .file-recovery-versions .file-recovery-list-item-header")[1].click();
    btn("Restore", q(".mod-file-recovery")!).click();
    await vi.waitFor(() => expect(disk("Note.md")).toBe("v1\nline two\n"));
    // the content before restoring became a snapshot too
    expect((await fr.store.versions("Note.md")).map((x) => x.data)).toContain("v1\nchanged soon\n");
    // keep days prune by timestamp
    await fr.store.add({ path: "Old.md", ts: Date.now() - 30 * 86_400_000, data: "old" });
    expect(await fr.prune()).toBe(1);
  });

  it("has an options tab writing file-recovery.json and goes away when disabled", async () => {
    await boot({ "Note.md": "x\n" });
    s.app.setting.open();
    expect(qa(".vertical-tab-header-group-title").map((e) => e.textContent)).toContain("Core plugins");
    s.app.setting.openTabById("file-recovery");
    const inputs = qa(".vertical-tab-content input[type=number]") as HTMLInputElement[];
    inputs[0].value = "2"; inputs[0].dispatchEvent(new Event("input"));
    inputs[1].value = "30"; inputs[1].dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(json(".obsidian/file-recovery.json")).toEqual({ intervalMinutes: 2, keepDays: 30 }));
    expect(btn("View")).toBeTruthy();
    // core plugins list shows a gear for it
    s.app.setting.openTabById("core-plugins");
    expect(q('.core-plugin-item[data-plugin-id="file-recovery"] .extra-setting-button, .core-plugin-item[data-plugin-id="file-recovery"] .clickable-icon')).toBeTruthy();
    await s.app.internalPlugins.plugins["file-recovery"].disable();
    expect(s.app.setting.settingTabs.some((t) => t.id === "file-recovery")).toBe(false);
    expect(s.app.commands.findCommand("file-recovery:open")).toBeFalsy();
    expect(json(".obsidian/core-plugins.json")["file-recovery"]).toBe(false);
    s.app.setting.close();
  });
});

describe("workspaces", () => {
  it("saves, loads and deletes named layouts in workspaces.json", async () => {
    await boot({ "A.md": "a\n", "B.md": "b\n" }, { workspaces: true });
    const ws = s.app.workspace;
    await ws.openLinkText("A", "", false);
    expect(qa(".side-dock-ribbon-action, .workspace-ribbon .clickable-icon").some((e) => e.getAttribute("aria-label") === "Manage workspace layouts")).toBe(true);
    s.app.commands.executeCommandById("workspaces:open-modal");
    const modal = q(".mod-workspaces")!;
    const input = q<HTMLInputElement>("input", modal)!;
    input.value = "Writing";
    btn("Save", modal).click();
    await vi.waitFor(() => expect(json(".obsidian/workspaces.json").active).toBe("Writing"));
    const saved = json(".obsidian/workspaces.json");
    expect(Object.keys(saved.workspaces)).toEqual(["Writing"]);
    expect(JSON.stringify(saved.workspaces.Writing.main)).toContain('"file":"A.md"');
    expect(saved.workspaces.Writing.lastOpenFiles).toBeUndefined();
    // change the layout, save it as another workspace, then load the first one back
    await ws.openLinkText("B", "", "tab");
    input.value = "Research";
    btn("Save", modal).click();
    await vi.waitFor(() => expect(json(".obsidian/workspaces.json").active).toBe("Research"));
    await vi.waitFor(() => expect(qa(".workspace-item", modal).map((e) => e.dataset.workspace)).toEqual(["Research", "Writing"]));
    qa(".workspace-item", modal).find((e) => e.dataset.workspace === "Writing")!.querySelector<HTMLElement>("button.mod-load")!.click();
    await vi.waitFor(() => expect(json(".obsidian/workspaces.json").active).toBe("Writing"));
    expect(ws.getLeavesOfType("markdown").map((l: any) => l.view.file?.path)).toEqual(["A.md"]);
    // workspaces:save stores the current layout into the active one
    await ws.openLinkText("B", "", "tab");
    s.app.commands.executeCommandById("workspaces:save");
    await vi.waitFor(() => expect(JSON.stringify(json(".obsidian/workspaces.json").workspaces.Writing.main)).toContain('"file":"B.md"'));
    // load command: suggest modal
    s.app.commands.executeCommandById("workspaces:load");
    await vi.waitFor(() => expect(qa(".prompt .suggestion-item").map((e) => e.textContent)).toEqual(["Research", "Writing"]));
    qa(".prompt .suggestion-item")[0].click();
    await vi.waitFor(() => expect(json(".obsidian/workspaces.json").active).toBe("Research"));
    // delete
    s.app.commands.executeCommandById("workspaces:open-modal");
    const m2 = qa(".mod-workspaces").pop()!;
    q(".workspace-item[data-workspace=Writing] .mod-delete", m2)!.click();
    await vi.waitFor(() => expect(Object.keys(json(".obsidian/workspaces.json").workspaces)).toEqual(["Research"]));
    // the plugin instance exposes the data like Obsidian's
    expect((s.app.internalPlugins.getPluginById("workspaces")!.instance as any).activeWorkspace).toBe("Research");
    await s.app.internalPlugins.plugins["workspaces"].disable();
    expect(s.app.commands.findCommand("workspaces:load")).toBeFalsy();
    expect(qa(".workspace-ribbon .clickable-icon").some((e) => e.getAttribute("aria-label") === "Manage workspace layouts")).toBe(false);
  });
});

describe("outgoing links", () => {
  const files = {
    "Home.md": "---\ntags: [x]\n---\nLinks [[Target]] and [[Missing]].\nTalks about Other note and the Alias Name here.\nAlso Target again.\n",
    "Other note.md": "other\n",
    "Aliased.md": "---\naliases: [Alias Name]\n---\nx\n",
    "Target.md": "t\n",
  };
  it("lists links, unresolved links and unlinked mentions with a Link button; state round trip", async () => {
    await boot(files);
    await s.app.workspace.openLinkText("Home", "", false);
    const leaf = await s.app.workspace.ensureSideLeaf("outgoing-link", "right", { active: false });
    const view = leaf.view as unknown as OutgoingLinksView;
    await vi.waitFor(() => expect(qa(".mod-links .outgoing-link-item", view.contentEl).map((e) => e.textContent)).toEqual(["Target", "Missing"]));
    expect(q(".mod-links .outgoing-link-item.is-unresolved", view.contentEl)!.textContent).toBe("Missing");
    expect(view.getState()).toEqual({ unlinkedCollapsed: true });
    q(".outgoing-link-section.mod-unlinked > .tree-item-self", view.contentEl)!.click();
    expect(view.getState()).toEqual({ unlinkedCollapsed: false });
    await vi.waitFor(() => expect(qa(".mod-unlinked .outgoing-link-item .tree-item-inner", view.contentEl).map((e) => e.textContent)).toEqual(["Aliased", "Other note"]));
    // "Target" is already linked, so its plain mention is not offered
    const row = q('.mod-unlinked .outgoing-link-item[data-path="Other note.md"] .search-result-file-match', view.contentEl)!;
    btn("Link", row).click();
    await vi.waitFor(() => expect(disk("Home.md")).toContain("Talks about [[Other note]] and the Alias Name here."));
    await vi.waitFor(() => expect(q('.mod-unlinked .outgoing-link-item[data-path="Aliased.md"] .search-result-file-match', view.contentEl)).toBeTruthy());
    btn("Link", q('.mod-unlinked .outgoing-link-item[data-path="Aliased.md"] .search-result-file-match', view.contentEl)!).click();
    await vi.waitFor(() => expect(disk("Home.md")).toContain("Talks about [[Other note]] and the [[Aliased|Alias Name]] here."));
    await view.setState({ unlinkedCollapsed: true });
    expect(q(".outgoing-link-section.mod-unlinked.is-collapsed", view.contentEl)).toBeTruthy();
  });

  it("backlinks' unlinked mentions can be linked too", async () => {
    await boot({ "Target.md": "t\n", "Other.md": "Plain mention of Target in prose.\n" });
    await s.app.workspace.openLinkText("Target", "", false);
    const leaf = await s.app.workspace.ensureSideLeaf("backlink", "right", { active: false });
    const view = leaf.view as unknown as BacklinksView;
    await view.setState({ unlinkedCollapsed: false });
    await vi.waitFor(() => expect(q(".backlink-unlinked .search-result-file-match", view.contentEl)).toBeTruthy());
    btn("Link", q(".backlink-unlinked .search-result-file-match", view.contentEl)!).click();
    await vi.waitFor(() => expect(disk("Other.md")).toBe("Plain mention of [[Target]] in prose.\n"));
    expect(findUnlinkedMentions(disk("Other.md"), ["Target"])).toEqual([]);
  });
});
