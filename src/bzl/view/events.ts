import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';
import * as vscode from 'vscode';
import { IMarker, IMarkerService, MarkerSeverity } from '../../common/markers';
import { MarkerService } from '../../common/markerService';
import { IProblemMatcherRegistry, LineDecoder, ProblemMatcher, StartStopProblemCollector } from '../../common/problemMatcher';
import * as strings from '../../common/strings';
import { BuiltInCommands } from '../../constants';
import { downloadAsset } from '../../download';
import { FileKind } from '../../proto/build/stack/bezel/v1beta1/FileKind';
import { Workspace } from '../../proto/build/stack/bezel/v1beta1/Workspace';
import { ActionExecuted } from '../../proto/build_event_stream/ActionExecuted';
import { _build_event_stream_BuildEventId_NamedSetOfFilesId as NamedSetOfFilesId } from '../../proto/build_event_stream/BuildEventId';
import { BuildFinished } from '../../proto/build_event_stream/BuildFinished';
import { BuildStarted } from '../../proto/build_event_stream/BuildStarted';
import { File } from '../../proto/build_event_stream/File';
import { NamedSetOfFiles } from '../../proto/build_event_stream/NamedSetOfFiles';
import { TargetComplete } from '../../proto/build_event_stream/TargetComplete';
import { TargetConfigured } from '../../proto/build_event_stream/TargetConfigured';
import { TestResult } from '../../proto/build_event_stream/TestResult';
import { WorkspaceConfig } from '../../proto/build_event_stream/WorkspaceConfig';
import { FailureDetail } from '../../proto/failure_details/FailureDetail';
import { BzlClient } from '../bzlclient';
import { BazelBuildEvent } from '../commandrunner';
import { BzlClientTreeDataProvider } from './bzlclienttreedataprovider';
import Long = require('long');

const bazelSvg = path.join(__dirname, '..', '..', '..', 'media', 'bazel-icon.svg');
const bazelWireframeSvg = path.join(__dirname, '..', '..', '..', 'media', 'bazel-wireframe.svg');
const stackbSvg = path.join(__dirname, '..', '..', '..', 'media', 'stackb.svg');

/**
 * Renders a view for bezel license status.  Makes a call to the status
 * endpoint to gather the data.
 */
export class BuildEventProtocolView extends BzlClientTreeDataProvider<BazelBuildEventItem> {
    static readonly viewId = 'bzl-events';
    static readonly commandActionStderr = BuildEventProtocolView.viewId + '.action.stderr';
    static readonly commandActionStdout = BuildEventProtocolView.viewId + '.action.stdout';
    static readonly commandPrimaryOutputFile = BuildEventProtocolView.viewId + '.event.output';
    static readonly commandStartedExplore = BuildEventProtocolView.viewId + '.started.explore';
    static readonly commandFileDownload = BuildEventProtocolView.viewId + '.file.download';
    static readonly commandFileSave = BuildEventProtocolView.viewId + '.file.save';
    static readonly revealButton = 'Reveal';

    private items: BazelBuildEventItem[] = [];
    private testsPassed: TestResult[] = [];
    private state = new BuildEventState();
    private problemCollector: ProblemCollector;

    constructor(
        protected problemMatcherRegistry: IProblemMatcherRegistry,
        onDidChangeBzlClient: vscode.Event<BzlClient>,
        onDidRecieveBazelBuildEvent: vscode.Event<BazelBuildEvent>
    ) {
        super(BuildEventProtocolView.viewId, onDidChangeBzlClient);

        onDidRecieveBazelBuildEvent(this.handleBazelBuildEvent, this, this.disposables);

        this.disposables.push(this.problemCollector = new ProblemCollector(
            problemMatcherRegistry,
        ));
    }

    registerCommands() {
        // super.registerCommands(); // explicitly skipped as we don't need a 'refresh' command
        this.disposables.push(vscode.window.registerTreeDataProvider(BuildEventProtocolView.viewId, this));
        this.disposables.push(vscode.commands.registerCommand(BuildEventProtocolView.commandActionStderr, this.handleCommandActionStderr, this));
        this.disposables.push(vscode.commands.registerCommand(BuildEventProtocolView.commandActionStdout, this.handleCommandActionStdout, this));
        this.disposables.push(vscode.commands.registerCommand(BuildEventProtocolView.commandPrimaryOutputFile, this.handleCommandPrimaryOutputFile, this));
        this.disposables.push(vscode.commands.registerCommand(BuildEventProtocolView.commandStartedExplore, this.handleCommandStartedExplore, this));
        this.disposables.push(vscode.commands.registerCommand(BuildEventProtocolView.commandFileDownload, this.handleCommandFileDownload, this));
        this.disposables.push(vscode.commands.registerCommand(BuildEventProtocolView.commandFileSave, this.handleCommandFileSave, this));
    }

    async handleCommandFileDownload(item: FileItem): Promise<void> {
        const client = this.client;
        if (!client) {
            return;
        }
        const response = await client.downloadFile(
            this.state.createWorkspace(), FileKind.EXTERNAL, item.file.uri!);
        vscode.commands.executeCommand(BuiltInCommands.Open, vscode.Uri.parse(`${client.httpURL()}${response.uri}`));
    }

    async handleCommandFileSave(item: FileItem): Promise<void> {
        const client = this.client;
        if (!client) {
            return;
        }
        const response = await client.downloadFile(
            this.state.createWorkspace(), FileKind.EXTERNAL, item.file.uri!);
        const hostDir = client.address.replace(':', '-');
        const relname = path.join('bazel-out', hostDir, item.file.name!);
        let rootDir = this.state.workspaceInfo?.localExecRoot!;
        if (!fs.existsSync(rootDir)) {
            rootDir = vscode.workspace.rootPath || '.';
        }
        const filename = path.join(rootDir, relname);
        const url = `${client.httpURL()}${response.uri}`;
        await vscode.window.withProgress<void>({
            location: vscode.ProgressLocation.SourceControl,
            title: `Downloading ${path.basename(relname)}`,
            cancellable: true,
        }, async (progress: vscode.Progress<{ message: string | undefined }>, token: vscode.CancellationToken): Promise<void> => {
            return downloadAsset(url, filename, response.mode!);
        });
        const selection = await vscode.window.showInformationMessage(
            `Saved ${relname}`,
            BuildEventProtocolView.revealButton,
        );
        if (selection === BuildEventProtocolView.revealButton) {
            return vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filename));
        }
    }

    async handleCommandStartedExplore(item: BuildStartedItem): Promise<void> {
        if (!(item instanceof BuildStartedItem)) {
            return;
        }
        vscode.commands.executeCommand(BuiltInCommands.Open, vscode.Uri.parse(`${this.client?.httpURL()}/stream/${item.event.bes.started?.uuid}`));
    }

    async handleCommandActionStderr(item: ActionFailedItem): Promise<void> {
        if (!(item instanceof ActionFailedItem)) {
            return;
        }
        return this.openFile(item.event.bes.action?.stderr);
    }

    async handleCommandActionStdout(item: ActionFailedItem): Promise<void> {
        if (!(item instanceof ActionFailedItem)) {
            return;
        }
        return this.openFile(item.event.bes.action?.stdout);
    }

    async handleCommandPrimaryOutputFile(item: BazelBuildEventItem): Promise<void> {
        const file = item.getPrimaryOutputFile();
        if (!file) {
            return;
        }
        return this.openFile(file);
    }

    async openFile(file: File | undefined): Promise<void> {
        if (!(file && file.uri)) {
            return;
        }
        return vscode.commands.executeCommand(BuiltInCommands.Open, vscode.Uri.parse(file.uri));
    }

    clear(): void {
        this.items.length = 0;
        this.testsPassed.length = 0;
        this.state.reset();
        this.problemCollector.clear();
    }

    addItem(item: BazelBuildEventItem) {
        this.items.push(item);
        this.refresh();
    }

    replaceLastItem(item: BazelBuildEventItem) {
        this.items[this.items.length - 1] = item;
        this.refresh();
    }

    getTreeItem(element: BazelBuildEventItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: BazelBuildEventItem): Promise<BazelBuildEventItem[] | undefined> {
        if (element) {
            return element.getChildren();
        }
        return this.getRootItems();
    }

    async getRootItems(): Promise<BazelBuildEventItem[] | undefined> {
        return this.items;
    }

    async handleBazelBuildEvent(e: BazelBuildEvent) {
        switch (e.bes.payload) {
            case 'started':
                return this.handleStartedEvent(e, e.bes.started!);
            case 'workspaceInfo':
                return this.handleWorkspaceInfoEvent(e, e.bes.workspaceInfo!);
            case 'action':
                return this.handleActionExecutedEvent(e, e.bes.action!);
            case 'namedSetOfFiles':
                return this.handleNamedSetOfFilesEvent(e);
            case 'configured':
                return this.handleTargetConfiguredEvent(e);
            case 'completed':
                return this.handleCompletedEvent(e, e.bes.completed!);
            case 'finished':
                return this.handleFinishedEvent(e, e.bes.finished!);
            case 'testResult':
                return this.handleTestResultEvent(e, e.bes.testResult!);
            default:
            // console.log(`skipping "${e.bes.payload}"`);
        }
    }

    async handleStartedEvent(e: BazelBuildEvent, started: BuildStarted) {
        this.clear();
        this.state.started = started;
        this.problemCollector.started = started;
        this.addItem(new BuildStartedItem(e));
    }

    async handleWorkspaceInfoEvent(e: BazelBuildEvent, workspaceInfo: WorkspaceConfig) {
        this.state.workspaceInfo = workspaceInfo;
    }

    async handleCompletedEvent(e: BazelBuildEvent, completed: TargetComplete) {
        this.addItem(new TargetCompleteItem(e, this.state));
    }

    async handleFinishedEvent(e: BazelBuildEvent, finished: BuildFinished) {
        this.items = this.items.filter(item => item.attention);
        if (finished.overallSuccess) {
            this.addItem(new BuildSuccessItem(e, this.state.started));
        } else {
            this.addItem(new BuildFailedItem(e, this.state.started));
        }
    }

    handleNamedSetOfFilesEvent(e: BazelBuildEvent) {
        this.state.handleNamedSetOfFiles(e);
    }

    handleTargetConfiguredEvent(e: BazelBuildEvent) {
        this.state.handleTargetConfigured(e);
    }

    async handleActionExecutedEvent(e: BazelBuildEvent, action: ActionExecuted) {
        if (action.success) {
            return this.handleActionExecutedEventSuccess(e, action);
        }
        this.addItem(new ActionFailedItem(e, this.problemCollector));
    }

    async handleActionExecutedEventSuccess(e: BazelBuildEvent, action: ActionExecuted) {
        const item = new ActionSuccessItem(e);
        if (this.items[this.items.length - 1] instanceof ActionSuccessItem) {
            this.replaceLastItem(item);
        } else {
            this.addItem(item);
        }
    }

    async handleTestResultEvent(e: BazelBuildEvent, test: TestResult) {
        if (test.status === 'PASSED') {
            this.testsPassed.push(test);
            return;
        }
        this.addItem(new TestResultFailedItem(e));
    }

}


export class BazelBuildEventItem extends vscode.TreeItem {
    
    constructor(
        public readonly event: BazelBuildEvent,
        public label?: string,
    ) {
        super(label || event.bes.payload!);
        this.tooltip = `#${event.obe.sequenceNumber} ${event.bes.payload}`;
        // this.iconPath = stackbSvg;
        this.contextValue = event.bes.payload;
        // this.command = {
        //     title: 'Open Primary Output File',
        //     command: BuildEventProtocolView.commandPrimaryOutputFile,
        //     arguments: [this],
        // };
    }

    /**
     * This flag is used to filter events the end of a build to indicate if they
     * require attention by the user.
     */
    get attention(): boolean {
        return false;
    }
    
    getPrimaryOutputFile(): File | undefined {
        return undefined;
    }

    async getChildren(): Promise<BazelBuildEventItem[] | undefined> {
        return undefined;
    }
}

export class BuildStartedItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
    ) {
        super(event, `Started bazel ${event.bes.started?.buildToolVersion} ${event.bes.started?.command}`);
        this.description = event.bes.started?.optionsDescription;
        // this.iconPath = new vscode.ThemeIcon('debug-continue');
        this.iconPath = bazelSvg;
    }

    get attention(): boolean {
        return true;
    }

}


export class BuildFinishedItem extends BazelBuildEventItem {
    protected timeDelta: Long | undefined;
    constructor(
        public readonly event: BazelBuildEvent,
        started: BuildStarted | undefined,
    ) {
        super(event, `Bazel ${event.bes.started?.buildToolVersion} ${event.bes.started?.command}`);
        const end = Long.fromValue(event.bes.finished?.finishTimeMillis!);
        const start = Long.fromValue(started?.startTimeMillis!);
        try {
            this.timeDelta = end.sub(start);
        } catch (e) {
            console.warn(`Could not compute timeDelta ${end}, ${start}`);
        }
        let elapsed = '';
        if (this.timeDelta) {
            elapsed = `(${this.timeDelta?.toString()}ms)`;
        }
        this.label = `${event.bes.finished?.exitCode?.name} ${elapsed}`;
    }

    get attention(): boolean {
        return true;
    }
}


export class BuildSuccessItem extends BuildFinishedItem {
    constructor(
        public readonly event: BazelBuildEvent,
        started: BuildStarted | undefined,
    ) {
        super(event, started);
        this.iconPath = bazelSvg;
    }
}

export class BuildFailedItem extends BuildFinishedItem {
    constructor(
        public readonly event: BazelBuildEvent,
        started: BuildStarted | undefined,
    ) {
        super(event, started);
        this.iconPath = bazelWireframeSvg;
    }
}

export class ActionExecutedItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
    ) {
        super(event, `${event.bes.action?.type} action`);
        this.description = `${event.bes.action?.label || ''}`;
        this.tooltip = event.bes.action?.commandLine?.join(' ');
        this.iconPath = new vscode.ThemeIcon('symbol-event');
    }

    getPrimaryOutputFile(): File | undefined {
        if (this.event.bes.action?.stderr) {
            return this.event.bes.action?.stderr;
        }
        return this.event.bes.action?.stdout;
    }

}

export class ActionFailedItem extends ActionExecutedItem {
    private problems: FileProblems;

    constructor(
        public readonly event: BazelBuildEvent,
        public readonly problemCollector: ProblemCollector,
    ) {
        super(event);
        this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
    }

    get attention(): boolean {
        return true;
    }

    async getChildren(): Promise<BazelBuildEventItem[] | undefined> {
        const problems = this.problems = await this.problemCollector.actionProblems(this.event.bes.action!);
        if (!problems) {
            this.collapsibleState = vscode.TreeItemCollapsibleState.None;
            return undefined;
        }
        const children: BazelBuildEventItem[] = [];
        problems.forEach((markers, uri) => {
            children.push(new ProblemFileItem(this.event, uri, markers));
        });
        return children;
    }
}

export class ActionSuccessItem extends ActionExecutedItem {
    constructor(
        public readonly event: BazelBuildEvent,
    ) {
        super(event);
        this.iconPath = new vscode.ThemeIcon('github-action');
    }
}

export class TestResultFailedItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
    ) {
        super(event, `${event.bes.testResult?.status} test`);
        this.description = `${event.bes.id?.testResult?.label || ''} ${event.bes.testResult?.statusDetails || ''}`;
        this.iconPath = new vscode.ThemeIcon('debug-breakpoint-data');
        // this.iconPath = new vscode.ThemeIcon('debug-breakpoint-data-disabled');
        // this.iconPath = new vscode.ThemeIcon('debug-breakpoint-data-disabled');
    }

    get attention(): boolean {
        return true;
    }

    getPrimaryOutputFile(): File | undefined {
        for (const file of this.event.bes.testResult?.testActionOutput!) {
            if (!file) {
                continue;
            }
            if (file.name === 'test.log') {
                return file;
            }
        }
        return undefined;
    }
}

export class TargetCompleteItem extends BazelBuildEventItem {
    private outputs: FileItem[] | undefined;

    constructor(
        public readonly event: BazelBuildEvent,
        private readonly state: BuildEventState,
    ) {
        super(
            event, 
            `${state.getTargetKind(event)}${event.bes.completed?.success ? '' : ' failed'} `,
        );
        this.description = `${event.bes.id?.targetCompleted?.label}`;
        this.iconPath = state.getTargetIcon(event, event.bes.completed!);
        this.collapsibleState = event.bes.completed?.success ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
    }

    get attention(): boolean {
        return !this.event.bes.completed?.success;
    }

    async getChildren(): Promise<BazelBuildEventItem[] | undefined> {
        const detail = this.event.bes.completed?.failureDetail;
        if (detail) {
            return this.getFailureDetailItems(detail);
        }
        
        if (!this.outputs) {
            this.outputs = [];
            const files = new Set<File>();
            for (const group of this.event.bes?.completed?.outputGroup || []) {
                this.state.collectFilesFromFileSetIds(group.fileSets, files);
            }
            files.forEach(file => {
                this.outputs?.push(new FileItem(this.event, file));
            });
        }
        return this.outputs;
    }

    getFailureDetailItems(detail: FailureDetail): BazelBuildEventItem[] {
        const items: BazelBuildEventItem[] = [];
        items.push(new FailureDetailItem(this.event, detail));
        return items;
    }

    getPrimaryOutputFile(): File | undefined {
        for (const file of this.event.bes?.completed?.importantOutput || []) {
            return file;
        }
        return undefined;
    }
}

export class FileItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
        public readonly file: File,
    ) {
        super(event, path.basename(file.name!));
        this.description = `${file.name}`;
        this.iconPath = vscode.ThemeIcon.File;
        if (file.uri) {
            this.resourceUri = vscode.Uri.parse(file.uri);
        }
        this.contextValue = 'file';
        this.command = {
            title: 'Download File',
            command: BuildEventProtocolView.commandFileDownload,
            arguments: [this],
        };
    }
}

export class ProblemFileItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
        public readonly uri: vscode.Uri,
        public readonly markers: IMarker[],
    ) {
        super(event, `${path.basename(uri.fsPath!)}`);
        this.description = `${uri.fsPath || ''}`;
        // this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = uri;
        this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        this.contextValue = 'problem-file';
    }

    async getChildren(): Promise<BazelBuildEventItem[] | undefined> {
        return this.markers.map(marker => new FileMarkerItem(this.event, this.uri, marker));
    }
}

export class FileMarkerItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
        public readonly uri: vscode.Uri,
        public readonly marker: IMarker,
    ) {
        // super(event, MarkerSeverity.toString(marker.severity));
        super(event, `${marker.startLineNumber}:${marker.startColumn}`);
        this.description = `${marker.message}`;
        // this.iconPath = new vscode.ThemeIcon(MarkerSeverity.toThemeIconName(marker.severity));
        this.resourceUri = uri;
        this.contextValue = 'problem-file-marker';
        this.command = {
            title: 'Open File',
            command: BuiltInCommands.Open,
            arguments: [uri.with({ fragment: `${marker.startLineNumber},${marker.startColumn}` })],
        };
    }
}

export class FailureDetailItem extends BazelBuildEventItem {
    constructor(
        public readonly event: BazelBuildEvent,
        public readonly detail: FailureDetail,
    ) {
        super(event, 'Failed');
        this.description = `${detail.message} (${detail.category})`;
        this.iconPath = new vscode.ThemeIcon('report');
    }
}

class BuildEventState {
    private fileSets = new Map<string, NamedSetOfFiles>();
    private targetsConfigured = new Map<string, TargetConfigured>();
    public workspaceInfo: WorkspaceConfig | undefined;
    public started: BuildStarted | undefined;

    constructor() {
    }
    
    handleNamedSetOfFiles(event: BazelBuildEvent) {
        const id = event.bes.id?.namedSet;
        const fileSet = event.bes.namedSetOfFiles;
        this.fileSets.set(id?.id!, fileSet!);
    }

    handleTargetConfigured(event: BazelBuildEvent) {
        const id = event.bes.id?.targetConfigured;
        const configured = event.bes.configured;
        this.targetsConfigured.set(id?.label!, configured!);
    }

    reset() {
        this.fileSets.clear();
        this.workspaceInfo = undefined;
        this.started = undefined;
    }

    collectFilesFromFileSet(fileSet: NamedSetOfFiles | undefined, files: Set<File>) {
        if (!fileSet) {
            return undefined;
        }
        for (const file of fileSet.files || []) {
            files.add(file);
        }
        this.collectFilesFromFileSetIds(fileSet.fileSets, files);
    }

    collectFilesFromFileSetId(id: NamedSetOfFilesId | undefined, files: Set<File>) {
        if (!id) {
            return;
        }
        this.collectFilesFromFileSet(this.fileSets.get(id.id!), files);
    }

    collectFilesFromFileSetIds(ids: NamedSetOfFilesId[] | undefined, files: Set<File>) {
        if (!ids) {
            return;
        }
        for (const id of ids) {
            this.collectFilesFromFileSetId(id, files);
        }
    }

    /**
     * Convenience method to create a Workspace object from the current bes
     * state.
     */
    createWorkspace(): Workspace {
        return {
            cwd: this.started?.workingDirectory
        };
    }

    getTargetKind(event: BazelBuildEvent): string | undefined {
        const label = event.bes.id?.targetCompleted?.label!;
        const configured = this.targetsConfigured.get(label);
        if (!configured) {
            return undefined;
        }
        let kind = configured.targetKind;
        return kind;
    }

    getTargetIcon(event: BazelBuildEvent, completed: TargetComplete): vscode.Uri | vscode.ThemeIcon {
        if (!completed.success) {
            return new vscode.ThemeIcon('stop');
        }
        let kind = this.getTargetKind(event);
        if (kind?.endsWith(' rule')) {
            kind = kind.slice(0, kind.length - 5);
            return vscode.Uri.parse(`https://results.bzl.io/v1/image/rule/${kind}.svg`);
        }
        return new vscode.ThemeIcon('symbol-interface');
    }

}

type FileProblems = Map<vscode.Uri, IMarker[]> | undefined;

class ProblemCollector implements vscode.Disposable {
    private diagnostics: vscode.DiagnosticCollection;
    private markerService = new MarkerService();

    public started: BuildStarted | undefined;
    
    constructor(
        protected problemMatcherRegistry: IProblemMatcherRegistry,
    ) {
        this.diagnostics = this.recreateDiagnostics();
    }

    clear() {
        this.recreateDiagnostics();
        this.started = undefined;
    }
    
    recreateDiagnostics(): vscode.DiagnosticCollection {
        if (this.diagnostics) {
            this.diagnostics.clear();
            this.diagnostics.dispose();
        }
        return this.diagnostics = vscode.languages.createDiagnosticCollection('bazel');
    }

    provideUri(path: string): vscode.Uri {
        if (this.started) {
            // TODO: will this work on windows?
            path = path.replace('/${workspaceRoot}', this.started.workspaceDirectory!);
        }
        return vscode.Uri.file(path);
    }

    async actionProblems(action: ActionExecuted): Promise<FileProblems> {
        if (action.success) {
            return undefined;
        }
        if (action.stderr) {
            return this.fileProblems(action.type!, action.stderr);
        }
        if (action.stdout) {
            return this.fileProblems(action.type!, action.stdout);
        }
    }

    async fileProblems(type: string, file: File): Promise<FileProblems> {
        const matcher = this.problemMatcherRegistry.get(type);
        if (!matcher) {
            return;
        }
        matcher.uriProvider = this.provideUri.bind(this);

        if (file.contents) {
            return this.fileContentProblems(type, matcher, file.contents);
        } else if (file.uri) {
            return this.fileUriProblems(type, matcher, file.uri);
        }
    }

    async fileContentProblems(type: string, matcher: ProblemMatcher, contents: string | Uint8Array | Buffer | undefined): Promise<FileProblems> {
        return undefined;
    }

    async fileUriProblems(type: string, matcher: ProblemMatcher, uri: string): Promise<FileProblems> {
        const url = new URL(uri);

        // TODO: support bytestream URIs
        const data = fs.readFileSync(url);

        const problems = await parseProblems(matcher, data, this.markerService);

        problems.forEach((markers, uri) => {
            this.diagnostics?.set(uri, markers.map(marker => createDiagnosticFromMarker(marker)));
        });

        return problems; 
    }    

    public dispose() {
        this.diagnostics.dispose();
        this.markerService.dispose();
    }
}

function createDiagnosticFromMarker(marker: IMarker): vscode.Diagnostic {
    const severity = MarkerSeverity.toDiagnosticSeverity(marker.severity);
    const start = new vscode.Position(marker.startLineNumber - 1, marker.startColumn - 1);
    const end = new vscode.Position(marker.endLineNumber - 1, marker.endColumn - 1);
    const range = new vscode.Range(start, end);
    return new vscode.Diagnostic(range, marker.message, severity);
}


export async function parseProblems(matcher: ProblemMatcher, data: Buffer, markerService: IMarkerService): Promise<Map<vscode.Uri, IMarker[]>> {
    const decoder = new LineDecoder();

    const collector = new StartStopProblemCollector([matcher], markerService);

    const processLine = async (line: string) => {
        line = strings.removeAnsiEscapeCodes(line);
        return collector.processLine(line);
    };

    for (const line of decoder.write(data)) {
        await processLine(line);
    }
    // decoder.write(data).forEach(async (line) => await processLine(line));
    let line = decoder.end();
    if (line) {
        await processLine(line);
    }

    collector.done();

    collector.dispose();

    const markers = markerService.read({});
    const byResource = new Map<vscode.Uri, IMarker[]>();
    
    for (const marker of markers) {
        if (!marker.resource) {
            console.log('skipping marker without a resource?', marker);
            continue;
        }
        let items = byResource.get(marker.resource);
        if (!items) {
            items = [];
            byResource.set(marker.resource, items);
        }
        items.push(marker);
    }

    return byResource;
}
