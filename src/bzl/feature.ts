import * as vscode from 'vscode';
import { API } from '../api';
import { IExtensionFeature } from '../common';
import { BzlClient, Closeable } from './bzlclient';
import { BzlServerProcess } from './client';
import { BzlServerCommandRunner } from './commandrunner';
import {
    BzlConfiguration,
    BzlServerConfiguration,
    createAuthServiceClient,
    createBzlConfiguration,
    createLicensesClient,
    createPlansClient,
    createSubscriptionsClient,
    loadAuthProtos,
    loadBzlProtos,
    loadLicenseProtos,
    loadNucleateProtos
} from './configuration';
import { CommandName, ConfigSection, Server, ViewName } from './constants';
import { EmptyView } from './view/emptyview';
import { BuildEventProtocolView } from './view/events';
import { BzlHelp } from './view/help';
import { BzlCommandHistoryView } from './view/history';
import { BzlAccountView } from './view/license';
import { BzlPackageListView } from './view/packages';
import { BzlRepositoryListView } from './view/repositories';
import { BzlServerView } from './view/server';
import { BzlSignup } from './view/signup';
import { BzlWorkspaceListView } from './view/workspaces';

export const BzlFeatureName = 'bsv.bzl';

export class BzlFeature implements IExtensionFeature, vscode.Disposable {
    public readonly name = BzlFeatureName;

    private disposables: vscode.Disposable[] = [];
    private closeables: Closeable[] = [];
    private client: BzlClient | undefined;
    private onDidBzlClientChange = new vscode.EventEmitter<BzlClient>();

    constructor(private api: API) {
        this.add(this.onDidBzlClientChange);
    }

    async activate(ctx: vscode.ExtensionContext, config: vscode.WorkspaceConfiguration): Promise<any> {
        const cfg = await createBzlConfiguration(ctx.asAbsolutePath.bind(ctx), ctx.globalStoragePath, config);
        this.setupStackBuildActivity(ctx, cfg);

        const token = config.get<string>(ConfigSection.LicenseToken);
        if (!token) {
            new EmptyView(ViewName.Repository, this.disposables);
            new EmptyView(ViewName.Workspace, this.disposables);
            new EmptyView(ViewName.Package, this.disposables);
            new EmptyView(ViewName.History, this.disposables);
            new EmptyView(ViewName.BEP, this.disposables);
            return;
        }

        cfg.server.command.push(Server.LicenseTokenFlag);
        cfg.server.command.push(token);

        return this.setupBazelActivity(ctx, cfg);
    }

    async setupBazelActivity(ctx: vscode.ExtensionContext, cfg: BzlConfiguration) {

        const bzlProto = loadBzlProtos(cfg.server.protofile);
        this.client = this.add(new BzlClient(bzlProto, cfg.server.address));
        
        const commandRunner = this.add(new BzlServerCommandRunner(
            cfg.commandTask,
            this.onDidBzlClientChange.event,
        ));

        this.add(new BuildEventProtocolView(
            this.api,
            this.onDidBzlClientChange.event,
            commandRunner.onDidReceiveBazelBuildEvent.event,
        ));

        const repositoryListView = this.add(new BzlRepositoryListView(
            this.onDidBzlClientChange.event,
        ));

        this.add(new BzlCommandHistoryView(
            this.onDidBzlClientChange.event,
            repositoryListView.onDidChangeCurrentRepository.event,
            commandRunner.onDidRunCommand.event,
            commandRunner,
        ));

        const workspaceListView = this.add(new BzlWorkspaceListView(
            this.onDidBzlClientChange.event,
            repositoryListView.onDidChangeCurrentRepository.event,
        ));

        this.add(new BzlPackageListView(
            commandRunner,
            this.onDidBzlClientChange.event,
            repositoryListView.onDidChangeCurrentRepository.event,
            workspaceListView.onDidChangeCurrentExternalWorkspace.event,
        ));

        this.add(new BzlServerView(
            bzlProto,
            cfg.server.remotes,
            this.onDidBzlClientChange,
        ));

        new BzlHelp(CommandName.HelpRepository, ctx.asAbsolutePath, this.disposables);
        new BzlHelp(CommandName.HelpWorkspace, ctx.asAbsolutePath, this.disposables);
        new BzlHelp(CommandName.HelpPackage, ctx.asAbsolutePath, this.disposables);

        return this.tryConnectServer(cfg.server, 0);
    }

    async tryConnectServer(cfg: BzlServerConfiguration, attempts: number): Promise<void> {
        if (attempts > 3) {
            return Promise.reject(`could not connect to bzl: too many failed attempts to ${cfg.address}, giving up.`);
        }
        
        try {
            await this.client!.waitForReady();
            const metadata = await this.client!.getMetadata();
            console.debug(`Connected to bzl ${metadata.version} at ${cfg.address}`);
            this.onDidBzlClientChange.fire(this.client!);
        } catch (e) {
            console.log('connect error', e);
            return this.startServer(cfg, ++attempts);
        }
    }

    async startServer(cfg: BzlServerConfiguration, attempts: number): Promise<void> {
        console.log('starting server!');

        const server = this.add(new BzlServerProcess(cfg.executable, cfg.command));
        server.start();
        await server.onReady();
        return this.tryConnectServer(cfg, attempts);
    }

    setupStackBuildActivity(ctx: vscode.ExtensionContext, cfg: BzlConfiguration) {

        const licenseProto = loadLicenseProtos(cfg.license.protofile);
        const authProto = loadAuthProtos(cfg.auth.protofile);
        const nucleateProto = loadNucleateProtos(cfg.nucleate.protofile);

        const authClient = createAuthServiceClient(authProto, cfg.auth.address);
        this.closeables.push(authClient);

        const licenseClient = createLicensesClient(licenseProto, cfg.license.address);
        this.closeables.push(licenseClient);

        const subscriptionsClient = createSubscriptionsClient(nucleateProto, cfg.nucleate.address);
        this.closeables.push(subscriptionsClient);

        const plansClient = createPlansClient(nucleateProto, cfg.nucleate.address);
        this.closeables.push(licenseClient);

        this.disposables.push(new BzlSignup(ctx.extensionPath, cfg.license, authClient, licenseClient, plansClient, subscriptionsClient));
        this.disposables.push(new BzlAccountView(cfg.license.token, licenseClient));
    }

    public deactivate() {
        this.dispose();

        // Even when deactivated/disposed we need to provide view implementations
        // declared in the package.json to avoid the 'no tree view with id ...' error.
        new EmptyView(ViewName.Repository, this.disposables);
        new EmptyView(ViewName.Workspace, this.disposables);
        new EmptyView(ViewName.Package, this.disposables);
        new EmptyView(ViewName.BEP, this.disposables);
        new EmptyView(ViewName.History, this.disposables);
        new EmptyView(ViewName.Account, this.disposables);
        new EmptyView(ViewName.Server, this.disposables);
    }

    protected add<T extends vscode.Disposable>(disposable: T): T {
        this.disposables.push(disposable);
        return disposable;
    }

    public dispose() {
        for (const closeable of this.closeables) {
            closeable.close();
        }
        this.closeables.length = 0;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;
    }

}
