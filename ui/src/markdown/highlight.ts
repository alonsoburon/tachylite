// Reading-view syntax highlighting for fenced code: the editor's lezer parsers (editor/languages.ts) produce the tree,
// and the spans get the Prism-style `token <type>` classes that themes style in reading view (`.token.keyword`...).
import { ensureSyntaxTree, type LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightCode, tagHighlighter, tags as t } from "@lezer/highlight";
import { findCodeLanguage } from "../editor/languages";

/** Lezer highlight tags -> Prism token classes (the names Obsidian themes target in reading view). */
export const prismHighlighter = tagHighlighter([
  { tag: [t.keyword, t.self, t.null], class: "token keyword" },
  { tag: [t.string, t.special(t.string), t.docString], class: "token string" },
  { tag: t.character, class: "token char" },
  { tag: t.regexp, class: "token regex" },
  { tag: t.escape, class: "token entity" },
  { tag: [t.number, t.unit], class: "token number" },
  { tag: t.bool, class: "token boolean" },
  { tag: [t.atom, t.constant(t.variableName), t.constant(t.propertyName)], class: "token constant" },
  { tag: t.comment, class: "token comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "token function" },
  { tag: [t.typeName, t.className], class: "token class-name" },
  { tag: t.namespace, class: "token namespace" },
  { tag: t.standard(t.variableName), class: "token builtin" },
  { tag: [t.special(t.variableName), t.local(t.variableName)], class: "token variable" },
  { tag: t.propertyName, class: "token property" },
  { tag: t.labelName, class: "token symbol" },
  { tag: t.operator, class: "token operator" },
  { tag: [t.punctuation, t.bracket, t.angleBracket], class: "token punctuation" },
  { tag: t.tagName, class: "token tag" },
  { tag: t.attributeName, class: "token attr-name" },
  { tag: t.attributeValue, class: "token attr-value" },
  { tag: [t.meta, t.annotation], class: "token atrule" },
  { tag: t.processingInstruction, class: "token prolog" },
  { tag: t.documentMeta, class: "token doctype" },
  { tag: [t.url, t.link], class: "token url" },
  { tag: t.inserted, class: "token inserted" },
  { tag: t.deleted, class: "token deleted" },
  { tag: t.heading, class: "token title important" },
  { tag: t.emphasis, class: "token italic" },
  { tag: t.strong, class: "token bold" },
]);

/** Highlight `code` with `support` into `el` (replaces its children with text nodes and token spans). */
export function highlightInto(el: HTMLElement, code: string, support: LanguageSupport): void {
  const state = EditorState.create({ doc: code, extensions: support.language });
  const tree = ensureSyntaxTree(state, code.length, 500);
  if (!tree) return;
  const doc = el.ownerDocument;
  const frag = doc.createDocumentFragment();
  highlightCode(code, tree, prismHighlighter, (text, classes) => {
    if (!classes) { frag.appendChild(doc.createTextNode(text)); return; }
    const span = doc.createElement("span");
    span.className = classes;
    span.textContent = text;
    frag.appendChild(span);
  }, () => frag.appendChild(doc.createTextNode("\n")));
  el.replaceChildren(frag);
}

const done = new WeakSet<HTMLElement>();

function highlightElement(code: HTMLElement, desc: LanguageDescription): Promise<void> | void {
  const source = code.textContent ?? "";
  const run = (support: LanguageSupport) => {
    // The block may have been replaced (a code-block processor) or edited in the meantime.
    if (!code.parentElement?.parentElement || (code.textContent ?? "") !== source) return;
    try { highlightInto(code, source, support); done.add(code); } catch (e) { console.warn("highlight failed", e); }
  };
  if (desc.support) return run(desc.support);
  return desc.load().then(run, (e) => console.warn(`loading ${desc.name} highlighting failed`, e));
}

/**
 * Highlight every `pre > code[data-lang]` under `root` whose language we know. Languages bundled with the editor are
 * highlighted synchronously; others load lazily and re-highlight the block when ready (the returned promise settles then).
 */
export function highlightCodeBlocks(root: HTMLElement): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const code of Array.from(root.querySelectorAll<HTMLElement>("pre > code[data-lang]"))) {
    if (done.has(code)) continue;
    const desc = findCodeLanguage(code.getAttribute("data-lang") ?? "");
    if (!desc) continue;
    const p = highlightElement(code, desc);
    if (p) pending.push(p);
  }
  return Promise.all(pending).then(() => {});
}
