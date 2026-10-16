import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { LinkTarget } from "./types";
import type { WidgetEnv } from "./widgets";

function inCode(state: EditorState, pos: number): boolean {
  let n: { name: string; parent: any } | null = syntaxTree(state).resolveInner(pos, -1);
  while (n) {
    if (n.name === "FencedCode" || n.name === "InlineCode" || n.name === "CodeBlock" || n.name === "Frontmatter") return true;
    n = n.parent;
  }
  return false;
}

const TYPE_MAP: Record<LinkTarget["type"], string> = {
  file: "text",
  heading: "keyword",
  block: "constant",
  alias: "variable",
  unresolved: "text",
};

/** `[[` / `![[` completion: files, then `#heading` and `#^block` subpaths. */
export function wikilinkCompletionSource(env: WidgetEnv): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = /\[\[([^[\]|]*)$/.exec(before);
    if (!m) return null;
    if (inCode(ctx.state, ctx.pos)) return null;
    const query = m[1];
    const from = ctx.pos - query.length;
    const targets = await env.host.listLinkTargets(query, env.getSourcePath());
    const after = line.text.slice(ctx.pos - line.from);
    const closed = after.startsWith("]]");
    const piped = after.startsWith("|") && /^\|[^\]]*\]\]/.test(after);
    const options: Completion[] = targets.map((t) => ({
      label: t.linktext,
      displayLabel: t.label ?? t.linktext,
      detail: t.detail,
      type: TYPE_MAP[t.type] ?? "text",
      apply: (view, _c, f, to) => {
        if (t.markdown) {
          // Wikilinks are off: replace the `[[query` (and its `]]` when already typed) with a Markdown link.
          const end = closed ? to + 2 : to;
          view.dispatch({ changes: { from: f - 2, to: end, insert: t.markdown }, selection: { anchor: f - 2 + t.markdown.length }, userEvent: "input.complete" });
          return;
        }
        const insert = t.linktext + (closed || piped ? "" : "]]");
        const cursor = f + t.linktext.length + (closed ? 2 : piped ? 0 : 2);
        view.dispatch({
          changes: { from: f, to: closed || piped ? to : to, insert },
          selection: { anchor: cursor },
          userEvent: "input.complete",
        });
      },
    }));
    return { from, options, filter: false };
  };
}

/** `#tag` completion. */
export function tagCompletionSource(env: WidgetEnv): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const m = /(?:^|[\s(])#([\p{L}\p{N}_/-]*)$/u.exec(before);
    if (!m) return null;
    if (/^#{1,6}$/.test(before.trim()) && ctx.explicit === false && m[1] === "") return null;
    if (inCode(ctx.state, ctx.pos)) return null;
    const q = m[1].toLowerCase();
    const all = await env.host.listTags();
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const raw of all) {
      const t = raw.replace(/^#/, "");
      if (!t || seen.has(t)) continue;
      if (q && !t.toLowerCase().includes(q)) continue;
      seen.add(t);
      options.push({ label: "#" + t, type: "keyword", boost: t.toLowerCase().startsWith(q) ? 1 : 0 });
      if (options.length >= 60) break;
    }
    if (!options.length) return null;
    return { from: ctx.pos - m[1].length - 1, options, filter: false };
  };
}
