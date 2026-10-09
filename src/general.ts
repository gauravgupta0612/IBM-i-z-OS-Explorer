import * as vscode from 'vscode';
import { Favorite, newId, Profile, ProfileStore } from './profiles';
import { Ui } from './ui/helpers';
import { Node } from './ui/trees';
import { SCHEME } from './fsProvider';

/** Fields of a connection that are exported (never passwords). */
const EXPORTED: Array<keyof Profile> = ['type', 'name', 'host', 'port', 'user', 'secure', 'rejectUnauthorized', 'dsFilters', 'paths',
  'jobFilters', 'libraries', 'objectLibrary', 'libraryList', 'currentLibrary', 'favorites'];

export function registerGeneralCommands(ui: Ui, store: ProfileStore) {
  const reg = ui.reg.bind(ui);

  // ---------------------------------------------------------------- favorites
  reg('mf.addFavorite', async (n: Node) => {
    const uri = n.resourceUri;
    if (!uri) { vscode.window.showWarningMessage('This item cannot be opened directly (for example a migrated data set), so it cannot be a favorite.'); return; }
    const label = typeof n.label === 'string' ? n.label : n.label?.label ?? uri.path;
    const where = n.data.ds ? n.data.ds : n.data.lib ? `${n.data.lib}/${n.data.file}` : (n.data.path ?? '').replace(/\/[^/]*$/, '');
    const fav: Favorite = { label, description: where, uri: uri.toString() };
    await ui.updateProfile(n.pid, p => { p.favorites = [...(p.favorites ?? []).filter(f => f.uri !== fav.uri), fav]; });
    vscode.window.setStatusBarMessage(`$(star-full) ${label} added to Favorites`, 3000);
  });
  reg('mf.removeFavorite', (n: Node) => ui.updateProfile(n.pid, p => { p.favorites = (p.favorites ?? []).filter(f => f.uri !== n.data.favorite.uri); }));

  // ---------------------------------------------------------------- compare
  reg('mf.compareWithLocal', async (arg?: Node | vscode.Uri) => {
    const remote = arg instanceof vscode.Uri ? arg : arg?.resourceUri ?? (vscode.window.activeTextEditor?.document.uri.scheme === SCHEME ? vscode.window.activeTextEditor.document.uri : undefined);
    if (!remote) { vscode.window.showWarningMessage('Select a remote member or file first.'); return; }
    const local = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Compare', title: 'Local file to compare with' });
    if (!local?.length) { return; }
    const name = remote.path.split('/').pop();
    await vscode.commands.executeCommand('vscode.diff', local[0], remote, `${local[0].path.split('/').pop()} (local) ↔ ${name} (host)`);
  });

  // ---------------------------------------------------------------- export / import
  reg('mf.exportConnections', async () => {
    const all = store.all();
    if (!all.length) { vscode.window.showInformationMessage('There are no connections to export.'); return; }
    const picks = await vscode.window.showQuickPick(all.map(p => ({ label: p.name, description: `${p.type === 'zos' ? 'z/OS' : 'IBM i'} · ${p.user}@${p.host}`, picked: true, p })),
      { title: 'Connections to export (passwords are never exported)', canPickMany: true });
    if (!picks?.length) { return; }
    const target = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export', defaultUri: vscode.Uri.file('mainframe-connections.json') });
    if (!target) { return; }
    const connections = picks.map(x => Object.fromEntries(EXPORTED.filter(k => x.p[k] !== undefined).map(k => [k, x.p[k]])));
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify({ format: 'ibmi-zos-explorer-connections', version: 1, connections }, null, 2), 'utf8'));
    vscode.window.showInformationMessage(`${connections.length} connection(s) exported to ${target.fsPath}. Passwords are not included.`);
  });
  reg('mf.importConnections', async () => {
    const src = await vscode.window.showOpenDialog({ filters: { JSON: ['json'] }, canSelectMany: false, openLabel: 'Import' });
    if (!src?.length) { return; }
    let list: any[];
    try {
      const j = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(src[0])).toString('utf8'));
      list = Array.isArray(j) ? j : j.connections;
      if (!Array.isArray(list)) { throw new Error('no "connections" array'); }
    } catch (e) { vscode.window.showErrorMessage(`Not a valid connections file: ${e instanceof Error ? e.message : e}`); return; }
    let added = 0, skipped = 0;
    for (const c of list) {
      if (!c || (c.type !== 'zos' && c.type !== 'ibmi') || typeof c.host !== 'string' || typeof c.user !== 'string' || typeof c.name !== 'string') { skipped++; continue; }
      if (store.all().some(p => p.type === c.type && p.host === c.host && p.user === c.user && p.name === c.name)) { skipped++; continue; }
      const p: Profile = { id: newId(), type: c.type, name: c.name, host: c.host, port: Number(c.port) || (c.type === 'zos' ? 443 : 22), user: c.user };
      for (const k of EXPORTED) { if (c[k] !== undefined && !(k in p)) { (p as any)[k] = c[k]; } }
      await store.save(p); added++;
    }
    vscode.window.showInformationMessage(`${added} connection(s) imported${skipped ? `, ${skipped} skipped (duplicate or invalid)` : ''}. Passwords are asked on first connect.`);
  });
}
