import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vsogh.file', createCommand(createFileUrl)));
	context.subscriptions.push(vscode.commands.registerCommand('vsogh.blame', createCommand(createBlameUrl)));
	context.subscriptions.push(vscode.commands.registerCommand('vsogh.history', createCommand(createHistoryUrl)));
}

export function deactivate() {

}

class Err {
	constructor(
		public readonly msg: string,
		public readonly detail?: any
	) { }
}

function createFileUrl(state: IState): string {
	// https://github.com/microsoft/vscode/blob/master/extensions/typescript-basics/package.json#L85
	return `${state.upstream}/blob/${state.upstreamBranch}/${state.filePath}#L${state.lineNumber}`;
}

function createBlameUrl(state: IState): string {
	// https://github.com/microsoft/vscode/blame/master/extensions/typescript-basics/package.json#L85
	return `${state.upstream}/blame/${state.upstreamBranch}/${state.filePath}#L${state.lineNumber}`;
}

function createHistoryUrl(state: IState): string {
	https://github.com/microsoft/vscode/commits/master/extensions/typescript-basics/package.json
	return `${state.upstream}/commits/${state.upstreamBranch}/${state.filePath}`;
}

function createCommand(urlBuilder: (state: IState) => string) {
	return async function openFile() {
		const state = await getCurrentState();
		if (state instanceof Err) {
			vscode.window.showInformationMessage(state.msg);
			if (state.detail) {
				console.log(state.detail);
			}
			return;
		}

		vscode.env.openExternal(vscode.Uri.parse(urlBuilder(state)));
	};
}

interface IState {
	filePath: string;
	lineNumber: number;
	branch: string;
	upstream: string;
	upstreamBranch: string;
}

async function getCurrentState(): Promise<IState | Err> {
	const activeTextEditor = vscode.window.activeTextEditor;
	if (!activeTextEditor) {
		return new Err('No file selected!');
	}

	const uri = activeTextEditor.document.uri;
	if (uri.scheme !== 'file') {
		return new Err('Can only open files!');
	}

	const fsPath = uri.fsPath;
	const lineNumber = activeTextEditor.selection.active.line + 1;
	const repoState = await getRepoState(fsPath);
	if (repoState instanceof Err) {
		return repoState;
	}

	const m = repoState.upstream.match(/^https:\/\/(.*)\.git$/);
	if (!m) {
		return new Err(`Could not identify GH url ${repoState.upstream}`);
	}

	const upstream = repoState.upstream.replace(/\.git$/, '');
	return {
		branch: repoState.branch,
		upstream: upstream,
		upstreamBranch: repoState.upstreamBranch,
		lineNumber: lineNumber,
		filePath: path.relative(path.dirname(repoState.gitDataPath), fsPath).replace(/\\/g, '/')
	};
}

async function getRepoState(filePath: string): Promise<IRepoState | Err> {
	// search for .git folder
	const gitDataPath = await findGitDataPath(filePath);
	if (gitDataPath instanceof Err) {
		return gitDataPath;
	}

	const currentBranch = await getCurrentHEAD(gitDataPath);
	if (currentBranch instanceof Err) {
		return currentBranch;
	}

	if (currentBranch.type === 'sha1') {
		// we are in a detached HEAD, just try origin
		const upstream = await getRemoteUrl(gitDataPath, 'origin');
		if (upstream instanceof Err) {
			return upstream;
		}

		return {
			gitDataPath: gitDataPath,
			branch: currentBranch.sha1,
			upstream: upstream,
			upstreamBranch: currentBranch.sha1
		};
	}

	return await getBranchUpstream(gitDataPath, currentBranch.branch);
}

interface IRepoState {
	gitDataPath: string;
	branch: string;
	upstream: string;
	upstreamBranch: string;
}

async function getBranchUpstream(gitDataPath: string, branch: string): Promise<IRepoState | Err> {
	try {
		const byteConfig = await readFile(path.join(gitDataPath, 'config'));
		const strConfig = byteConfig.toString();
		const branchSection = extractSection(strConfig, `branch "${branch}"`);
		if (branchSection instanceof Err) {
			return branchSection;
		}
		const branchInfo = decodeKeyValuePairs(branchSection);
		if (!branchInfo['remote'] || !branchInfo['merge']) {
			return new Err(`Could not determine upstream info from branch info ${JSON.stringify(branchInfo)}`);
		}

		const remoteName = branchInfo['remote'];
		const remoteFullBranchName = branchInfo['merge'];

		if (!/^refs\/heads\//.test(remoteFullBranchName)) {
			return new Err(`Remote branch name does not start with refs/heads -- ${remoteFullBranchName}`);
		}

		const remoteBranchName = remoteFullBranchName.replace(/^refs\/heads\//, '');

		const remoteUrl = await getRemoteUrl(gitDataPath, remoteName);
		if (remoteUrl instanceof Err) {
			return remoteUrl;
		}

		return {
			gitDataPath: gitDataPath,
			branch: branch,
			upstream: remoteUrl,
			upstreamBranch: remoteBranchName
		};

	} catch (err) {
		return new Err(`An error occurend when getting branch info`, err);
	}
}

async function getRemoteUrl(gitDataPath: string, remoteName: string): Promise<string | Err> {
	try {
		const byteConfig = await readFile(path.join(gitDataPath, 'config'));
		const strConfig = byteConfig.toString();

		const remoteSection = extractSection(strConfig, `remote "${remoteName}"`);
		if (remoteSection instanceof Err) {
			return remoteSection;
		}

		const remoteInfo = decodeKeyValuePairs(remoteSection);
		if (!remoteInfo['url']) {
			return new Err(`Could not determine upstream url from remote info ${JSON.stringify(remoteInfo)}`);
		}

		return remoteInfo['url'];
	} catch (err) {
		return new Err(`An error occurend when getting remote info`, err);
	}
}

function decodeKeyValuePairs(str: string): { [key: string]: string; } {
	let r: { [key: string]: string; } = Object.create(null);
	const lines = str.split(/\n/g);
	for (const line of lines) {
		const trimmedLine = line.trim();
		if (trimmedLine.length === 0) {
			continue;
		}

		const pieces = trimmedLine.split(' = ');
		if (pieces.length === 1) {
			console.warn(`Could not parse key value pair around <<${trimmedLine}>>`);
			continue;
		}

		const key = pieces[0];
		const value = pieces[1];
		r[key] = value;
	}
	return r;
}

function extractSection(config: string, sectionName: string): string | Err {
	const regex = new RegExp(`\\[${sectionName}\\]\n((\\s.*\\n)+)`, 'm');
	const m = config.match(regex);
	if (m) {
		return m[1];
	}
	return new Err(`Could not find section for [${sectionName}]`);
}

interface CurrentBranchHEAD { type: 'branch'; branch: string; }
interface CurrentSHA1HEAD { type: 'sha1'; sha1: string; }
type CurrentHEAD = CurrentBranchHEAD | CurrentSHA1HEAD;

async function getCurrentHEAD(gitDataPath: string): Promise<CurrentHEAD | Err> {
	try {
		const byteHead = await readFile(path.join(gitDataPath, 'HEAD'));
		const strHead = byteHead.toString();
		const m1 = strHead.match(/ref: refs\/heads\/(.*)/);
		if (m1) {
			return { type: 'branch', branch: m1[1] };
		}
		const m2 = strHead.match(/([0-9a-f]{40})/);
		if (m2) {
			return { type: 'sha1', sha1: m2[1] };
		}
	} catch (err) {
		return new Err(`Cannot read HEAD file in repository at ${gitDataPath}`, err);
	}
	return new Err(`HEAD file does not match ref pattern or sha1 pattern`);
}

async function findGitDataPath(filePath: string): Promise<string | Err> {
	do {
		const dirPath = path.dirname(filePath);
		if (dirPath === filePath) {
			// no progress!
			return new Err(`Could not find .git folder for file ${filePath}.`);
		}
		filePath = dirPath;

		const candidate = path.join(filePath, '.git');
		const candidateExists = await exists(candidate);
		if (candidateExists) {
			return candidate;
		}
	} while (true);
}

function exists(path: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		fs.exists(path, (exists) => {
			resolve(exists);
		});
	});
}

function readFile(path: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		fs.readFile(path, (err, result) => {
			if (err) {
				return reject(err);
			}
			resolve(result);
		});
	});
}
