import * as vscode from 'vscode'
import { openHistoryWebview } from './historyWebview'

export function activate(context: vscode.ExtensionContext) {
    const openHistoryEditorDisposable = vscode.commands.registerCommand(
        'ipython-history-editor.openHistoryEditor',
        () => {
            openHistoryWebview(context)
        },
    )
    context.subscriptions.push(openHistoryEditorDisposable)
}

export function deactivate() {}
