import * as vscode from 'vscode';
import { Sessions } from '../sessions';
import { ProfileStore } from '../profiles';
import { Ui } from '../ui/helpers';
import { Node, IbmiTree } from '../ui/trees';
import { uris } from '../fsProvider';
import { guard } from '../log';
import { showSqlResults } from '../ui/sqlView';
import { LibObject, MessageEntry } from './ibmiClient';

const NAME_RE = /^[A-Z#$@][A-Z0-9#$@_.]{0,9}$/i;

export function registerIbmiCommands(ui: Ui, store: ProfileStore, sessions: Sessions, ibmiTree: IbmiTree) {
  const reg = ui.reg.bind(ui);

  // ---------------------------------------------------------------- search
  reg('mf.ibmi.searchSourceFile', async (n: Node) => {
    const files: string[] = n.ctx === 'ibmi-srcpf' ? [n.data.file] : await sessions.ibmiClient(n.pid).listSourceFiles(n.data.lib);
    if (!files.length) { vscode.window.showInformationMessage('No source files in this library.'); return; }
    const where = n.ctx === 'ibmi-srcpf' ? `${n.data.lib}/${n.data.file}` : `${n.data.lib} (${files.length} source files)`;
    const term = await vscode.window.showInputBox({ title: `Search in ${where}`, placeHolder: 'Text to find (case-insensitive)', ignoreFocusOut: true });
    if (!term) { return; }
    const c = sessions.ibmiClient(n.pid);
    const res = await guard(`Searching "${term}" in ${where}`, async () => {
      const hits = await c.searchMembers(n.data.lib, files, term);
      // source types give the right editor language
      const types = new Map<string, string>();
      for (const f of [...new Set(hits.map(h => h.file))]) {
        for (const m of await c.listMembers(n.data.lib, f)) { types.set(`${f}/${m.name}`, m.type); }
      }
      return hits.map(h => ({ ...h, type: types.get(`${h.file}/${h.mbr}`) ?? '' }));
    });
    if (!res) { return; }
    if (!res.length) { vscode.window.showInformationMessage(`"${term}" not found in ${where}.`); return; }
    const pick = await vscode.window.showQuickPick(res.map(h => ({
      label: `${h.mbr}.${(h.type || 'txt').toLowerCase()}:${h.line + 1}`, description: `${h.lib}/${h.file}`, detail: h.text.trim(), h
    })), { title: `${res.length} hit(s) for "${term}"`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) { return; }
    const h = pick.h;
    const col = Math.max(0, h.text.toLowerCase().indexOf(term.toLowerCase()));
    await vscode.window.showTextDocument(uris.ibmiMember(n.pid, h.lib, h.file, h.mbr, h.type),
      { preview: false, selection: new vscode.Range(h.line, col, h.line, col + term.length) });
  });

  reg('mf.ibmi.searchIfs', async (n: Node) => {
    const term = await vscode.window.showInputBox({ title: `Search in ${n.data.path}`, placeHolder: 'Text to find (case-insensitive, text files only)', ignoreFocusOut: true });
    if (!term) { return; }
    const hits = await guard(`Searching "${term}"`, () => sessions.ibmiClient(n.pid).searchIfs(n.data.path, term));
    if (!hits) { return; }
    if (!hits.length) { vscode.window.showInformationMessage(`"${term}" not found under ${n.data.path}.`); return; }
    const pick = await vscode.window.showQuickPick(hits.map(h => ({ label: `${h.path.split('/').pop()}:${h.line + 1}`, description: h.path, detail: h.text.trim(), h })),
      { title: `${hits.length} hit(s) for "${term}"${hits.length >= 500 ? ' (first 500)' : ''}`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) { return; }
    const col = Math.max(0, pick.h.text.toLowerCase().indexOf(term.toLowerCase()));
    await vscode.window.showTextDocument(uris.ibmiIfs(n.pid, pick.h.path),
      { preview: false, selection: new vscode.Range(pick.h.line, col, pick.h.line, col + term.length) });
  });

  // ---------------------------------------------------------------- library list
  const libl = (pid: string) => [...(store.get(pid)?.libraryList ?? [])];
  reg('mf.ibmi.addToLibraryList', async (n: Node) => {
    const pid = n.pid;
    let libs: string[] = [];
    if (n.ctx === 'ibmi-libFilter') { libs = [n.data.lib]; }
    else {
      const typed = await vscode.window.showInputBox({ title: 'Add library(ies) to the library list', prompt: 'Names separated by spaces or commas; added at the end, in this order' });
      libs = (typed ?? '').split(/[ ,]+/).filter(Boolean).map(l => l.toUpperCase());
    }
    if (!libs.length) { return; }
    await ui.updateProfile(pid, p => { p.libraryList = [...libl(pid).filter(l => !libs.includes(l)), ...libs].slice(0, 250); });
  });
  reg('mf.ibmi.removeFromLibraryList', (n: Node) => ui.updateProfile(n.pid, p => { p.libraryList = libl(n.pid).filter(l => l !== n.data.lib); }));
  const move = (n: Node, d: number) => ui.updateProfile(n.pid, p => {
    const l = libl(n.pid); const i = l.indexOf(n.data.lib); const j = i + d;
    if (i < 0 || j < 0 || j >= l.length) { return; }
    [l[i], l[j]] = [l[j], l[i]]; p.libraryList = l;
  });
  reg('mf.ibmi.moveLibraryUp', (n: Node) => move(n, -1));
  reg('mf.ibmi.moveLibraryDown', (n: Node) => move(n, 1));
  reg('mf.ibmi.setCurrentLibrary', async (n: Node) => {
    const lib = n.ctx === 'ibmi-libFilter' || n.ctx === 'ibmi-liblEntry' ? n.data.lib
      : (await vscode.window.showInputBox({ title: 'Current library (empty = none)', value: store.get(n.pid)?.currentLibrary ?? '' }))?.trim().toUpperCase();
    if (lib === undefined) { return; }
    await ui.updateProfile(n.pid, p => { p.currentLibrary = lib || undefined; });
    vscode.window.setStatusBarMessage(lib ? `$(home) Current library: ${lib}` : 'Current library cleared', 4000);
  });
  reg('mf.ibmi.clearCurrentLibrary', (n: Node) => ui.updateProfile(n.pid, p => { p.currentLibrary = undefined; }));

  // ---------------------------------------------------------------- objects
  const objOf = (n: Node): LibObject & { lib: string } => ({ ...n.data.obj, lib: n.data.lib });
  reg('mf.ibmi.deleteObject', async (n: Node) => {
    const o = objOf(n);
    if (!await ui.confirm(`Delete ${o.lib}/${o.name} ${o.type}? This cannot be undone.`)) { return; }
    await guard(`Deleting ${o.name}`, () => sessions.ibmiClient(n.pid).deleteObject(o.lib, o.name, o.type));
    ibmiTree.refresh();
  });
  reg('mf.ibmi.renameObject', async (n: Node) => {
    const o = objOf(n);
    const nm = (await vscode.window.showInputBox({ title: `Rename ${o.lib}/${o.name} ${o.type}`, value: o.name, validateInput: v => NAME_RE.test(v) ? undefined : '1-10 chars' }))?.toUpperCase();
    if (!nm || nm === o.name) { return; }
    await guard(`Renaming ${o.name}`, () => sessions.ibmiClient(n.pid).renameObject(o.lib, o.name, o.type, nm));
    ibmiTree.refresh();
  });
  const printTo = async (title: string, pid: string, cmd: string) => {
    const out = await guard(title, () => sessions.ibmiClient(pid).printOutput(cmd));
    if (out !== undefined) { await ui.openText(out || '(no output)'); }
  };
  reg('mf.ibmi.objectDescription', (n: Node) => { const o = objOf(n); return printTo(`DSPOBJD ${o.name}`, n.pid, `DSPOBJD OBJ(${o.lib}/${o.name}) OBJTYPE(${o.type}) DETAIL(*FULL) OUTPUT(*PRINT)`); });
  reg('mf.ibmi.programReferences', (n: Node) => {
    const o = objOf(n);
    return printTo(`DSPPGMREF ${o.name}`, n.pid, `DSPPGMREF PGM(${o.lib}/${o.name}) OUTPUT(*PRINT) OBJTYPE(${o.type})`);
  });
  reg('mf.ibmi.fileFields', (n: Node) => { const o = objOf(n); return printTo(`DSPFFD ${o.name}`, n.pid, `DSPFFD FILE(${o.lib}/${o.name}) OUTPUT(*PRINT)`); });
  reg('mf.ibmi.queryFile', async (n: Node) => {
    const o = objOf(n);
    const stmt = `select * from ${o.lib}.${o.name} fetch first 1000 rows only`;
    const t0 = Date.now();
    const r = await guard(`Querying ${o.lib}/${o.name}`, () => sessions.ibmiClient(n.pid).sql(stmt));
    if (r) { showSqlResults(`${o.lib}/${o.name}`, stmt, r.columns, r.rows, r.message, Date.now() - t0); }
  });

  // ---------------------------------------------------------------- messages
  reg('mf.ibmi.showMessage', async (n: Node) => {
    const m: MessageEntry = n.data.msg;
    const help = await guard('Reading message', () => sessions.ibmiClient(n.pid).messageHelp(n.data.lib, n.data.queue, m.key));
    const text = `${m.id}  ${m.type}  Severity ${m.severity}\n${m.time}\nFrom: ${m.fromUser}  ${m.fromJob}\nQueue: ${n.data.lib}/${n.data.queue}\n\n${help || m.text}\n`;
    if (m.type === 'INQUIRY') {
      const a = await vscode.window.showInformationMessage(m.text, { modal: true, detail: help }, 'Reply…', 'Show Details');
      if (a === 'Reply…') { return vscode.commands.executeCommand('mf.ibmi.replyMessage', n); }
      if (a !== 'Show Details') { return; }
    }
    await ui.openText(text);
  });
  reg('mf.ibmi.replyMessage', async (n: Node) => {
    const m: MessageEntry = n.data.msg;
    const reply = await vscode.window.showInputBox({ title: `Reply to ${m.id}`, prompt: m.text, ignoreFocusOut: true, placeHolder: 'e.g. G, C, I, R or your answer' });
    if (!reply) { return; }
    await guard(`Replying to ${m.id}`, () => sessions.ibmiClient(n.pid).replyMessage(n.data.lib, n.data.queue, m.key, reply));
    ibmiTree.refresh();
  });
}
