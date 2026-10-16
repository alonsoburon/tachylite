// "Auto pair brackets" and "Auto pair Markdown syntax" switch the editor's pairing on and off.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { clickToggle, row, show } from "./helpers/settings";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Note.md": "\n" });
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

async function boot() {
  session = await startSession((await v.backend("vault_info")) as any, document.body.appendChild(document.createElement("div")));
  const app = session.app;
  await app.workspace.openLinkText("Note", "", false);
  const view = app.workspace.activeLeaf!.view as any;
  await vi.waitFor(() => expect(view.file?.basename).toBe("Note"));
  view.editor.focus = () => {};
  return { app, cm: view.editor.cm as EditorView };
}
/** Type one character through the editor's input handlers, then fall back to a plain insert. */
function typeChar(cm: EditorView, text: string) {
  const { from, to } = cm.state.selection.main;
  const handled = cm.state.facet(EditorView.inputHandler).some((h) => h(cm, from, to, text, () => cm.state.update({ changes: { from, to, insert: text } })));
  if (!handled) cm.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
}
const reset = (cm: EditorView) => cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: "" }, selection: { anchor: 0 } });

describe("auto pairing", () => {
  it("pairs brackets and backticks by default", async () => {
    const { cm } = await boot();
    reset(cm);
    typeChar(cm, "(");
    expect(cm.state.doc.toString()).toBe("()");
    reset(cm);
    typeChar(cm, "`");
    expect(cm.state.doc.toString()).toBe("``");
  });

  it("stops pairing brackets with Auto pair brackets off, but still pairs backticks", async () => {
    const { app, cm } = await boot();
    clickToggle(row((await show(app, "editor")).containerEl, "Auto pair brackets"));
    await vi.waitFor(() => { reset(cm); typeChar(cm, "["); expect(cm.state.doc.toString()).toBe("["); });
    reset(cm);
    typeChar(cm, "`");
    expect(cm.state.doc.toString()).toBe("``");
  });

  it("stops pairing backticks and wrapping selections with Auto pair Markdown syntax off", async () => {
    const { app, cm } = await boot();
    clickToggle(row((await show(app, "editor")).containerEl, "Auto pair Markdown syntax"));
    await vi.waitFor(() => { reset(cm); typeChar(cm, "`"); expect(cm.state.doc.toString()).toBe("`"); });
    reset(cm);
    cm.dispatch({ changes: { from: 0, insert: "word" }, selection: { anchor: 0, head: 4 } });
    typeChar(cm, "*");
    expect(cm.state.doc.toString()).toBe("*");
    reset(cm);
    typeChar(cm, "(");
    expect(cm.state.doc.toString()).toBe("()");
  });
});
