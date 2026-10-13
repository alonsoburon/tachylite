// Undo history in a compartment per editor, so loading another file into an editor can start a fresh history
// (otherwise Ctrl+Z right after switching files would bring back the previous file's text).
import { Compartment, type Extension } from "@codemirror/state";
import { history } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";

const historyCompartments = new WeakMap<EditorView, Compartment>();

/** The undo-history extension for `view`'s editor; factories must use it instead of `history()`. */
export function historyFor(): { ext: Extension; register(view: EditorView): void } {
  const c = new Compartment();
  return { ext: c.of(history()), register: (view) => { historyCompartments.set(view, c); } };
}
/** Forget the undo history (a different file was loaded into the editor). */
export function clearEditorHistory(view: EditorView): void {
  const c = historyCompartments.get(view);
  if (!c) return;
  view.dispatch({ effects: c.reconfigure([]) });
  view.dispatch({ effects: c.reconfigure(history()) });
}

