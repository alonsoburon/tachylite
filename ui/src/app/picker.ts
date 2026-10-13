// Vault picker (start screen): recent vaults, open a folder, create a new vault.
import { ipc } from "../ipc";
import { setIcon } from "../obsidian/icons";

export interface PickerHandlers { onOpen(path: string, create: boolean): Promise<void> | void }

/** Folder chooser through the Tauri dialog plugin (`window.__TAURI__.dialog`). */
export async function chooseFolder(title: string): Promise<string | null> {
  const dlg = (globalThis as any).__TAURI__?.dialog;
  if (!dlg?.open) throw new Error("The folder dialog is not available outside the desktop app.");
  const r = await dlg.open({ directory: true, multiple: false, title });
  return typeof r === "string" ? r : Array.isArray(r) ? r[0] ?? null : null;
}

export async function showPicker(host: HTMLElement, h: PickerHandlers, message?: string): Promise<void> {
  host.replaceChildren();
  let recents: string[] = [];
  try { recents = await ipc.vaultsRecent(); } catch { /* no backend: empty list */ }
  const root = host.createDiv({ cls: "vault-picker" });
  const card = root.createDiv({ cls: "vault-picker-card" });
  const head = card.createDiv({ cls: "vault-picker-header" });
  const logo = head.createDiv({ cls: "vault-picker-logo" });
  setIcon(logo, "lucide-gem");
  head.createDiv({ cls: "vault-picker-title", text: "Tachylite" });
  head.createDiv({ cls: "vault-picker-subtitle", text: "Your notes, in plain files." });
  const error = card.createDiv({ cls: "vault-picker-error mod-hidden" });
  const fail = (e: unknown) => { error.setText(String((e as Error)?.message ?? e)); error.removeClass("mod-hidden"); };
  if (message) fail(message);

  const list = card.createDiv({ cls: "vault-picker-section" });
  list.createDiv({ cls: "vault-picker-heading", text: "Recent vaults" });
  const items = list.createDiv({ cls: "vault-picker-list" });
  if (!recents.length) items.createDiv({ cls: "vault-picker-empty", text: "No vaults yet." });
  for (const p of recents) {
    const row = items.createDiv({ cls: "vault-picker-item", attr: { tabindex: "0", "data-path": p } });
    const name = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
    const ic = row.createDiv({ cls: "vault-picker-item-icon" });
    setIcon(ic, "lucide-vault");
    const t = row.createDiv({ cls: "vault-picker-item-text" });
    t.createDiv({ cls: "vault-picker-item-name", text: name });
    t.createDiv({ cls: "vault-picker-item-path", text: p });
    const go = () => { Promise.resolve(h.onOpen(p, false)).catch(fail); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  const actions = card.createDiv({ cls: "vault-picker-actions" });
  const open = actions.createEl("button", { text: "Open folder as vault" });
  open.addEventListener("click", async () => {
    try {
      const p = await chooseFolder("Open folder as vault");
      if (p) await h.onOpen(p, false);
    } catch (e) { fail(e); }
  });
  const create = actions.createEl("button", { cls: "mod-cta", text: "Create new vault" });
  const form = card.createDiv({ cls: "vault-picker-create mod-hidden" });
  const nameInput = form.createEl("input", { type: "text", placeholder: "Vault name", attr: { spellcheck: "false" } });
  const where = form.createEl("button", { text: "Choose location..." });
  const loc = form.createDiv({ cls: "vault-picker-item-path" });
  const make = form.createEl("button", { cls: "mod-cta", text: "Create" });
  let parent = "";
  create.addEventListener("click", () => { form.removeClass("mod-hidden"); nameInput.focus(); });
  where.addEventListener("click", async () => {
    try { const p = await chooseFolder("Where should the vault be created?"); if (p) { parent = p; loc.setText(p); } } catch (e) { fail(e); }
  });
  make.addEventListener("click", async () => {
    const n = nameInput.value.trim();
    if (!n || /[\\/:*?"<>|]/.test(n)) { fail("Enter a valid vault name."); return; }
    if (!parent) { fail("Choose where to create the vault."); return; }
    try { await h.onOpen(`${parent.replace(/[\\/]+$/, "")}/${n}`, true); } catch (e) { fail(e); }
  });
}
