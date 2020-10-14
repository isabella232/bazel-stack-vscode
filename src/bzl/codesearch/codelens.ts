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
import { CodesearchPanel, Message } from './panel';
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
    ) {
        const output = this.output = vscode.window.createOutputChannel(OutputChannelName);
        this.disposables.push(output);
        this.disposables.push(this._onDidChangeCommandCodeLenses);
        this.disposables.push(vscode.commands.registerCommand(CommandName.CodeSearchIndex, this.handleCodesearchIndex, this));
        this.disposables.push(vscode.commands.registerCommand(CommandName.CodeSearchSearch, this.handleCodesearchSearch, this));

        workspaceChanged(this.handleWorkspaceChanged, this, this.disposables);
        onDidChangeBzlClient(this.handleBzlClientChange, this, this.disposables);
    }

    handleWorkspaceChanged(workspace: Workspace | undefined) {
        this.currentWorkspace = workspace;
        if (workspace) {
            this.updateScopes();
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

        return new Promise((resolve, reject) => {
            this.output.clear();
            this.output.show();

            const stream = client.scopes.Create(request, new grpc.Metadata());

            stream.on('data', (response: CreateScopeResponse) => {
                if (response.progress) {
                    for (const line of response.progress || []) {
                        this.output.appendLine(line);
                    }
                }
            });

            stream.on('metadata', (md: grpc.Metadata) => {
            });

            stream.on('error', (err: Error) => {
                reject(err.message);
            });

            stream.on('end', () => {
                resolve();
            });
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

        const queryChangeEmitter = new event.Emitter<Query>();
        const renderedHtmlDidChange = new event.Emitter<string>();

        const queryDidChange = event.Event.debounce(
            queryChangeEmitter.event,
            (last, e) => e,
            250,
            true,
        );

        const queryExpression = opts.args.join(' ');
        const scopeName = md5Hash(queryExpression);

        const panel = this.getOrCreateSearchPanel(queryExpression);
        await panel.render({
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

        queryDidChange(async (q) => {
            if (!query.line) {
                return;
            }
            try {
                const result = await client.search({
                    scopeName: scopeName,
                    query: q,
                });

                panel.postMessage({
                    command: 'innerHTML',
                    type: 'div',
                    id: 'summary',
                    value: await this.renderer.renderSummary(result, this.currentWorkspace!),
                });

                const html = await this.renderer.renderResults(result, this.currentWorkspace!);
                renderedHtmlDidChange.fire(html);

            } catch (e) {
                const err = e as grpc.ServiceError;
                panel.postMessage({
                    command: 'innerHTML',
                    type: 'div',
                    id: 'summary',
                    value: err.message,
                });
                renderedHtmlDidChange.fire('');
            }
        });

        renderedHtmlDidChange.event(async html => {
            return panel.postMessage({
                command: 'innerHTML',
                type: 'div',
                id: 'results',
                value: html,
            });
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
