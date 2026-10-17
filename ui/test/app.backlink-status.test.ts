// The Backlinks core plugin adds "N backlinks" to the status bar for the active note.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Target.md": "# T\n", "A.md": "[[Target]] and [[Target|again]]", "B.md": "[[Target]]", "Lonely.md": "x\n", "pic.png": "" });
  setBackend(async (cmd, a) => {
    switch (cmd) {
      case "meta_backlinks": case "meta_tags": return {};
      case "vault_search": return [];
      case "launch_args": return { vault: null, script: null };
      case "log_frontend": return null;
      default: return v.backend(cmd, a);
    }
  });
});
afterEach(async () => { await session?.stop(); session = null; v.cleanup(); document.body.innerHTML = ""; });

const items = () => document.querySelectorAll<HTMLElement>(".status-bar-item.plugin-backlink");
const status = () => items()[0];

describe("backlinks status bar item", () => {
  it("counts the notes that link to the active note, pluralises, hides for non-notes, and opens the Backlinks view on click", async () => {
    session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
    const app = session.app;
    await app.workspace.openLinkText("Target", "", false);
    await vi.waitFor(() => expect(status()?.textContent).toBe("2 backlinks"));
    expect(items()).toHaveLength(1); // A links twice but counts once; and there is a single status bar item
    await app.workspace.openLinkText("Lonely", "", false);
    await vi.waitFor(() => expect(status()?.textContent).toBe("0 backlinks"));
    await app.vault.modify(app.vault.getFileByPath("Lonely.md")!, "[[Target]]");
    await app.workspace.openLinkText("A", "", false);
    await vi.waitFor(() => expect(status()?.textContent).toBe("0 backlinks"));
    await app.vault.modify(app.vault.getFileByPath("A.md")!, "[[Lonely]]");
    await app.workspace.openLinkText("Lonely", "", false);
    await vi.waitFor(() => expect(status()?.textContent).toBe("1 backlink"));
    status()!.click();
    await vi.waitFor(() => expect(app.workspace.getLeavesOfType("backlink")).toHaveLength(1));
  });
});
