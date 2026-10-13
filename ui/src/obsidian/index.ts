// The `obsidian` module as seen by plugins (`require("obsidian")`).
import { installDomHelpers } from "./dom";
installDomHelpers();

export { App } from "./app";
export { Events, Component, Scope, Keymap, Platform } from "./events";
export type { EventRef, Modifier, Hotkey, KeymapContext, KeymapEventHandler, KeymapEventListener, KeymapInfo } from "./events";
export { TAbstractFile, TFile, TFolder, TExternalFile } from "./files";
export type { FileStats } from "./files";
export { Vault, FileSystemAdapter } from "./vault";
export type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from "./vault";
export { MetadataCache, FileManager } from "./metadata";
export {
  Workspace, WorkspaceLeaf, WorkspaceItem, WorkspaceParent, WorkspaceSplit, WorkspaceTabs, WorkspaceContainer, WorkspaceRoot, WorkspaceWindow,
  WorkspaceFloating, WorkspaceMobileDrawer, WorkspaceSidedock, WorkspaceRibbon,
} from "./workspace";
export type { OpenViewState, ViewState, SplitDirection, PaneType, Side, LayoutHost, WorkspaceWindowInitData } from "./workspace";
export { View, ItemView, FileView, EditableFileView, TextFileView, MarkdownView, MarkdownPreviewView, MarkdownEditView } from "./views";
export type { ViewCreator, ViewStateResult, MarkdownViewModeType } from "./views";
export { Editor, editorEditorField, editorInfoField, editorViewField, editorLivePreviewField, livePreviewState } from "./editor";
export type { EditorPosition, EditorRange, EditorChange, EditorTransaction, EditorCommandName, EditorRangeOrCaret, EditorSelectionOrCaret} from "./editor";
export { EditorSuggest } from "./editorSuggest";
export type { EditorSuggestContext, EditorSuggestTriggerInfo } from "./editorSuggest";
export { Plugin } from "./plugin";
export type { PluginManifest, Command } from "./plugin";
export {
  BaseComponent, ValueComponent, AbstractTextComponent, TextComponent, TextAreaComponent, SearchComponent, MomentFormatComponent, ToggleComponent,
  DropdownComponent, SliderComponent, ColorComponent, ProgressBarComponent, ButtonComponent, ExtraButtonComponent, DisplayValueComponent, SecretComponent,
  Setting, SettingGroup, SettingTab, PluginSettingTab, SettingPage, ConfirmationButton, ConfirmationModal,
} from "./setting";
export {
  Notice, Modal, Menu, MenuItem, MenuSeparator, PopoverSuggest, AbstractInputSuggest, SuggestModal, FuzzySuggestModal, HoverPopover, PopoverState,
  setTooltip, displayTooltip,
} from "./ui";
export type { FuzzyMatch, Instruction, TooltipOptions, HoverParent } from "./ui";
export { requestUrl, request } from "./net";
export { MarkdownBaseView, MarkdownScrollableEditView, MarkdownEmbed, EmbedRegistry } from "./embeds";
export type { RequestUrlParam, RequestUrlResponse, RequestUrlResponsePromise } from "./net";
export { MarkdownRenderer, MarkdownRenderChild, MarkdownPreviewRenderer } from "./markdown";
export type { MarkdownPostProcessor, MarkdownPostProcessorContext, MarkdownSectionInformation } from "./markdown";
export * from "./values";
export { BasesEntry, BasesEntryGroup, BasesQueryResult, BasesViewConfig, BasesView, QueryController, parsePropertyId } from "../bases/api";
export type { BasesPropertyId, BasesViewRegistration } from "../bases/api";
export * from "./util";
export { addIcon, removeIcon, getIcon, getIconIds, setIcon } from "./icons";

import { renderMarkdownMath } from "./math";
export const renderMath = renderMarkdownMath.renderMath;
export const finishRenderMath = renderMarkdownMath.finishRenderMath;
export const loadMathJax = renderMarkdownMath.loadMathJax;
export const loadPdfJs = async (): Promise<any> => ({});
export const loadMermaid = async (): Promise<any> => ({ initialize() {}, render: async () => ({ svg: "" }) });
export const loadPrism = async (): Promise<any> => ({ highlight: (s: string) => s, languages: {}, highlightElement() {} });

export class CapacitorAdapter {}
