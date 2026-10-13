export { createEditor, editorKeymap, codeHighlightStyle, continueMarkup } from "./editor";
export type { EditorHost, EditorOptions, EditorHandle, EditorMode, LinkTarget } from "./types";
export { obsidianMarkdown, obsidianSyntax } from "./parser";
export {
  toggleWrap, toggleBold, toggleItalic, toggleStrikethrough, toggleHighlight, toggleInlineCode,
  insertLink, toggleChecklist, toggleTask, indentListMore, indentListLess,
} from "./commands";
export { wikilinkCompletionSource, tagCompletionSource } from "./autocomplete";
export { buildInline, buildBlocks, envFacet, inlinePlugin, blockField } from "./decorations";
export {
  parseTable, splitRow, parseTableModel, serializeTable, escapeCell, displayWidth, setCell, insertRow, deleteRow,
  insertColumn, deleteColumn, setAlign, columnCount, TableWidget, type TableModel, type Align, type TableMenuItem,
} from "./table";
export { headingFold, listFold } from "./folding";
export { buildSetext, setextField } from "./setext";
