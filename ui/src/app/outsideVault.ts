// Commands that leave the current vault: the sandbox vault, "Open vault..." and "Open file from outside the vault...".
import { ipc } from "../ipc";
import { Notice, Platform, type App } from "../obsidian";
import { chooseFolder } from "./picker";
import { handleUri, matchVault, parseUri } from "./uri";

/** A clean reload is how vaults are swapped (it drops every global the old App installed). */
function switchTo(path: string): void {
  sessionStorage.setItem("tachylite-open", path);
  location.reload();
}

const tauri = () => (globalThis as any).__TAURI__;
const parentOf = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || "/";
const failure = (e: unknown) => new Notice(String((e as Error)?.message ?? e));

/** Open (creating it when needed) a throwaway vault in the OS temp directory. */
export async function openSandboxVault(): Promise<void> {
  const tmp: string | undefined = await tauri()?.path?.tempDir?.();
  if (!tmp) throw new Error("The sandbox vault is only available in the desktop app.");
  const path = `${tmp.replace(/[\\/]+$/, "")}/Tachylite Sandbox`;
  try { await ipc.vaultCreate(path); } catch { await ipc.vaultOpen(path); }
  switchTo(path);
}

/** "Open vault...": choose a folder and open it as a vault. */
export async function openAnotherVault(): Promise<void> {
  const p = await chooseFolder("Open vault");
  if (p) switchTo(p);
}

/** "Open file from outside the vault...": a file dialog limited to the extensions a view is registered for. A file in
 * a known vault opens there; any other file opens its folder as a vault first. */
export async function openFileFromOutside(app: App): Promise<void> {
  const dlg = tauri()?.dialog;
  if (!dlg?.open) throw new Error("The file dialog is not available outside the desktop app.");
  const extensions = Object.keys(app.viewRegistry.typeByExtension);
  const r = await dlg.open({ multiple: false, directory: false, title: "Open file", filters: [{ name: "Supported files", extensions }] });
  const abs: string | null = typeof r === "string" ? r : Array.isArray(r) ? r[0] ?? null : null;
  if (!abs) return;
  const uri = `tachylite://open?path=${encodeURIComponent(abs)}`;
  const recents = await ipc.vaultsRecent().catch(() => [] as string[]);
  const params = parseUri(uri, Platform.isWin);
  if (params && matchVault(params, { name: app.vault.getName(), path: app.vault.adapter.getBasePath() }, recents, !Platform.isLinux)) { await handleUri(app, uri); return; }
  // Not inside any known vault: open the file's folder as one and the file in it.
  const folder = parentOf(abs);
  sessionStorage.setItem("tachylite-uri", JSON.stringify([uri]));
  switchTo(folder);
}

export function registerOutsideVaultCommands(app: App, add: (c: any) => void): void {
  add({ id: "app:open-sandbox-vault", name: "Open sandbox vault", callback: () => { void openSandboxVault().catch(failure); } });
  add({ id: "app:open-another-vault", name: "Open vault...", callback: () => { void openAnotherVault().catch(failure); } });
  add({ id: "app:open-file", name: "Open file from outside the vault...", callback: () => { void openFileFromOutside(app).catch(failure); } });
  add({
    id: "workspace:show-trash", name: "Show deleted files",
    // Like Obsidian 1.14.4: only with "Deleted files: move to Obsidian trash", and it shows the .trash folder in the system file manager.
    checkCallback: (checking: boolean) => {
      if (app.vault.getConfig("trashOption") !== "local") return false;
      if (!checking) void ipc.openInSystem(".trash", true).catch(failure);
      return true;
    },
  });
}
