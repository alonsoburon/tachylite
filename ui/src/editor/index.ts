export { createEditor, editorKeymap, codeHighlightStyle, continueMarkup } from "./editor";
export type { EditorHost, EditorOptions, EditorHandle, EditorMode, LinkTarget, CodeBlockRenderInfo } from "./types";
export { tokenClassNodeProp, hypermdCompat, INLINE_CODE_TEXT } from "./tokens";
export { CodeBlockWidget, splitFence } from "./codeblocks";
export { obsidianMarkdown, obsidianSyntax } from "./parser";
export {
  toggleWrap, toggleBold, toggleItalic, toggleStrikethrough, toggleHighlight, toggleInlineCode,
  insertLink, toggleChecklist, toggleTask, indentListMore, indentListLess,
} from "./commands";
export { wikilinkCompletionSource, tagCompletionSource } from "./autocomplete";
export { buildInline, buildBlocks, envFacet, inlinePlugin, blockField, refreshBlocks } from "./decorations";
export {
  parseTable, splitRow, parseTableModel, serializeTable, escapeCell, displayWidth, setCell, insertRow, deleteRow,
  insertColumn, deleteColumn, setAlign, columnCount, TableWidget, type TableModel, type Align, type TableMenuItem,
} from "./table";
export { headingFold, listFold } from "./folding";
export { buildSetext, setextField } from "./setext";
export { calloutFoldField, setCalloutFold } from "./calloutFold";
export { vimAdapter, vimExtension, vimSaveFacet, Vim, getCM } from "./vim";
export * from "./blockCommands";
export { linkAt, type LinkAt } from "./linkAt";

export { TABLE_COMMANDS, tableAt, tableTransaction, type TableOp } from "./tableCommands";
export { coloredHighlight, foldEverything, foldLess, foldMore, HIGHLIGHT_COLORS } from "./editorExtras";
