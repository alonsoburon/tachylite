// "Open linked view" in a tab's menu links the tab the menu belongs to, even when the same note is open in several tabs
// (it used to link the first tab showing that file; found by the real-window smoke test).
import { expect, it } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault } from "./helpers/backend";
import { startSession } from "../src/app/session";
import { buildFileMenu } from "../src/app/files";

it("links the tab the menu was opened for", async () => {
  document.body.innerHTML = "";
  const v = makeVault({ "Doc.md": "# Doc\n" });
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  const s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  const app = s.app as any;
  const file = app.vault.getFileByPath("Doc.md");
  const first = app.workspace.getLeaf("tab"); await first.openFile(file);
  const second = app.workspace.getLeaf("tab"); await second.openFile(file);
  app.workspace.setActiveLeaf(first, { focus: true });
  const menu = buildFileMenu(app, file, "tab-header", undefined, second);
  const item = (menu as any).items.find((i: any) => i.titleEl?.textContent === "Open linked view");
  expect(item).toBeTruthy();
  const outline = item.submenu.items.find((i: any) => i.titleEl?.textContent === "Open outline");
  outline.callback(new MouseEvent("click"));
  await new Promise((r) => setTimeout(r, 50));
  expect(second.group).toBeTruthy();
  expect(first.group).toBeNull();
  await s.stop();
});
