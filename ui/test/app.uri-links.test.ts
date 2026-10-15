// obsidian:// and tachylite:// links clicked in a note are handled by the app itself, not handed to the OS.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { openExternal } from "../src/app/bridge";

let v: FakeVault;
let session: Session | null = null;
const opened: string[] = [];

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear(); opened.length = 0;
  v = makeVault({ "Note.md": "x\n", "Other.md": "# Other\n" });
  setBackend(async (cmd, a: any) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      case "vaults_recent": return [];
      case "open_url": opened.push(a.url); return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

describe("openExternal", () => {
  it("opens an obsidian:// link to a file inside the app", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    const app = session.app;
    openExternal(`obsidian://open?vault=${encodeURIComponent(app.vault.getName())}&file=Other`, app);
    await vi.waitFor(() => expect((app.workspace.activeLeaf!.view as any).file?.basename).toBe("Other"));
    expect(opened).toEqual([]);
  });

  it("still sends web links to the system", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    session = await startSession((await v.backend("vault_info")) as any, host);
    openExternal("https://example.com/", session.app);
    await vi.waitFor(() => expect(opened).toEqual(["https://example.com/"]));
  });
});
