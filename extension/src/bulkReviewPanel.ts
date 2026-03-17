import * as vscode from 'vscode';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export interface DeleteRequest {
  kind: 'delete';
  relativePath: string;
  deletedBy: string;
  /** peers who currently have this file tracked */
  affectedPeers: string[];
  backupId: string | null;
}

export interface ConflictRequest {
  kind: 'conflict';
  relativePath: string;
  peerName: string;
  ours: string;
  theirs: string;
}

export type ReviewItem = DeleteRequest | ConflictRequest;

export interface ReviewResult {
  /** For deletes: accepted = delete confirmed, rejected = keep local */
  deletes: Record<string, 'accept' | 'reject'>;
  /** For conflicts: 'mine' | 'theirs' | 'merged' + content */
  conflicts: Record<string, { choice: 'mine' | 'theirs' | 'merged'; content: string }>;
}

// ── BulkReviewPanel ────────────────────────────────────────────────────────

export class BulkReviewPanel {
  /**
   * Show a single panel with ALL pending deletes + conflicts.
   * Returns resolved decisions for each item.
   * Returns null if the panel is dismissed without resolving.
   */
  static show(
    items: ReviewItem[],
    context: vscode.ExtensionContext
  ): Promise<ReviewResult | null> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        'linesyncBulkReview',
        `LineSync - ${items.length} item${items.length !== 1 ? 's' : ''} need review`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );

      panel.webview.html = BulkReviewPanel.buildHtml(items);

      let resolved = false;

      panel.webview.onDidReceiveMessage(
        (msg:
          | { command: 'submit'; result: ReviewResult }
          | { command: 'cancel' }
          | { command: 'openDiff'; relativePath: string; ours: string; theirs: string; peerName: string }
        ) => {
          if (resolved) return;
          if (msg.command === 'openDiff') {
            BulkReviewPanel.openDiff(msg.relativePath, msg.ours, msg.theirs, msg.peerName).catch(() => {});
            return;
          }
          resolved = true;
          panel.dispose();
          resolve(msg.command === 'submit' ? msg.result : null);
        },
        undefined,
        context.subscriptions
      );

      panel.onDidDispose(() => {
        if (!resolved) resolve(null);
      });
    });
  }

  private static async openDiff(relativePath: string, ours: string, theirs: string, peerName: string) {
    const left = vscode.Uri.parse(`linesync-diff:/${encodeURIComponent(relativePath)}?side=ours`);
    const right = vscode.Uri.parse(`linesync-diff:/${encodeURIComponent(relativePath)}?side=theirs`);

    const provider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent(uri) {
        const side = new URL(uri.toString()).searchParams.get('side');
        return side === 'ours' ? ours : theirs;
      }
    };

    const reg = vscode.workspace.registerTextDocumentContentProvider('linesync-diff', provider);
    try {
      const title = `${relativePath} (you) <-> ${peerName}`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    } finally {
      reg.dispose();
    }
  }

  // ── HTML builder ───────────────────────────────────────────────────────────

  private static buildHtml(items: ReviewItem[]): string {
    const nonce = BulkReviewPanel.makeNonce();
    const e = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const deletes   = items.filter((i): i is DeleteRequest  => i.kind === 'delete');
    const conflicts = items.filter((i): i is ConflictRequest => i.kind === 'conflict');

    function fileIcon(p: string): string {
      const ext = path.extname(p).toLowerCase();
      const map: Record<string, string> = {
        '.ts': '[TS]', '.js': '[JS]', '.py': '[PY]', '.json': '[JSON]',
        '.md': '[MD]', '.html': '[HTML]', '.css': '[CSS]', '.go': '[GO]',
        '.rs': '[RS]', '.java': '[JAVA]', '.cpp': '[CPP]', '.c': '[C]',
      };
      return map[ext] ?? '[FILE]';
    }

    function diffLines(a: string, b: string): string {
      const aLines = a.split('\n');
      const bLines = b.split('\n');
      const maxLen = Math.max(aLines.length, bLines.length);
      const rows: string[] = [];
      for (let i = 0; i < Math.min(maxLen, 40); i++) {
        const al = aLines[i] ?? '';
        const bl = bLines[i] ?? '';
        const cls = al !== bl ? ' changed' : '';
        rows.push(`<div class="dl${cls}"><span class="ln">${i + 1}</span>${e(al) || ' '}</div>`);
      }
      if (maxLen > 40) rows.push(`<div class="dl more">... ${maxLen - 40} more lines</div>`);
      return rows.join('');
    }

    const deleteSection = deletes.length === 0 ? '' : /* html */`
    <section class="section">
      <div class="section-header">
        <span class="section-icon danger">DEL</span>
        <div>
          <div class="section-title">File deletions (${deletes.length})</div>
          <div class="section-sub">Choose which deletions to accept</div>
        </div>
        <div class="bulk-btns">
          <button class="btn-sm btn-danger" onclick="bulkDelete('accept')">Accept all</button>
          <button class="btn-sm btn-ghost"  onclick="bulkDelete('reject')">Reject all</button>
        </div>
      </div>
      ${deletes.map((d, i) => /* html */`
      <div class="item" id="del-item-${i}">
        <label class="item-check">
          <input type="checkbox" class="del-cb" data-idx="${i}" checked onchange="onDelChange(${i})">
          <span class="checkmark"></span>
        </label>
        <div class="item-body">
          <div class="item-file">${fileIcon(d.relativePath)} <code>${e(d.relativePath)}</code></div>
          <div class="item-meta">
            Deleted by <strong>${e(d.deletedBy)}</strong>
            ${d.affectedPeers.length > 0
              ? ` - affects <strong>${d.affectedPeers.map(e).join(', ')}</strong>`
              : ''}
            ${d.backupId ? `<span class="badge-backup">backup saved</span>` : ''}
          </div>
        </div>
        <div class="item-choice">
          <span class="choice-label" id="del-label-${i}">Will delete</span>
        </div>
      </div>
      `).join('')}
    </section>`;

    const conflictSection = conflicts.length === 0 ? '' : /* html */`
    <section class="section">
      <div class="section-header">
        <span class="section-icon warn">CONFLICT</span>
        <div>
          <div class="section-title">Sync conflicts (${conflicts.length})</div>
          <div class="section-sub">Pick which version wins, or merge manually</div>
        </div>
        <div class="bulk-btns">
          ${conflicts.length > 1 ? /* html */`
            <select id="conf-nav" class="nav-select" onchange="jumpConflict()">
              <option value="">Jump to file...</option>
              ${conflicts.map((c, i) => `<option value="${i}">${e(c.relativePath)}</option>`).join('')}
            </select>
          ` : ''}
          ${conflicts.length > 1 ? /* html */`
            <input id="conf-filter" class="nav-input" placeholder="Filter (path or peer)..." oninput="applyConflictView()" />
            <select id="conf-sort" class="nav-select" onchange="applyConflictView()">
              <option value="path">Sort: path</option>
              <option value="peer">Sort: peer</option>
            </select>
          ` : ''}
          <button class="btn-sm btn-mine"   onclick="bulkConflict('mine')">Keep all mine</button>
          <button class="btn-sm btn-theirs" onclick="bulkConflict('theirs')">Accept all theirs</button>
        </div>
      </div>
      ${conflicts.map((c, i) => /* html */`
      <div class="item conflict-item" id="con-item-${i}">
        <div class="item-body full">
          <div class="item-file">${fileIcon(c.relativePath)} <code>${e(c.relativePath)}</code>
            <span class="badge-conflict">CONFLICT</span>
          </div>
          <div class="item-meta">vs <strong>${e(c.peerName)}</strong></div>
          <div class="diff-cols">
            <div class="diff-col">
              <div class="diff-label mine-label">Your version</div>
              <div class="code-view">${diffLines(c.ours, c.theirs)}</div>
            </div>
            <div class="diff-col">
              <div class="diff-label their-label">${e(c.peerName)}'s version</div>
              <div class="code-view">${diffLines(c.theirs, c.ours)}</div>
            </div>
          </div>
          <div class="merge-row">
            <div class="merge-label">Manual merge <span class="hint">(Ctrl+Enter to confirm)</span></div>
            <textarea class="merge-ta" id="merge-${i}" spellcheck="false">${e(c.theirs)}</textarea>
          </div>
          <div class="choice-row">
            <button class="btn-mine"   onclick="setConflict(${i}, 'mine')">Keep mine</button>
            <button class="btn-theirs" onclick="setConflict(${i}, 'theirs', '${i}')">Accept ${e(c.peerName)}'s</button>
            <button class="btn-merge"  onclick="setConflict(${i}, 'merged')">Use merged</button>
            <button class="btn-ghost"  onclick="openDiff(${i})">Open diff in editor</button>
            <span class="choice-badge" id="con-badge-${i}"></span>
          </div>
        </div>
      </div>
      `).join('')}
    </section>`;

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
:root {
  --bg:    var(--vscode-editor-background, #1e1e1e);
  --fg:    var(--vscode-editor-foreground, #d4d4d4);
  --bd:    var(--vscode-panel-border, #3c3c3c);
  --inp:   var(--vscode-input-background, #3c3c3c);
  --desc:  var(--vscode-descriptionForeground, #888);
  --btn:   var(--vscode-button-background, #0e639c);
  --btnfg: var(--vscode-button-foreground, #fff);
  --mine:  #4ec9b0;
  --their: #f48771;
  --warn:  #e9a85a;
  --err:   #f48771;
  --font:  var(--vscode-editor-font-family, monospace);
  --fs:    var(--vscode-editor-font-size, 12px);
  --r:     4px;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font-family:var(--vscode-font-family,sans-serif);font-size:13px;padding:20px}

.page-header{margin-bottom:20px}
.page-title{font-size:16px;font-weight:600;margin-bottom:4px}
.page-sub{font-size:11px;color:var(--desc)}

.section{margin-bottom:24px;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.section-header{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--inp);border-bottom:1px solid var(--bd)}
.section-icon{font-size:16px}
.section-title{font-size:13px;font-weight:600}
.section-sub{font-size:11px;color:var(--desc);margin-top:2px}
.bulk-btns{margin-left:auto;display:flex;gap:6px}
.nav-select{
  background:var(--inp);
  color:var(--fg);
  border:1px solid var(--bd);
  border-radius:var(--r);
  font-size:11px;
  padding:3px 8px;
}
.nav-input{
  background:var(--inp);
  color:var(--fg);
  border:1px solid var(--bd);
  border-radius:var(--r);
  font-size:11px;
  padding:3px 8px;
  min-width:220px;
}
.nav-input:focus{outline:none;border-color:var(--mine)}
.nav-select:focus{outline:none;border-color:var(--mine)}

.item{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-bottom:1px solid var(--bd)}
.item:last-child{border-bottom:none}
.item.accepted{opacity:.55}
.item.rejected{opacity:.55;text-decoration:line-through}
.item-check{flex-shrink:0;margin-top:2px;cursor:pointer;position:relative;width:16px;height:16px}
.item-check input{opacity:0;position:absolute;width:100%;height:100%;cursor:pointer;margin:0}
.checkmark{display:block;width:16px;height:16px;border:1.5px solid var(--bd);border-radius:3px;transition:background .15s,border-color .15s}
.item-check input:checked ~ .checkmark{background:var(--err);border-color:var(--err)}
.checkmark::after{content:'X';position:absolute;top:1px;left:3px;font-size:11px;color:#000;display:none}
.item-check input:checked ~ .checkmark::after{display:block}

.item-body{flex:1;min-width:0}
.item-body.full{width:100%}
.item-file{font-size:12px;margin-bottom:4px;display:flex;align-items:center;gap:6px}
.item-file code{font-family:var(--font);background:var(--inp);padding:1px 5px;border-radius:3px;font-size:11px}
.item-meta{font-size:11px;color:var(--desc);margin-bottom:4px}
.item-choice{flex-shrink:0;font-size:11px;color:var(--desc);text-align:right;padding-top:2px}

.badge-backup{background:rgba(78,201,176,.15);color:var(--mine);padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;margin-left:6px}
.badge-conflict{background:rgba(233,168,90,.15);color:var(--warn);padding:1px 6px;border-radius:10px;font-size:10px;font-weight:600;margin-left:6px}
.choice-label{font-size:11px;font-weight:600;color:var(--err)}

.diff-cols{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
.diff-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:4px}
.mine-label{color:var(--mine)}
.their-label{color:var(--their)}
.code-view{background:var(--inp);border:1px solid var(--bd);border-radius:var(--r);overflow:auto;max-height:200px;font-family:var(--font);font-size:var(--fs);line-height:1.6}
.dl{padding:0 8px;white-space:pre}
.dl.changed{background:rgba(255,200,0,.07);border-left:2px solid rgba(255,200,0,.4)}
.dl.more{color:var(--desc);font-style:italic;padding:4px 8px}
.ln{color:#555;margin-right:10px;display:inline-block;min-width:2em;text-align:right;font-size:10px;user-select:none}

.merge-row{margin-bottom:10px}
.merge-label{font-size:10px;text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:#888;margin-bottom:5px}
.hint{font-weight:400;text-transform:none;letter-spacing:0;color:#555}
.merge-ta{width:100%;height:160px;resize:vertical;background:var(--inp);color:var(--fg);border:1px solid var(--bd);border-radius:var(--r);font-family:var(--font);font-size:var(--fs);padding:7px;line-height:1.6;tab-size:2}
.merge-ta:focus{outline:none;border-color:var(--mine)}

.choice-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.choice-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;display:none}
.choice-badge.set{display:inline-block;background:rgba(78,201,176,.15);color:var(--mine)}

button{padding:5px 12px;border:none;border-radius:var(--r);cursor:pointer;font-size:12px;font-weight:600;transition:filter .15s}
button:hover{filter:brightness(1.12)}
.btn-sm{padding:3px 10px;font-size:11px}
.btn-mine  {background:var(--mine);color:#000}
.btn-theirs{background:var(--their);color:#000}
.btn-merge {background:var(--btn);color:var(--btnfg)}
.btn-ghost {background:rgba(255,255,255,.07);color:var(--fg)}
.btn-sm.btn-danger{background:rgba(244,135,113,.2);color:var(--their)}
.btn-sm.btn-ghost {background:rgba(255,255,255,.07);color:var(--fg)}

.footer{display:flex;align-items:center;justify-content:space-between;padding-top:8px;border-top:1px solid var(--bd);margin-top:4px}
.footer-info{font-size:11px;color:var(--desc)}
.footer-btns{display:flex;gap:10px}
.btn-submit{background:var(--btn);color:var(--btnfg);padding:7px 20px;font-size:13px}
.btn-cancel{background:transparent;color:var(--desc);border:1px solid var(--bd);padding:6px 14px;font-size:13px}
</style>
</head>
<body>

<div class="page-header">
  <div class="page-title">LineSync - Review required</div>
  <div class="page-sub">${items.length} item${items.length !== 1 ? 's' : ''} need your attention before sync continues</div>
</div>

${deleteSection}
${conflictSection}

<div class="footer">
  <div class="footer-info" id="footer-info">Review all items above</div>
  <div class="footer-btns">
    <button class="btn-cancel" onclick="cancel()">Cancel</button>
    <button class="btn-submit" onclick="submit()" id="btn-submit">Apply decisions</button>
  </div>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();

const deletes   = ${JSON.stringify(deletes.map((d, i) => ({ idx: i, path: d.relativePath })))};
const conflicts = ${JSON.stringify(conflicts.map((c, i) => ({ idx: i, path: c.relativePath, theirs: c.theirs, ours: c.ours, peerName: c.peerName })))};

const delState = Object.fromEntries(deletes.map(d => [d.idx, 'accept']));
const conState = Object.fromEntries(conflicts.map(c => [c.idx, null]));

function onDelChange(i) {
  const cb = document.querySelector('.del-cb[data-idx="'+i+'"]');
  const accepted = cb.checked;
  delState[i] = accepted ? 'accept' : 'reject';
  document.getElementById('del-label-'+i).textContent = accepted ? 'Will delete' : 'Keeping local';
  document.getElementById('del-item-'+i).className = 'item ' + (accepted ? 'accepted' : 'rejected');
  updateFooter();
}

function bulkDelete(action) {
  deletes.forEach(d => {
    const cb = document.querySelector('.del-cb[data-idx="'+d.idx+'"]');
    cb.checked = action === 'accept';
    onDelChange(d.idx);
  });
}

function setConflict(i, choice) {
  const content = choice === 'merged'
    ? document.getElementById('merge-'+i).value
    : choice === 'mine'
      ? conflicts[i].ours
      : conflicts[i].theirs;
  conState[i] = { choice, content };
  const badge = document.getElementById('con-badge-'+i);
  badge.textContent = choice === 'mine' ? 'Keeping mine' : choice === 'theirs' ? 'Accepted theirs' : 'Using merged';
  badge.className = 'choice-badge set';
  updateFooter();
}

function bulkConflict(choice) {
  conflicts.forEach(c => setConflict(c.idx, choice));
}

function openDiff(i) {
  const c = conflicts[i];
  vscode.postMessage({
    command: 'openDiff',
    relativePath: c.path,
    ours: c.ours,
    theirs: c.theirs,
    peerName: c.peerName || 'Peer'
  });
}

function applyConflictView() {
  const sortEl = document.getElementById('conf-sort');
  const filterEl = document.getElementById('conf-filter');
  const sortBy = sortEl ? sortEl.value : 'path';
  const filter = (filterEl ? filterEl.value : '').trim().toLowerCase();

  const container = document.querySelector('.section .section-header').parentElement;
  if (!container) return;

  const items = conflicts.map(c => ({
    idx: c.idx,
    path: c.path,
    peerName: (c.peerName || '').toLowerCase(),
    el: document.getElementById('con-item-' + c.idx)
  })).filter(x => x.el);

  for (const it of items) {
    const hay = (it.path + ' ' + it.peerName).toLowerCase();
    it.el.style.display = !filter || hay.includes(filter) ? '' : 'none';
  }

  const visible = items.filter(it => it.el.style.display !== 'none');
  visible.sort((a, b) => {
    if (sortBy === 'peer') {
      const ap = a.peerName || '';
      const bp = b.peerName || '';
      if (ap !== bp) return ap.localeCompare(bp);
    }
    return a.path.localeCompare(b.path);
  });

  for (const it of visible) container.appendChild(it.el);
}

function jumpConflict() {
  const sel = document.getElementById('conf-nav');
  if (!sel || !sel.value) return;
  const el = document.getElementById('con-item-' + sel.value);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  sel.value = '';
}

function updateFooter() {
  const unresolved = conflicts.filter(c => conState[c.idx] === null).length;
  const info = document.getElementById('footer-info');
  const btn  = document.getElementById('btn-submit');
  if (unresolved > 0) {
    info.textContent = unresolved + ' conflict' + (unresolved>1?'s':'')+' still need a decision';
    btn.disabled = true;
    btn.style.opacity = '.5';
  } else {
    info.textContent = 'All items resolved - ready to apply';
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

function submit() {
  const result = {
    deletes: Object.fromEntries(deletes.map(d => [d.path, delState[d.idx]])),
    conflicts: Object.fromEntries(
      conflicts.map(c => [c.path, conState[c.idx] ?? { choice: 'theirs', content: c.theirs }])
    )
  };
  vscode.postMessage({ command: 'submit', result });
}

function cancel() {
  vscode.postMessage({ command: 'cancel' });
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
});

// Init
updateFooter();
if (conflicts.length > 1) applyConflictView();
// Auto-disable submit if there are unresolved conflicts
if (conflicts.length > 0) {
  document.getElementById('btn-submit').disabled = true;
  document.getElementById('btn-submit').style.opacity = '.5';
}
</script>
</body>
</html>`;
  }

  private static makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
}
