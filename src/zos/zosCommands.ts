import * as vscode from 'vscode';
import * as path from 'path';
import { Sessions } from '../sessions';
import { Ui } from '../ui/helpers';
import { Node, ZosTree } from '../ui/trees';
import { uris, zosExt, parseUri, SCHEME } from '../fsProvider';
import { guard, log } from '../log';
import { Job, ZosmfClient } from './zosmf';

const MEMBER_RE = /^[A-Z#$@][A-Z0-9#$@]{0,7}$/i;
const DSN_RE = /^[A-Z#$@][A-Z0-9#$@-]{0,7}(\.[A-Z#$@][A-Z0-9#$@-]{0,7})*$/i;

/** Run async work over items with limited parallelism. */
export async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>, token?: vscode.CancellationToken) {
  let i = 0;
  const worker = async () => { while (i < items.length && !token?.isCancellationRequested) { await fn(items[i++]); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

/** After a submit: offer to wait for the job and open its output. */
export async function afterSubmit(sessions: Sessions, zosTree: ZosTree, pid: string, job: Job) {
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

export const DEFAULT_JCL_TEMPLATES: Record<string, string> = {
  'COBOL compile + link (IGYWCL)': [
    '${JOBCARD}',
    '//* If the IGYWCL procedure is not found, uncomment and adjust:',
    '//*       JCLLIB ORDER=(IGY.SIGYPROC)',
    '//* Compile ${SRCLIB}(${MEMBER}) and link-edit into ${LOADLIB}(${MEMBER})',
    '//CL       EXEC IGYWCL,PARM.COBOL=\'LIB,LIST,MAP,XREF\'',
    '//COBOL.SYSIN  DD DISP=SHR,DSN=${SRCLIB}(${MEMBER})',
    '//COBOL.SYSLIB DD DISP=SHR,DSN=${COPYLIB}',
    '//LKED.SYSLMOD DD DISP=SHR,DSN=${LOADLIB}(${MEMBER})'
  ].join('\n'),
  'COBOL compile, link & go (IGYWCLG)': [
    '${JOBCARD}',
    '//* If the IGYWCLG procedure is not found, uncomment and adjust:',
    '//*       JCLLIB ORDER=(IGY.SIGYPROC)',
    '//CLG      EXEC IGYWCLG,PARM.COBOL=\'LIB,LIST,MAP,XREF\'',
    '//COBOL.SYSIN  DD DISP=SHR,DSN=${SRCLIB}(${MEMBER})',
    '//COBOL.SYSLIB DD DISP=SHR,DSN=${COPYLIB}',
    '//GO.SYSOUT    DD SYSOUT=*',
    '//GO.SYSIN     DD *',
    '/*'
  ].join('\n'),
  'Run program (EXEC PGM)': [
    '${JOBCARD}',
    '//RUN      EXEC PGM=${MEMBER}',
    '//STEPLIB  DD DISP=SHR,DSN=${LOADLIB}',
    '//SYSOUT   DD SYSOUT=*',
    '//SYSPRINT DD SYSOUT=*',
    '//SYSIN    DD *',
    '/*'
  ].join('\n'),
  'Assemble + link (HLASM, ASMACL)': [
    '${JOBCARD}',
    '//AL       EXEC ASMACL',
    '//C.SYSIN    DD DISP=SHR,DSN=${SRCLIB}(${MEMBER})',
    '//L.SYSLMOD  DD DISP=SHR,DSN=${LOADLIB}(${MEMBER})'
  ].join('\n')
};

/** Replace ${NAME} placeholders (JCL's own &SYMBOLS are left alone). */
export function fillTemplate(tmpl: string, vars: Record<string, string>): string {
  let out = tmpl;
  for (let pass = 0; pass < 2; pass++) { out = out.replace(/\$\{([A-Z]+)\}/g, (m, k) => vars[k] ?? m); }
  return out;
}

interface Hit { ds: string; member?: string; line: number; text: string; }

export function registerZosCommands(ui: Ui, sessions: Sessions, zosTree: ZosTree) {
  const reg = ui.reg.bind(ui);
  const cfg = () => vscode.workspace.getConfiguration('mainframe');

  // ---------------------------------------------------------------- search
  async function searchDatasets(pid: string, datasets: string[], label: string) {
    const term = await vscode.window.showInputBox({ title: `Search in ${label}`, placeHolder: 'Text to find (case-insensitive)', ignoreFocusOut: true });
    if (!term) { return; }
    const z = sessions.zosClient(pid);
    const needle = term.toLowerCase();
    const hits: Hit[] = [];
    let scanned = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Searching "${term}"`, cancellable: true }, async (prog, tok) => {
      for (const ds of datasets) {
        if (tok.isCancellationRequested) { break; }
        let members: string[] = [];
        try { members = (await z.listMembers(ds)).map(m => m.member); }
        catch (e) { log(`search: ${ds}: ${e instanceof Error ? e.message : e}`); continue; }
        await pool(members, 6, async m => {
          try {
            const { text } = await z.readDataset(ds, m);
            text.split('\n').forEach((l, i) => { if (l.toLowerCase().includes(needle)) { hits.push({ ds, member: m, line: i, text: l }); } });
          } catch (e) { log(`search: ${ds}(${m}): ${e instanceof Error ? e.message : e}`); }
          scanned++;
          prog.report({ message: `${ds} – ${scanned} member(s) scanned, ${hits.length} hit(s)` });
        }, tok);
      }
    });
    await showHits(pid, hits, term, `${scanned} member(s) scanned`);
  }

  async function showHits(pid: string, hits: Hit[], term: string, detail: string) {
    if (!hits.length) { vscode.window.showInformationMessage(`"${term}" not found (${detail}).`); return; }
    hits.sort((a, b) => (a.ds + a.member).localeCompare(b.ds + b.member) || a.line - b.line);
    const pick = await vscode.window.showQuickPick(hits.map(h => ({
      label: `${h.member ?? h.ds}:${h.line + 1}`, description: h.member ? h.ds : '', detail: h.text.trim(), h
    })), { title: `${hits.length} hit(s) for "${term}" – ${detail}`, matchOnDescription: true, matchOnDetail: true });
    if (!pick) { return; }
    const h = pick.h;
    const uri = h.member ? uris.zosMember(pid, h.ds, h.member) : uris.zosSeq(pid, h.ds);
    const col = Math.max(0, h.text.toLowerCase().indexOf(term.toLowerCase()));
    await vscode.window.showTextDocument(uri, { preview: false, selection: new vscode.Range(h.line, col, h.line, col + term.length) });
  }

  reg('mf.zos.searchPds', (n: Node) => searchDatasets(n.pid, [n.data.ds], n.data.ds));
  reg('mf.zos.searchFilter', async (n: Node) => {
    const list = await guard(`Listing ${n.data.filter}`, () => sessions.zosClient(n.pid).listDatasets(n.data.filter));
    const pds = (list ?? []).filter(d => d.dsorg?.startsWith('PO')).map(d => d.dsname);
    if (!pds.length) { vscode.window.showInformationMessage('No partitioned data sets in this filter.'); return; }
    if (pds.length > 10 && !await ui.confirm(`Search ${pds.length} partitioned data sets? This may take a while.`)) { return; }
    await searchDatasets(n.pid, pds, `${n.data.filter} (${pds.length} data sets)`);
  });

  // ---------------------------------------------------------------- copy / rename
  reg('mf.zos.copyMember', async (n: Node) => {
    const target = (await vscode.window.showInputBox({
      title: `Copy ${n.data.ds}(${n.data.member}) to`, value: `${n.data.ds}(${n.data.member})`, ignoreFocusOut: true,
      prompt: 'Target as DATA.SET(MEMBER); the target data set must exist',
      validateInput: v => /^([^()]+)\(([^()]+)\)$/.test(v.trim()) && DSN_RE.test(v.trim().replace(/\(.*$/, '')) && MEMBER_RE.test(v.trim().replace(/^.*\(|\)$/g, '')) ? undefined : 'Format: DATA.SET(MEMBER)'
    }))?.trim().toUpperCase();
    if (!target) { return; }
    const [, toDs, toMbr] = /^([^()]+)\(([^()]+)\)$/.exec(target)!;
    if (toDs === n.data.ds && toMbr === n.data.member) { return; }
    const z = sessions.zosClient(n.pid);
    const exists = (await z.listMembers(toDs, toMbr).catch(() => [])).some(m => m.member === toMbr);
    if (exists && !await ui.confirm(`${target} already exists. Replace it?`)) { return; }
    await guard(`Copying to ${target}`, () => z.copyMember(n.data.ds, n.data.member, toDs, toMbr, true));
    zosTree.refresh();
  });
  reg('mf.zos.copyAllMembers', async (n: Node) => {
    const toDs = (await vscode.window.showInputBox({ title: `Copy all members of ${n.data.ds} to`, prompt: 'Existing partitioned data set', ignoreFocusOut: true,
      validateInput: v => DSN_RE.test(v.trim()) ? undefined : 'Invalid data set name' }))?.trim().toUpperCase();
    if (!toDs || toDs === n.data.ds) { return; }
    const replace = (await vscode.window.showQuickPick(['Keep existing members in the target', 'Replace members with the same name'], { title: 'Members that already exist' }))?.startsWith('Replace');
    if (replace === undefined) { return; }
    await guard(`Copying ${n.data.ds} → ${toDs}`, () => sessions.zosClient(n.pid).copyMember(n.data.ds, '*', toDs, '*', replace));
    zosTree.refresh();
  });
  reg('mf.zos.renameMember', async (n: Node) => {
    const nm = (await vscode.window.showInputBox({ title: `Rename ${n.data.ds}(${n.data.member})`, value: n.data.member, validateInput: v => MEMBER_RE.test(v) ? undefined : '1-8 chars, A-Z 0-9 # $ @' }))?.toUpperCase();
    if (!nm || nm === n.data.member) { return; }
    await guard(`Renaming to ${nm}`, () => sessions.zosClient(n.pid).renameMember(n.data.ds, n.data.member, nm));
    zosTree.refresh();
  });
  reg('mf.zos.renameDataset', async (n: Node) => {
    const nm = (await vscode.window.showInputBox({ title: `Rename ${n.data.ds}`, value: n.data.ds, validateInput: v => DSN_RE.test(v) && v.length <= 44 ? undefined : 'Invalid data set name' }))?.toUpperCase();
    if (!nm || nm === n.data.ds) { return; }
    await guard(`Renaming to ${nm}`, () => sessions.zosClient(n.pid).renameDataset(n.data.ds, nm));
    zosTree.refresh();
  });
  reg('mf.zos.showAttributes', async (n: Node) => {
    const a = await guard(`Reading attributes of ${n.data.ds}`, () => sessions.zosClient(n.pid).datasetAttributes(n.data.ds));
    if (!a) { return; }
    const names: Record<string, string> = { dsname: 'Data set', dsorg: 'Organization', recfm: 'Record format', lrecl: 'Record length', blksz: 'Block size',
      vol: 'Volume', dev: 'Device', spacu: 'Space units', used: 'Used %', extx: 'Extents', cdate: 'Created', rdate: 'Last referenced', edate: 'Expires',
      catnm: 'Catalog', migr: 'Migrated', mvol: 'Multi-volume', ovf: 'Overflow', sizex: 'Size', dsntp: 'DSN type' };
    const lines = Object.entries(a).map(([k, v]) => `${(names[k] ?? k).padEnd(18)} ${v}`);
    await ui.openText(`Attributes of ${n.data.ds}\n${'='.repeat(40)}\n${lines.join('\n')}\n`);
  });

  // ---------------------------------------------------------------- download
  reg('mf.zos.downloadPds', async (n: Node) => {
    const target = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Download here', title: `Download all members of ${n.data.ds}` });
    if (!target?.length) { return; }
    const dir = vscode.Uri.joinPath(target[0], n.data.ds);
    const z = sessions.zosClient(n.pid);
    const ext = zosExt(n.data.ds);
    let count = 0;
    const ok = await guard(`Downloading ${n.data.ds}`, async () => {
      await vscode.workspace.fs.createDirectory(dir);
      const members = (await z.listMembers(n.data.ds)).map(m => m.member);
      await pool(members, 6, async m => {
        const { text } = await z.readDataset(n.data.ds, m);
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, `${m}.${ext}`), Buffer.from(text, 'utf8'));
        count++;
      });
      return true;
    });
    if (ok) {
      const a = await vscode.window.showInformationMessage(`${count} member(s) downloaded to ${dir.fsPath}`, 'Open Folder');
      if (a) { vscode.commands.executeCommand('revealFileInOS', dir); }
    }
  });
  reg('mf.zos.uploadFolder', async (n: Node) => {
    const src = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Upload', title: `Upload a folder into ${n.data.ds}` });
    if (!src?.length) { return; }
    const entries = (await vscode.workspace.fs.readDirectory(src[0])).filter(([, t]) => t === vscode.FileType.File);
    const plan = entries.map(([name]) => ({ name, member: path.basename(name, path.extname(name)).replace(/[^A-Za-z0-9#$@]/g, '').slice(0, 8).toUpperCase() }))
      .filter(x => MEMBER_RE.test(x.member));
    if (!plan.length) { vscode.window.showWarningMessage('No files with a usable member name in that folder.'); return; }
    const byMember = new Map<string, string[]>();
    plan.forEach(x => byMember.set(x.member, [...(byMember.get(x.member) ?? []), x.name]));
    const clashes = [...byMember.entries()].filter(([, names]) => names.length > 1);
    if (clashes.length) {
      vscode.window.showErrorMessage(`These files would become the same member: ${clashes.map(([m, names]) => `${m} ← ${names.join(', ')}`).join('; ')}. Rename them and try again.`, { modal: true });
      return;
    }
    if (!await ui.confirm(`Upload ${plan.length} file(s) into ${n.data.ds}? Members with the same name are replaced.`)) { return; }
    const z = sessions.zosClient(n.pid);
    await guard(`Uploading into ${n.data.ds}`, () => pool(plan, 4, async x => {
      const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(src[0], x.name))).toString('utf8');
      await z.writeDataset(n.data.ds, x.member, text);
    }));
    zosTree.refresh(n);
  });

  // ---------------------------------------------------------------- jobs
  reg('mf.zos.viewJobJcl', async (n: Node) => {
    const j: Job = n.data.job;
    const jcl = await guard(`Reading JCL of ${j.jobname}`, () => sessions.zosClient(n.pid).jobJcl(j.jobname, j.jobid));
    if (jcl !== undefined) { await ui.openText(jcl, 'jcl'); }
  });
  reg('mf.zos.resubmitJob', async (n: Node) => {
    const j: Job = n.data.job;
    const z = sessions.zosClient(n.pid);
    const job = await guard(`Resubmitting ${j.jobname}`, async () => z.submitJcl(await z.jobJcl(j.jobname, j.jobid)));
    if (job) { await afterSubmit(sessions, zosTree, n.pid, job); }
  });

  // ---------------------------------------------------------------- JCL templates
  reg('mf.zos.generateJcl', async (arg?: Node | vscode.Uri) => {
    // From the tree we get a Node; from an editor menu we get the editor's Uri
    const n = arg instanceof Node ? arg : undefined;
    let pid = n?.pid; let ds: string | undefined = n?.data?.ds; let member: string | undefined = n?.data?.member;
    const ed = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!n && ed?.scheme === SCHEME) {
      const p = parseUri(ed);
      if (p.kind === 'zds') { pid = p.pid; ds = p.ds; member = p.member; }
    }
    if (!pid) { pid = (await ui.pickProfile('zos'))?.id; }
    if (!pid) { return; }
    const prof = sessions.profile(pid);
    const templates = { ...DEFAULT_JCL_TEMPLATES, ...cfg().get<Record<string, string | string[]>>('zos.jclTemplates', {}) };
    const pick = await vscode.window.showQuickPick(Object.keys(templates), { title: 'JCL template' });
    if (!pick) { return; }
    const user = prof.user.toUpperCase();
    if (!member) { member = (await vscode.window.showInputBox({ title: 'Program / member name', validateInput: v => MEMBER_RE.test(v) ? undefined : '1-8 chars' }))?.toUpperCase(); }
    if (!member) { return; }
    const vars: Record<string, string> = {
      USER: user, MEMBER: member, SRCLIB: ds ?? `${user}.COBOL`,
      LOADLIB: cfg().get<string>('zos.loadLibrary', '') || `${user}.LOAD`,
      COPYLIB: cfg().get<string>('zos.copyLibrary', '') || `${user}.COPYLIB`,
      JOBNAME: (user.slice(0, 7) + 'C'), ACCOUNT: cfg().get<string>('zos.tsoAccount', 'ACCT#')
    };
    vars.JOBCARD = fillTemplate(cfg().get<string>('zos.jobCard', '') || "//${JOBNAME} JOB (${ACCOUNT}),'${USER}',CLASS=A,MSGCLASS=X,MSGLEVEL=(1,1),NOTIFY=&SYSUID", vars);
    const raw = templates[pick];
    await ui.openText(fillTemplate(Array.isArray(raw) ? raw.join('\n') : raw, vars) + '\n', 'jcl');
    vscode.window.setStatusBarMessage('$(info) Review the JCL, then press Ctrl+Alt+S to submit', 8000);
  });
}

export type { ZosmfClient };
