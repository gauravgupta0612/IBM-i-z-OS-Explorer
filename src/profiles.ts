import * as vscode from 'vscode';

export type ProfileType = 'zos' | 'ibmi';

export interface JobFilter { owner: string; prefix: string; }

export interface Profile {
  id: string;
  type: ProfileType;
  name: string;
  host: string;
  port: number;
  user: string;
  /** z/OS only: use https (default true) */
  secure?: boolean;
  /** z/OS only: accept self-signed certificates */
  rejectUnauthorized?: boolean;
  /** z/OS: data set filters (e.g. USER.*) */
  dsFilters?: string[];
  /** z/OS: USS paths, IBM i: IFS paths */
  paths?: string[];
  /** z/OS: job filters */
  jobFilters?: JobFilter[];
  /** IBM i: library filters */
  libraries?: string[];
  /** IBM i: optional private key file for SSH */
  privateKeyPath?: string;
  /** IBM i: library where compiled objects go (default = source library) */
  objectLibrary?: string;
}

const KEY = 'mf.profiles';

export class ProfileStore {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private ctx: vscode.ExtensionContext) {}

  all(): Profile[] { return this.ctx.globalState.get<Profile[]>(KEY, []); }
  byType(t: ProfileType): Profile[] { return this.all().filter(p => p.type === t); }
  get(id: string): Profile | undefined { return this.all().find(p => p.id === id); }

  async save(p: Profile): Promise<void> {
    const list = this.all().filter(x => x.id !== p.id);
    list.push(p);
    list.sort((a, b) => a.name.localeCompare(b.name));
    await this.ctx.globalState.update(KEY, list);
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(KEY, this.all().filter(p => p.id !== id));
    await this.ctx.secrets.delete(this.secretKey(id));
    this._onDidChange.fire();
  }

  private secretKey(id: string) { return `mf.password.${id}`; }

  /** Returns the stored password or asks the user once and stores it in VS Code SecretStorage (OS keychain). */
  async password(p: Profile, forcePrompt = false): Promise<string> {
    if (!forcePrompt) {
      const s = await this.ctx.secrets.get(this.secretKey(p.id));
      if (s) { return s; }
    }
    const pw = await vscode.window.showInputBox({
      title: `Password for ${p.user}@${p.host} (${p.name})`,
      password: true, ignoreFocusOut: true,
      prompt: 'Stored securely in your OS keychain via VS Code SecretStorage'
    });
    if (pw === undefined) { throw new Error('Password entry cancelled'); }
    await this.ctx.secrets.store(this.secretKey(p.id), pw);
    return pw;
  }

  async clearPassword(id: string) { await this.ctx.secrets.delete(this.secretKey(id)); }
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Interactive wizard to create or edit a profile. */
export async function profileWizard(type: ProfileType, existing?: Profile): Promise<Profile | undefined> {
  const label = type === 'zos' ? 'z/OS (z/OSMF)' : 'IBM i (SSH)';
  const name = await vscode.window.showInputBox({ title: `${label}: connection name`, value: existing?.name ?? '', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : 'Required' });
  if (!name) { return; }
  const host = await vscode.window.showInputBox({ title: `${label}: host name or IP`, value: existing?.host ?? '', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : 'Required' });
  if (!host) { return; }
  const defPort = type === 'zos' ? 443 : 22;
  const portS = await vscode.window.showInputBox({ title: `${label}: port`, value: String(existing?.port ?? defPort), ignoreFocusOut: true, validateInput: v => /^\d+$/.test(v) ? undefined : 'Number required' });
  if (!portS) { return; }
  const user = await vscode.window.showInputBox({ title: `${label}: user profile`, value: existing?.user ?? '', ignoreFocusOut: true, validateInput: v => v.trim() ? undefined : 'Required' });
  if (!user) { return; }

  const p: Profile = {
    ...(existing ?? { id: newId(), type, dsFilters: [], paths: [], jobFilters: [], libraries: [] }),
    name: name.trim(), host: host.trim(), port: Number(portS), user: user.trim()
  };

  if (type === 'zos') {
    const sec = await vscode.window.showQuickPick(
      [{ label: 'HTTPS', v: true }, { label: 'HTTP (not recommended)', v: false }],
      { title: 'Protocol', ignoreFocusOut: true });
    if (!sec) { return; }
    p.secure = sec.v;
    if (sec.v) {
      const rej = await vscode.window.showQuickPick(
        [{ label: 'Verify certificate', v: true }, { label: 'Accept self-signed certificate', v: false }],
        { title: 'TLS certificate', ignoreFocusOut: true });
      if (!rej) { return; }
      p.rejectUnauthorized = rej.v;
    }
    if (!existing) {
      p.dsFilters = [`${p.user.toUpperCase()}.*`];
      p.jobFilters = [{ owner: p.user.toUpperCase(), prefix: '*' }];
      p.paths = [`/u/${p.user.toLowerCase()}`];
    }
  } else {
    const auth = await vscode.window.showQuickPick([
      { label: '$(key) Password', description: 'Recommended – asked on first connect, stored in the OS keychain', v: 'pw' },
      { label: '$(file) SSH private key file', description: 'Choose a key file on this PC (e.g. id_rsa)', v: 'key' }
    ], { title: 'IBM i: how do you sign in?', ignoreFocusOut: true });
    if (!auth) { return; }
    if (auth.v === 'key') {
      const f = await vscode.window.showOpenDialog({ title: 'Select SSH private key file', canSelectMany: false, openLabel: 'Use this key' });
      if (!f?.length) { return; }
      p.privateKeyPath = f[0].fsPath;
    } else {
      p.privateKeyPath = undefined;
    }
    if (!existing) {
      p.libraries = [p.user.toUpperCase()];
      p.paths = [`/home/${p.user.toUpperCase()}`];
    }
  }
  return p;
}
