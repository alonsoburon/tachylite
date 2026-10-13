// Reading view: clicking a task checkbox toggles `[ ]` <-> `[x]` in the note. The checkbox carries the 0-based source
// line of its list item (`data-line`, from the markdown-it line map), which also covers nested lists and tasks in
// blockquotes/callouts, and stays right when the same task text appears twice. Like Obsidian (and the Live Preview
// checkbox), any non-space status (`[x]`, `[/]`, `[-]`, ...) toggles back to `[ ]`. The edit goes through the view's
// editor so an open editor stays in sync and undo works, and is saved right away.
import type { EditorView } from "@codemirror/view";

/** `- [ ]`, `1. [x]`, `> - [/]`, with any indentation/quote prefix; group 1 ends right before the status char. */
const TASK_LINE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([^\]\n])\]/;

/** Where the status char of the task on 0-based `line` sits, and what it toggles to; null if that line is not a task. */
export function taskToggleAt(doc: { lines: number; line(n: number): { from: number; text: string } }, line: number): { pos: number; from: string; to: string } | null {
  if (!Number.isInteger(line) || line < 0 || line >= doc.lines) return null;
  const l = doc.line(line + 1);
  const m = TASK_LINE.exec(l.text);
  if (!m) return null;
  return { pos: l.from + m[1].length, from: m[2], to: m[2] === " " ? "x" : " " };
}

/** Checkboxes rendered from somewhere else than this note's own source (embeds, footnote bodies, plugin output) are not ours. */
const FOREIGN = ".markdown-embed, .internal-embed, .footnotes, [class^='block-language-'], [class*=' block-language-']";

interface TaskHost {
  previewEl: HTMLElement;
  cm: EditorView;
  save(): Promise<void>;
}

export function installPreviewTaskToggle(view: TaskHost): void {
  view.previewEl.addEventListener("click", (e) => {
    const box = e.target as HTMLInputElement | null;
    if (!box?.matches?.("input.task-list-item-checkbox[data-line]") || box.closest(FOREIGN)) return;
    const cm = view.cm;
    const hit = cm.state.readOnly ? null : taskToggleAt(cm.state.doc, Number(box.getAttribute("data-line")));
    if (!hit) {
      e.preventDefault();
      return;
    }
    cm.dispatch({ changes: { from: hit.pos, to: hit.pos + 1, insert: hit.to }, userEvent: "input.toggle-task" });
    box.checked = hit.to !== " ";
    const li = box.closest("li");
    if (li) {
      li.classList.toggle("is-checked", hit.to !== " ");
      li.setAttribute("data-task", hit.to);
    }
    void view.save().catch((err) => console.error("saving the task toggle failed", err));
  });
}
