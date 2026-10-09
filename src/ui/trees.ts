import * as vscode from 'vscode';
import { Profile, ProfileStore, ProfileType } from '../profiles';
import { Sessions } from '../sessions';
import { uris } from '../fsProvider';
import { errorMessage } from '../log';

export class Node extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly ctx: string,
    public readonly pid: string,
    collapsible: boolean,
    public readonly data: any = {},
    public readonly loader?: () => Promise<Node[]>
  ) {
    super(label, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = ctx;
  }
  set icon(id: string) { this.iconPath = new vscode.ThemeIcon(id); }
}

function msgNode(pid: string, text: string, error = false): Node {
  const n = new Node(text, 'message', pid, false);
  n.icon = error ? 'error' : 'info';
  n.tooltip = text;
  return n;
}

function open(uri: vscode.Uri): vscode.Command { return { command: 'vscode.open', title: 'Open', arguments: [uri, { preview: false }] }; }

abstract class BaseTree implements vscode.TreeDataProvider<Node> {
  protected _emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(protected type: ProfileType, protected store: ProfileStore, protected sessions: Sessions) {
    store.onDidChange(() => this.refresh());
  }
  refresh(node?: Node) { this._emitter.fire(node); }
  getTreeItem(n: Node) { return n; }

  async getChildren(n?: Node): Promise<Node[]> {
    if (!n) {
      return this.store.byType(this.type).map(p => {
        const node = new Node(p.name, `profile-${this.type}`, p.id, true, { profile: p }, () => this.profileChildren(p));
        node.description = `${p.user}@${p.host}:${p.port}`;
        node.icon = this.type === 'zos' ? 'server-environment' : 'server';
        node.tooltip = `${p.name}\n${p.user}@${p.host}:${p.port}`;
        return node;
      });
    }
    if (!n.loader) { return []; }
    try {
      const kids = await n.loader();
      return kids.length ? kids : [msgNode(n.pid, 'No entries')];
    } catch (e) {
      return [msgNode(n.pid, errorMessage(e), true)];
    }
  }
  protected abstract profileChildren(p: Profile): Promise<Node[]>;

  /** "Favorites" node, only when the connection has favorites. */
  protected favoritesNode(p: Profile): Node[] {
    const favs = this.store.get(p.id)?.favorites ?? [];
    if (!favs.length) { return []; }
    const n = new Node('Favorites', `${this.type}-favRoot`, p.id, true, {}, async () =>
      (this.store.get(p.id)?.favorites ?? []).map(f => {
        const uri = vscode.Uri.parse(f.uri);
        const fn = new Node(f.label, 'favorite', p.id, false, { favorite: f });
        fn.description = f.description;
        fn.resourceUri = uri;
        fn.command = open(uri);
        fn.iconPath = new vscode.ThemeIcon('star-full');
        return fn;
      }));
    n.icon = 'star-full';
    return [n];
  }
}

// ===================================================================== z/OS
export class ZosTree extends BaseTree {
  constructor(store: ProfileStore, sessions: Sessions) { super('zos', store, sessions); }

  protected async profileChildren(p: Profile): Promise<Node[]> {
    const ds = new Node('Data Sets', 'zos-dsRoot', p.id, true, {}, async () => (this.store.get(p.id)?.dsFilters ?? []).map(f => this.dsFilterNode(p.id, f)));
    ds.icon = 'database';
    const uss = new Node('Unix Files (USS)', 'zos-ussRoot', p.id, true, {}, async () => (this.store.get(p.id)?.paths ?? []).map(path => this.ussNode(p.id, path, true, true)));
    uss.icon = 'folder-library';
    const jobs = new Node('Jobs', 'zos-jobRoot', p.id, true, {}, async () => (this.store.get(p.id)?.jobFilters ?? []).map(f => this.jobFilterNode(p.id, f.owner, f.prefix)));
    jobs.icon = 'checklist';
    return [...this.favoritesNode(p), ds, uss, jobs];
  }

  private dsFilterNode(pid: string, filter: string): Node {
    const n = new Node(filter, 'zos-dsFilter', pid, true, { filter }, async () => {
      const list = await this.sessions.zosClient(pid).listDatasets(filter);
      return list.map(d => {
        const isPO = d.dsorg?.startsWith('PO');
        const migrated = d.migr === 'YES' || d.vol === 'MIGRAT';
        const node = new Node(d.dsname, isPO ? 'zos-ds-po' : 'zos-ds-ps', pid, !!isPO, { ds: d.dsname }, isPO ? async () => {
          const members = await this.sessions.zosClient(pid).listMembers(d.dsname);
          return members.map(m => {
            const mn = new Node(m.member, 'zos-member', pid, false, { ds: d.dsname, member: m.member });
            mn.icon = 'file-code';
            mn.description = m.changed ? `${m.changed}${m.user ? ' ' + m.user : ''}` : '';
            mn.command = open(uris.zosMember(pid, d.dsname, m.member));
            mn.resourceUri = uris.zosMember(pid, d.dsname, m.member);
            mn.label = m.member;
            return mn;
          });
        } : undefined);
        node.icon = migrated ? 'cloud' : isPO ? 'library' : 'file';
        node.description = [d.dsorg, d.recfm, d.lrecl, d.vol].filter(Boolean).join(' ');
        if (!isPO && d.dsorg && !migrated) { node.command = open(uris.zosSeq(pid, d.dsname)); node.resourceUri = uris.zosSeq(pid, d.dsname); }
        if (migrated) { node.tooltip = 'Migrated – open to recall'; node.command = { command: 'mf.zos.recall', title: 'Recall', arguments: [node] }; }
        return node;
      });
    });
    n.icon = 'filter';
    return n;
  }

  ussNode(pid: string, path: string, isDir: boolean, isRoot = false, extra = ''): Node {
    const name = isRoot ? path : path.split('/').pop() || path;
    const ctx = isRoot ? 'zos-ussPath' : isDir ? 'zos-ussDir' : 'zos-ussFile';
    const n = new Node(name, ctx, pid, isDir, { path, isDir }, isDir ? async () => {
      const list = await this.sessions.zosClient(pid).listUss(path);
      return list.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1)
        .map(e => this.ussNode(pid, `${path.replace(/\/$/, '')}/${e.name}`, e.isDir, false, `${e.mode} ${e.isDir ? '' : e.size}`));
    } : undefined);
    n.description = extra;
    if (isDir) { n.icon = isRoot ? 'root-folder' : 'folder'; }
    else { n.resourceUri = uris.zosUss(pid, path); n.command = open(uris.zosUss(pid, path)); }
    return n;
  }

  private jobFilterNode(pid: string, owner: string, prefix: string): Node {
    const n = new Node(`Owner: ${owner}  Prefix: ${prefix}`, 'zos-jobFilter', pid, true, { owner, prefix }, async () => {
      const jobs = await this.sessions.zosClient(pid).listJobs(owner, prefix);
      return jobs.map(j => {
        const jn = new Node(`${j.jobname}(${j.jobid})`, 'zos-job', pid, true, { job: j }, async () => {
          const files = await this.sessions.zosClient(pid).listSpool(j.jobname, j.jobid);
          return files.map(f => {
            const fn = new Node(f.ddname, 'zos-spool', pid, false, { job: j, file: f });
            fn.description = [f.stepname, f.procstep, f.recordCount !== undefined ? `${f.recordCount} rec` : ''].filter(Boolean).join(' ');
            fn.icon = 'output';
            fn.command = open(uris.zosSpool(pid, j.jobname, j.jobid, f.id, `${j.jobname}.${j.jobid}.${f.ddname}`));
            return fn;
          });
        });
        const rc = j.retcode ?? j.status;
        jn.description = `${j.status} ${j.retcode ?? ''}`.trim();
        jn.tooltip = `${j.jobname} ${j.jobid}\nOwner: ${j.owner}\nStatus: ${j.status}\nRC: ${j.retcode ?? '-'}\nClass: ${j.class ?? ''}`;
        const ok = /^CC 000[04]$/.test(rc ?? '');
        const bad = /ABEND|JCL ERROR|SEC|CC (00(0[8-9]|[1-9]\d)|0[1-9]\d\d|[1-9])/.test(rc ?? '');
        jn.iconPath = new vscode.ThemeIcon(j.status === 'ACTIVE' ? 'sync~spin' : bad ? 'error' : ok ? 'pass' : 'circle-outline',
          new vscode.ThemeColor(bad ? 'testing.iconFailed' : ok ? 'testing.iconPassed' : 'foreground'));
        return jn;
      });
    });
    n.icon = 'filter';
    return n;
  }
}

// ===================================================================== IBM i
export class IbmiTree extends BaseTree {
  constructor(store: ProfileStore, sessions: Sessions) { super('ibmi', store, sessions); }

  protected async profileChildren(p: Profile): Promise<Node[]> {
    const libs = new Node('Libraries', 'ibmi-libRoot', p.id, true, {}, async () => (this.store.get(p.id)?.libraries ?? []).map(l => this.libNode(p.id, l)));
    libs.icon = 'library';
    const ifs = new Node('IFS', 'ibmi-ifsRoot', p.id, true, {}, async () => (this.store.get(p.id)?.paths ?? []).map(path => this.ifsNode(p.id, path, true, true)));
    ifs.icon = 'folder-library';
    const spool = new Node('My Spooled Files', 'ibmi-spoolRoot', p.id, true, {}, async () => {
      const list = await this.sessions.ibmiClient(p.id).listSpool(p.user);
      return list.map(s => {
        const n = new Node(`${s.name}`, 'ibmi-spool', p.id, false, { spool: s });
        n.description = `${s.job} #${s.number} ${s.status} ${s.pages}p ${s.created.slice(0, 19)}`;
        n.icon = 'output';
        n.tooltip = `${s.name} (${s.userData})\nJob: ${s.job}\nNumber: ${s.number}\nStatus: ${s.status}\nPages: ${s.pages}\nCreated: ${s.created}`;
        n.command = open(uris.ibmiSpool(p.id, s.job, s.name, s.number));
        return n;
      });
    });
    spool.icon = 'files';
    const jobs = new Node('My Active Jobs', 'ibmi-jobsRoot', p.id, true, {}, async () => {
      const list = await this.sessions.ibmiClient(p.id).listActiveJobs(p.user);
      return list.map(j => {
        const n = new Node(j.job, 'ibmi-job', p.id, false, { job: j.job });
        n.description = `${j.status} ${j.type} ${j.subsystem} ${j.function}`;
        n.icon = j.status === 'MSGW' ? 'warning' : 'pulse';
        n.command = open(uris.ibmiJobLog(p.id, j.job));
        return n;
      });
    });
    jobs.icon = 'pulse';
    const libl = new Node('Library List', 'ibmi-liblRoot', p.id, true, {}, async () => {
      const cur = this.store.get(p.id);
      const items: Node[] = [];
      if (cur?.currentLibrary) {
        const c = new Node(cur.currentLibrary, 'ibmi-curlib', p.id, false, { lib: cur.currentLibrary });
        c.description = 'current library'; c.icon = 'home';
        items.push(c);
      }
      (cur?.libraryList ?? []).forEach((l, i) => {
        const e = new Node(l, 'ibmi-liblEntry', p.id, false, { lib: l, index: i });
        e.description = `#${i + 1}`; e.icon = 'library';
        items.push(e);
      });
      return items;
    });
    libl.icon = 'list-ordered';
    libl.tooltip = 'Libraries added to the library list of CL commands and compiles';
    const msgq = new Node('Message Queues', 'ibmi-msgqRoot', p.id, true, {}, async () =>
      [['QSYS', 'QSYSOPR', 'QSYSOPR (system operator)'], ['QUSRSYS', p.user.toUpperCase(), `${p.user.toUpperCase()} (your messages)`]].map(([lib, q, label]) => {
        const qn = new Node(label, 'ibmi-msgq', p.id, true, { lib, queue: q }, async () => {
          const msgs = await this.sessions.ibmiClient(p.id).listMessages(lib, q);
          return msgs.map(m => {
            const waiting = m.type === 'INQUIRY' && !m.answered;
            const mn = new Node(m.text, waiting ? 'ibmi-msg-inq' : 'ibmi-msg', p.id, false, { lib, queue: q, msg: m });
            mn.description = `${m.id} ${m.time.slice(0, 19)}${m.type === 'INQUIRY' ? (m.answered ? ' · answered' : ' · waiting for reply') : ''}`;
            mn.tooltip = `${m.id}  ${m.type}  severity ${m.severity}\n${m.time}\nFrom: ${m.fromUser} ${m.fromJob}\n\n${m.text}`;
            mn.iconPath = new vscode.ThemeIcon(waiting ? 'question' : m.type === 'INQUIRY' ? 'pass' : m.severity >= 40 ? 'error' : m.severity >= 20 ? 'warning' : 'info');
            mn.command = { command: 'mf.ibmi.showMessage', title: 'Show', arguments: [mn] };
            return mn;
          });
        });
        qn.icon = 'mail';
        return qn;
      }));
    msgq.icon = 'inbox';
    return [...this.favoritesNode(p), libs, libl, ifs, spool, jobs, msgq];
  }

  private libNode(pid: string, lib: string): Node {
    const n = new Node(lib, 'ibmi-libFilter', pid, true, { lib }, async () => {
      const c = this.sessions.ibmiClient(pid);
      const [srcFiles, objects] = await Promise.all([c.listSourceFiles(lib), c.listObjects(lib)]);
      const src = new Set(srcFiles);
      const nodes: Node[] = srcFiles.map(f => {
        const fn = new Node(f, 'ibmi-srcpf', pid, true, { lib, file: f }, async () => {
          const mbrs = await c.listMembers(lib, f);
          return mbrs.map(m => {
            const mn = new Node(`${m.name}.${m.type.toLowerCase() || 'txt'}`, 'ibmi-member', pid, false, { lib, file: f, mbr: m.name, type: m.type });
            mn.description = m.text;
            mn.tooltip = `${lib}/${f}(${m.name})  ${m.type}\n${m.text}\nChanged: ${m.changed ?? ''}`;
            mn.resourceUri = uris.ibmiMember(pid, lib, f, m.name, m.type);
            mn.command = open(mn.resourceUri);
            return mn;
          });
        });
        fn.icon = 'file-submodule';
        fn.description = 'source file';
        return fn;
      });
      for (const o of objects) {
        if (o.type === '*FILE' && src.has(o.name)) { continue; }
        const on = new Node(o.name, `ibmi-object-${o.type.replace(/^\*/, '')}`, pid, false, { lib, obj: o });
        on.description = `${o.type} ${o.attribute} ${o.text}`.replace(/\s+/g, ' ').trim();
        on.icon = o.type === '*PGM' ? 'symbol-method' : o.type === '*SRVPGM' ? 'symbol-module' : o.type === '*FILE' ? 'table'
          : o.type === '*MODULE' ? 'symbol-class' : o.type === '*DTAARA' ? 'symbol-variable' : 'symbol-misc';
        nodes.push(on);
      }
      return nodes;
    });
    n.icon = 'library';
    return n;
  }

  ifsNode(pid: string, path: string, isDir: boolean, isRoot = false, extra = ''): Node {
    const name = isRoot ? path : path.split('/').pop() || path;
    const ctx = isRoot ? 'ibmi-ifsPath' : isDir ? 'ibmi-ifsDir' : 'ibmi-ifsFile';
    const n = new Node(name, ctx, pid, isDir, { path, isDir }, isDir ? async () => {
      const list = await this.sessions.ibmiClient(pid).listIfs(path);
      return list.map(e => this.ifsNode(pid, `${path.replace(/\/$/, '')}/${e.name}`, e.isDir, false, e.isDir ? '' : `${e.size} B`));
    } : undefined);
    n.description = extra;
    if (isDir) { n.icon = isRoot ? 'root-folder' : 'folder'; }
    else { n.resourceUri = uris.ibmiIfs(pid, path); n.command = open(uris.ibmiIfs(pid, path)); }
    return n;
  }
}
