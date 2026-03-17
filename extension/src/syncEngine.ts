import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as Y from 'yjs';
import { DocStore } from './docStore';
import { Presence } from './presence';
import { DecorationManager } from './decorationManager';
import type { Transport, TransportEvent } from './transport';
import type { Payload } from './protocol';

type SnapshotRecv = {
  total: number;
  received: Map<number, string>;
};

function toRel(root: string, fsPath: string): string | null {
  const rel = path.relative(root, fsPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return null;
  return rel;
}

function isTextDoc(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== 'file') return false;
  // VS Code already classifies, but keep it simple: exclude very large docs.
  return doc.getText().length < 2_000_000;
}

function isBinaryPath(relativePath: string): boolean {
  return /\.(png|jpe?g|gif|ico|webp|bmp|avif|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|wasm|mp[34]|mov|avi|mkv|webm|ttf|otf|woff2?|eot|bin|dat|db|sqlite|class|pyc)$/i
    .test(relativePath);
}

type TextOp =
  | { kind: 'insert'; offset: number; text: string }
  | { kind: 'delete'; offset: number; length: number };

export class SyncEngine {
  private root: string;
  private myPeerId = '';
  private peers = new Map<string, string>(); // peerId -> name
  private isHost = false;

  private store = new DocStore();
  private docPresence = new Presence(new Y.Doc());
  private applyingRemote = new Set<string>(); // file rel
  private suppressDocToEditor = new Set<string>();
  private suppressEditorToDoc = new Set<string>();
  private maxFileSizeBytes: number;

  private pendingSnapshotChunks = new Map<string, { tries: number; msg: any; timer: ReturnType<typeof setTimeout> }>();
  private snapshotRecv = new Map<string, SnapshotRecv>(); // id -> recv

  private remoteManifest: { file: string; size: number; mtimeMs?: number }[] = [];
  private manifestRequestedAt = 0;
  private lastManifestSentAt = 0;

  private lastPresenceByPeerId = new Map<string, { file: string; line: number; character: number }>();

  private persistDir: string | null = null;
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private disposables: vscode.Disposable[] = [];

  constructor(
    private transport: Transport,
    private myName: string,
    private decorationManager: DecorationManager,
    private context: vscode.ExtensionContext,
    private sessionId: string
  ) {
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const cfg = vscode.workspace.getConfiguration('linesync');
    this.maxFileSizeBytes = (cfg.get<number>('maxFileSizeKB') ?? 512) * 1024;

    try {
      const wsId = this.safeId(this.root);
      const sessionSafe = this.safeId(this.sessionId);
      this.persistDir = path.join(this.context.globalStorageUri.fsPath, 'docs', wsId, sessionSafe);
      fs.mkdirSync(this.persistDir, { recursive: true });
    } catch {
      this.persistDir = null;
    }
  }

  attach() {
    // Presence updates from local selection
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        const rel = toRel(this.root, e.textEditor.document.uri.fsPath);
        if (!rel) return;
        const sel = e.selections[0];
        const active = sel?.active ?? new vscode.Position(0, 0);
        const anchor = sel?.anchor ?? active;
        const selection = sel && !sel.isEmpty
          ? {
              anchor: { line: anchor.line, character: anchor.character },
              active: { line: active.line, character: active.character },
            }
          : null;
        this.docPresence.setLocal(this.myName, this.myPeerId, { file: rel, line: active.line, character: active.character, selection });
      })
    );

    // When local awareness changes, broadcast
    this.disposables.push(
      this.docPresence.onChange((changed) => {
        const updateB64 = this.docPresence.encodeUpdate(changed);
        this.transport.send({ type: 'awareness_update', updateB64 } satisfies Payload);
      })
    );

    // Track local doc edits -> update yjs -> broadcast
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.trackDocument(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onTextChanged(e)),
    );

    for (const doc of vscode.workspace.textDocuments) this.trackDocument(doc);
  }

  dispose() {
    for (const t of this.persistTimers.values()) clearTimeout(t);
    this.persistTimers.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  handleTransportEvent(e: TransportEvent) {
    if (e.type === 'session_info') {
      this.myPeerId = e.peerId;
      this.peers.clear();
      for (const p of e.peers) this.peers.set(String(p.peerId), String(p.peerName || ''));
      this.recomputeHost();
      // Ensure our awareness has the stable relay peerId.
      const s: any = this.docPresence.awareness.getLocalState() ?? {};
      this.docPresence.setLocal(this.myName, this.myPeerId, {
        file: s.file,
        line: s.line,
        character: s.character,
        selection: s.selection ?? null,
      });
      return;
    }
    if (e.type === 'peer_joined') {
      this.peers.set(e.peerId, e.peerName);
      this.recomputeHost();
      if (this.isHost) {
        // send current state of opened docs
        for (const [file, entry] of this.store.entries()) {
          const update = Y.encodeStateAsUpdate(entry.doc);
          const updateB64 = Buffer.from(update).toString('base64');
          this.transport.send({ type: 'y_update', file, updateB64 } satisfies Payload);
        }
      }
      return;
    }
    if (e.type === 'peer_left') {
      this.peers.delete(e.peerId);
      this.decorationManager.clearPeer(e.peerId);
      this.recomputeHost();
      return;
    }
    if (e.type === 'enc') {
      const p = e.payload;
      if (p.type === 'awareness_update') {
        this.docPresence.applyUpdate(p.updateB64, e.from);
        this.renderRemotePresence();
        return;
      }
      if (p.type === 'y_update') {
        this.applyRemoteYUpdate(e.from, p.file, p.updateB64);
        return;
      }
      if (p.type === 'manifest_request') {
        if (this.isHost) this.sendManifest();
        return;
      }
      if (p.type === 'manifest') {
        this.remoteManifest = Array.isArray((p as any).files) ? (p as any).files : [];
        return;
      }
      if (p.type === 'snapshot_request') {
        if (this.isHost) this.handleSnapshotRequest(p.file);
        return;
      }
      if (p.type === 'snapshot_chunk') {
        this.handleSnapshotChunk(p);
        return;
      }
      if (p.type === 'snapshot_ack') {
        this.handleSnapshotAck(p);
        return;
      }
    }
  }

  private recomputeHost() {
    if (!this.myPeerId) return;
    const ids = [this.myPeerId, ...this.peers.keys()].sort();
    const hostId = ids[0] ?? '';
    this.isHost = hostId === this.myPeerId;
  }

  private trackDocument(doc: vscode.TextDocument) {
    const rel = toRel(this.root, doc.uri.fsPath);
    if (!rel) return;

    // For binary or very large docs, use snapshot transfer instead of CRDT text.
    if (!isTextDoc(doc) || isBinaryPath(rel) || Buffer.byteLength(doc.getText(), 'utf8') > this.maxFileSizeBytes) {
      this.requestSnapshot(rel);
      return;
    }

    const entry = this.store.getOrCreate(rel);

    // Apply persisted CRDT state first (if any).
    this.loadPersistedDoc(rel).catch(() => {});

    // Initialize doc content once
    if (entry.text.length === 0 && doc.getText().length > 0) {
      entry.doc.transact(() => {
        entry.text.insert(0, doc.getText());
      }, 'init');
    }

    // Broadcast doc updates
    entry.doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin === 'remote') return;
      const updateB64 = Buffer.from(update).toString('base64');
      this.transport.send({ type: 'y_update', file: rel, updateB64 } satisfies Payload);
    });

    // Persist full state debounced (covers local + remote changes).
    entry.doc.on('update', (_update: Uint8Array, _origin: any) => {
      this.schedulePersist(rel);
    });

    // Apply remote Y.Text deltas to editor without full replace.
    entry.text.observe((evt: any) => {
      const tr = evt?.transaction;
      if (!tr || tr.origin !== 'remote') return;
      const delta = Array.isArray(evt.delta) ? evt.delta : null;
      if (!delta) return;
      this.applyRemoteDeltaToEditor(rel, delta).catch(() => {
        // Fallback: if delta apply fails, do a full replace to re-converge.
        this.applyDocToEditor(rel).catch(() => {});
      });
    });
  }

  private onTextChanged(e: vscode.TextDocumentChangeEvent) {
    const doc = e.document;
    if (!isTextDoc(doc)) return;
    const rel = toRel(this.root, doc.uri.fsPath);
    if (!rel) return;
    if (this.applyingRemote.has(rel)) return;
    if (this.suppressEditorToDoc.has(rel)) return;
    const entry = this.store.getOrCreate(rel);

    // Apply delta edits from VS Code to Y.Text.
    // Process from end -> start to keep offsets stable.
    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    entry.doc.transact(() => {
      for (const c of changes) {
        const delLen = c.rangeLength;
        if (delLen > 0) entry.text.delete(c.rangeOffset, delLen);
        if (c.text) entry.text.insert(c.rangeOffset, c.text);
      }
    }, 'local');
  }

  private applyRemoteYUpdate(fromPeerId: string, file: string, updateB64: string) {
    const entry = this.store.getOrCreate(file);
    const update = new Uint8Array(Buffer.from(updateB64, 'base64'));
    this.applyingRemote.add(file);
    try {
      Y.applyUpdate(entry.doc, update, 'remote');
    } finally {
      this.applyingRemote.delete(file);
    }
    // Optional: highlight changed lines later (presence-ui todo)
  }

  private async applyDocToEditor(file: string) {
    if (this.suppressDocToEditor.has(file)) return;
    this.suppressDocToEditor.add(file);
    try {
      const entry = this.store.getOrCreate(file);
      const content = entry.text.toString();
      const fsPath = path.join(this.root, file);
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
      if (!doc) return;
      if (doc.getText() === content) return;
      const edit = new vscode.WorkspaceEdit();
      const last = doc.lineCount - 1;
      edit.replace(doc.uri, new vscode.Range(0, 0, last, doc.lineAt(last).range.end.character), content);
      this.suppressEditorToDoc.add(file);
      await vscode.workspace.applyEdit(edit);
    } finally {
      setTimeout(() => {
        this.suppressDocToEditor.delete(file);
        this.suppressEditorToDoc.delete(file);
      }, 50);
    }
  }

  private deltaToOps(delta: any[]): TextOp[] {
    const ops: TextOp[] = [];
    let index = 0;
    for (const d of delta) {
      if (!d || typeof d !== 'object') continue;
      if (typeof d.retain === 'number') {
        index += d.retain;
        continue;
      }
      if (typeof d.insert === 'string') {
        ops.push({ kind: 'insert', offset: index, text: d.insert });
        index += d.insert.length;
        continue;
      }
      if (typeof d.delete === 'number') {
        ops.push({ kind: 'delete', offset: index, length: d.delete });
        continue;
      }
    }
    return ops;
  }

  private async applyRemoteDeltaToEditor(file: string, delta: any[]) {
    const fsPath = path.join(this.root, file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
    if (!doc) return;
    if (this.suppressDocToEditor.has(file)) return;

    const ops = this.deltaToOps(delta);
    if (ops.length === 0) return;

    // Apply from end to start to keep offsets stable.
    ops.sort((a, b) => {
      if (a.offset !== b.offset) return b.offset - a.offset;
      // For same offset: delete first, then insert.
      if (a.kind === b.kind) return 0;
      return a.kind === 'delete' ? -1 : 1;
    });

    this.suppressDocToEditor.add(file);
    this.suppressEditorToDoc.add(file);
    try {
      const edit = new vscode.WorkspaceEdit();
      for (const op of ops) {
        if (op.kind === 'delete') {
          const start = doc.positionAt(op.offset);
          const end = doc.positionAt(op.offset + op.length);
          edit.delete(doc.uri, new vscode.Range(start, end));
        } else {
          const pos = doc.positionAt(op.offset);
          edit.insert(doc.uri, pos, op.text);
        }
      }
      await vscode.workspace.applyEdit(edit);
    } finally {
      setTimeout(() => {
        this.suppressDocToEditor.delete(file);
        this.suppressEditorToDoc.delete(file);
      }, 50);
    }
  }

  private renderRemotePresence() {
    // Map awareness states to DecorationManager cursors/selections
    for (const [clientId, state] of this.docPresence.awareness.getStates()) {
      const s: any = state;
      const peerId = typeof s?.peerId === 'string' && s.peerId ? s.peerId : String(clientId);
      const nameFromRelay = this.peers.get(peerId) ?? '';
      const name = nameFromRelay || String(s?.name || '');
      const file = typeof s?.file === 'string' ? s.file : null;
      const line = typeof s?.line === 'number' ? s.line : null;
      const character = typeof s?.character === 'number' ? s.character : 0;
      const selection = s?.selection ?? null;
      if (!file || line === null) continue;
      this.lastPresenceByPeerId.set(peerId, { file, line, character });
      this.decorationManager.updateCursor(peerId, file, line, character, selection, name || 'Peer');
    }
  }

  async requestManifest(): Promise<void> {
    const now = Date.now();
    if (now - this.manifestRequestedAt < 1500) return;
    this.manifestRequestedAt = now;
    this.transport.send({ type: 'manifest_request' } satisfies Payload);
  }

  async showRemoteFileBrowser(): Promise<void> {
    await this.requestManifest();
    if (!this.remoteManifest.length) {
      vscode.window.showInformationMessage('LineSync: Waiting for file list from host...');
      return;
    }
    const picks = this.remoteManifest
      .slice()
      .sort((a, b) => a.file.localeCompare(b.file))
      .map((f) => ({
        label: f.file,
        description: `${Math.round((f.size ?? 0) / 1024)} KB`,
        f,
      }));
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'LineSync: Remote files' });
    if (!pick) return;
    const rel = pick.f.file;
    const uri = vscode.Uri.file(path.join(this.root, rel));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    if (isBinaryPath(rel) || (pick.f.size ?? 0) > this.maxFileSizeBytes) {
      this.requestSnapshot(rel);
    }
  }

  async followPeer(): Promise<void> {
    const peers = [...this.lastPresenceByPeerId.entries()].map(([peerId, pos]) => ({
      peerId,
      name: this.peers.get(peerId) || `Peer-${peerId.slice(0, 4)}`,
      pos,
    }));
    if (peers.length === 0) {
      vscode.window.showInformationMessage('LineSync: No peer positions yet.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      peers.map((p) => ({ label: p.name, description: `${p.pos.file}:${p.pos.line + 1}:${p.pos.character + 1}`, p })),
      { placeHolder: 'LineSync: Follow peer' }
    );
    if (!pick) return;
    const target = pick.p.pos;
    const uri = vscode.Uri.file(path.join(this.root, target.file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(target.line, target.character);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async sendManifest() {
    const now = Date.now();
    if (now - this.lastManifestSentAt < 1000) return;
    this.lastManifestSentAt = now;

    try {
      const cfg = vscode.workspace.getConfiguration('linesync');
      const ignores = (cfg.get<string[]>('ignorePatterns') ?? []).filter(Boolean);
      const exclude = ignores.length ? `{${ignores.join(',')}}` : undefined;
      const uris = await vscode.workspace.findFiles('**/*', exclude, 5000);
      const files: { file: string; size: number; mtimeMs?: number }[] = [];
      for (const u of uris) {
        const rel = toRel(this.root, u.fsPath);
        if (!rel) continue;
        try {
          const st = fs.statSync(u.fsPath);
          if (!st.isFile()) continue;
          files.push({ file: rel, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // ignore
        }
      }
      this.transport.send({ type: 'manifest', files } satisfies Payload);
    } catch {
      // ignore
    }
  }

  private safeId(s: string): string {
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
  }

  private persistedPath(file: string): string | null {
    if (!this.persistDir) return null;
    const id = this.safeId(file);
    return path.join(this.persistDir, `${id}.bin`);
  }

  private async loadPersistedDoc(file: string) {
    const p = this.persistedPath(file);
    if (!p) return;
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p);
    if (!raw || raw.length === 0) return;
    const entry = this.store.getOrCreate(file);

    this.applyingRemote.add(file);
    try {
      Y.applyUpdate(entry.doc, new Uint8Array(raw), 'persist');
    } finally {
      this.applyingRemote.delete(file);
    }

    // Persist origin won't trigger remote delta apply, so align editor once.
    await this.applyDocToEditor(file);
  }

  private schedulePersist(file: string) {
    const p = this.persistedPath(file);
    if (!p) return;
    const prev = this.persistTimers.get(file);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.persistTimers.delete(file);
      try {
        const entry = this.store.getOrCreate(file);
        const update = Y.encodeStateAsUpdate(entry.doc);
        fs.writeFileSync(p, Buffer.from(update));
      } catch {
        // ignore
      }
    }, 900);
    this.persistTimers.set(file, t);
  }

  private requestSnapshot(file: string) {
    if (!file) return;
    this.transport.send({ type: 'snapshot_request', file } satisfies Payload);
  }

  private handleSnapshotRequest(file: string) {
    if (!file) return;
    const fsPath = path.join(this.root, file);
    let data: Buffer;
    try {
      data = fs.readFileSync(fsPath);
    } catch {
      return;
    }
    if (data.length > Math.max(this.maxFileSizeBytes, 8 * 1024 * 1024)) {
      // Hard cap to avoid absurd transfers until we add dedicated UI.
      return;
    }
    const id = crypto.randomUUID();
    const chunkSize = 32 * 1024;
    const total = Math.ceil(data.length / chunkSize) || 1;
    for (let i = 0; i < total; i++) {
      const slice = data.subarray(i * chunkSize, Math.min(data.length, (i + 1) * chunkSize));
      const msg = {
        type: 'snapshot_chunk',
        file,
        id,
        chunk: i,
        total,
        dataB64: slice.toString('base64'),
      };
      this.transport.send(msg as any);
      this.trackPendingSnapshotChunk(msg);
    }
  }

  private snapshotChunkKey(msg: { file: string; id: string; chunk: number }): string {
    return `${msg.file}|${msg.id}|${msg.chunk}`;
  }

  private trackPendingSnapshotChunk(msg: any) {
    if (!msg || typeof msg.file !== 'string' || typeof msg.id !== 'string' || typeof msg.chunk !== 'number') return;
    const key = this.snapshotChunkKey(msg);
    if (this.pendingSnapshotChunks.has(key)) return;
    const timer = setTimeout(() => this.retryPendingSnapshotChunk(key), 2000);
    this.pendingSnapshotChunks.set(key, { tries: 1, msg, timer });
  }

  private retryPendingSnapshotChunk(key: string) {
    const p = this.pendingSnapshotChunks.get(key);
    if (!p) return;
    if (p.tries >= 5) {
      clearTimeout(p.timer);
      this.pendingSnapshotChunks.delete(key);
      return;
    }
    p.tries++;
    try { this.transport.send(p.msg); } catch { /* ignore */ }
    p.timer = setTimeout(() => this.retryPendingSnapshotChunk(key), 2000);
    this.pendingSnapshotChunks.set(key, p);
  }

  private handleSnapshotAck(p: { file: string; id: string; chunk: number }) {
    const key = `${p.file}|${p.id}|${p.chunk}`;
    const pending = this.pendingSnapshotChunks.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingSnapshotChunks.delete(key);
    }
  }

  private handleSnapshotChunk(p: { file: string; id: string; chunk: number; total: number; dataB64: string }) {
    // Ack immediately so sender can stop retrying.
    this.transport.send({ type: 'snapshot_ack', file: p.file, id: p.id, chunk: p.chunk } satisfies Payload);

    let recv = this.snapshotRecv.get(p.id);
    if (!recv) {
      recv = { total: p.total, received: new Map() };
      this.snapshotRecv.set(p.id, recv);
    }
    recv.received.set(p.chunk, p.dataB64);
    if (recv.received.size < recv.total) return;

    // Reassemble
    const parts: Buffer[] = [];
    for (let i = 0; i < recv.total; i++) {
      const b64 = recv.received.get(i);
      if (!b64) return;
      parts.push(Buffer.from(b64, 'base64'));
    }
    this.snapshotRecv.delete(p.id);
    const data = Buffer.concat(parts);
    if (data.length > Math.max(this.maxFileSizeBytes, 8 * 1024 * 1024)) return;

    const fsPath = path.join(this.root, p.file);
    try {
      fs.mkdirSync(path.dirname(fsPath), { recursive: true });
      fs.writeFileSync(fsPath, data);
    } catch {
      return;
    }
    vscode.window.showInformationMessage(`LineSync: Received snapshot for ${p.file}`);
  }
}

