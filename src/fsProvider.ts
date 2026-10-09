import * as vscode from 'vscode';
import { Sessions } from './sessions';
import { log } from './log';

export const SCHEME = 'mf';
export const SPOOL_SCHEME = 'mfspool';

const enc = (s: string) => encodeURIComponent(s);

const ZOS_LANG_EXT: Array<[RegExp, string]> = [
  [/^(JCL|CNTL|PROCLIB|PROC|JCLLIB|SKELS?)$/, 'jcl'],
  [/^(COBOL|CBL|COB|COBSRC|SRCCOB)$/, 'cbl'],
  [/^(COPY|COPYLIB|CPY)$/, 'cpy'],
  [/^(REXX|EXEC|CLIST)$/, 'rexx'],
  [/^(ASM|ASSEMBLE|MACLIB|MAC)$/, 'asm'],
  [/^(PLI|PL1)$/, 'pli'],
  [/^(SQL|DDL)$/, 'sql'],
  [/^(XML)$/, 'xml']
];

export function zosExt(dsn: string): string {
  const q = dsn.split('.').pop()?.toUpperCase() ?? '';
  for (const [re, ext] of ZOS_LANG_EXT) { if (re.test(q)) { return ext; } }
  return 'txt';
}

export function ibmiExt(srcType: string): string {
  const t = (srcType || 'txt').toLowerCase();
  const map: Record<string, string> = { rpgleinc: 'rpgle', clp: 'clp', cmd: 'cmd', sqlrpgle: 'sqlrpgle', cbl: 'cbl', sqlcblle: 'sqlcblle', cblle: 'cblle', txt: 'txt', '': 'txt' };
  return map[t] ?? t;
}

export const uris = {
  zosMember: (pid: string, ds: string, m: string) => vscode.Uri.parse(`${SCHEME}://${pid}/zds/${enc(ds)}/${enc(m)}.${zosExt(ds)}`),
  zosSeq: (pid: string, ds: string) => vscode.Uri.parse(`${SCHEME}://${pid}/zdsps/${enc(ds)}.${zosExt(ds)}`),
  zosUss: (pid: string, path: string) => vscode.Uri.parse(`${SCHEME}://${pid}/zuss${path.split('/').map(enc).join('/')}`),
  ibmiMember: (pid: string, lib: string, file: string, mbr: string, type: string) =>
    vscode.Uri.parse(`${SCHEME}://${pid}/ibmimbr/${enc(lib)}/${enc(file)}/${enc(mbr)}.${ibmiExt(type)}`),
  ibmiIfs: (pid: string, path: string) => vscode.Uri.parse(`${SCHEME}://${pid}/ibmiifs${path.split('/').map(enc).join('/')}`),
  zosSpool: (pid: string, job: string, jobid: string, id: number, dd: string) =>
    vscode.Uri.parse(`${SPOOL_SCHEME}://${pid}/zjob/${enc(job)}/${enc(jobid)}/${id}/${enc(dd)}.log`),
  zosAllSpool: (pid: string, job: string, jobid: string) => vscode.Uri.parse(`${SPOOL_SCHEME}://${pid}/zjoball/${enc(job)}/${enc(jobid)}.log`),
  ibmiSpool: (pid: string, job: string, name: string, num: number) =>
    vscode.Uri.parse(`${SPOOL_SCHEME}://${pid}/ibmispl/${enc(job)}/${enc(name)}/${num}.log`),
  ibmiJobLog: (pid: string, job: string) => vscode.Uri.parse(`${SPOOL_SCHEME}://${pid}/ibmijoblog/${enc(job)}.log`)
};

export type Parsed =
  | { kind: 'zds'; pid: string; ds: string; member?: string }
  | { kind: 'zuss'; pid: string; path: string }
  | { kind: 'ibmimbr'; pid: string; lib: string; file: string; mbr: string; type: string }
  | { kind: 'ibmiifs'; pid: string; path: string };

const stripExt = (s: string) => { const i = s.lastIndexOf('.'); return i > 0 ? s.slice(0, i) : s; };

export function parseUri(uri: vscode.Uri): Parsed {
  const pid = uri.authority;
  const seg = uri.path.split('/').filter(Boolean).map(decodeURIComponent);
  const kind = seg.shift();
  switch (kind) {
    case 'zds': return { kind: 'zds', pid, ds: seg[0], member: stripExt(seg[1]) };
    case 'zdsps': return { kind: 'zds', pid, ds: stripExt(seg[0]) };
    case 'zuss': return { kind: 'zuss', pid, path: '/' + seg.join('/') };
    case 'ibmimbr': {
      const last = seg[2]; const i = last.lastIndexOf('.');
      return { kind: 'ibmimbr', pid, lib: seg[0], file: seg[1], mbr: i > 0 ? last.slice(0, i) : last, type: i > 0 ? last.slice(i + 1) : '' };
    }
    case 'ibmiifs': return { kind: 'ibmiifs', pid, path: '/' + seg.join('/') };
  }
  throw vscode.FileSystemError.FileNotFound(uri);
}

/** Lets VS Code open, edit and save remote members / data sets / stream files directly. */
export class MainframeFS implements vscode.FileSystemProvider {
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;
  private meta = new Map<string, { mtime: number; size: number; etag?: string }>();

  constructor(private sessions: Sessions) {}

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const p = parseUri(uri);
    if (p.kind === 'ibmiifs') {
      const s = await this.sessions.ibmiClient(p.pid).statIfs(p.path).catch(() => { throw vscode.FileSystemError.FileNotFound(uri); });
      return { type: s.isDir ? vscode.FileType.Directory : vscode.FileType.File, ctime: s.mtime, mtime: s.mtime, size: s.size };
    }
    const m = this.meta.get(uri.toString());
    return { type: vscode.FileType.File, ctime: 0, mtime: m?.mtime ?? Date.now(), size: m?.size ?? 0 };
  }

  readDirectory(): [string, vscode.FileType][] { return []; }
  createDirectory(): void { throw vscode.FileSystemError.NoPermissions('Use the IBM i & z/OS tree to create folders'); }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const p = parseUri(uri);
    let data: Buffer; let etag: string | undefined;
    switch (p.kind) {
      case 'zds': { const r = await this.sessions.zosClient(p.pid).readDataset(p.ds, p.member); data = Buffer.from(r.text, 'utf8'); etag = r.etag; break; }
      case 'zuss': data = await this.sessions.zosClient(p.pid).readUss(p.path); break;
      case 'ibmimbr': data = Buffer.from(await this.sessions.ibmiClient(p.pid).readMember(p.lib, p.file, p.mbr), 'utf8'); break;
      case 'ibmiifs': data = await this.sessions.ibmiClient(p.pid).readIfs(p.path); break;
    }
    const prev = this.meta.get(uri.toString());
    this.meta.set(uri.toString(), { mtime: prev?.mtime ?? Date.now(), size: data.length, etag });
    return data;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const p = parseUri(uri);
    const text = Buffer.from(content).toString('utf8');
    const key = uri.toString();
    let etag: string | undefined;
    switch (p.kind) {
      case 'zds':
        try {
          etag = await this.sessions.zosClient(p.pid).writeDataset(p.ds, p.member, text, this.meta.get(key)?.etag);
        } catch (e: any) {
          if (e?.status === 412) {
            const a = await vscode.window.showWarningMessage(`${p.ds}${p.member ? `(${p.member})` : ''} was changed on the host since you opened it.`, { modal: true }, 'Overwrite');
            if (a !== 'Overwrite') { throw e; }
            etag = await this.sessions.zosClient(p.pid).writeDataset(p.ds, p.member, text);
          } else { throw e; }
        }
        break;
      case 'zuss': await this.sessions.zosClient(p.pid).writeUss(p.path, text); break;
      case 'ibmimbr': await this.sessions.ibmiClient(p.pid).writeMember(p.lib, p.file, p.mbr, text); break;
      case 'ibmiifs': await this.sessions.ibmiClient(p.pid).writeIfs(p.path, Buffer.from(content)); break;
    }
    log(`Saved ${uri.path}`);
    this.meta.set(key, { mtime: Date.now(), size: content.length, etag });
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(): void { throw vscode.FileSystemError.NoPermissions('Use the IBM i & z/OS tree to delete'); }
  rename(): void { throw vscode.FileSystemError.NoPermissions('Rename is not supported'); }
}

/** Read-only documents: job spool, IBM i spooled files, job logs. */
export class SpoolProvider implements vscode.TextDocumentContentProvider {
  constructor(private sessions: Sessions) {}
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const pid = uri.authority;
    const seg = uri.path.split('/').filter(Boolean).map(decodeURIComponent);
    const kind = seg.shift();
    const noExt = (s: string) => s.replace(/\.log$/, '');
    try {
      switch (kind) {
        case 'zjob': return await this.sessions.zosClient(pid).readSpool(seg[0], seg[1], Number(seg[2]));
        case 'zjoball': {
          const z = this.sessions.zosClient(pid); const id = noExt(seg[1]);
          const files = await z.listSpool(seg[0], id);
          const parts: string[] = [];
          for (const f of files) {
            parts.push(`${'='.repeat(20)} ${f.ddname} ${f.stepname ?? ''} ${f.procstep ?? ''} (id ${f.id}) ${'='.repeat(20)}`);
            parts.push(await z.readSpool(seg[0], id, f.id));
          }
          return parts.join('\n');
        }
        case 'ibmispl': return await this.sessions.ibmiClient(pid).readSpool(seg[0], seg[1], Number(noExt(seg[2])));
        case 'ibmijoblog': return await this.sessions.ibmiClient(pid).jobLog(noExt(seg[0]));
      }
    } catch (e: any) { return `*** Error: ${e?.message ?? e}`; }
    return '';
  }
}
