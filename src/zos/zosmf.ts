import * as http from 'http';
import * as https from 'https';
import { Profile } from '../profiles';
import { log } from '../log';

export interface Dataset { dsname: string; dsorg?: string; recfm?: string; lrecl?: string; vol?: string; migr?: string; }
export interface Member { member: string; changed?: string; user?: string; }
export interface UssEntry { name: string; mode: string; size: number; mtime?: string; isDir: boolean; }
export interface Job { jobname: string; jobid: string; owner: string; status: string; retcode: string | null; type?: string; class?: string; }
export interface SpoolFile { id: number; ddname: string; stepname?: string; procstep?: string; recordCount?: number; }

export interface CreateDsOptions {
  dsorg: 'PO' | 'PS' | 'PO-E'; recfm: string; lrecl: number; blksize?: number;
  primary: number; secondary: number; alcunit: 'TRK' | 'CYL'; dirblk?: number; dsntype?: string; volser?: string;
}

export class ZosmfError extends Error {
  constructor(msg: string, public status: number, public body: string) { super(msg); }
}

interface Resp { status: number; headers: http.IncomingHttpHeaders; body: Buffer; }

/** Minimal, dependency-free z/OSMF REST client (files, jobs, TSO, console). */
export class ZosmfClient {
  constructor(private p: Profile, private password: () => Promise<string>,
              private opts: { maxItems: number; encoding: string; tsoAccount: string; tsoProc: string }) {}

  private async request(method: string, path: string, body?: string | Buffer | object,
                        extraHeaders: Record<string, string> = {}): Promise<Resp> {
    const pw = await this.password();
    const secure = this.p.secure !== false;
    const headers: Record<string, string> = {
      'X-CSRF-ZOSMF-HEADER': 'true',
      'Authorization': 'Basic ' + Buffer.from(`${this.p.user}:${pw}`).toString('base64'),
      ...extraHeaders
    };
    let payload: Buffer | undefined;
    if (body !== undefined) {
      if (Buffer.isBuffer(body)) { payload = body; }
      else if (typeof body === 'string') { payload = Buffer.from(body, 'utf8'); headers['Content-Type'] ??= 'text/plain; charset=UTF-8'; }
      else { payload = Buffer.from(JSON.stringify(body), 'utf8'); headers['Content-Type'] ??= 'application/json'; }
      headers['Content-Length'] = String(payload.length);
    }
    log(`[z/OS ${this.p.name}] ${method} ${path}`);
    const mod = secure ? https : http;
    return new Promise<Resp>((resolve, reject) => {
      const req = mod.request({
        host: this.p.host, port: this.p.port, method, path, headers,
        rejectUnauthorized: this.p.rejectUnauthorized !== false, timeout: 60000
      } as https.RequestOptions, res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const r = { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) };
          if (r.status >= 400) {
            const text = r.body.toString('utf8');
            let msg = text;
            try {
              const j = JSON.parse(text);
              msg = j.message ?? (Array.isArray(j.details) ? j.details.join(' ') : '') ?? text;
              if (j.details && j.message) { msg = `${j.message} ${[].concat(j.details).join(' ')}`; }
            } catch { /* not json */ }
            if (r.status === 401) { msg = 'Authentication failed (401). Use "Reset Stored Password".'; }
            reject(new ZosmfError(`z/OSMF ${method} ${path} → ${r.status}: ${msg}`.slice(0, 800), r.status, text));
          } else { resolve(r); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('z/OSMF request timed out')));
      req.on('error', reject);
      if (payload) { req.write(payload); }
      req.end();
    });
  }

  private json(r: Resp): any { const t = r.body.toString('utf8'); return t ? JSON.parse(t) : {}; }
  private dataType(): Record<string, string> {
    return this.opts.encoding ? { 'X-IBM-Data-Type': `text;fileEncoding=${this.opts.encoding}` } : { 'X-IBM-Data-Type': 'text' };
  }

  // ---------- info ----------
  async info(): Promise<any> { return this.json(await this.request('GET', '/zosmf/info')); }

  // ---------- data sets ----------
  async listDatasets(filter: string): Promise<Dataset[]> {
    const r = await this.request('GET', `/zosmf/restfiles/ds?dslevel=${encodeURIComponent(filter)}`,
      undefined, { 'X-IBM-Attributes': 'base', 'X-IBM-Max-Items': String(this.opts.maxItems) });
    return (this.json(r).items ?? []) as Dataset[];
  }

  async listMembers(ds: string, pattern?: string): Promise<Member[]> {
    const q = pattern ? `?pattern=${encodeURIComponent(pattern)}` : '';
    const r = await this.request('GET', `/zosmf/restfiles/ds/${encodeURIComponent(ds)}/member${q}`,
      undefined, { 'X-IBM-Attributes': 'base', 'X-IBM-Max-Items': '0' });
    return (this.json(r).items ?? []).map((m: any) => ({ member: m.member, changed: m.m4date ? `${m.m4date} ${m.mtime ?? ''}` : undefined, user: m.user }));
  }

  private dsPath(ds: string, member?: string) {
    return `/zosmf/restfiles/ds/${encodeURIComponent(member ? `${ds}(${member})` : ds)}`;
  }

  async readDataset(ds: string, member?: string): Promise<{ text: string; etag?: string }> {
    const r = await this.request('GET', this.dsPath(ds, member), undefined, { ...this.dataType(), 'X-IBM-Return-Etag': 'true' });
    return { text: r.body.toString('utf8'), etag: r.headers.etag as string | undefined };
  }

  async writeDataset(ds: string, member: string | undefined, text: string, etag?: string): Promise<string | undefined> {
    const h: Record<string, string> = { ...this.dataType(), 'Content-Type': 'text/plain; charset=UTF-8', 'X-IBM-Return-Etag': 'true' };
    if (etag) { h['If-Match'] = etag; }
    const r = await this.request('PUT', this.dsPath(ds, member), text.replace(/\r\n/g, '\n'), h);
    return r.headers.etag as string | undefined;
  }

  async createDataset(ds: string, o: CreateDsOptions): Promise<void> {
    const body: any = {
      dsorg: o.dsorg === 'PO-E' ? 'PO' : o.dsorg, alcunit: o.alcunit, primary: o.primary, secondary: o.secondary,
      recfm: o.recfm, lrecl: o.lrecl, blksize: o.blksize ?? 0
    };
    if (o.dsorg !== 'PS') { body.dirblk = o.dirblk ?? 10; }
    if (o.dsorg === 'PO-E') { body.dsntype = 'LIBRARY'; }
    if (o.volser) { body.volser = o.volser; }
    if (!body.blksize) { delete body.blksize; }
    await this.request('POST', this.dsPath(ds), body);
  }

  async deleteDataset(ds: string, member?: string): Promise<void> { await this.request('DELETE', this.dsPath(ds, member)); }

  async recallDataset(ds: string): Promise<void> { await this.request('PUT', this.dsPath(ds), { request: 'hrecall', wait: true }); }

  // ---------- USS ----------
  async listUss(path: string): Promise<UssEntry[]> {
    const r = await this.request('GET', `/zosmf/restfiles/fs?path=${encodeURIComponent(path)}`, undefined, { 'X-IBM-Max-Items': '0' });
    return (this.json(r).items ?? [])
      .filter((e: any) => e.name !== '.' && e.name !== '..')
      .map((e: any) => ({ name: e.name, mode: e.mode, size: e.size, mtime: e.mtime, isDir: String(e.mode).startsWith('d') }));
  }
  private ussPath(p: string) { return `/zosmf/restfiles/fs${p.split('/').map(encodeURIComponent).join('/')}`; }
  async readUss(path: string): Promise<Buffer> {
    return (await this.request('GET', this.ussPath(path), undefined, { 'X-IBM-Data-Type': 'text' })).body;
  }
  async writeUss(path: string, content: Buffer | string): Promise<void> {
    await this.request('PUT', this.ussPath(path), typeof content === 'string' ? content : content.toString('utf8'),
      { 'X-IBM-Data-Type': 'text', 'Content-Type': 'text/plain; charset=UTF-8' });
  }
  async createUss(path: string, type: 'file' | 'directory'): Promise<void> {
    await this.request('POST', this.ussPath(path), { type, mode: type === 'directory' ? 'rwxr-xr-x' : 'rw-r--r--' });
  }
  async deleteUss(path: string, recursive = false): Promise<void> {
    await this.request('DELETE', this.ussPath(path), undefined, recursive ? { 'X-IBM-Option': 'recursive' } : {});
  }

  // ---------- jobs ----------
  async listJobs(owner: string, prefix: string): Promise<Job[]> {
    const q = `owner=${encodeURIComponent(owner || '*')}&prefix=${encodeURIComponent(prefix || '*')}&max-jobs=${this.opts.maxItems}`;
    const r = await this.request('GET', `/zosmf/restjobs/jobs?${q}`);
    return (this.json(r) as any[]).map(j => ({ jobname: j.jobname, jobid: j.jobid, owner: j.owner, status: j.status, retcode: j.retcode, type: j.type, class: j.class }));
  }
  async jobStatus(jobname: string, jobid: string): Promise<Job> {
    return this.json(await this.request('GET', `/zosmf/restjobs/jobs/${jobname}/${jobid}`));
  }
  async listSpool(jobname: string, jobid: string): Promise<SpoolFile[]> {
    const r = await this.request('GET', `/zosmf/restjobs/jobs/${jobname}/${jobid}/files`);
    return (this.json(r) as any[]).map(f => ({ id: f.id, ddname: f.ddname, stepname: f.stepname, procstep: f.procstep, recordCount: f['record-count'] }));
  }
  async readSpool(jobname: string, jobid: string, id: number): Promise<string> {
    return (await this.request('GET', `/zosmf/restjobs/jobs/${jobname}/${jobid}/files/${id}/records`)).body.toString('utf8');
  }
  async submitJcl(jcl: string): Promise<Job> {
    const r = await this.request('PUT', '/zosmf/restjobs/jobs', jcl.replace(/\r\n/g, '\n'),
      { 'Content-Type': 'text/plain; charset=UTF-8', 'X-IBM-Intrdr-Class': 'A', 'X-IBM-Intrdr-Recfm': 'F', 'X-IBM-Intrdr-Lrecl': '80', 'X-IBM-Intrdr-Mode': 'TEXT' });
    return this.json(r);
  }
  async submitDataset(ds: string): Promise<Job> {
    const r = await this.request('PUT', '/zosmf/restjobs/jobs', { file: `//'${ds}'` });
    return this.json(r);
  }
  async cancelJob(jobname: string, jobid: string): Promise<void> {
    await this.request('PUT', `/zosmf/restjobs/jobs/${jobname}/${jobid}`, { request: 'cancel', version: '2.0' });
  }
  async purgeJob(jobname: string, jobid: string): Promise<void> {
    await this.request('DELETE', `/zosmf/restjobs/jobs/${jobname}/${jobid}`);
  }

  /** Original JCL of a job (as submitted). */
  async jobJcl(jobname: string, jobid: string): Promise<string> {
    return (await this.request('GET', `/zosmf/restjobs/jobs/${jobname}/${jobid}/files/JCL/records`)).body.toString('utf8');
  }

  // ---------- copy / rename / attributes ----------
  /** Copy a member (or all members with member '*') into another partitioned data set. */
  async copyMember(fromDs: string, fromMember: string, toDs: string, toMember: string, replace: boolean): Promise<void> {
    await this.request('PUT', this.dsPath(toDs, toMember === '*' ? undefined : toMember),
      { request: 'copy', 'from-dataset': { dsn: fromDs, member: fromMember }, replace });
  }
  /** Copy a sequential data set into another (existing) data set or member. */
  async copySequential(fromDs: string, toDs: string, toMember?: string): Promise<void> {
    await this.request('PUT', this.dsPath(toDs, toMember), { request: 'copy', 'from-dataset': { dsn: fromDs } });
  }
  async renameMember(ds: string, oldMember: string, newMember: string): Promise<void> {
    await this.request('PUT', this.dsPath(ds, newMember), { request: 'rename', 'from-dataset': { dsn: ds, member: oldMember } });
  }
  async renameDataset(oldDs: string, newDs: string): Promise<void> {
    await this.request('PUT', this.dsPath(newDs), { request: 'rename', 'from-dataset': { dsn: oldDs } });
  }
  /** All attributes z/OSMF returns for one data set. */
  async datasetAttributes(ds: string): Promise<Record<string, unknown>> {
    const r = await this.request('GET', `/zosmf/restfiles/ds?dslevel=${encodeURIComponent(ds)}`, undefined, { 'X-IBM-Attributes': 'base,total' });
    const items: any[] = this.json(r).items ?? [];
    return items.find(i => i.dsname === ds) ?? items[0] ?? {};
  }

  // ---------- console ----------
  async console(cmd: string): Promise<string> {
    const r = this.json(await this.request('PUT', '/zosmf/restconsoles/consoles/defcn', { cmd }));
    let out: string = r['cmd-response'] ?? '';
    // If response is not complete yet, poll the solicited response key once or twice
    for (let i = 0; i < 3 && r['cmd-response-key'] && !out.trim(); i++) {
      await new Promise(res => setTimeout(res, 1500));
      const r2 = this.json(await this.request('GET', `/zosmf/restconsoles/consoles/defcn/solmsgs/${r['cmd-response-key']}`));
      out += r2['cmd-response'] ?? '';
    }
    return out.replace(/\r/g, '\n');
  }

  // ---------- TSO (start / send / receive / stop) ----------
  async tso(cmd: string): Promise<string> {
    const q = `proc=${encodeURIComponent(this.opts.tsoProc)}&chset=697&cpage=1047&rows=204&cols=160&rsize=4096&acct=${encodeURIComponent(this.opts.tsoAccount)}`;
    const start = this.json(await this.request('POST', `/zosmf/tsoApp/tso?${q}`));
    const key: string = start.servletKey;
    if (!key) { throw new Error('Could not start TSO address space: ' + JSON.stringify(start).slice(0, 300)); }
    const out: string[] = [];
    const collect = (j: any): boolean => {
      let ready = false;
      for (const d of j.tsoData ?? []) {
        if (d['TSO MESSAGE']) { out.push(d['TSO MESSAGE'].DATA); }
        if (d['TSO PROMPT']) { ready = true; }
      }
      return ready;
    };
    try {
      // drain logon messages
      let ready = collect(start);
      for (let i = 0; !ready && i < 10; i++) { ready = collect(this.json(await this.request('GET', `/zosmf/tsoApp/tso/${key}`))); }
      out.length = 0;
      let r = this.json(await this.request('PUT', `/zosmf/tsoApp/tso/${key}`, { 'TSO RESPONSE': { VERSION: '0100', DATA: cmd } }));
      ready = collect(r);
      for (let i = 0; !ready && i < 30; i++) {
        r = this.json(await this.request('GET', `/zosmf/tsoApp/tso/${key}`));
        ready = collect(r);
      }
    } finally {
      await this.request('DELETE', `/zosmf/tsoApp/tso/${key}`).catch(() => undefined);
    }
    return out.join('\n');
  }
}
