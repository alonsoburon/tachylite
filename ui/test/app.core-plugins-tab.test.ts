// Settings > Core plugins is honest about plugins Tachylite does not provide.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { show } from "./helpers/settings";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "x\n" });
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

describe("core plugins tab", () => {
  it("marks Sync, Publish, Web viewer and Format converter as unavailable and keeps their switches off and disabled", async () => {
    session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
    const el = (await show(session.app, "core-plugins")).containerEl;
    for (const id of ["sync", "publish", "webviewer", "markdown-importer"]) {
      const item = el.querySelector<HTMLElement>(`.core-plugin-item[data-plugin-id="${id}"]`);
      if (!item) continue; // not listed for this vault
      expect(item.classList.contains("is-unavailable"), id).toBe(true);
      expect(item.textContent, id).toContain("Not available in Tachylite");
      const toggle = item.querySelector<HTMLElement>(".checkbox-container")!;
      expect(toggle.classList.contains("is-enabled"), id).toBe(false);
      expect(toggle.classList.contains("is-disabled"), id).toBe(true);
    }
    // At least the two that every vault lists, so the loop above cannot pass vacuously.
    expect(el.querySelectorAll(".core-plugin-item.is-unavailable").length).toBeGreaterThan(1);
    // Plugins that exist are untouched.
    expect(el.querySelector('.core-plugin-item[data-plugin-id="graph"]')?.classList.contains("is-unavailable")).toBe(false);
  });
});
