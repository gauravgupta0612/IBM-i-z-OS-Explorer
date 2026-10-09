import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function output(): vscode.OutputChannel {
  if (!channel) { channel = vscode.window.createOutputChannel('IBM i & z/OS'); }
  return channel;
}

export function log(msg: string) {
  output().appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function guard<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, fn);
  } catch (e) {
    const m = errorMessage(e);
    log(`ERROR ${title}: ${m}`);
    vscode.window.showErrorMessage(`${title} failed: ${m}`, 'Show Log').then(a => { if (a) { output().show(); } });
    return undefined;
  }
}
