import { EditorSelection, EditorState, type ChangeSpec, type StateCommand } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

function runBefore(state: EditorState, pos: number, ch: string): number {
  let n = 0;
  while (pos - n - 1 >= 0 && state.sliceDoc(pos - n - 1, pos - n) === ch) n++;
  return n;
}
function runAfter(state: EditorState, pos: number, ch: string): number {
  let n = 0;
  while (pos + n < state.doc.length && state.sliceDoc(pos + n, pos + n + 1) === ch) n++;
  return n;
}

/** Are `marker`s directly around [from, to]? Returns how many chars to strip per side (0 if none). */
function wrappedAround(state: EditorState, from: number, to: number, marker: string): number {
  const m = marker.length;
  if (marker === "*") {
    const b = runBefore(state, from, "*");
    const a = runAfter(state, to, "*");
    return b % 2 === 1 && a % 2 === 1 ? 1 : 0;
  }
  if (marker === "**") {
    return runBefore(state, from, "*") >= 2 && runAfter(state, to, "*") >= 2 ? 2 : 0;
  }
  if (marker === "==" || marker === "~~") {
    return state.sliceDoc(from - m, from) === marker && state.sliceDoc(to, to + m) === marker ? m : 0;
  }
  return state.sliceDoc(from - m, from) === marker && state.sliceDoc(to, to + m) === marker ? m : 0;
}

/** Toggle an inline markdown wrapper (`**`, `*`, `~~`, `==`, `` ` ``) around each selection. */
export function toggleWrap(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const m = marker.length;
    const tr = state.changeByRange((range) => {
      let { from, to } = range;
      const selText = state.sliceDoc(from, to);
      // selection includes the markers themselves
      if (
        !range.empty && selText.length > 2 * m && selText.startsWith(marker) && selText.endsWith(marker) &&
        !(marker === "*" && (selText.startsWith("**") || selText.endsWith("**")))
      ) {
        return {
          changes: [{ from, to: from + m }, { from: to - m, to }],
          range: EditorSelection.range(from, to - 2 * m),
        };
      }
      let cursorOffset = 0;
      if (range.empty) {
        const w = state.wordAt(from);
        if (w && marker !== "`") {
          cursorOffset = from - w.from;
          from = w.from;
          to = w.to;
        }
      }
      const strip = wrappedAround(state, from, to, marker);
      if (strip > 0) {
        return {
          changes: [{ from: from - strip, to: from }, { from: to, to: to + strip }],
          range: range.empty && cursorOffset ? EditorSelection.cursor(from - strip + cursorOffset) : EditorSelection.range(from - strip, to - strip),
        };
      }
      if (from === to) {
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + m),
        };
      }
      return {
        changes: [{ from, insert: marker }, { from: to, insert: marker }],
        range: range.empty ? EditorSelection.cursor(from + m + cursorOffset) : EditorSelection.range(from + m, to + m),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("*");
export const toggleStrikethrough = toggleWrap("~~");
export const toggleHighlight = toggleWrap("==");
export const toggleInlineCode = toggleWrap("`");

/** Mod-K: wrap selection as a markdown link. */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    const sel = state.sliceDoc(range.from, range.to);
    if (/^(https?:\/\/|www\.)\S+$/.test(sel)) {
      return { changes: { from: range.from, to: range.to, insert: `[](${sel})` }, range: EditorSelection.cursor(range.from + 1) };
    }
    if (sel) {
      return {
        changes: { from: range.from, to: range.to, insert: `[${sel}]()` },
        range: EditorSelection.cursor(range.from + sel.length + 3),
      };
    }
    return { changes: { from: range.from, insert: "[]()" }, range: EditorSelection.cursor(range.from + 1) };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]))(\s+)\[(.)\](\s|$)/;
const LIST_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)]))(\s+)/;

function selectedLines(state: EditorState) {
  const seen = new Set<number>();
  const out: { from: number; to: number; text: string; number: number }[] = [];
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    // a selection ending at the very start of a line does not include that line
    if (b > a && state.doc.line(b).from === r.to) b--;
    for (let n = a; n <= b; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(state.doc.line(n));
    }
  }
  return out;
}

function checklistChange(line: { from: number; text: string }, allTasks: boolean): ChangeSpec | null {
  const task = TASK_RE.exec(line.text);
  if (task) {
    if (!allTasks) return null;
    const start = task[1].length + task[2].length; // at '['
    const end = start + 3 + (task[4] ? 1 : 0);
    return { from: line.from + start, to: line.from + end };
  }
  if (allTasks) return null;
  const list = LIST_RE.exec(line.text);
  if (list) return { from: line.from + list[0].length, insert: "[ ] " };
  const indent = /^\s*/.exec(line.text)![0].length;
  return { from: line.from + indent, insert: "- [ ] " };
}

/** Mod-L: toggle checklist on the selected lines. */
export const toggleChecklist: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = selectedLines(state);
  const allTasks = lines.length > 0 && lines.every((l) => TASK_RE.test(l.text));
  const changes: ChangeSpec[] = [];
  for (const l of lines) {
    const c = checklistChange(l, allTasks);
    if (c) changes.push(c);
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "input", scrollIntoView: true }));
  return true;
};

/** Mod-Enter: toggle `[ ]`/`[x]` on task lines; turn plain/list lines into tasks. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const lines = selectedLines(state);
  const changes: ChangeSpec[] = [];
  for (const l of lines) {
    const t = TASK_RE.exec(l.text);
    if (t) {
      const at = l.from + t[1].length + t[2].length + 1;
      changes.push({ from: at, to: at + 1, insert: t[3] === " " ? "x" : " " });
    } else {
      const c = checklistChange(l, false);
      if (c) changes.push(c);
    }
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: "input" }));
  return true;
};

/** Tab: indent list items / selected lines; otherwise insert an indent unit. */
export const indentListMore: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const unit = state.facet(indentUnit);
  const lines = selectedLines(state);
  const multi = lines.length > 1;
  const onList = lines.some((l) => LIST_RE.test(l.text));
  if (!multi && !onList) {
    dispatch(state.update(state.replaceSelection(unit), { userEvent: "input", scrollIntoView: true }));
    return true;
  }
  const changes = lines.map((l) => ({ from: l.from, insert: unit }));
  dispatch(state.update({ changes, userEvent: "input.indent", scrollIntoView: true }));
  return true;
};

/** Shift-Tab: outdent selected lines by one indent unit. */
export const indentListLess: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const unit = state.facet(indentUnit);
  const changes: ChangeSpec[] = [];
  for (const l of selectedLines(state)) {
    if (l.text.startsWith("\t")) changes.push({ from: l.from, to: l.from + 1 });
    else {
      const m = /^ +/.exec(l.text);
      if (m) changes.push({ from: l.from, to: l.from + Math.min(m[0].length, Math.max(1, unit.length)) });
    }
  }
  if (!changes.length) return true; // swallow Shift-Tab
  dispatch(state.update({ changes, userEvent: "delete.dedent", scrollIntoView: true }));
  return true;
};

/**
 * Typing helpers: wrap selection with `*`, `_`, `~`; pair `**`; step over a closing `*`.
 * (Brackets, backticks and `[[` are handled by closeBrackets.)
 */
export const markupInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  const state = view.state;
  if (text.length !== 1 || state.readOnly || state.selection.ranges.length !== 1) return false;
  const sel = state.selection.main;
  if (from !== sel.from || to !== sel.to) return false;
  if (!sel.empty && (text === "*" || text === "_" || text === "~")) {
    view.dispatch({
      changes: [{ from, insert: text }, { from: to, insert: text }],
      selection: EditorSelection.range(from + 1, to + 1),
      userEvent: "input.type",
    });
    return true;
  }
  if (text !== "*" || !sel.empty) return false;
  const prev = from > 0 ? state.sliceDoc(from - 1, from) : "";
  const next = state.sliceDoc(from, from + 1);
  if (next === "*" && prev && !/\s/.test(prev)) {
    view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: "input.type" });
    return true;
  }
  if (prev === "*" && runBefore(state, from, "*") === 1 && !/[\p{L}\p{N}*]/u.test(next)) {
    view.dispatch({
      changes: { from, insert: "***" },
      selection: EditorSelection.cursor(from + 1),
      userEvent: "input.type",
    });
    return true;
  }
  return false;
});
