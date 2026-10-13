// Helpers to drive settings tabs through their DOM.
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { FakeVault } from "./backend";
import type { App } from "../../src/obsidian/app";

export function readJson(v: FakeVault, rel: string): any {
  const p = path.join(v.root, rel);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}
export function tabOf(app: App, id: string) {
  const t = [...app.setting.settingTabs, ...app.setting.pluginTabs].find((x) => x.id === id);
  if (!t) throw new Error(`no tab ${id}`);
  return t;
}
/** Display a tab and wait until some content is rendered. */
export async function show(app: App, id: string) {
  const t = tabOf(app, id);
  t.display();
  await vi.waitFor(() => { if (!t.containerEl.querySelector(".setting-item")) throw new Error("not rendered"); });
  return t;
}
export function row(root: HTMLElement, name: string): HTMLElement {
  const el = [...root.querySelectorAll<HTMLElement>(".setting-item")].find((s) => s.querySelector(".setting-item-name")?.textContent?.trim() === name);
  if (!el) throw new Error(`no setting row "${name}"`);
  return el;
}
export const clickToggle = (r: HTMLElement) => r.querySelector<HTMLElement>(".checkbox-container")!.click();
export function pick(r: HTMLElement, value: string) {
  const s = r.querySelector("select")!;
  s.value = value;
  s.dispatchEvent(new Event("change"));
}
export function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}
export const flush = () => new Promise((r) => setTimeout(r, 20));
export async function confirmTop(label?: string) {
  const btns = [...document.querySelectorAll<HTMLElement>(".modal.mod-confirmation .modal-button-container button")];
  const b = label ? btns.find((x) => x.textContent === label) : btns[0];
  if (!b) throw new Error("no confirm dialog");
  b.click();
}
