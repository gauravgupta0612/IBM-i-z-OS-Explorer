import * as vscode from 'vscode';
import { Profile, ProfileStore } from './profiles';
import { ZosmfClient } from './zos/zosmf';
import { IbmiClient } from './ibmi/ibmiClient';

/** Holds one live client per profile. */
export class Sessions {
  private zos = new Map<string, ZosmfClient>();
  private ibmi = new Map<string, IbmiClient>();

  constructor(private store: ProfileStore) {
    store.onDidChange(() => this.prune());
  }

  private cfg() { return vscode.workspace.getConfiguration('mainframe'); }

  profile(id: string): Profile {
    const p = this.store.get(id);
    if (!p) { throw new Error(`Connection ${id} no longer exists`); }
    return p;
  }

  zosClient(id: string): ZosmfClient {
    let c = this.zos.get(id);
    if (!c) {
      const p = this.profile(id);
      const cfg = this.cfg();
      c = new ZosmfClient(p, () => this.store.password(p), {
        maxItems: cfg.get('zos.maxItems', 500), encoding: cfg.get('zos.encoding', ''),
        tsoAccount: cfg.get('zos.tsoAccount', 'ACCT#'), tsoProc: cfg.get('zos.tsoProc', 'IKJACCNT')
      });
      this.zos.set(id, c);
    }
    return c;
  }

  ibmiClient(id: string): IbmiClient {
    let c = this.ibmi.get(id);
    if (!c) {
      const p = this.profile(id);
      c = new IbmiClient(p, () => this.store.password(p), () => ({
        tempDir: this.cfg().get('ibmi.tempDir', '/tmp'), ccsid: this.cfg().get('ibmi.sourceCcsid', 1208)
      }));
      this.ibmi.set(id, c);
    }
    return c;
  }

  reset(id: string) {
    this.zos.delete(id);
    const i = this.ibmi.get(id);
    i?.disconnect();
    this.ibmi.delete(id);
  }

  private prune() {
    const ids = new Set(this.store.all().map(p => p.id));
    for (const id of [...this.zos.keys(), ...this.ibmi.keys()]) { if (!ids.has(id)) { this.reset(id); } }
  }

  dispose() { for (const c of this.ibmi.values()) { c.disconnect(); } }
}
