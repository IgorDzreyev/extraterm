/*
 * Copyright 2019 Simon Edwards <simon@simonzone.com>
 *
 * This source code is licensed under the MIT license which is detailed in the LICENSE.txt file.
 */
import * as path from 'path';
import * as _ from 'lodash';
import * as ExtensionApi from 'extraterm-extension-api';
import * as Ace from 'ace-ts';
import { BooleanExpressionEvaluator } from 'extraterm-boolean-expression-evaluator';

import { Logger, getLogger, log } from "extraterm-logging";
import { EtTerminal } from '../Terminal';
import { TextViewer } from'../viewers/TextAceViewer';
import { ProxyFactoryImpl } from './ProxyFactoryImpl';
import { ExtensionManager, ExtensionUiUtils, InternalExtensionContext, InternalWindow, ProxyFactory,
  isMainProcessExtension, isSupportedOnThisPlatform, CommandQueryOptions } from './InternalTypes';
import { ExtensionUiUtilsImpl } from './ExtensionUiUtilsImpl';
import { WindowProxy } from './Proxies';
import { ExtensionMetadata, ExtensionCommandContribution, Category, WhenVariables } from '../../ExtensionMetadata';
import * as WebIpc from '../WebIpc';
import { CommandsRegistry } from './CommandsRegistry';
import { CommonExtensionWindowState } from './CommonExtensionState';
import { Mode } from '../viewers/ViewerElementTypes';
import { TextEditor } from '../viewers/TextEditorType';
import { TerminalViewer } from '../viewers/TerminalAceViewer';
import { ViewerElement } from '../viewers/ViewerElement';
import { EmbeddedViewer } from '../viewers/EmbeddedViewer';
import { TabWidget } from '../gui/TabWidget';


interface ActiveExtension {
  metadata: ExtensionMetadata;
  contextImpl: InternalExtensionContext;
  publicApi: any;
  module: any;
}

const allCategories: Category[] = [
  "textEditing",
  "terminalCursorMode",
  "terminal",
  "viewer",
  "window",
  "application",
  "global",
];


export class ExtensionManagerImpl implements ExtensionManager {
  private _log: Logger = null;
  private _extensionMetadata: ExtensionMetadata[] = [];
  private _activeExtensions: ActiveExtension[] = [];

  extensionUiUtils: ExtensionUiUtils = null;

  private _commonExtensionWindowState: CommonExtensionWindowState = {
    activeTabContent: null,
    activeTerminal: null,
    focusTerminal: null,
    activeTextEditor: null,
    focusTextEditor: null,
    activeTabsWidget: null,
    activeViewerElement: null,
    focusViewerElement: null,
    isInputFieldFocus: false,
  };

  constructor() {
    this._log = getLogger("ExtensionManager", this);
    this.extensionUiUtils = new ExtensionUiUtilsImpl();
  }

  startUp(): void {
    this._extensionMetadata = WebIpc.requestExtensionMetadataSync();

    for (const extensionInfo of this._extensionMetadata) {
      if ( ! isMainProcessExtension(extensionInfo) && isSupportedOnThisPlatform(extensionInfo)) {
        this._startExtension(extensionInfo);
      }
    }
  }

  getExtensionContextByName(name: string): InternalExtensionContext {
    for (const ext of this._activeExtensions) {
this._log.debug(`getExtensionContextByName() ext.metadata.name: ${ext.metadata.name}`);
      if (ext.metadata.name === name) {
        return ext.contextImpl;
      }
    }
    return null;
  }

  findViewerElementTagByMimeType(mimeType: string): string {
    for (let extension of this._activeExtensions) {
      const tag = extension.contextImpl.findViewerElementTagByMimeType(mimeType);
      if (tag !== null) {
        return tag;
      }
    }
    return null;
  }

  private _startExtension(metadata: ExtensionMetadata): void {
    this._log.info(`Starting extension '${metadata.name}' in the render process.`);

    let module = null;
    let publicApi = null;
    const contextImpl = new InternalExtensionContextImpl(this, metadata, this._commonExtensionWindowState);
    if (metadata.main != null) {
      module = this._loadExtensionModule(metadata);
      if (module == null) {
        return;
      }

      try {
        publicApi = (<ExtensionApi.ExtensionModule> module).activate(contextImpl);
      } catch(ex) {
        this._log.warn(`Exception occurred while starting extensions ${metadata.name}. ${ex}`);
        return;
      }      
    }
    this._activeExtensions.push({metadata, publicApi, contextImpl, module});
  }

  private _loadExtensionModule(extension: ExtensionMetadata): any {
    const mainJsPath = path.join(extension.path, extension.main);
    try {
      const module = require(mainJsPath);
      return module;
    } catch(ex) {
      this._log.warn(`Unable to load ${mainJsPath}. ${ex}`);
      return null;
    }
  }

  getAllSessionTypes(): { name: string, type: string }[] {
    return _.flatten(
      this._activeExtensions.map(activeExtension => {
        if (activeExtension.metadata.contributes.sessionEditors != null) {
          return activeExtension.metadata.contributes.sessionEditors.map(se => ({name: se.name, type: se.type}));
        } else {
          return [];
        }
      })
    );
  }

  getSessionEditorTagForType(sessionType: string): string {
    const seExtensions = this._activeExtensions.filter(ae => ae.metadata.contributes.sessionEditors != null);
    for (const extension of seExtensions) {
      const tag = extension.contextImpl.internalWindow.getSessionEditorTagForType(sessionType);
      if (tag != null) {
        return tag;
      }
    }
    return null;
  }

  getAllTerminalThemeFormats(): {name: string, formatName: string}[] {
    const results = [];
    for (const metadata of this._extensionMetadata) {
      for (const provider of metadata.contributes.terminalThemeProviders) {
        for (const formatName of provider.humanFormatNames) {
          results.push( { name: provider.name, formatName } );
        }
      }
    }
    return results;
  }

  getAllSyntaxThemeFormats(): {name: string, formatName: string}[] {
    const results = [];
    for (const metadata of this._extensionMetadata) {
      for (const provider of metadata.contributes.syntaxThemeProviders) {
        for (const formatName of provider.humanFormatNames) {
          results.push( { name: provider.name, formatName } );
        }
      }
    }
    return results;
  }

  getActiveTab(): HTMLElement {
    return this._commonExtensionWindowState.activeTabContent;
  }

  getActiveTerminal(): EtTerminal {
    return this._commonExtensionWindowState.activeTerminal;
  }

  getActiveTextEditor(): TextEditor {
    return this._commonExtensionWindowState.activeTextEditor;
  }

  getActiveTabContent(): HTMLElement {
    return this._commonExtensionWindowState.activeTabContent;
  }

  isInputFieldFocus(): boolean {
    return this._commonExtensionWindowState.isInputFieldFocus;
  }

  queryCommands(options: CommandQueryOptions): ExtensionCommandContribution[] {
    return this.queryCommandsWithExtensionWindowState(options, this._commonExtensionWindowState);
  }

  queryCommandsWithExtensionWindowState(options: CommandQueryOptions, context: CommonExtensionWindowState): ExtensionCommandContribution[] {
    const truePredicate = (command: ExtensionCommandContribution): boolean => true;

    let commandPalettePredicate = truePredicate;
    if (options.commandPalette != null) {
      const commandPalette = options.commandPalette;
      commandPalettePredicate = command => command.commandPalette === commandPalette;
    }

    let contextMenuPredicate = truePredicate;
    if (options.contextMenu != null) {
      const contextMenu = options.contextMenu;
      contextMenuPredicate = command => command.contextMenu === contextMenu;
    }

    let emptyPaneMenuPredicate = truePredicate;
    if (options.emptyPaneMenu != null) {
      const emptyPaneMenu = options.emptyPaneMenu;
      emptyPaneMenuPredicate = command => command.emptyPaneMenu === emptyPaneMenu;
    }

    let newTerminalMenuPredicate = truePredicate;
    if (options.newTerminalMenu != null) {
      const newTerminalMenu = options.newTerminalMenu;
      newTerminalMenuPredicate = command => command.newTerminalMenu === newTerminalMenu;
    }

    let categoryPredicate = truePredicate;
    if (options.categories != null) {
      const categories = options.categories;
      categoryPredicate = command => categories.indexOf(command.category) !== -1;
    }

    let commandPredicate = truePredicate;
    if (options.commandsWithCategories != null) {
      const commandsWithCategories = options.commandsWithCategories;

      const index = new Map<Category, string[]>();
      for (const commandWithCategory of commandsWithCategories) {
        if ( ! index.has(commandWithCategory.category)) {
          index.set(commandWithCategory.category, []);
        }
        index.get(commandWithCategory.category).push(commandWithCategory.command);
      }

      commandPredicate = command => {
        if ( ! index.has(command.category)) {
          return false;
        }
        return index.get(command.category).indexOf(command.command) !== -1;
      };
    }

    const whenPredicate = options.when ? this._createWhenPredicate(context) : truePredicate;

    const entries: ExtensionCommandContribution[] = [];
    for (const activeExtension  of this._activeExtensions) {
      for (const command of activeExtension.metadata.contributes.commands) {
        if (commandPredicate(command) && commandPalettePredicate(command) && contextMenuPredicate(command) &&
            emptyPaneMenuPredicate(command) && newTerminalMenuPredicate(command) &&
            categoryPredicate(command) && whenPredicate(command)) {

          const customizer = activeExtension.contextImpl.commands.getFunctionCustomizer(command.command);
          if (customizer != null) {
            entries.push( {...command, ...customizer() });
          } else {
            entries.push(command);
          }
        }
      }
    }
    this._sortCommandsInPlace(entries);
    return entries;
  }

  private _createWhenPredicate(state: CommonExtensionWindowState): (ecc: ExtensionCommandContribution) => boolean {
    const variables = this._createWhenVariables(state);
    const bee = new BooleanExpressionEvaluator(variables);
    return (ecc: ExtensionCommandContribution): boolean => {
      if (ecc.when === "") {
        return true;
      }
      return bee.evaluate(ecc.when);
    };
  }

  private _createWhenVariables(state: CommonExtensionWindowState): WhenVariables {
    const whenVariables: WhenVariables = {
      true: true,
      false: false,
      terminalFocus: false,
      isCursorMode: false,
      isNormalMode: false,
      textEditorFocus: false,
      isTextEditing: false,
      viewerFocus: false,
    };

    if (state.focusTerminal != null) {
      whenVariables.terminalFocus = true;
      if (state.focusTerminal.getMode() === Mode.CURSOR) {
        whenVariables.isCursorMode = true;
      } else {
        whenVariables.isNormalMode = true;
      }
    } else {
      if (state.focusViewerElement) {
        whenVariables.viewerFocus = true;
      }
    }

    if (state.focusTextEditor != null) {
      if ( ! (whenVariables.terminalFocus && whenVariables.isNormalMode)) {
        whenVariables.textEditorFocus = true;
        if (state.focusTextEditor.getEditable()) {
          whenVariables.isTextEditing = true;
        }
      }
    }
    return whenVariables;
  }

  private _sortCommandsInPlace(entries: ExtensionCommandContribution[]): void {
    entries.sort(this._sortCompareFunc);
  }

  private _sortCompareFunc(a: ExtensionCommandContribution, b: ExtensionCommandContribution): number {
    const aIndex = allCategories.indexOf(a.category);
    const bIndex = allCategories.indexOf(b.category);
    if (aIndex !== bIndex) {
      return aIndex < bIndex ? -1 : 1;
    }

    if (a.order !== b.order) {
      return a.order < b.order ? -1 : 1;
    }

    if (a.title !== b.title) {
      return a.title < b.title ? -1 : 1;
    }
    return 0;
  }

  executeCommandWithExtensionWindowState(tempState: CommonExtensionWindowState, command: string, args?: any): any {
    const oldState = this.copyExtensionWindowState();
    this._setExtensionWindowState(tempState);
    const result = this.executeCommand(command, args);
    this._setExtensionWindowState(oldState);
    return result;
  }

  copyExtensionWindowState(): CommonExtensionWindowState {
    return { ...this._commonExtensionWindowState };
  }

  executeCommand(command: string, args?: any): any {
    let commandName = command;
    let argsString: string = null;

    const qIndex = command.indexOf("?");
    if (qIndex !== -1) {
      commandName = command.slice(0, qIndex);
      argsString = command.slice(qIndex+1);
    }

    const parts = commandName.split(":");
    if (parts.length !== 2) {
      this._log.warn(`Command '${command}' does have the right form. (Wrong numer of colons.)`);
      return null;
    }
    
    let extensionName = parts[0];
    if (extensionName === "extraterm") {
      extensionName = "internal-commands";
    }

    if (args === undefined) {
      if (argsString != null) {
        args = JSON.parse(decodeURIComponent(argsString));
      } else {
        args = {};
      }
    }

    for (const ext of this._activeExtensions) {
      if (ext.metadata.name === extensionName) {
        const commandFunc = ext.contextImpl.commands.getCommandFunction(commandName);
        if (commandFunc == null) {
          this._log.warn(`Unable to find command '${commandName}' in extension '${extensionName}'.`);
          return null;
        }
        return this._runCommandFunc(commandName, commandFunc, args);
      }
    }

    this._log.warn(`Unable to find extension with name '${extensionName}' for command '${commandName}'.`);
    return null;
  }

  private _runCommandFunc(name: string, commandFunc: (args: any) => any, args: any): any {
    try {
      return commandFunc(args);
    } catch(ex) {
      this._log.warn(`Command '${name}' threw an exception.`, ex);
    }
    return null;
  }

  updateExtensionWindowStateFromEvent(ev: Event): void {
    const newState = this.getExtensionWindowStateFromEvent(ev);
    this._mergeExtensionWindowState(newState);
  }

  private _mergeExtensionWindowState(newState: CommonExtensionWindowState): void {
    const state = this._commonExtensionWindowState;

    if (state.activeTabContent === newState.activeTabContent) {
      state.activeTerminal = newState.focusTerminal || state.activeTerminal;
      state.activeTextEditor = newState.focusTextEditor || state.activeTextEditor;
      state.activeViewerElement = newState.focusViewerElement || state.activeViewerElement;
    } else {
      state.activeTerminal = newState.focusTerminal;
      state.focusTerminal = newState.focusTerminal;

      state.activeTextEditor = newState.focusTextEditor;
      state.focusTextEditor = newState.focusTextEditor;

      state.activeViewerElement = newState.focusViewerElement;
      state.focusViewerElement = newState.focusViewerElement;
    }
    
    state.activeTabsWidget = newState.activeTabsWidget;
    state.activeTabContent = newState.activeTabContent;
    state.isInputFieldFocus = newState.isInputFieldFocus;
  }

  private _setExtensionWindowState(newState: CommonExtensionWindowState): void {
    for (const key in newState) {
      this._commonExtensionWindowState[key] = newState[key];
    }
  }

  getExtensionWindowStateFromEvent(ev: Event): CommonExtensionWindowState {
    const newState: CommonExtensionWindowState = {
      activeTabContent: null,
      activeTerminal: null,
      focusTerminal: null,
      activeTextEditor: null,
      focusTextEditor: null,
      activeTabsWidget: null,
      activeViewerElement: null,
      focusViewerElement: null,
      isInputFieldFocus: false
    };

    const composedPath = ev.composedPath();
    for (const target of composedPath) {
      if (target instanceof EtTerminal) {
        newState.activeTerminal = target;
      }
      if (target instanceof TerminalViewer || target instanceof TextViewer) {
        newState.activeTextEditor = target;
      }
      if (target instanceof ViewerElement) {
        if (newState.activeViewerElement == null || newState.activeViewerElement instanceof EmbeddedViewer) {
          newState.activeViewerElement = target;
        }
      }
      if (target instanceof TabWidget) {
        newState.activeTabsWidget = target;
      }
      if (target.parentElement != null && target.parentElement.parentElement instanceof TabWidget) {
        newState.activeTabContent = <HTMLElement> target;
      }
      if (target instanceof HTMLInputElement) {
        newState.isInputFieldFocus = true;
      }
    }
    newState.focusTerminal = newState.activeTerminal;
    newState.focusTextEditor = newState.activeTextEditor;
    newState.focusViewerElement = newState.activeViewerElement;
    return newState;
  }

  refocus(state: CommonExtensionWindowState): void {
    if (state.activeViewerElement != null) {
      state.activeViewerElement.focus();
      return;
    }

    if (state.activeTerminal != null) {
      state.activeTerminal.focus();
      return;
    }
  }

  newTerminalCreated(newTerminal: EtTerminal): void {
    newTerminal.addEventListener(EtTerminal.EVENT_APPENDED_VIEWER, (ev: CustomEvent) => {
      for (let extension of this._activeExtensions) {
        extension.contextImpl.internalWindow.terminalAppendedViewer(newTerminal, ev.detail.viewer);
      }
    });

    for (let extension of this._activeExtensions) {
      extension.contextImpl.internalWindow.newTerminalCreated(newTerminal);
    }
  }
}


class InternalExtensionContextImpl implements InternalExtensionContext {
  private _log: Logger = null;

  commands: CommandsRegistry = null;
  window: InternalWindow = null;
  internalWindow: InternalWindow = null;
  aceModule: typeof Ace = Ace;
  logger: ExtensionApi.Logger = null;
  isBackendProcess = false;

  proxyFactory: ProxyFactory = null;

  constructor(public extensionManager: ExtensionManager, public extensionMetadata: ExtensionMetadata,
              commonExtensionState: CommonExtensionWindowState) {

    this._log = getLogger("InternalExtensionContextImpl", this);
    this.proxyFactory = new ProxyFactoryImpl(this);
    this.commands = new CommandsRegistry(this, extensionMetadata.name, extensionMetadata.contributes.commands);
    this.window = new WindowProxy(this, commonExtensionState);
    this.internalWindow = this.window;
    this.logger = getLogger(extensionMetadata.name);
  }

  get backend(): never {
    this.logger.warn("'ExtensionContext.backend' is not available from a render process.");
    throw Error("'ExtensionContext.backend' is not available from a render process.");
  }

  findViewerElementTagByMimeType(mimeType: string): string {
    return this.internalWindow.findViewerElementTagByMimeType(mimeType);
  }

  debugRegisteredCommands(): void {
    for (const command of this.extensionMetadata.contributes.commands) {
      if (this.commands.getCommandFunction(command.command) == null) {
        this._log.debug(`Command '${command.command}' from extension '${this.extensionMetadata.name}' has no function registered.`);
      }
    }
  }

  registerCommandContribution(contribution: ExtensionCommandContribution): ExtensionApi.Disposable {
    this.extensionMetadata.contributes.commands.push(contribution);
    const commandDisposable = this.commands.registerCommandContribution(contribution);
    return {
      dispose: () => {
        commandDisposable.dispose();
        const index = this.extensionMetadata.contributes.commands.indexOf(contribution);
        this.extensionMetadata.contributes.commands.splice(index, 1);
      }
    };
  }
}
