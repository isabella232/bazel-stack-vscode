import * as grpc from '@grpc/grpc-js';
import * as vscode from 'vscode';
import { event } from 'vscode-common';
import { CommandCodeLensProvider } from '../../api';
import { getRelativeDateFromTimestamp, md5Hash } from '../../common';
import { BuiltInCommands } from '../../constants';
import { Container } from '../../container';
import { Workspace } from '../../proto/build/stack/bezel/v1beta1/Workspace';
import { CreateScopeRequest } from '../../proto/build/stack/codesearch/v1beta1/CreateScopeRequest';
import { CreateScopeResponse } from '../../proto/build/stack/codesearch/v1beta1/CreateScopeResponse';
import { Scope } from '../../proto/build/stack/codesearch/v1beta1/Scope';
import { Query } from '../../proto/livegrep/Query';
import { BzlCodesearch } from '../bzlclient';
import { CommandName } from '../constants';
import { OutputChannelName, PanelTitle, QueryOptions } from './constants';
import { CodesearchPanel, CodesearchRenderProvider, Message } from './panel';
import { CodesearchRenderer } from './renderer';
import path = require('path');
import Long = require('long');

/**
 * CodesearchIndexOptions describes options for the index command.
 */
export interface CodesearchIndexOptions {
    // arguments to the index operation, typically a single element bazel query
    // expression
    args: string[],
    // The bazel working directory
    cwd: string
}

export interface OutputChannel {
    clear(): void;
    show(): void;
    appendLine(line: string): void;
}

/**
 * CodeSearchCodeLens implements a codelens provider for launch.bazelrc lines
 * like `codesearch deps(//...)`.
 */
export class CodeSearchCodeLens implements CommandCodeLensProvider, vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private output: vscode.OutputChannel;
    private renderer = new CodesearchRenderer();
    private _onDidChangeCommandCodeLenses = new vscode.EventEmitter<void>();
    /** 
     * A mapping of scope name (typically md5 hash of the query) to Scope. Used
     * to make the codelens command titles more informative. 
     * */
    private scopes: Map<string, Scope> = new Map();

    private currentWorkspace: Workspace | undefined;
    private client: BzlCodesearch | undefined;
    private panel: CodesearchPanel | undefined;

    /**
     * Implements part of the CommandCodeLensProvider interface.
     */
    public onDidChangeCommandCodeLenses = this._onDidChangeCommandCodeLenses.event;

    constructor(
        workspaceChanged: vscode.Event<Workspace | undefined>,
        onDidChangeBzlClient: vscode.Event<BzlCodesearch>,
        skipCommandRegistrationForTesting = false,
    ) {
        const output = this.output = vscode.window.createOutputChannel(OutputChannelName);
        this.disposables.push(output);
        this.disposables.push(this.renderer);
        this.disposables.push(this._onDidChangeCommandCodeLenses);

        workspaceChanged(this.handleWorkspaceChanged, this, this.disposables);
        onDidChangeBzlClient(this.handleBzlClientChange, this, this.disposables);
        
        if (!skipCommandRegistrationForTesting) {
            this.registerCommands();
        }
    }

    registerCommands() {
        this.disposables.push(vscode.commands.registerCommand(CommandName.CodeSearchIndex, this.handleCodesearchIndex, this));
        this.disposables.push(vscode.commands.registerCommand(CommandName.CodeSearchSearch, this.handleCodesearchSearch, this));
    }

    async handleWorkspaceChanged(workspace: Workspace | undefined) {
        this.currentWorkspace = workspace;
        if (workspace) {
            return this.updateScopes();
        }
    }

    handleBzlClientChange(client: BzlCodesearch) {
        this.client = client;
    }

    async updateScopes() {
        if (!(this.client && this.currentWorkspace)) {
            return;
        }
        const result = await this.client.listScopes({
            outputBase: this.currentWorkspace.outputBase,
        });
        this.scopes.clear();
        for (const scope of result.scope || []) {
            this.scopes.set(scope.name!, scope);
        }
        this._onDidChangeCommandCodeLenses.fire();
    }

    getOrCreateSearchPanel(queryExpression: string): CodesearchPanel {
        if (!this.panel) {
            this.panel = new CodesearchPanel(Container.context.extensionPath, PanelTitle, `Codesearch ${queryExpression}`, vscode.ViewColumn.One);
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            }, this, this.disposables);
        }
        return this.panel;
    }

    checkCodelensPreconditions(command: string): boolean {
        const client = this.client;
        if (!client) {
            vscode.window.showWarningMessage(`Cannot execute command "${command}" (bzl client not active)`);
            return false;
        }
        const ws = this.currentWorkspace;
        if (!ws) {
            vscode.window.showWarningMessage(`Cannot execute command "${command}" (no active bazel workspace)`);
            return false;
        }
        return true;
    }

    async handleCodesearchIndex(opts: CodesearchIndexOptions): Promise<void> {
        if (!this.checkCodelensPreconditions(CommandName.CodeSearchIndex)) {
            return;
        }
        const client = this.client;
        if (!client) {
            return;
        }
        const ws = this.currentWorkspace;
        if (!ws) {
            return;
        }
        return this.createScope(opts, client, ws, this.output);
    }

    async createScope(opts: CodesearchIndexOptions, client: BzlCodesearch, ws: Workspace, output: OutputChannel): Promise<void> {

        const queryExpression = opts.args.join(' ');
        const scopeName = md5Hash(queryExpression);

        const request: CreateScopeRequest = {
            cwd: ws.cwd,
            outputBase: ws.outputBase,
            name: scopeName,
            bazelQuery: {
                expression: queryExpression,
            },
        };

        output.clear();
        output.show();

        return client.createScope(request, async (response: CreateScopeResponse) => {
            if (response.progress) {
                for (const line of response.progress || []) {
                    output.appendLine(line);
                }
            }
        });
    }

    async handleCodesearchSearch(opts: CodesearchIndexOptions): Promise<void> {
        if (!this.checkCodelensPreconditions(CommandName.CodeSearchSearch)) {
            return;
        }
        const client = this.client;
        if (!client) {
            return;
        }
        const ws = this.currentWorkspace;
        if (!ws) {
            return;
        }

        const query: Query = {
            repo: ws.outputBase,
            file: ws.cwd,
            foldCase: true,
            maxMatches: 50,
            contextLines: 3,
            tags: QueryOptions.QuoteMeta,
        };

        const queryExpression = opts.args.join(' ');
        const scopeName = md5Hash(queryExpression);
        const panel = this.getOrCreateSearchPanel(queryExpression);

        const queryChangeEmitter = new event.Emitter<Query>();

        const queryDidChange = event.Event.debounce(
            queryChangeEmitter.event,
            (last, e) => e,
            250,
            true,
        );

        queryDidChange(async (q) => {
            if (!q.line) {
                panel.onDidChangeHTMLSummary.fire('');
                panel.onDidChangeHTMLResults.fire('');
                return;
            }

            try {
                const result = await client.searchScope({
                    scopeName: scopeName,
                    query: q,
                });
                panel.onDidChangeHTMLSummary.fire(await this.renderer.renderSummary(result));
                panel.onDidChangeHTMLResults.fire(await this.renderer.renderResults(result, ws));
            } catch (e) {
                const err = e as grpc.ServiceError;
                panel.onDidChangeHTMLSummary.fire(err.message);
                panel.onDidChangeHTMLResults.fire('');
            }
        });

        return this.renderSearchPanel(queryExpression, panel, query, queryChangeEmitter);
    }

    async renderSearchPanel(queryExpression: string, panel: CodesearchRenderProvider, query: Query, queryChangeEmitter: vscode.EventEmitter<Query>): Promise<void> {
        return panel.render({
            title: `Search ${queryExpression}`,
            heading: PanelTitle,
            form: {
                name: 'search',
                inputs: [
                    {
                        label: 'Query',
                        type: 'text',
                        name: 'number',
                        placeholder: 'Search expression',
                        display: 'inline-block',
                        size: 40,
                        autofocus: true,
                        onchange: async (value: string) => {
                            if (!value || value.length < 3) {
                                query.line = '';
                                queryChangeEmitter.fire(query);
                                return;
                            }
                            query.line = value;
                            queryChangeEmitter.fire(query);
                            return '';
                        },
                    },
                    {
                        label: 'Max Matches',
                        type: 'number',
                        name: 'max',
                        value: '50',
                        display: 'inline-block',
                        maxlength: 3,
                        size: 3,
                        onchange: async (value: string) => {
                            if (!value) {
                                return;
                            }
                            query.maxMatches = parseInt(value, 10);
                            queryChangeEmitter.fire(query);
                            return '';
                        },
                    },
                    {
                        label: 'Lines Context',
                        type: 'number',
                        name: 'context',
                        value: '3',
                        maxlength: 3,
                        display: 'inline-block',
                        size: 2,
                        onchange: async (value: string) => {
                            if (!value) {
                                return;
                            }
                            query.contextLines = parseInt(value, 10);
                            queryChangeEmitter.fire(query);
                            return '';
                        },
                    },
                    {
                        label: 'Regexp',
                        type: 'checkbox',
                        name: 'regexp',
                        style: 'vertical-align: top',
                        display: 'inline-block',
                        onchange: async (value: string) => {
                            if (!value) {
                                return;
                            }
                            query.tags = value === 'on' ? '' : QueryOptions.QuoteMeta;
                            queryChangeEmitter.fire(query);
                            return '';
                        },
                    }
                ]
            },
            callbacks: {
                'click.line': (m: Message) => {
                    if (!m.data) {
                        return;
                    }
                    const filename = m.data['file'];
                    const line = m.data['line'];
                    const col = m.data['col'];
                    if (!(filename && line && col)) {
                        return;
                    }
                    vscode.commands.executeCommand(BuiltInCommands.Open, vscode.Uri.file(filename).with({
                        fragment: `${line},${col}`,
                    }));
                }
            },
        });
    }

    async provideCommandCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
        lineNum: number,
        colNum: number,
        command: string,
        args: string[],
    ): Promise<vscode.CodeLens[] | undefined> {
        const client = this.client;
        if (!client) {
            return;
        }
        const ws = this.currentWorkspace;
        if (!ws) {
            return;
        }

        const cwd = path.dirname(document.uri.fsPath);
        const scopeName = md5Hash(args.join(' '));
        const scope = this.scopes.get(scopeName);

        const range = new vscode.Range(
            new vscode.Position(lineNum, colNum),
            new vscode.Position(lineNum, colNum + command.length));

        let indexTitle = 'Index';
        if (scope && scope.createdAt) {
            const created = getRelativeDateFromTimestamp(scope.createdAt);
            indexTitle += ` (${created})`;
        }
        const index = new vscode.CodeLens(range, {
            command: CommandName.CodeSearchIndex,
            title: indexTitle,
            arguments: [{
                args: args,
                cwd: cwd,
            }],
        });

        let searchTitle = 'Search';
        if (scope && scope.size) {
            const files = Long.fromValue(scope.size).toInt();
            searchTitle += ` (${files} files)`;
        }

        const search = new vscode.CodeLens(range, {
            command: CommandName.CodeSearchSearch,
            title: searchTitle,
            arguments: [{
                args: args,
                cwd: cwd,
            }],
        });

        return [index, search];
    }

    public dispose() {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }
}