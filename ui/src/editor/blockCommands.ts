// Line- and block-level editor commands behind the `editor:*` command ids (lists, quotes, headings, inserts).
import { EditorSelection, EditorState, type ChangeSpec, type StateCommand } from "@codemirror/state";
import { selectedLines } from "./commands";

const BULLET_RE = /^(\s*(?:>\s*)*)([-*+])(\s+)/;
const NUMBER_RE = /^(\s*(?:>\s*)*)(\d+)[.)](\s+)/;
const QUOTE_RE = /^(\s*)>\s?/;
const HEADING_RE = /^(\s*)#{1,6}\s+/;

/** The leading whitespace and quote markers of a line, which list markers go after. */
function prefixLength(text: string): number {
  return /^(\s*(?:>\s*)*)/.exec(text)![0].length;
}

/** Apply per-line changes as one input transaction; false when there was nothing to do. */
function dispatchChanges(state: EditorState, dispatch: (tr: ReturnType<EditorState["update"]>) => void, changes: ChangeSpec[]): boolean {
  if (state.readOnly || !changes.length) return false;
  dispatch(state.update({ changes, userEvent: "input", scrollIntoView: true }));
  return true;
}

/** Turn the selected lines into a bullet list, or remove the bullets when they all have one. */
export const toggleBulletList: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state).filter((l) => l.text.trim() !== "" || selectedLines(state).length === 1);
  const allBullets = lines.length > 0 && lines.every((l) => BULLET_RE.test(l.text));
  const changes: ChangeSpec[] = [];
  for (const l of lines) {
    const b = BULLET_RE.exec(l.text);
    const n = NUMBER_RE.exec(l.text);
    if (allBullets) changes.push({ from: l.from + b![1].length, to: l.from + b![0].length });
    else if (b) continue;
    else if (n) changes.push({ from: l.from + n[1].length, to: l.from + n[0].length, insert: "- " });
    else changes.push({ from: l.from + prefixLength(l.text), insert: "- " });
  }
  return dispatchChanges(state, dispatch, changes);
};

/** Turn the selected lines into a numbered list (1., 2., ...), or remove the numbers when they all have one. */
export const toggleNumberedList: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state).filter((l) => l.text.trim() !== "" || selectedLines(state).length === 1);
  const allNumbered = lines.length > 0 && lines.every((l) => NUMBER_RE.test(l.text));
  const changes: ChangeSpec[] = [];
  let i = 1;
  for (const l of lines) {
    const b = BULLET_RE.exec(l.text);
    const n = NUMBER_RE.exec(l.text);
    if (allNumbered) changes.push({ from: l.from + n![1].length, to: l.from + n![0].length });
    else if (n) { i++; continue; }
    else if (b) changes.push({ from: l.from + b[1].length, to: l.from + b[0].length, insert: `${i++}. ` });
    else changes.push({ from: l.from + prefixLength(l.text), insert: `${i++}. ` });
  }
  return dispatchChanges(state, dispatch, changes);
};

/** Prefix the selected lines with `> `, or strip one level when they are all quoted. */
export const toggleBlockquote: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state);
  const allQuoted = lines.length > 0 && lines.every((l) => QUOTE_RE.test(l.text));
  const changes: ChangeSpec[] = lines.map((l) => {
    if (allQuoted) {
      const q = QUOTE_RE.exec(l.text)!;
      return { from: l.from + q[1].length, to: l.from + q[0].length };
    }
    return { from: l.from, insert: "> " };
  });
  return dispatchChanges(state, dispatch, changes);
};

/** `# ` to `###### ` on the current line, toggling off when it already has that level; level 0 clears the heading. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    for (const l of selectedLines(state)) {
      const h = HEADING_RE.exec(l.text);
      const marker = level > 0 ? "#".repeat(level) + " " : "";
      const current = h ? h[0].trim().length : 0;
      if (h) changes.push({ from: l.from + h[1].length, to: l.from + h[0].length, insert: current === level ? "" : marker });
      else if (marker) changes.push({ from: l.from + /^\s*/.exec(l.text)![0].length, insert: marker });
    }
    return dispatchChanges(state, dispatch, changes);
  };
}

/** Replace the selection with `before` + selection + `after`, keeping the selected text selected (or the cursor between). */
function wrapSelection(before: string, after: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const tr = state.changeByRange((r) => {
      const text = state.sliceDoc(r.from, r.to);
      return {
        changes: { from: r.from, to: r.to, insert: before + text + after },
        range: EditorSelection.range(r.from + before.length, r.from + before.length + text.length),
      };
    });
    dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
    return true;
  };
}

export const insertWikilink = wrapSelection("[[", "]]");
export const insertEmbed = wrapSelection("![[", "]]");
export const insertTag: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  dispatch(state.update(state.replaceSelection("#"), { userEvent: "input", scrollIntoView: true }));
  return true;
};

/** Insert text on its own line(s) below the cursor line; the cursor lands `cursorOffset` into the inserted text. */
function insertBlock(text: string, cursorOffset: number): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const line = state.doc.lineAt(state.selection.main.head);
    const empty = line.text.trim() === "";
    const from = empty ? line.from : line.to;
    const insert = (empty ? "" : "\n") + text;
    dispatch(state.update({
      changes: { from, to: empty ? line.to : from, insert },
      selection: { anchor: from + (empty ? 0 : 1) + cursorOffset },
      userEvent: "input",
      scrollIntoView: true,
    }));
    return true;
  };
}

export const insertHorizontalRule = insertBlock("---\n", 4);
export const insertCallout = insertBlock("> [!note]\n> ", 12);
export const insertMathBlock = insertBlock("$$\n\n$$", 3);
export const insertTable = insertBlock("|  |  |\n| --- | --- |\n|  |  |", 2);

/** A fenced code block around the selection (empty fence with the cursor inside when nothing is selected). */
export const insertCodeBlock: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((r) => {
    const text = state.sliceDoc(r.from, r.to);
    const lead = r.from > 0 && state.sliceDoc(r.from - 1, r.from) !== "\n" ? "\n" : "";
    const open = lead + "```\n";
    return {
      changes: { from: r.from, to: r.to, insert: open + text + "\n```" },
      range: EditorSelection.range(r.from + open.length, r.from + open.length + text.length),
    };
  });
  dispatch(state.update(tr, { userEvent: "input", scrollIntoView: true }));
  return true;
};

/** Delete the paragraph (run of non-blank lines) under the cursor, with the blank line that follows it. */
export const deleteParagraph: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const doc = state.doc;
  let a = doc.lineAt(state.selection.main.head).number;
  if (doc.line(a).text.trim() === "") return false;
  let b = a;
  while (a > 1 && doc.line(a - 1).text.trim() !== "") a--;
  while (b < doc.lines && doc.line(b + 1).text.trim() !== "") b++;
  const from = doc.line(a).from;
  let to = doc.line(b).to;
  if (b < doc.lines) to = doc.line(b + 1).to + (b + 1 < doc.lines ? 1 : 0);
  else if (from > 0) return dispatchChanges(state, dispatch, [{ from: from - 1, to }]);
  return dispatchChanges(state, dispatch, [{ from, to }]);
};
