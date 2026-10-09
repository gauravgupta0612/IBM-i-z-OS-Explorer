import * as vscode from 'vscode';
import { Row } from '../ibmi/ibmiClient';

let panel: vscode.WebviewPanel | undefined;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Shows SQL results in a sortable/filterable grid with CSV export. */
export function showSqlResults(title: string, statement: string, columns: string[], rows: Row[], message: string, ms: number) {
  if (!panel) {
    panel = vscode.window.createWebviewPanel('mfSql', 'SQL Results', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage(async m => {
      if (m.type === 'csv') {
        const uri = await vscode.window.showSaveDialog({ filters: { CSV: ['csv'] }, saveLabel: 'Export CSV' });
        if (uri) { await vscode.workspace.fs.writeFile(uri, Buffer.from(m.csv, 'utf8')); vscode.window.showInformationMessage(`Exported ${uri.fsPath}`); }
      }
    });
  }
  panel.title = `SQL: ${title}`;
  const nonce = Math.random().toString(36).slice(2);
  const data = JSON.stringify({ columns, rows: rows.map(r => columns.map(c => r[c])) }).replace(/</g, '\\u003c');
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
 body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:8px}
 .bar{display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
 input{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:3px 6px;flex:1;min-width:160px}
 button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;cursor:pointer}
 pre{background:var(--vscode-textCodeBlock-background);padding:6px;white-space:pre-wrap;margin:0 0 8px}
 .wrap{overflow:auto;max-height:calc(100vh - 140px)}
 table{border-collapse:collapse;font-family:var(--vscode-editor-font-family);font-size:12px}
 th,td{border:1px solid var(--vscode-panel-border);padding:2px 6px;white-space:nowrap;text-align:left}
 th{position:sticky;top:0;background:var(--vscode-sideBar-background);cursor:pointer}
 td.null{opacity:.5;font-style:italic}
 .meta{opacity:.8}
</style></head><body>
<pre>${esc(statement)}</pre>
<div class="bar"><input id="f" placeholder="Filter rows…"><button id="csv">Export CSV</button><span class="meta">${esc(message || '')} · ${rows.length} row(s) · ${ms} ms</span></div>
<div class="wrap"><table id="t"></table></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const D = ${data};
let rows = D.rows.slice(), sortCol = -1, asc = true;
const t = document.getElementById('t'), f = document.getElementById('f');
const e = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function render(){
  const q = f.value.toLowerCase();
  const vis = rows.filter(r => !q || r.some(v => v != null && String(v).toLowerCase().includes(q)));
  t.innerHTML = '<tr>' + D.columns.map((c,i) => '<th data-i="'+i+'">'+e(c)+(i===sortCol?(asc?' ▲':' ▼'):'')+'</th>').join('') + '</tr>' +
    vis.slice(0, 5000).map(r => '<tr>' + r.map(v => v == null ? '<td class="null">null</td>' : '<td>'+e(v)+'</td>').join('') + '</tr>').join('');
}
t.addEventListener('click', ev => {
  const th = ev.target.closest('th'); if (!th) return;
  const i = +th.dataset.i; asc = sortCol === i ? !asc : true; sortCol = i;
  rows.sort((a,b) => { const x=a[i], y=b[i]; const nx=Number(x), ny=Number(y);
    const c = (x!=null&&y!=null&&x!==''&&y!==''&&!isNaN(nx)&&!isNaN(ny)) ? nx-ny : String(x??'').localeCompare(String(y??''));
    return asc ? c : -c; });
  render();
});
f.addEventListener('input', render);
document.getElementById('csv').addEventListener('click', () => {
  const q = v => v == null ? '' : /[",\\n]/.test(String(v)) ? '"' + String(v).replace(/"/g,'""') + '"' : String(v);
  const csv = [D.columns.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\\n');
  vscode.postMessage({ type: 'csv', csv });
});
render();
</script></body></html>`;
  panel.reveal(vscode.ViewColumn.Beside, true);
}
