import * as fs from 'fs';
import * as path from 'path';
import { Client, ClientChannel, SFTPWrapper } from 'ssh2';
import { Profile } from '../profiles';
import { log } from '../log';

export interface ExecResult { code: number; stdout: string; stderr: string; }
export type Row = Record<string, string | null>;

export interface LibObject { name: string; type: string; attribute: string; text: string; }
export interface SrcMember { name: string; type: string; text: string; changed?: string; }
export interface IfsEntry { name: string; isDir: boolean; size: number; mtime: number; }
export interface SpoolEntry { name: string; job: string; number: number; status: string; pages: string; created: string; userData: string; }
export interface ActiveJob { job: string; status: string; type: string; subsystem: string; function: string; }

/** Single-quote a string for a POSIX shell. */
export function shq(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }
/** Escape a value for an SQL string literal. */
export function sqlq(s: string): string { return `'${s.replace(/'/g, "''")}'`; }
/** Escape a value inside a CL quoted string. */
export function clq(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

export function qsysPath(lib: string, file: string, mbr: string) {
  return `/QSYS.LIB/${lib.toUpperCase()}.LIB/${file.toUpperCase()}.FILE/${mbr.toUpperCase()}.MBR`;
}

/** Parse the fixed-width table output of the Qshell `db2` utility. */
export function parseDb2Output(out: string): { rows: Row[]; columns: string[]; message: string } {
  const lines = out.replace(/\r/g, '').split('\n');
  if (/CLI ERROR|SQLSTATE\s*:/i.test(out) && !/RECORD\(S\) SELECTED/i.test(out)) {
    throw new Error(lines.map(l => l.trim()).filter(Boolean).join(' ').slice(0, 1000));
  }
  const dashIdx = lines.findIndex(l => /^-+( +-+)*\s*$/.test(l) && l.trim().length > 0);
  if (dashIdx < 1) { return { rows: [], columns: [], message: lines.map(l => l.trim()).filter(Boolean).join('\n') }; }
  const dash = lines[dashIdx];
  const spans: Array<[number, number]> = [];
  const re = /-+/g; let m: RegExpExecArray | null;
  while ((m = re.exec(dash))) { spans.push([m.index, m.index + m[0].length]); }
  const header = lines[dashIdx - 1];
  const cut = (l: string, i: number) => {
    const [s] = spans[i];
    const e = i + 1 < spans.length ? spans[i + 1][0] : l.length;
    return l.substring(s, e).trim();
  };
  const columns = spans.map((_, i) => cut(header, i));
  const rows: Row[] = [];
  let message = '';
  for (let i = dashIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/RECORD\(S\) SELECTED/i.test(l)) { message = l.trim(); break; }
    if (!l.trim()) { continue; }
    const r: Row = {};
    columns.forEach((c, ci) => { const v = cut(l, ci); r[c] = v === '-' ? null : v; });
    rows.push(r);
  }
  return { rows, columns, message };
}

export class IbmiClient {
  private conn?: Client;
  private sftpP?: Promise<SFTPWrapper>;
  private connecting?: Promise<Client>;
  private hasDb2util?: boolean;

  constructor(public readonly profile: Profile, private password: () => Promise<string>,
              private opts: () => { tempDir: string; ccsid: number }) {}

  get connected() { return !!this.conn; }

  async connect(): Promise<Client> {
    if (this.conn) { return this.conn; }
    if (this.connecting) { return this.connecting; }
    this.connecting = (async () => {
      const p = this.profile;
      const cfg: any = { host: p.host, port: p.port, username: p.user, readyTimeout: 30000, keepaliveInterval: 30000 };
      if (p.privateKeyPath) {
        if (!path.isAbsolute(p.privateKeyPath) || !fs.existsSync(p.privateKeyPath)) {
          throw new Error(`SSH key file not found: "${p.privateKeyPath}". Right-click the connection → Edit Connection and choose "Password" (or pick a valid key file).`);
        }
        cfg.privateKey = fs.readFileSync(p.privateKeyPath);
      }
      else { cfg.password = await this.password(); cfg.tryKeyboard = true; }
      const c = new Client();
      await new Promise<void>((resolve, reject) => {
        c.on('ready', () => resolve());
        c.on('error', reject);
        c.on('keyboard-interactive', (_n, _i, _l, _prompts, finish) => finish([cfg.password ?? '']));
        c.connect(cfg);
      });
      c.on('close', () => { this.conn = undefined; this.sftpP = undefined; });
      c.on('error', e => log(`[IBM i ${p.name}] SSH error: ${e.message}`));
      log(`[IBM i ${p.name}] connected to ${p.host}:${p.port} as ${p.user}`);
      this.conn = c;
      return c;
    })();
    try { return await this.connecting; } finally { this.connecting = undefined; }
  }

  disconnect() { this.conn?.end(); this.conn = undefined; this.sftpP = undefined; }

  async exec(command: string): Promise<ExecResult> {
    const c = await this.connect();
    log(`[IBM i ${this.profile.name}] $ ${command.length > 300 ? command.slice(0, 300) + '…' : command}`);
    return new Promise((resolve, reject) => {
      c.exec(command, (err, stream) => {
        if (err) { return reject(err); }
        const out: Buffer[] = [], errb: Buffer[] = [];
        stream.on('data', (d: Buffer) => out.push(d));
        stream.stderr.on('data', (d: Buffer) => errb.push(d));
        stream.on('close', (code: number) => resolve({ code: code ?? 0, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errb).toString('utf8') }));
      });
    });
  }

  async shell(window: { rows: number; cols: number }): Promise<ClientChannel> {
    const c = await this.connect();
    return new Promise((resolve, reject) => c.shell({ term: 'xterm-256color', rows: window.rows, cols: window.cols }, (e, s) => e ? reject(e) : resolve(s)));
  }

  async sftp(): Promise<SFTPWrapper> {
    const c = await this.connect();
    if (!this.sftpP) {
      this.sftpP = new Promise((resolve, reject) => c.sftp((e, s) => e ? reject(e) : resolve(s)));
      this.sftpP.catch(() => { this.sftpP = undefined; });
    }
    return this.sftpP;
  }

  // ---------------- CL ----------------
  /** Run a CL command; throws when the command ends in error (non-zero exit). */
  async cl(cmd: string, throwOnError = true): Promise<ExecResult> {
    const r = await this.exec(`/QOpenSys/usr/bin/system ${shq(cmd)}`);
    if (throwOnError && r.code !== 0) {
      throw new Error(`${cmd.split(' ')[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-6).join(' ')}`);
    }
    return r;
  }

  // ---------------- SQL ----------------
  async sql(statement: string): Promise<{ rows: Row[]; columns: string[]; message: string }> {
    const stmt = statement.trim().replace(/;\s*$/, '');
    if (this.hasDb2util === undefined) {
      this.hasDb2util = (await this.exec('test -x /QOpenSys/pkgs/bin/db2util && echo yes')).stdout.trim() === 'yes';
    }
    if (this.hasDb2util) {
      const r = await this.exec(`/QOpenSys/pkgs/bin/db2util -o json ${shq(stmt)}`);
      const txt = r.stdout.trim();
      if (txt.startsWith('{') || txt.startsWith('[')) {
        try {
          const j = JSON.parse(txt);
          const rows: Row[] = Array.isArray(j) ? j : (j.records ?? []);
          return { rows, columns: rows.length ? Object.keys(rows[0]) : [], message: `${rows.length} row(s)` };
        } catch { /* fall through */ }
      }
      if (!txt && r.code === 0 && !/^\s*(select|with|values)/i.test(stmt)) {
        return { rows: [], columns: [], message: 'Statement executed.' };
      }
      if (r.stderr.trim() || /SQLSTATE|SQLCODE/i.test(txt)) { throw new Error((r.stderr + ' ' + txt).trim().slice(0, 1000)); }
    }
    // Qshell db2 fallback
    const f = `${this.opts().tempDir}/mfsql_${Date.now()}_${Math.floor(Math.random() * 1e6)}.sql`;
    const cmd = `printf '%s' ${shq(stmt)} > ${f} && /QOpenSys/usr/bin/setccsid 1208 ${f}; ` +
                `/QOpenSys/usr/bin/qsh -c ${shq(`db2 -f ${f}`)}; rc=$?; rm -f ${f}; exit $rc`;
    const r = await this.exec(cmd);
    return parseDb2Output(r.stdout + (r.stderr ? '\n' + r.stderr : ''));
  }

  // ---------------- Libraries / objects ----------------
  async listLibraries(pattern = '*ALLUSR'): Promise<LibObject[]> {
    const { rows } = await this.sql(`select OBJNAME, OBJTEXT from table(QSYS2.OBJECT_STATISTICS(${sqlq(pattern)}, '*LIB')) order by OBJNAME`);
    return rows.map(r => ({ name: r.OBJNAME ?? '', type: '*LIB', attribute: '', text: r.OBJTEXT ?? '' }));
  }

  async listObjects(lib: string): Promise<LibObject[]> {
    const { rows } = await this.sql(
      `select OBJNAME, OBJTYPE, coalesce(OBJATTRIBUTE,'') as OBJATTRIBUTE, coalesce(OBJTEXT,'') as OBJTEXT ` +
      `from table(QSYS2.OBJECT_STATISTICS(${sqlq(lib.toUpperCase())}, '*ALL')) order by OBJTYPE, OBJNAME`);
    return rows.map(r => ({ name: r.OBJNAME ?? '', type: r.OBJTYPE ?? '', attribute: r.OBJATTRIBUTE ?? '', text: r.OBJTEXT ?? '' }));
  }

  async listSourceFiles(lib: string): Promise<string[]> {
    const { rows } = await this.sql(
      `select SYSTEM_TABLE_NAME from QSYS2.SYSTABLES where SYSTEM_TABLE_SCHEMA = ${sqlq(lib.toUpperCase())} and FILE_TYPE = 'S' order by 1`);
    return rows.map(r => r.SYSTEM_TABLE_NAME ?? '').filter(Boolean);
  }

  async listMembers(lib: string, file: string): Promise<SrcMember[]> {
    const { rows } = await this.sql(
      `select SYSTEM_TABLE_MEMBER, coalesce(SOURCE_TYPE,'') as SOURCE_TYPE, coalesce(PARTITION_TEXT,'') as PARTITION_TEXT, ` +
      `varchar(LAST_SOURCE_UPDATE_TIMESTAMP) as CHANGED from QSYS2.SYSPARTITIONSTAT ` +
      `where SYSTEM_TABLE_SCHEMA = ${sqlq(lib.toUpperCase())} and SYSTEM_TABLE_NAME = ${sqlq(file.toUpperCase())} order by 1`);
    return rows.map(r => ({ name: r.SYSTEM_TABLE_MEMBER ?? '', type: r.SOURCE_TYPE ?? '', text: r.PARTITION_TEXT ?? '', changed: r.CHANGED ?? undefined }));
  }

  // ---------------- Source members ----------------
  private tmp(ext = 'txt') { return `${this.opts().tempDir}/mfmbr_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`; }

  async readMember(lib: string, file: string, mbr: string): Promise<string> {
    const t = this.tmp();
    try {
      await this.cl(`CPYTOSTMF FROMMBR('${qsysPath(lib, file, mbr)}') TOSTMF('${t}') STMFOPT(*REPLACE) STMFCCSID(${this.opts().ccsid}) ENDLINFMT(*LF)`);
      const buf = await this.readIfs(t);
      return buf.toString('utf8').split('\n').map(l => l.replace(/\s+$/, '')).join('\n');
    } finally {
      await this.exec(`rm -f ${shq(t)}`).catch(() => undefined);
    }
  }

  async writeMember(lib: string, file: string, mbr: string, content: string): Promise<void> {
    const t = this.tmp();
    try {
      await this.writeIfs(t, Buffer.from(content.replace(/\r\n/g, '\n'), 'utf8'));
      await this.exec(`/QOpenSys/usr/bin/setccsid ${this.opts().ccsid} ${shq(t)}`);
      await this.cl(`CPYFRMSTMF FROMSTMF('${t}') TOMBR('${qsysPath(lib, file, mbr)}') MBROPT(*REPLACE) STMFCCSID(${this.opts().ccsid}) DBFCCSID(*FILE)`);
    } finally {
      await this.exec(`rm -f ${shq(t)}`).catch(() => undefined);
    }
  }

  async createSourceFile(lib: string, file: string, rcdlen: number) {
    await this.cl(`CRTSRCPF FILE(${lib}/${file}) RCDLEN(${rcdlen}) CCSID(*JOB)`);
  }
  async createMember(lib: string, file: string, mbr: string, type: string, text: string) {
    await this.cl(`ADDPFM FILE(${lib}/${file}) MBR(${mbr}) SRCTYPE(${type || '*NONE'}) TEXT(${clq(text || '*BLANK')})`.replace(`TEXT('*BLANK')`, 'TEXT(*BLANK)'));
  }
  async deleteMember(lib: string, file: string, mbr: string) { await this.cl(`RMVM FILE(${lib}/${file}) MBR(${mbr})`); }

  // ---------------- IFS (SFTP) ----------------
  async listIfs(path: string): Promise<IfsEntry[]> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => s.readdir(path, (e, list) => {
      if (e) { return reject(new Error(`${path}: ${e.message}`)); }
      resolve(list.filter(x => x.filename !== '.' && x.filename !== '..').map(x => ({
        name: x.filename, isDir: (x.attrs.mode & 0o170000) === 0o040000, size: x.attrs.size, mtime: x.attrs.mtime * 1000
      })).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)));
    }));
  }
  async statIfs(path: string): Promise<IfsEntry> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => s.stat(path, (e, a) => e ? reject(e) : resolve({
      name: path.split('/').pop() ?? path, isDir: (a.mode & 0o170000) === 0o040000, size: a.size, mtime: a.mtime * 1000 })));
  }
  async readIfs(path: string): Promise<Buffer> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => s.readFile(path, (e, b) => e ? reject(new Error(`${path}: ${e.message}`)) : resolve(b)));
  }
  async writeIfs(path: string, data: Buffer): Promise<void> {
    const s = await this.sftp();
    return new Promise((resolve, reject) => s.writeFile(path, data, e => e ? reject(new Error(`${path}: ${e.message}`)) : resolve()));
  }
  async mkdirIfs(path: string) {
    const s = await this.sftp();
    return new Promise<void>((resolve, reject) => s.mkdir(path, e => e ? reject(e) : resolve()));
  }
  async deleteIfs(path: string, isDir: boolean) {
    const r = await this.exec(isDir ? `rm -rf ${shq(path)}` : `rm -f ${shq(path)}`);
    if (r.code !== 0) { throw new Error(r.stderr || `rm failed (${r.code})`); }
  }

  // ---------------- Spool / jobs ----------------
  async listSpool(user: string): Promise<SpoolEntry[]> {
    const { rows } = await this.sql(
      `select SPOOLED_FILE_NAME, JOB_NAME, FILE_NUMBER, STATUS, TOTAL_PAGES, varchar(CREATE_TIMESTAMP) as CREATED, coalesce(USER_DATA,'') as USER_DATA ` +
      `from QSYS2.OUTPUT_QUEUE_ENTRIES_BASIC where USER_NAME = ${sqlq(user.toUpperCase())} order by CREATE_TIMESTAMP desc fetch first 300 rows only`);
    return rows.map(r => ({ name: r.SPOOLED_FILE_NAME ?? '', job: r.JOB_NAME ?? '', number: Number(r.FILE_NUMBER ?? 1),
      status: r.STATUS ?? '', pages: r.TOTAL_PAGES ?? '', created: r.CREATED ?? '', userData: r.USER_DATA ?? '' }));
  }
  async readSpool(job: string, name: string, num: number): Promise<string> {
    const t = this.tmp();
    try {
      await this.cl(`CPYSPLF FILE(${name}) TOFILE(*TOSTMF) JOB(${job}) SPLNBR(${num}) TOSTMF('${t}') STMFOPT(*REPLACE)`);
      return (await this.readIfs(t)).toString('utf8');
    } finally { await this.exec(`rm -f ${shq(t)}`).catch(() => undefined); }
  }
  async deleteSpool(job: string, name: string, num: number) { await this.cl(`DLTSPLF FILE(${name}) JOB(${job}) SPLNBR(${num})`); }

  async listActiveJobs(user: string): Promise<ActiveJob[]> {
    const { rows } = await this.sql(
      `select JOB_NAME, JOB_STATUS, JOB_TYPE, coalesce(SUBSYSTEM,'') as SUBSYSTEM, coalesce(FUNCTION,'') as FUNCTION ` +
      `from table(QSYS2.ACTIVE_JOB_INFO(CURRENT_USER_LIST_FILTER => ${sqlq(user.toUpperCase())})) order by JOB_NAME`);
    return rows.map(r => ({ job: r.JOB_NAME ?? '', status: r.JOB_STATUS ?? '', type: r.JOB_TYPE ?? '', subsystem: r.SUBSYSTEM ?? '', function: r.FUNCTION ?? '' }));
  }
  async jobLog(job: string): Promise<string> {
    const { rows } = await this.sql(
      `select varchar(MESSAGE_TIMESTAMP) as TS, coalesce(MESSAGE_ID,'') as MSGID, MESSAGE_TYPE, MESSAGE_TEXT ` +
      `from table(QSYS2.JOBLOG_INFO(${sqlq(job)})) order by ORDINAL_POSITION`);
    return rows.map(r => `${r.TS ?? ''}  ${(r.MSGID ?? '').padEnd(7)} ${(r.MESSAGE_TYPE ?? '').padEnd(12)} ${r.MESSAGE_TEXT ?? ''}`).join('\n');
  }
  async endJob(job: string) { await this.cl(`ENDJOB JOB(${job}) OPTION(*IMMED)`); }

  /** Compile errors from the EVFEVENT member written by OPTION(*EVENTF). */
  async eventFile(lib: string, mbr: string): Promise<string[]> {
    try {
      const txt = await this.readMember(lib, 'EVFEVENT', mbr);
      return txt.split('\n').filter(l => l.startsWith('ERROR'));
    } catch { return []; }
  }
}
