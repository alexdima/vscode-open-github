import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('vsogh.openFile',openFile));
}

export function deactivate() {

}

function openFile() {
	vscode.window.showInformationMessage('Hello World!');
	// https://github.com/microsoft/vscode/blob/master/extensions/typescript-basics/package.json#L82
	
}
