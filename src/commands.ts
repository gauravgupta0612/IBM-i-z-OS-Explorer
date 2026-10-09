import * as vscode from 'vscode';
import * as path from 'path';
import { Profile, ProfileStore, ProfileType, profileWizard } from './profiles';
import { Sessions } from './sessions';
import { Node, ZosTree, IbmiTree } from './ui/trees';
import { parseUri, SCHEME, uris } from './fsProvider';
import { guard, log, output } from './log';
import { showSqlResults } from './ui/sqlView';
import { openIbmiTerminal } from './ui/terminal';
import { CreateDsOptions, Job } from './zos/zosmf';

export function registerCommands(ctx: vscode.ExtensionContext, store: ProfileStore, sessions: Sessions, zosTree: ZosTree, ibmiTree: IbmiTree) {
  const diags = vscode.languages.createDiagnosticCollection('ibmi-compile');
  ctx.subscriptions.push(diags);

  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const treeOf = (n?: Node) => (n?.ctx.startsWith('zos') || n?.ctx === 'profile-zos') ? zosTree : ibmiTree;

  async function pickProfile(type: ProfileType, n?: Node): Promise<Profile | undefined> {
    if (n?.pid) { return store.get(n.pid); }
    const ed = vscode.window.activeTextEditor?.document.uri;
    if (ed?.scheme === SCHEME) {
      const p = store.get(ed.authority);
      if (p?.type === type) { return p; }
    }
    const list = store.byType(type);
    if (list.length === 0) {
      vscode.window.showWarningMessage(`No ${type === 'zos' ? 'z/OS' : 'IBM i'} connection defined.`, 'Add Connection')
        .then(a => a && vscode.commands.executeCommand(type === 'zos' ? 'mf.addZosProfile' : 'mf.addIbmiProfile'));
      return;
    }
    if (list.length === 1) { return list[0]; }
    const pick = await vscode.window.showQuickPick(list.map(p => ({ label: p.name, description: `${p.user}@${p.host}`, p })), { title: 'Select connection' });
    return pick?.p;
  }

  async function updateProfile(id: string, fn: (p: Profile) => void) {
    const p = store.get(id); if (!p) { return; }
    fn(p); await store.save(p);
  }

  async function confirm(msg: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(msg, { modal: true }, 'Yes')) === 'Yes';
  }

  /** Input box with a remembered history shown as a quick pick. */
  async function historyInput(key: string, title: string, placeholder: string): Promise<string | undefined> {
    const hist = ctx.globalState.get<string[]>(key, []);
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
      await ctx.globalState.update(key, [val.trim(), ...hist.filter(h => h !== val.trim())].slice(0, 50));
      return val.trim();
    }
    return undefined;
  }

  function showText(header: string, text: string) {
    const o = output();
    o.appendLine(''); o.appendLine(`──── ${header} ────`); o.appendLine(text.trimEnd()); o.show(true);
  }

  // ===================================================== profiles
  reg('mf.addZosProfile', async () => { const p = await profileWizard('zos'); if (p) { await store.save(p); vscode.commands.executeCommand('mf.testConnection', undefined, p.id); } });
  reg('mf.addIbmiProfile', async () => { const p = await profileWizard('ibmi'); if (p) { await store.save(p); vscode.commands.executeCommand('mf.testConnection', undefined, p.id); } });
  reg('mf.editProfile', async (n?: Node) => {
    const cur = n ? store.get(n.pid) : await pickProfile((await vscode.window.showQuickPick(['zos', 'ibmi'], { title: 'Type' })) as ProfileType);
    if (!cur) { return; }
    const p = await profileWizard(cur.type, cur);
    if (p) {
      if (cur.type === 'ibmi') {
        const objLib = await vscode.window.showInputBox({ title: 'Object library for compiles (empty = same as source library)', value: cur.objectLibrary ?? '' });
        if (objLib !== undefined) { p.objectLibrary = objLib.trim().toUpperCase() || undefined; }
      }
      sessions.reset(p.id); await store.save(p);
    }
  });
  reg('mf.removeProfile', async (n?: Node) => {
    const p = n ? store.get(n.pid) : undefined; if (!p) { return; }
    if (await confirm(`Remove connection "${p.name}"?`)) { sessions.reset(p.id); await store.remove(p.id); }
  });
  reg('mf.resetPassword', async (n?: Node) => {
    const p = n ? store.get(n.pid) : undefined; if (!p) { return; }
    await store.clearPassword(p.id); sessions.reset(p.id);
    await store.password(p, true);
    vscode.window.showInformationMessage(`Password updated for ${p.name}`);
  });
  reg('mf.disconnect', (n?: Node) => { if (n) { sessions.reset(n.pid); vscode.window.showInformationMessage('Disconnected'); } });
  reg('mf.testConnection', async (n?: Node, id?: string) => {
    const p = store.get(n?.pid ?? id ?? ''); if (!p) { return; }
    await guard(`Connecting to ${p.name}`, async () => {
      if (p.type === 'zos') {
        const i = await sessions.zosClient(p.id).info();
        await sessions.zosClient(p.id).listDatasets(`${p.user.toUpperCase()}.*`).catch(() => undefined);
        vscode.window.showInformationMessage(`Connected to ${i.zos_version ?? 'z/OS'} (z/OSMF ${i.zosmf_full_version ?? i.zosmf_version ?? '?'}) on ${i.zosmf_hostname ?? p.host}`);
      } else {
        const c = sessions.ibmiClient(p.id);
        const r = await c.sql(`select OS_VERSION concat '.' concat OS_RELEASE as REL, CURRENT SERVER as SYS from SYSIBMADM.ENV_SYS_INFO`).catch(async () => ({ rows: [{ REL: (await c.exec('uname -vr')).stdout.trim(), SYS: p.host }] }));
        const row: any = r.rows[0] ?? {};
        vscode.window.showInformationMessage(`Connected to IBM i ${row.REL ?? ''} (${row.SYS ?? p.host}) as ${p.user}`);
      }
    });
  });
  reg('mf.refresh', (n?: Node) => treeOf(n).refresh(n));
  reg('mf.refreshAll', () => { zosTree.refresh(); ibmiTree.refresh(); });
  reg('mf.removeFilter', async (n: Node) => {
    await updateProfile(n.pid, p => {
      if (n.ctx === 'zos-dsFilter') { p.dsFilters = (p.dsFilters ?? []).filter(f => f !== n.data.filter); }
      if (n.ctx === 'zos-jobFilter') { p.jobFilters = (p.jobFilters ?? []).filter(f => !(f.owner === n.data.owner && f.prefix === n.data.prefix)); }
      if (n.ctx === 'zos-ussPath' || n.ctx === 'ibmi-ifsPath') { p.paths = (p.paths ?? []).filter(f => f !== n.data.path); }
      if (n.ctx === 'ibmi-libFilter') { p.libraries = (p.libraries ?? []).filter(f => f !== n.data.lib); }
    });
  });

  // ===================================================== z/OS
  reg('mf.zos.addDsFilter', async (n?: Node) => {
    const p = await pickProfile('zos', n); if (!p) { return; }
    const f = await vscode.window.showInputBox({ title: 'Data set filter', placeHolder: 'e.g. USER01.**, SYS1.PROCLIB, HLQ.*.COBOL', value: `${p.user.toUpperCase()}.*` });
    if (f) { await updateProfile(p.id, x => { x.dsFilters = [...new Set([...(x.dsFilters ?? []), f.trim().toUpperCase()])]; }); }
  });
  reg('mf.zos.addUssPath', async (n?: Node) => {
    const p = await pickProfile('zos', n); if (!p) { return; }
    const f = await vscode.window.showInputBox({ title: 'USS directory', value: `/u/${p.user.toLowerCase()}` });
    if (f) { await updateProfile(p.id, x => { x.paths = [...new Set([...(x.paths ?? []), f.trim()])]; }); }
  });
  reg('mf.zos.addJobFilter', async (n?: Node) => {
    const p = await pickProfile('zos', n); if (!p) { return; }
    const owner = await vscode.window.showInputBox({ title: 'Job owner (* for all)', value: p.user.toUpperCase() }); if (owner === undefined) { return; }
    const prefix = await vscode.window.showInputBox({ title: 'Job name prefix (* for all)', value: '*' }); if (prefix === undefined) { return; }
    await updateProfile(p.id, x => { x.jobFilters = [...(x.jobFilters ?? []), { owner: owner.toUpperCase() || '*', prefix: prefix.toUpperCase() || '*' }]; });
  });
  reg('mf.zos.recall', async (n: Node) => {
    await guard(`Recalling ${n.data.ds}`, () => sessions.zosClient(n.pid).recallDataset(n.data.ds));
    zosTree.refresh();
  });
  reg('mf.zos.createDataset', async (n?: Node) => {
    const p = await pickProfile('zos', n); if (!p) { return; }
    const ds = (await vscode.window.showInputBox({ title: 'New data set name', value: `${p.user.toUpperCase()}.`, validateInput: v => /^[A-Z#$@][A-Z0-9#$@-]{0,7}(\.[A-Z#$@][A-Z0-9#$@-]{0,7})*$/i.test(v) && v.length <= 44 ? undefined : 'Invalid data set name' }))?.toUpperCase();
    if (!ds) { return; }
    const presets: Array<{ label: string; description: string; o: CreateDsOptions }> = [
      { label: 'PDSE – source (FB 80)', description: 'COBOL, JCL, copybooks', o: { dsorg: 'PO-E', recfm: 'FB', lrecl: 80, primary: 5, secondary: 5, alcunit: 'CYL', dirblk: 10 } },
      { label: 'PDS – source (FB 80)', description: 'classic partitioned', o: { dsorg: 'PO', recfm: 'FB', lrecl: 80, primary: 5, secondary: 5, alcunit: 'CYL', dirblk: 20 } },
      { label: 'PDS – load library (U)', description: 'RECFM U 0', o: { dsorg: 'PO', recfm: 'U', lrecl: 0, blksize: 32760, primary: 5, secondary: 5, alcunit: 'CYL', dirblk: 20 } },
      { label: 'Sequential (FB 80)', description: '', o: { dsorg: 'PS', recfm: 'FB', lrecl: 80, primary: 1, secondary: 1, alcunit: 'CYL' } },
      { label: 'Sequential (VB 255)', description: '', o: { dsorg: 'PS', recfm: 'VB', lrecl: 255, primary: 1, secondary: 1, alcunit: 'CYL' } },
      { label: 'Sequential (FBA 133) – print', description: '', o: { dsorg: 'PS', recfm: 'FBA', lrecl: 133, primary: 1, secondary: 1, alcunit: 'CYL' } }
    ];
    const pick = await vscode.window.showQuickPick(presets, { title: `Allocate ${ds}` }); if (!pick) { return; }
    await guard(`Allocating ${ds}`, () => sessions.zosClient(p.id).createDataset(ds, pick.o));
    zosTree.refresh();
  });
  reg('mf.zos.createMember', async (n: Node) => {
    const m = (await vscode.window.showInputBox({ title: `New member in ${n.data.ds}`, validateInput: v => /^[A-Z#$@][A-Z0-9#$@]{0,7}$/i.test(v) ? undefined : '1-8 chars, A-Z 0-9 # $ @' }))?.toUpperCase();
    if (!m) { return; }
    const ok = await guard(`Creating ${n.data.ds}(${m})`, async () => { await sessions.zosClient(n.pid).writeDataset(n.data.ds, m, ''); return true; });
    if (ok) { zosTree.refresh(n); vscode.commands.executeCommand('vscode.open', uris.zosMember(n.pid, n.data.ds, m)); }
  });
  reg('mf.zos.createUssFile', async (n: Node) => {
    const name = await vscode.window.showInputBox({ title: `New file in ${n.data.path}` }); if (!name) { return; }
    const full = `${n.data.path.replace(/\/$/, '')}/${name}`;
    const ok = await guard(`Creating ${full}`, async () => { await sessions.zosClient(n.pid).createUss(full, 'file'); return true; });
    if (ok) { zosTree.refresh(n); vscode.commands.executeCommand('vscode.open', uris.zosUss(n.pid, full)); }
  });
  reg('mf.zos.createUssDir', async (n: Node) => {
    const name = await vscode.window.showInputBox({ title: `New directory in ${n.data.path}` }); if (!name) { return; }
    await guard(`Creating ${name}`, () => sessions.zosClient(n.pid).createUss(`${n.data.path.replace(/\/$/, '')}/${name}`, 'directory'));
    zosTree.refresh(n);
  });
  reg('mf.zos.delete', async (n: Node) => {
    const z = sessions.zosClient(n.pid);
    const what = n.ctx === 'zos-member' ? `${n.data.ds}(${n.data.member})` : n.data.ds ?? n.data.path;
    if (!await confirm(`Delete ${what}? This cannot be undone.`)) { return; }
    await guard(`Deleting ${what}`, async () => {
      if (n.ctx === 'zos-member') { await z.deleteDataset(n.data.ds, n.data.member); }
      else if (n.ctx === 'zos-ds-ps' || n.ctx === 'zos-ds-po') { await z.deleteDataset(n.data.ds); }
      else { await z.deleteUss(n.data.path, !!n.data.isDir); }
    });
    zosTree.refresh();
  });
  reg('mf.zos.uploadFile', async (n: Node) => {
    const files = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Upload' }); if (!files) { return; }
    const z = sessions.zosClient(n.pid);
    await guard('Uploading', async () => {
      for (const f of files) {
        const text = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
        if (n.ctx === 'zos-ds-po') {
          const m = path.basename(f.fsPath).replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9#$@]/g, '').slice(0, 8).toUpperCase();
          await z.writeDataset(n.data.ds, m, text);
        } else { await z.writeUss(`${n.data.path.replace(/\/$/, '')}/${path.basename(f.fsPath)}`, text); }
      }
    });
    zosTree.refresh(n);
  });

  async function afterSubmit(pid: string, job: Job) {
    log(`Submitted ${job.jobname}(${job.jobid})`);
    zosTree.refresh();
    const a = await vscode.window.showInformationMessage(`Job ${job.jobname}(${job.jobid}) submitted.`, 'Wait & Show Output', 'Show Output Now');
    if (!a) { return; }
    if (a === 'Wait & Show Output') {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Waiting for ${job.jobname}(${job.jobid})`, cancellable: true }, async (_p, tok) => {
        for (let i = 0; i < 120 && !tok.isCancellationRequested; i++) {
          const s = await sessions.zosClient(pid).jobStatus(job.jobname, job.jobid);
          if (s.status === 'OUTPUT') { vscode.window.showInformationMessage(`${job.jobname}(${job.jobid}) ended: ${s.retcode}`); break; }
          await new Promise(r => setTimeout(r, 2000));
        }
      });
    }
    zosTree.refresh();
    vscode.commands.executeCommand('vscode.open', uris.zosAllSpool(pid, job.jobname, job.jobid), { preview: false });
  }
  reg('mf.zos.submitJcl', async () => {
    const ed = vscode.window.activeTextEditor; if (!ed) { return; }
    const p = await pickProfile('zos'); if (!p) { return; }
    const jcl = ed.selection.isEmpty ? ed.document.getText() : ed.document.getText(ed.selection);
    const job = await guard('Submitting JCL', () => sessions.zosClient(p.id).submitJcl(jcl));
    if (job) { await afterSubmit(p.id, job); }
  });
  reg('mf.zos.submitMember', async (n: Node) => {
    const ds = n.data.member ? `${n.data.ds}(${n.data.member})` : n.data.ds;
    const job = await guard(`Submitting ${ds}`, () => sessions.zosClient(n.pid).submitDataset(ds));
    if (job) { await afterSubmit(n.pid, job); }
  });
  reg('mf.zos.cancelJob', async (n: Node) => {
    const j: Job = n.data.job;
    await guard(`Cancelling ${j.jobname}`, () => sessions.zosClient(n.pid).cancelJob(j.jobname, j.jobid)); zosTree.refresh();
  });
  reg('mf.zos.purgeJob', async (n: Node) => {
    const j: Job = n.data.job;
    if (!await confirm(`Purge ${j.jobname}(${j.jobid})?`)) { return; }
    await guard(`Purging ${j.jobname}`, () => sessions.zosClient(n.pid).purgeJob(j.jobname, j.jobid)); zosTree.refresh();
  });
  reg('mf.zos.downloadAllSpool', (n: Node) => {
    const j: Job = n.data.job;
    vscode.commands.executeCommand('vscode.open', uris.zosAllSpool(n.pid, j.jobname, j.jobid), { preview: false });
  });
  reg('mf.zos.tso', async (n?: Node) => {
    const p = await pickProfile('zos', n); if (!p) { return; }
    const cmd = await historyInput('mf.hist.tso', `TSO command on ${p.name}`, 'e.g. LISTCAT LEVEL(USER01), TIME, STATUS'); if (!cmd) { return; }
    const out = await guard(`TSO ${cmd}`, () => sessions.zosClient(p.id).tso(cmd));
    if (out !== undefined) { showText(`TSO ${cmd} (${p.name})`, out); }
  });
  reg('mf.zos.console', async (n?: Node) => {
    const p = await pickProfile('zos', n); if (!p) { return; }
    const cmd = await historyInput('mf.hist.console', `MVS console command on ${p.name}`, 'e.g. D IPLINFO, D A,L, D T'); if (!cmd) { return; }
    const out = await guard(`Console ${cmd}`, () => sessions.zosClient(p.id).console(cmd));
    if (out !== undefined) { showText(`Console ${cmd} (${p.name})`, out); }
  });

  // ===================================================== IBM i
  reg('mf.ibmi.addLibrary', async (n?: Node) => {
    const p = await pickProfile('ibmi', n); if (!p) { return; }
    const items = await guard('Loading libraries', () => sessions.ibmiClient(p.id).listLibraries());
    const manual = '$(edit) Enter library name(s) manually…';
    let libs: string[] = [];
    if (items) {
      const qp = await vscode.window.showQuickPick(
        [{ label: manual, description: '' }, ...items.map(l => ({ label: l.name, description: l.text }))],
        { title: 'Add library filter(s)', canPickMany: true, ignoreFocusOut: true, matchOnDescription: true });
      if (!qp) { return; }
      libs = qp.filter(x => x.label !== manual).map(x => x.label);
      if (!qp.some(x => x.label === manual) && libs.length) { /* done */ } else if (!libs.length || qp.some(x => x.label === manual)) {
        const typed = await vscode.window.showInputBox({ title: 'Library name(s), comma separated' });
        libs.push(...(typed ? typed.split(/[ ,]+/).filter(Boolean) : []));
      }
    } else {
      const typed = await vscode.window.showInputBox({ title: 'Library name(s), comma separated' });
      libs = typed ? typed.split(/[ ,]+/).filter(Boolean) : [];
    }
    if (libs.length) { await updateProfile(p.id, x => { x.libraries = [...new Set([...(x.libraries ?? []), ...libs.map(l => l.toUpperCase())])]; }); }
  });
  reg('mf.ibmi.addIfsPath', async (n?: Node) => {
    const p = await pickProfile('ibmi', n); if (!p) { return; }
    const f = await vscode.window.showInputBox({ title: 'IFS directory', value: `/home/${p.user.toUpperCase()}` });
    if (f) { await updateProfile(p.id, x => { x.paths = [...new Set([...(x.paths ?? []), f.trim()])]; }); }
  });
  reg('mf.ibmi.runCl', async (n?: Node) => {
    const p = await pickProfile('ibmi', n); if (!p) { return; }
    const cmd = await historyInput('mf.hist.cl', `CL command on ${p.name}`, 'e.g. WRKACTJOB, DSPLIBL, CRTLIB LIB(TEST)'); if (!cmd) { return; }
    const r = await guard(`CL ${cmd}`, () => sessions.ibmiClient(p.id).cl(cmd, false));
    if (r) {
      showText(`CL ${cmd} (${p.name}) → exit ${r.code}`, `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`);
      if (r.code !== 0) { vscode.window.showErrorMessage(`CL command failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); }
      else { vscode.window.setStatusBarMessage(`$(check) ${cmd.split(' ')[0]} completed`, 5000); }
    }
  });

  async function runSql(p: Profile, stmt: string) {
    const t0 = Date.now();
    const r = await guard('Running SQL', () => sessions.ibmiClient(p.id).sql(stmt));
    if (r) {
      log(`SQL ok: ${r.rows.length} row(s)`);
      if (r.columns.length) { showSqlResults(p.name, stmt, r.columns, r.rows, r.message, Date.now() - t0); }
      else { vscode.window.showInformationMessage(r.message || 'Statement executed.'); showText(`SQL (${p.name})`, `${stmt}\n${r.message}`); }
    }
  }
  reg('mf.ibmi.runSql', async (n?: Node) => {
    const p = await pickProfile('ibmi', n); if (!p) { return; }
    const stmt = await historyInput('mf.hist.sql', `SQL on ${p.name}`, 'e.g. select * from qsys2.library_list_info'); if (!stmt) { return; }
    await runSql(p, stmt);
  });
  reg('mf.ibmi.runSqlEditor', async () => {
    const ed = vscode.window.activeTextEditor; if (!ed) { return; }
    const p = await pickProfile('ibmi'); if (!p) { return; }
    let stmt = ed.document.getText(ed.selection);
    if (!stmt.trim()) {
      // statement under the cursor, delimited by ';'
      const text = ed.document.getText(); const off = ed.document.offsetAt(ed.selection.active);
      const start = text.lastIndexOf(';', off - 1) + 1; let end = text.indexOf(';', off); if (end < 0) { end = text.length; }
      stmt = text.slice(start, end);
    }
    stmt = stmt.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').trim();
    if (stmt) { await runSql(p, stmt); }
  });

  async function compile(pid: string, lib: string, file: string, mbr: string, type: string, uri: vscode.Uri) {
    const p = store.get(pid)!; const c = sessions.ibmiClient(pid);
    const cmds = vscode.workspace.getConfiguration('mainframe').get<Record<string, string>>('ibmi.compileCommands', {});
    const objlib = p.objectLibrary || lib;
    const tmpl = cmds[type.toUpperCase()] ?? '';
    const cmd0 = tmpl.replace(/&OBJLIB/g, objlib).replace(/&LIB/g, lib).replace(/&FILE/g, file).replace(/&MBR/g, mbr);
    const cmd = await vscode.window.showInputBox({ title: `Compile ${lib}/${file}(${mbr}) [${type}]`, value: cmd0, ignoreFocusOut: true,
      prompt: tmpl ? 'Edit the command if needed, then press Enter' : `No compile command configured for type ${type}. Enter one.` });
    if (!cmd) { return; }
    const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (doc?.isDirty) { await doc.save(); }
    diags.delete(uri);
    const r = await guard(`Compiling ${mbr}`, () => c.cl(cmd, false));
    if (!r) { return; }
    showText(`${cmd} → exit ${r.code}`, `${r.stdout}${r.stderr ? '\n' + r.stderr : ''}`);
    if (/OPTION\([^)]*\*EVENTF/i.test(cmd)) {
      const lines = await c.eventFile(objlib, mbr);
      const ds: vscode.Diagnostic[] = [];
      for (const l of lines) {
        const t = l.trim().split(/\s+/);
        // ERROR ver fileId annot stmtLine startLine tokStart endLine tokEnd msgId sevChar sev len text...
        if (t.length < 13 || t[2] !== '001') { continue; }
        const sl = Math.max(0, Number(t[5]) - 1), sc = Math.max(0, Number(t[6]) - 1), el = Math.max(sl, Number(t[7]) - 1), ec = Math.max(sc + 1, Number(t[8]));
        const sev = Number(t[11]);
        const d = new vscode.Diagnostic(new vscode.Range(sl, sc, el, ec), `${t[9]}: ${t.slice(13).join(' ')}`,
          sev >= 30 ? vscode.DiagnosticSeverity.Error : sev >= 20 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
        d.source = 'IBM i'; d.code = t[9];
        ds.push(d);
      }
      diags.set(uri, ds);
      if (ds.length) { vscode.commands.executeCommand('workbench.actions.view.problems'); }
    }
    if (r.code === 0) { vscode.window.showInformationMessage(`${mbr} compiled successfully into ${objlib}.`); ibmiTree.refresh(); }
    else { vscode.window.showErrorMessage(`Compile of ${mbr} failed. See Problems / Output.`, 'Show Output').then(a => a && output().show()); }
  }
  reg('mf.ibmi.compile', (n: Node) => compile(n.pid, n.data.lib, n.data.file, n.data.mbr, n.data.type, uris.ibmiMember(n.pid, n.data.lib, n.data.file, n.data.mbr, n.data.type)));
  reg('mf.ibmi.compileEditor', async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== SCHEME) { vscode.window.showWarningMessage('Open an IBM i source member first.'); return; }
    const p = parseUri(uri);
    if (p.kind !== 'ibmimbr') { vscode.window.showWarningMessage('Compile is available for IBM i source members.'); return; }
    await compile(p.pid, p.lib, p.file, p.mbr, p.type, uri);
  });
  reg('mf.ibmi.createSrcFile', async (n: Node) => {
    const f = (await vscode.window.showInputBox({ title: `New source file in ${n.data.lib}`, value: 'QRPGLESRC' }))?.toUpperCase(); if (!f) { return; }
    const len = await vscode.window.showInputBox({ title: 'Record length', value: '112' }); if (!len) { return; }
    await guard(`Creating ${n.data.lib}/${f}`, () => sessions.ibmiClient(n.pid).createSourceFile(n.data.lib, f, Number(len)));
    ibmiTree.refresh(n);
  });
  reg('mf.ibmi.createMember', async (n: Node) => {
    const mbr = (await vscode.window.showInputBox({ title: `New member in ${n.data.lib}/${n.data.file}`, validateInput: v => /^[A-Z#$@][A-Z0-9#$@_.]{0,9}$/i.test(v) ? undefined : '1-10 chars' }))?.toUpperCase();
    if (!mbr) { return; }
    const types = ['RPGLE', 'SQLRPGLE', 'CLLE', 'CBLLE', 'SQLCBLLE', 'PF', 'LF', 'DSPF', 'PRTF', 'CMD', 'SQL', 'RPGLEINC', 'TXT'];
    const type = await vscode.window.showQuickPick(types, { title: 'Source type' }); if (!type) { return; }
    const text = await vscode.window.showInputBox({ title: 'Member text (optional)' }); if (text === undefined) { return; }
    const ok = await guard(`Creating ${mbr}`, async () => { await sessions.ibmiClient(n.pid).createMember(n.data.lib, n.data.file, mbr, type, text); return true; });
    if (ok) { ibmiTree.refresh(n); vscode.commands.executeCommand('vscode.open', uris.ibmiMember(n.pid, n.data.lib, n.data.file, mbr, type)); }
  });
  reg('mf.ibmi.deleteMember', async (n: Node) => {
    if (!await confirm(`Delete member ${n.data.lib}/${n.data.file}(${n.data.mbr})?`)) { return; }
    await guard(`Deleting ${n.data.mbr}`, () => sessions.ibmiClient(n.pid).deleteMember(n.data.lib, n.data.file, n.data.mbr));
    ibmiTree.refresh();
  });
  reg('mf.ibmi.createIfsFile', async (n: Node) => {
    const name = await vscode.window.showInputBox({ title: `New file in ${n.data.path}` }); if (!name) { return; }
    const full = `${n.data.path.replace(/\/$/, '')}/${name}`;
    const ok = await guard(`Creating ${full}`, async () => { await sessions.ibmiClient(n.pid).writeIfs(full, Buffer.alloc(0)); return true; });
    if (ok) { ibmiTree.refresh(n); vscode.commands.executeCommand('vscode.open', uris.ibmiIfs(n.pid, full)); }
  });
  reg('mf.ibmi.createIfsDir', async (n: Node) => {
    const name = await vscode.window.showInputBox({ title: `New directory in ${n.data.path}` }); if (!name) { return; }
    await guard(`Creating ${name}`, () => sessions.ibmiClient(n.pid).mkdirIfs(`${n.data.path.replace(/\/$/, '')}/${name}`));
    ibmiTree.refresh(n);
  });
  reg('mf.ibmi.deleteIfs', async (n: Node) => {
    if (!await confirm(`Delete ${n.data.path}${n.data.isDir ? ' and everything in it' : ''}?`)) { return; }
    await guard(`Deleting ${n.data.path}`, () => sessions.ibmiClient(n.pid).deleteIfs(n.data.path, n.data.isDir));
    ibmiTree.refresh();
  });
  reg('mf.ibmi.deleteSpool', async (n: Node) => {
    const s = n.data.spool;
    await guard(`Deleting ${s.name}`, () => sessions.ibmiClient(n.pid).deleteSpool(s.job, s.name, s.number));
    ibmiTree.refresh();
  });
  reg('mf.ibmi.endJob', async (n: Node) => {
    if (!await confirm(`End job ${n.data.job} *IMMED?`)) { return; }
    await guard(`Ending ${n.data.job}`, () => sessions.ibmiClient(n.pid).endJob(n.data.job));
    ibmiTree.refresh();
  });
  reg('mf.ibmi.showJobLog', (n: Node) => vscode.commands.executeCommand('vscode.open', uris.ibmiJobLog(n.pid, n.data.job), { preview: false }));
  reg('mf.ibmi.terminal', async (n?: Node) => {
    const p = await pickProfile('ibmi', n); if (!p) { return; }
    openIbmiTerminal(sessions.ibmiClient(p.id));
  });
}
