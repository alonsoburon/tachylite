// Vim key bindings (`vimMode` in .obsidian/app.json) via @replit/codemirror-vim, plus the CM5-compatible adapter Obsidian
// exposes as `window.CodeMirrorAdapter` (with `.Vim`: defineEx, map, noremap, defineAction, mapCommand...), which
// vimrc-style plugins use to add mappings and ex commands.
import { Facet, Prec, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { CodeMirror, Vim, getCM, vim } from "@replit/codemirror-vim";

/** What `:w` does for an editor (the host saves the note). */
export const vimSaveFacet = Facet.define<(view: EditorView) => void>();

type Adapter = typeof CodeMirror & { Vim: typeof Vim };
let adapter: Adapter | null = null;

/** The CM5 adapter class with `.Vim` attached, as Obsidian puts it on `window.CodeMirrorAdapter`. */
export function vimAdapter(): Adapter {
  if (adapter) return adapter;
  const a = CodeMirror as Adapter;
  a.Vim = Vim;
  // `:w` / `:write` call CodeMirror.commands.save with the CM5 wrapper; route it to the editor's save hook.
  (a.commands as Record<string, unknown>).save = (cm: { cm6: EditorView }) => {
    for (const save of cm.cm6.state.facet(vimSaveFacet)) save(cm.cm6);
  };
  return (adapter = a);
}

/** The Vim extension; must sit above every other keymap. */
export function vimExtension(): Extension {
  vimAdapter();
  return Prec.highest(vim());
}

export { Vim, getCM };
