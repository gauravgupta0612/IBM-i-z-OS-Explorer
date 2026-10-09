import * as vscode from 'vscode';
import { ClientChannel } from 'ssh2';
import { IbmiClient } from '../ibmi/ibmiClient';

/** Interactive SSH (PASE) shell inside a VS Code terminal. */
export function openIbmiTerminal(client: IbmiClient) {
  const write = new vscode.EventEmitter<string>();
  const close = new vscode.EventEmitter<number | void>();
  let stream: ClientChannel | undefined;
  let dims = { rows: 30, cols: 120 };
  const pty: vscode.Pseudoterminal = {
    onDidWrite: write.event,
    onDidClose: close.event,
    open: async (d) => {
      if (d) { dims = { rows: d.rows, cols: d.columns }; }
      write.fire(`Connecting to ${client.profile.host}…\r\n`);
      try {
        stream = await client.shell(dims);
        stream.on('data', (b: Buffer) => write.fire(b.toString('utf8')));
        stream.stderr.on('data', (b: Buffer) => write.fire(b.toString('utf8')));
        stream.on('close', () => close.fire(0));
      } catch (e: any) {
        write.fire(`\r\nConnection failed: ${e?.message ?? e}\r\n`);
      }
    },
    close: () => stream?.end(),
    handleInput: (data) => stream?.write(data),
    setDimensions: (d) => { dims = { rows: d.rows, cols: d.columns }; stream?.setWindow(d.rows, d.columns, 0, 0); }
  };
  const t = vscode.window.createTerminal({ name: `IBM i: ${client.profile.name}`, pty, iconPath: new vscode.ThemeIcon('server') });
  t.show();
}
