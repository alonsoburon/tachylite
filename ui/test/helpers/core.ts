// Boots a vault + App with the core side-panel modules installed (shared by app.core.*.test.ts).
import { makeApp, makeVault, type FakeVault } from "./backend";
import { setBackend } from "../../src/ipc";
import { coreModules } from "../../src/app/core";
import type { App } from "../../src/obsidian/app";

export interface Core { v: FakeVault; app: App; dispose(): Promise<void> }

/** `stubs` answer backend commands the fake backend lacks (e.g. vault_search); others fall through. */
export async function bootCore(files: Record<string, string>, stubs: Record<string, (args: any) => unknown> = {}): Promise<Core> {
  const v = makeVault(files);
  setBackend(async (cmd, a) => (stubs[cmd] ? stubs[cmd](a) : v.backend(cmd, a)));
  const app = await makeApp(v);
  const offs = coreModules.map((m) => m.install(app));
  document.body.appendChild(app.dom.appContainerEl);
  return {
    v, app,
    async dispose() {
      offs.forEach((o) => typeof o === "function" && o());
      // Detach the leaves so their CodeMirror views are destroyed; a live view keeps timers that fire after the window is gone.
      app.workspace.iterateAllLeaves((l) => { try { l.detach(); } catch { /* already gone */ } });
      await app.stop(); v.cleanup(); document.body.innerHTML = "";
    },
  };
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
