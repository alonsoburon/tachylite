// Tasks with any status char (`- [/]`, `- [-]`, `- [>]` ...), which Obsidian renders as checkboxes in Live Preview
// (GFM's task list only knows `[ ]`/`[x]`). Produces the same Task/TaskMarker nodes, so decorations and commands
// treat them like the built-in ones; the checkbox shows as checked with `data-task` set to the char.
import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";

const CUSTOM = /^\[[^\]\n\r \txX]\](?:[ \t]|$)/;

class CustomTaskParser implements LeafBlockParser {
  nextLine(): boolean {
    return false;
  }
  finish(cx: BlockContext, leaf: LeafBlock): boolean {
    cx.addLeafElement(leaf, cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
      cx.elt("TaskMarker", leaf.start, leaf.start + 3),
      ...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
    ]));
    return true;
  }
}

export const customTaskSyntax: MarkdownConfig = {
  parseBlock: [{
    name: "CustomTask",
    leaf: (cx, leaf) => (CUSTOM.test(leaf.content) && cx.parentType().name === "ListItem" ? new CustomTaskParser() : null),
    after: "SetextHeading",
  }],
};
