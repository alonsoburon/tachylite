import {
  Annotation, Compartment, EditorState, Prec, type Extension,
} from "@codemirror/state";
import {
  EditorView, drawSelection, dropCursor, keymap, lineNumbers, type ViewUpdate,
} from "@codemirror/view";
import {
  defaultKeymap, history, historyKeymap,
} from "@codemirror/commands";
import {
  bracketMatching, codeFolding, foldGutter, foldKeymap, HighlightStyle, indentUnit, syntaxHighlighting,
} from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

import type { EditorHandle, EditorMode, EditorOptions } from "./types";
import { obsidianMarkdown } from "./parser";
import { blockField, envFacet, inlinePlugin } from "./decorations";
import {
  indentListLess, indentListMore, insertLink, markupInputHandler, toggleBold, toggleChecklist,
  toggleHighlight, toggleInlineCode, toggleItalic, toggleStrikethrough, toggleTask,
} from "./commands";
import { tagCompletionSource, wikilinkCompletionSource } from "./autocomplete";
import { headingFoldService, listFoldService } from "./folding";
import type { WidgetEnv } from "./widgets";

const External = Annotation.define<boolean>();

/** Code-token classes in the CodeMirror 5 naming (`cm-keyword`...) that Obsidian themes style. */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.self], class: "cm-keyword" },
  { tag: [t.string, t.regexp, t.special(t.string)], class: "cm-string" },
  { tag: [t.number, t.bool, t.null], class: "cm-number" },
  { tag: t.atom, class: "cm-atom" },
  { tag: t.comment, class: "cm-comment" },
  { tag: t.standard(t.variableName), class: "cm-builtin" },
  { tag: t.special(t.variableName), class: "cm-variable-2" },
  { tag: [t.definition(t.variableName), t.function(t.variableName)], class: "cm-def" },
  { tag: t.variableName, class: "cm-variable" },
  { tag: t.propertyName, class: "cm-property" },
  { tag: [t.operator, t.operatorKeyword], class: "cm-operator" },
  { tag: [t.typeName, t.className], class: "cm-type" },
  { tag: t.tagName, class: "cm-tag" },
  { tag: t.attributeName, class: "cm-attribute" },
  { tag: [t.punctuation, t.separator], class: "cm-punctuation" },
  { tag: [t.bracket, t.brace, t.paren, t.squareBracket], class: "cm-bracket" },
  { tag: t.meta, class: "cm-meta" },
]);

/** Enter continues lists/quotes/tasks; an empty item exits the list (no loose-list quirk). */
export const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

function markdownKeymap() {
  return [
    { key: "Enter", run: continueMarkup },
    { key: "Backspace", run: deleteMarkupBackward },
  ];
}

export function editorKeymap() {
  return keymap.of([
    { key: "Mod-b", run: toggleBold, preventDefault: true },
    { key: "Mod-i", run: toggleItalic, preventDefault: true },
    { key: "Mod-k", run: insertLink, preventDefault: true },
    { key: "Mod-`", run: toggleInlineCode, preventDefault: true },
    { key: "Mod-Shift-x", run: toggleStrikethrough, preventDefault: true },
    { key: "Mod-Shift-h", run: toggleHighlight, preventDefault: true },
    { key: "Mod-l", run: toggleChecklist, preventDefault: true },
    { key: "Mod-Enter", run: toggleTask, preventDefault: true },
    { key: "Tab", run: indentListMore },
    { key: "Shift-Tab", run: indentListLess },
    ...markdownKeymap(),
  ]);
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const cur = {
    readOnly: opts.readOnly ?? false,
    lineWrapping: opts.lineWrapping ?? true,
    tabSize: opts.tabSize ?? 4,
    useTabs: opts.useTabs ?? true,
    spellcheck: opts.spellcheck ?? false,
    showLineNumbers: opts.showLineNumbers ?? false,
    foldHeading: opts.foldHeading ?? true,
    foldIndent: opts.foldIndent ?? true,
    extra: opts.extraExtensions ?? [],
    sourcePath: opts.sourcePath ?? "",
  };
  let mode: EditorMode = opts.mode ?? "live-preview";

  const env: WidgetEnv = { host: opts.host, getSourcePath: () => cur.sourcePath };

  const modeC = new Compartment();
  const wrapC = new Compartment();
  const tabC = new Compartment();
  const roC = new Compartment();
  const spellC = new Compartment();
  const numC = new Compartment();
  const foldC = new Compartment();
  const extraC = new Compartment();

  const modeExt = (m: EditorMode): Extension =>
    m === "live-preview" ? [inlinePlugin(true), blockField] : [inlinePlugin(false)];
  const wrapExt = () => (cur.lineWrapping ? EditorView.lineWrapping : []);
  const tabExt = () => [
    EditorState.tabSize.of(cur.tabSize),
    indentUnit.of(cur.useTabs ? "\t" : " ".repeat(cur.tabSize)),
  ];
  const roExt = () => [EditorState.readOnly.of(cur.readOnly), EditorView.editable.of(!cur.readOnly)];
  const spellExt = () =>
    EditorView.contentAttributes.of({
      spellcheck: cur.spellcheck ? "true" : "false",
      autocorrect: "off",
      autocapitalize: "off",
    });
  const numExt = () => (cur.showLineNumbers ? lineNumbers() : []);
  const foldExt = (): Extension => {
    const svc: Extension[] = [];
    if (cur.foldHeading) svc.push(headingFoldService());
    if (cur.foldIndent) svc.push(listFoldService());
    if (!svc.length) return [];
    return [
      svc,
      codeFolding({
        placeholderDOM(_v, onclick) {
          const s = document.createElement("span");
          s.className = "cm-fold-placeholder";
          s.textContent = "…";
          s.title = "Unfold";
          s.addEventListener("click", onclick);
          return s;
        },
      }),
      foldGutter({
        markerDOM(open) {
          const s = document.createElement("div");
          s.className = "cm-fold-indicator" + (open ? "" : " is-collapsed");
          s.innerHTML = '<div class="collapse-indicator collapse-icon"><svg class="svg-icon right-triangle" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></div>';
          return s;
        },
      }),
    ];
  };

  const linkClicks = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (e.button !== 0) return false;
      const target = e.target as HTMLElement | null;
      if (!target?.closest) return false;
      const mod = e.ctrlKey || e.metaKey;
      const live = mode === "live-preview";
      const wiki = target.closest<HTMLElement>(".cm-hmd-internal-link[data-href]");
      if (wiki && (mod || (live && wiki.getAttribute("data-lp") === "1"))) {
        e.preventDefault();
        opts.host.openLink(wiki.getAttribute("data-href") ?? "", cur.sourcePath, mod);
        return true;
      }
      const tag = target.closest<HTMLElement>(".cm-hashtag[data-tag]");
      if (tag && (mod || live)) {
        e.preventDefault();
        opts.host.openTag?.("#" + tag.getAttribute("data-tag"));
        return true;
      }
      const ext = target.closest<HTMLElement>(".cm-link[data-url]");
      if (ext && mod) {
        e.preventDefault();
        const url = ext.getAttribute("data-url") ?? "";
        if (opts.host.openExternal) opts.host.openExternal(url);
        else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) window.open(url, "_blank", "noopener");
        else opts.host.openLink(decodeURI(url), cur.sourcePath, true);
        return true;
      }
      void view;
      return false;
    },
  });

  const changeListener = EditorView.updateListener.of((u: ViewUpdate) => {
    if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
      opts.onChange?.(u.state.doc.toString(), u);
    }
  });

  const baseExtensions: Extension[] = [
    envFacet.of(env),
    obsidianMarkdown(),
    EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{", "`"] } }]),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    bracketMatching(),
    closeBrackets(),
    markupInputHandler,
    autocompletion({
      override: [wikilinkCompletionSource(env), tagCompletionSource(env)],
      activateOnTyping: true,
      icons: false,
    }),
    highlightSelectionMatches(),
    search({ top: true }),
    syntaxHighlighting(codeHighlightStyle),
    linkClicks,
    changeListener,
    Prec.high(editorKeymap()),
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    modeC.of(modeExt(mode)),
    wrapC.of(wrapExt()),
    tabC.of(tabExt()),
    roC.of(roExt()),
    spellC.of(spellExt()),
    numC.of(numExt()),
    foldC.of(foldExt()),
    extraC.of(cur.extra),
  ];

  const view = new EditorView({
    state: EditorState.create({ doc: opts.doc ?? "", extensions: baseExtensions }),
    parent,
  });

  const rootClasses = ["markdown-source-view", "cm-s-obsidian", "mod-cm6"];
  const applyRoot = () => {
    parent.classList.add(...rootClasses);
    parent.classList.toggle("is-live-preview", mode === "live-preview");
    view.dom.classList.toggle("is-live-preview", mode === "live-preview");
    view.dom.setAttribute("data-mode", mode === "live-preview" ? "live-preview" : "source");
  };
  applyRoot();

  return {
    view,
    get mode() {
      return mode;
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      view.dispatch({ effects: modeC.reconfigure(modeExt(m)) });
      applyRoot();
    },
    setValue(doc) {
      if (doc === view.state.doc.toString()) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: doc },
        annotations: [External.of(true)],
        selection: { anchor: Math.min(view.state.selection.main.anchor, doc.length) },
      });
    },
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy() {
      view.destroy();
      parent.classList.remove(...rootClasses, "is-live-preview");
    },
    reconfigure(o) {
      const effects = [];
      if (o.lineWrapping !== undefined) { cur.lineWrapping = o.lineWrapping; effects.push(wrapC.reconfigure(wrapExt())); }
      if (o.tabSize !== undefined || o.useTabs !== undefined) {
        if (o.tabSize !== undefined) cur.tabSize = o.tabSize;
        if (o.useTabs !== undefined) cur.useTabs = o.useTabs;
        effects.push(tabC.reconfigure(tabExt()));
      }
      if (o.readOnly !== undefined) { cur.readOnly = o.readOnly; effects.push(roC.reconfigure(roExt())); }
      if (o.spellcheck !== undefined) { cur.spellcheck = o.spellcheck; effects.push(spellC.reconfigure(spellExt())); }
      if (o.showLineNumbers !== undefined) { cur.showLineNumbers = o.showLineNumbers; effects.push(numC.reconfigure(numExt())); }
      if (o.foldHeading !== undefined || o.foldIndent !== undefined) {
        if (o.foldHeading !== undefined) cur.foldHeading = o.foldHeading;
        if (o.foldIndent !== undefined) cur.foldIndent = o.foldIndent;
        effects.push(foldC.reconfigure(foldExt()));
      }
      if (o.extraExtensions !== undefined) { cur.extra = o.extraExtensions; effects.push(extraC.reconfigure(cur.extra)); }
      if (o.sourcePath !== undefined) cur.sourcePath = o.sourcePath;
      if (effects.length) view.dispatch({ effects });
    },
    setSourcePath(p) {
      cur.sourcePath = p;
    },
  };
}
