// Entry sequence: decide which vault to open (CLI / env / picker), then start a session.
import { ipc } from "../ipc";
import { showPicker } from "./picker";
import { startSession, type Session } from "./session";

let session: Session | null = null;
export function getSession(): Session | null { return session; }

async function open(host: HTMLElement, path: string, create: boolean, script?: string | null): Promise<void> {
  host.replaceChildren();
  host.createDiv({ cls: "vault-loading", text: "Opening vault..." });
  const info = create ? await ipc.vaultCreate(path) : await ipc.vaultOpen(path);
  session = await startSession(info, host, { script });
}

export async function boot(host: HTMLElement): Promise<void> {
  let launch: { vault: string | null; script: string | null } = { vault: null, script: null };
  try { launch = await ipc.launchArgs(); } catch { /* not running inside Tauri */ }
  const showPick = sessionStorage.getItem("tachylite-show-picker") === "1";
  sessionStorage.removeItem("tachylite-show-picker");
  const next = sessionStorage.getItem("tachylite-open");
  sessionStorage.removeItem("tachylite-open");
  const target = showPick ? null : next ?? launch.vault;
  const handlers = {
    onOpen: async (p: string, create: boolean) => {
      // A clean reload is the simplest way to swap vaults: it drops every global the previous App installed.
      if (session) { sessionStorage.setItem("tachylite-open", p); location.reload(); return; }
      await open(host, p, create);
    },
  };
  if (target) {
    try { await open(host, target, false, launch.script); return; }
    catch (e) { console.error("could not open vault", target, e); await showPicker(host, handlers, `Could not open ${target}: ${(e as Error).message ?? e}`); return; }
  }
  await showPicker(host, handlers);
  if (launch.script) {
    // Developer automation (TACHYLITE_SCRIPT) also works on the picker; `app`/`shell` are null there.
    try { await new Function("app", "shell", "ipc", `return (async () => {\n${launch.script}\n})();`)(null, null, ipc); }
    catch (e) { console.error("TACHYLITE_SCRIPT failed", e); }
  }
}
