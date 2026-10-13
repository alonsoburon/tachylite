// Switching files in a leaf must not let Ctrl+Z restore the previous file's text into the new one.
import { afterEach, expect, it } from "vitest";
import { undo } from "@codemirror/commands";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault, session: Session | null = null;
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

it("each file opened in a leaf gets a fresh undo history", async () => {
  v = makeVault({ "A.md": "alpha\n", "B.md": "beta\n" });
  setBackend(async (cmd, a) => (["meta_backlinks", "meta_tags"].includes(cmd) ? {} : cmd === "vault_search" ? [] : cmd === "launch_args" ? { vault: null, script: null } : cmd === "log_frontend" ? null : v.backend(cmd, a)));
  const host = document.createElement("div"); document.body.appendChild(host);
  session = await startSession((await v.backend("vault_info")) as any, host);
  const ws = session.app.workspace;
  await ws.openLinkText("A", "", false);
  const view = ws.activeLeaf!.view as any;
  view.editor.replaceRange("typed ", { line: 0, ch: 0 });
  await ws.openLinkText("B", "", false);
  expect(ws.activeLeaf!.view).toBe(view);
  expect(view.editor.getValue()).toBe("beta\n");
  undo(view.editor.cm);
  expect(view.editor.getValue()).toBe("beta\n");
});
