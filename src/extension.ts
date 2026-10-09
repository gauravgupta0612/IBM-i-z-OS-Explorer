import * as vscode from 'vscode';
import { ProfileStore } from './profiles';
import { Sessions } from './sessions';
import { MainframeFS, SpoolProvider, SCHEME, SPOOL_SCHEME } from './fsProvider';
import { ZosTree, IbmiTree } from './ui/trees';
import { registerCommands } from './commands';
import { log } from './log';

export function activate(ctx: vscode.ExtensionContext) {
  const store = new ProfileStore(ctx);
  const sessions = new Sessions(store);
  ctx.subscriptions.push({ dispose: () => sessions.dispose() });

  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, new MainframeFS(sessions), { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(SPOOL_SCHEME, new SpoolProvider(sessions))
  );

  const zosTree = new ZosTree(store, sessions);
  const ibmiTree = new IbmiTree(store, sessions);
  ctx.subscriptions.push(
    vscode.window.createTreeView('mf.zosView', { treeDataProvider: zosTree, showCollapseAll: true }),
    vscode.window.createTreeView('mf.ibmiView', { treeDataProvider: ibmiTree, showCollapseAll: true })
  );

  registerCommands(ctx, store, sessions, zosTree, ibmiTree);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'workbench.view.extension.mainframeExplorer';
  const upd = () => {
    const z = store.byType('zos').length, i = store.byType('ibmi').length;
    status.text = `$(server-environment) z/OS ${z} · IBM i ${i}`;
    status.tooltip = 'IBM i & z/OS Explorer';
    status.show();
  };
  upd(); store.onDidChange(upd);
  ctx.subscriptions.push(status);

  log('IBM i & z/OS Explorer activated');
}

export function deactivate() { /* sessions disposed via subscriptions */ }
