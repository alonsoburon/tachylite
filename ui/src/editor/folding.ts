import { foldService, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

const HEADING = /^ {0,3}(#{1,6})\s/;

function headingFold(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const doc = state.doc;
  const line = doc.lineAt(lineStart);
  const m = HEADING.exec(line.text);
  if (!m) return null;
  const node = syntaxTree(state).resolveInner(line.from + (line.text.length - line.text.trimStart().length), 1);
  if (!node.name.startsWith("ATXHeading") && node.parent?.name?.startsWith("ATXHeading") !== true) return null;
  const level = m[1].length;
  let end = line.number;
  for (let n = line.number + 1; n <= doc.lines; n++) {
    const l = doc.line(n);
    const hm = HEADING.exec(l.text);
    if (hm && hm[1].length <= level) {
      const t = syntaxTree(state).resolveInner(l.from + (l.text.length - l.text.trimStart().length), 1);
      if (t.name.startsWith("ATXHeading") || t.parent?.name?.startsWith("ATXHeading")) break;
    }
    if (l.text.trim() !== "") end = n;
  }
  if (end === line.number) return null;
  return { from: line.to, to: doc.line(end).to };
}

function listFold(state: EditorState, lineStart: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineStart);
  let item: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(n) {
      if (n.name === "ListItem" && n.from >= line.from && n.from <= line.to && !item) item = { from: n.from, to: n.to };
    },
  });
  const it = item as { from: number; to: number } | null;
  if (!it || it.to <= line.to) return null;
  const end = state.doc.lineAt(it.to);
  // don't swallow trailing blank text
  return { from: line.to, to: end.to };
}

export function headingFoldService() {
  return foldService.of((state, lineStart) => headingFold(state, lineStart));
}
export function listFoldService() {
  return foldService.of((state, lineStart) => listFold(state, lineStart));
}
export { headingFold, listFold };
