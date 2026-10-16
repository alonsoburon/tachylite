// `[[` link suggestions: aliases use the shortest link, and vaults with wikilinks off get Markdown links.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setBackend } from "../src/ipc";
import { makeVault, type FakeVault } from "./helpers/backend";
import { startSession, type Session } from "../src/app/session";
import { makeEditorHost } from "../src/app/bridge";

let v: FakeVault;
let session: Session | null = null;

beforeEach(() => {
  document.body.innerHTML = ""; localStorage.clear();
  v = makeVault({ "Home.md": "x\n", "Notes/Target Note.md": "---\naliases: [Tgt]\n---\n# Head\ntext ^blk\n", "Notes/pic.png": "" });
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
  return session.app;
}

describe("link suggestions", () => {
  it("offers wikilink text, with aliases as the shortest link plus |alias", async () => {
    const app = await boot();
    const host = makeEditorHost(app);
    const t = await host.listLinkTargets("Tgt", "Home.md");
    expect(t[0]).toMatchObject({ type: "alias", linktext: "Target Note|Tgt" });
    expect(t[0].markdown).toBeUndefined();
    const h = await host.listLinkTargets("Target Note#Hea", "Home.md");
    expect(h[0].linktext).toBe("Target Note#Head");
  });
  it("offers Markdown links when wikilinks are off", async () => {
    const app = await boot();
    app.vault.setConfig("useMarkdownLinks", true);
    const host = makeEditorHost(app);
    const t = await host.listLinkTargets("Target", "Home.md");
    expect(t.find((x) => x.type === "file")!.markdown).toBe("[Target Note](Target%20Note.md)");
    const al = (await host.listLinkTargets("Tgt", "Home.md")).find((x) => x.type === "alias")!;
    expect(al.markdown).toBe("[Tgt](Target%20Note.md)");
    const h = await host.listLinkTargets("Target Note#Hea", "Home.md");
    expect(h[0].markdown).toBe("[Target Note](Target%20Note.md#Head)");
    const img = await host.listLinkTargets("pic", "Home.md");
    expect(img[0].markdown).toBe("[pic.png](pic.png)");
  });
});

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { wikilinkCompletionSource } from "../src/editor/autocomplete";

describe("completion apply", () => {
  const run = async (doc: string, md?: string) => {
    const view = new EditorView({ state: EditorState.create({ doc, selection: { anchor: doc.indexOf("|") >= 0 ? doc.indexOf("|") : doc.length } }) });
    const env: any = { host: { listLinkTargets: async () => [{ linktext: "Target Note", type: "file", markdown: md }] }, getSourcePath: () => "Home.md" };
    const res = (await wikilinkCompletionSource(env)(new CompletionContext(view.state, view.state.selection.main.head, true)))!;
    const opt: any = res.options[0];
    opt.apply(view, opt, res.from, view.state.selection.main.head);
    return view.state.doc.toString();
  };
  it("inserts wikilink text and closes the brackets", async () => {
    expect(await run("see [[Tar")).toBe("see [[Target Note]]");
  });
  it("replaces the whole [[query with a Markdown link", async () => {
    expect(await run("see [[Tar", "[Target Note](Target%20Note.md)")).toBe("see [Target Note](Target%20Note.md)");
  });
});
