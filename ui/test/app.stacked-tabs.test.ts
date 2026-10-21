// Stacked tabs: toggling, layout round-trip, the command and the tab list menu entry.
import { expect, it } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault } from "./helpers/backend";
import { startSession } from "../src/app/session";
import { WorkspaceTabs } from "../src/obsidian";

async function boot() {
  document.body.innerHTML = "";
  const v = makeVault({ "A.md": "a\n", "B.md": "b\n", "C.md": "c\n" });
  setBackend(async (cmd, a) => { switch (cmd) { case "meta_backlinks": case "meta_tags": return {}; case "vault_search": return []; case "launch_args": return { vault: null, script: null }; case "log_frontend": return null; default: return v.backend(cmd, a); } });
  const s = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  for (const n of ["A", "B", "C"]) { s.app.workspace.getLeaf("tab"); await s.app.workspace.openLinkText(n, "", true); }
  return s;
}
const tabsOf = (s: any) => s.app.workspace.activeLeaf.parent as WorkspaceTabs;

it("the command toggles mod-stacked, moves headers next to their panes and serialises stacked: true", async () => {
  const s = await boot();
  const cmd = s.app.commands.commands["workspace:toggle-stacked-tabs"];
  expect(cmd.name).toBe("Toggle stacked tabs");
  expect(cmd.hotkeys ?? []).toEqual([]);
  const tabs = tabsOf(s), n = tabs.children.length;
  expect(n).toBeGreaterThanOrEqual(3);
  expect(tabs.containerEl.classList.contains("mod-stacked")).toBe(false);
  expect(JSON.stringify(s.app.workspace.getLayout())).not.toContain("stacked");
  expect(s.app.commands.executeCommandById("workspace:toggle-stacked-tabs")).toBe(true);
  expect(tabs.containerEl.classList.contains("mod-stacked")).toBe(true);
  expect(tabs.tabHeaderContainerEl.children.length).toBe(0);
  const kids = [...tabs.tabContainerEl.children] as HTMLElement[];
  expect(kids.map((k) => k.classList.contains("workspace-tab-header"))).toEqual(Array.from({ length: n * 2 }, (_, i) => i % 2 === 0));
  expect(kids[0].style.left).toBe("0px");
  expect(kids[0].style.right).toBe(`${(n - 1) * 40}px`);
  expect(kids[1].style.left).toBe("40px");
  expect(kids.filter((k) => k.classList.contains("workspace-leaf")).every((k) => k.style.display === "")).toBe(true);
  const saved = (s.app.workspace.getLayout() as any).main.children.find((c: any) => c.type === "tabs");
  expect(saved.stacked).toBe(true);
  s.app.commands.executeCommandById("workspace:toggle-stacked-tabs");
  expect(tabs.containerEl.classList.contains("mod-stacked")).toBe(false);
  expect(tabs.tabHeaderContainerEl.children.length).toBe(n);
  expect(JSON.stringify(s.app.workspace.getLayout())).not.toContain("stacked");
  await s.stop();
});

it("a stacked tab group survives getLayout/changeLayout", async () => {
  const s = await boot();
  tabsOf(s).setStacked(true);
  const layout = JSON.parse(JSON.stringify(s.app.workspace.getLayout()));
  await s.app.workspace.changeLayout(layout);
  const tabs = tabsOf(s);
  expect(tabs.isStacked).toBe(true);
  expect(tabs.containerEl.classList.contains("mod-stacked")).toBe(true);
  await s.stop();
});

it("the tab list menu offers Stack tabs / Unstack tabs", async () => {
  const s = await boot();
  const tabs = tabsOf(s);
  const list = tabs.containerEl.querySelector(".workspace-tab-header-tab-list") as HTMLElement;
  const titles = () => [...document.querySelectorAll(".menu-item-title")].map((e) => e.textContent);
  list.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(titles()[0]).toBe("Stack tabs");
  (document.querySelector(".menu-item") as HTMLElement).click();
  expect(tabs.isStacked).toBe(true);
  document.body.querySelectorAll(".menu").forEach((m) => m.remove());
  list.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(titles()[0]).toBe("Unstack tabs");
  await s.stop();
});
