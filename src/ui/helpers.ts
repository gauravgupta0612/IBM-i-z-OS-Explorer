import * as vscode from 'vscode';
import { Profile, ProfileStore, ProfileType } from '../profiles';
import { SCHEME } from '../fsProvider';
import { output } from '../log';
import type { Node } from './trees';

/** Small UI helpers shared by all command modules. */
export class Ui {
  constructor(private ctx: vscode.ExtensionContext, private store: ProfileStore) {}

  /** Register a command and keep it disposable with the extension. */
  reg(id: string, fn: (...a: any[]) => any) {
    this.ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }

  /** Connection of a tree node, of the active remote editor, or picked by the user. */
  async pickProfile(type: ProfileType, n?: Node): Promise<Profile | undefined> {
    if (n?.pid) { return this.store.get(n.pid); }
    const ed = vscode.window.activeTextEditor?.document.uri;
    if (ed?.scheme === SCHEME) {
      const p = this.store.get(ed.authority);
      if (p?.type === type) { return p; }
    }
    const list = this.store.byType(type);
    if (list.length === 0) {
      vscode.window.showWarningMessage(`No ${type === 'zos' ? 'z/OS' : 'IBM i'} connection defined.`, 'Add Connection')
        .then(a => a && vscode.commands.executeCommand(type === 'zos' ? 'mf.addZosProfile' : 'mf.addIbmiProfile'));
      return;
    }
    if (list.length === 1) { return list[0]; }
    const pick = await vscode.window.showQuickPick(list.map(p => ({ label: p.name, description: `${p.user}@${p.host}`, p })), { title: 'Select connection' });
    return pick?.p;
  }

  async updateProfile(id: string, fn: (p: Profile) => void) {
    const p = this.store.get(id); if (!p) { return; }
    fn(p); await this.store.save(p);
  }

  async confirm(msg: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(msg, { modal: true }, 'Yes')) === 'Yes';
  }

  /** Input box with a remembered history shown as a quick pick. */
  async historyInput(key: string, title: string, placeholder: string): Promise<string | undefined> {
    const hist = this.ctx.globalState.get<string[]>(key, []);
    const qp = vscode.window.createQuickPick();
    qp.title = title; qp.placeholder = placeholder; qp.ignoreFocusOut = true;
    qp.items = hist.map(h => ({ label: h }));
    const val = await new Promise<string | undefined>(res => {
      qp.onDidAccept(() => { res(qp.selectedItems[0]?.label ?? qp.value); qp.hide(); });
      qp.onDidHide(() => res(undefined));
      qp.onDidChangeValue(v => { qp.items = [...(v ? [{ label: v }] : []), ...hist.filter(h => h !== v).map(h => ({ label: h }))]; });
      qp.show();
    });
    qp.dispose();
    if (val?.trim()) {
      await this.ctx.globalState.update(key, [val.trim(), ...hist.filter(h => h !== val.trim())].slice(0, 50));
      return val.trim();
    }
    return undefined;
  }

  /** Append a titled block to the output channel and reveal it. */
  showText(header: string, text: string) {
    const o = output();
    o.appendLine(''); o.appendLine(`──── ${header} ────`); o.appendLine(text.trimEnd()); o.show(true);
  }

  /** Open text in a new (untitled) editor. */
  async openText(content: string, language = 'plaintext') {
    const doc = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
