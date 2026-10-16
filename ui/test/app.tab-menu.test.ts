// The tab header context menu lists each action once.
import { it } from "vitest";
import { expect } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault } from "./helpers/backend";
import { startSession } from "../src/app/session";
it("tab header menu has no duplicate entries", async () => {
  document.body.innerHTML = "";
  const v = makeVault({ "Note.md": "x\n" });
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  const s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  await s.app.workspace.openLinkText("Note", "", false);
  const leaf = s.app.workspace.activeLeaf!;
  (s as any).shell?.tabMenu?.(leaf, new MouseEvent("contextmenu"));
  const el = [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent);
  expect(el.length).toBeGreaterThan(10);
  expect(el.filter((t, i) => el.indexOf(t) !== i)).toEqual([]);
  expect(el).toEqual(expect.arrayContaining(["Close", "Pin", "Open in new window", "Reveal file in navigation", "Copy path from vault folder"]));
  await s.stop();
});

it("the More options menu has Find, Replace and Add file property, and no duplicate entries", async () => {
  document.body.innerHTML = "";
  const v = makeVault({ "Note.md": "x\n" });
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  const s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  await s.app.workspace.openLinkText("Note", "", false);
  (s.app.workspace.activeLeaf!.view as any).showMoreMenu(new MouseEvent("click"));
  const el = [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent);
  expect(el.filter((t, i) => el.indexOf(t) !== i)).toEqual([]);
  expect(el).toEqual(expect.arrayContaining(["Find...", "Replace...", "Add file property", "Split right", "Pin", "Open in new window", "Rename...", "Delete"]));
  expect(el).not.toContain("Open in new tab");
  await s.stop();
});

it("the note's reading view gets heading fold arrows, switched by the foldHeading setting", async () => {
  document.body.innerHTML = "";
  const v = makeVault({ "Note.md": "# A\ntext\n\n## B\nmore\n" });
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  const s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  await s.app.workspace.openLinkText("Note", "", false);
  const view = s.app.workspace.activeLeaf!.view as any;
  s.app.commands.executeCommandById("markdown:toggle-preview");
  const { vi } = await import("vitest");
  await vi.waitFor(() => expect(view.containerEl.querySelectorAll(".heading-collapse-indicator").length).toBe(2));
  s.app.vault.setConfig("foldHeading", false);
  view.previewMode.rerender(true);
  await vi.waitFor(() => expect(view.containerEl.querySelectorAll(".heading-collapse-indicator").length).toBe(0));
  await s.stop();
});
