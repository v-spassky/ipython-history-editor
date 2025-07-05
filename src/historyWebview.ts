import * as vscode from 'vscode'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as sqlite3 from 'sqlite3'

export interface Command {
    id: number
    source: string
}

export interface PaginatedResult<T> {
    data: T[]
    totalCount: number
    page: number
    pageSize: number
    totalPages: number
}

export class IPythonREPLHistoryRepo {
    private static readonly PAGINATED_QUERY =
        'SELECT rowid as id, source FROM history ORDER BY session DESC, line DESC LIMIT ? OFFSET ?'
    private static readonly SEARCH_PAGINATED_QUERY =
        'SELECT rowid as id, source FROM history WHERE source LIKE ? ORDER BY session DESC, line DESC LIMIT ? OFFSET ?'
    private static readonly COUNT_QUERY = 'SELECT COUNT(*) as count FROM history'
    private static readonly SEARCH_COUNT_QUERY = 'SELECT COUNT(*) as count FROM history WHERE source LIKE ?'
    private static readonly DELETE_QUERY_TEMPLATE = 'DELETE FROM history WHERE rowid IN (%IDS%)'

    private getDbPath(): string {
        const config = vscode.workspace.getConfiguration('ipython-history-editor')
        let configuredPath = config.get<string>('historyDatabasePath')

        if (configuredPath && configuredPath.startsWith('~')) {
            configuredPath = path.join(os.homedir(), configuredPath.slice(1))
        }

        if (configuredPath) {
            return configuredPath
        }

        return path.join(os.homedir(), '.ipython', 'profile_default', 'history.sqlite')
    }

    getCommands(options: { page: number; pageSize: number; searchTerm?: string }): Promise<PaginatedResult<Command>> {
        return new Promise((resolve, reject) => {
            const dbPath = this.getDbPath()
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
                if (err) {
                    reject(err)
                    return
                }
            })

            const hasSearch = options.searchTerm && options.searchTerm.trim().length > 0
            const countQuery = hasSearch
                ? IPythonREPLHistoryRepo.SEARCH_COUNT_QUERY
                : IPythonREPLHistoryRepo.COUNT_QUERY
            const dataQuery = hasSearch
                ? IPythonREPLHistoryRepo.SEARCH_PAGINATED_QUERY
                : IPythonREPLHistoryRepo.PAGINATED_QUERY

            const countParams = hasSearch ? [`%${options.searchTerm}%`] : []

            db.get(countQuery, countParams, (err, countRow: any) => {
                if (err) {
                    db.close()
                    reject(err)
                    return
                }

                const totalCount = countRow.count
                const totalPages = Math.ceil(totalCount / options.pageSize)
                const offset = (options.page - 1) * options.pageSize

                const dataParams = hasSearch
                    ? [`%${options.searchTerm}%`, options.pageSize, offset]
                    : [options.pageSize, offset]

                db.all(dataQuery, dataParams, (err, rows) => {
                    db.close()
                    if (err) {
                        reject(err)
                    } else {
                        resolve({
                            data: rows as Command[],
                            totalCount,
                            page: options.page,
                            pageSize: options.pageSize,
                            totalPages,
                        })
                    }
                })
            })
        })
    }

    deleteCommands(ids: number[]): Promise<void> {
        return new Promise((resolve, reject) => {
            if (ids.length === 0) {
                resolve()
                return
            }

            const dbPath = this.getDbPath()
            const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
                if (err) {
                    reject(err)
                    return
                }
            })

            const placeholders = ids.map(() => '?').join(',')
            const deleteQuery = IPythonREPLHistoryRepo.DELETE_QUERY_TEMPLATE.replace('%IDS%', placeholders)

            db.run(deleteQuery, ids, function (err) {
                db.close()
                if (err) {
                    reject(err)
                } else {
                    resolve()
                }
            })
        })
    }
}

export function openHistoryWebview(context: vscode.ExtensionContext) {
    const panel = vscode.window.createWebviewPanel(
        'ipythonHistoryEditor',
        'IPython History Editor',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
        },
    )

    const htmlPath = path.join(context.extensionPath, 'src', 'historyWebview.html')
    let html = fs.readFileSync(htmlPath, 'utf8')
    panel.webview.html = html

    const historyRepo = new IPythonREPLHistoryRepo()

    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'getHistory': {
                try {
                    const { page, pageSize, searchTerm } = message
                    const result = await historyRepo.getCommands({ page, pageSize, searchTerm })
                    panel.webview.postMessage({ command: 'historyData', data: result })
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to load IPython history: ${error}`)
                }
                break
            }
            case 'deleteItems': {
                try {
                    const { ids } = message
                    const numericIds = ids.map((id: string) => parseInt(id, 10))
                    await historyRepo.deleteCommands(numericIds)
                    panel.webview.postMessage({
                        command: 'deleteComplete',
                        success: true,
                    })
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error)
                    panel.webview.postMessage({
                        command: 'deleteComplete',
                        success: false,
                        error: errorMessage,
                    })
                    vscode.window.showErrorMessage(`Failed to delete history items: ${error}`)
                }
                break
            }
        }
    })
}
