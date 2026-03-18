import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as Y from 'yjs';
import { DocStore } from './docStore';
import { Presence } from './presence';
import { DecorationManager } from './decorationManager';
import { IgnoreMatcher } from './ignoreMatcher';
import type { Transport, TransportEvent } from './transport';
import type { Payload } from './protocol';

const SNAPSHOT_CHUNK_BYTES = 32 * 1024;
const SNAPSHOT_SEND_WINDOW = 8;
const SNAPSHOT_RETRY_MS = 1200;
const SNAPSHOT_MAX_RETRIES = 6;
const SNAPSHOT_RECV_TTL_MS = 45_000;
const SNAPSHOT_MAX_ACTIVE_RECV_BYTES = 32 * 1024 * 1024;

type SnapshotSendState = {
  file: string;
  id: string;
  data: Buffer;
  total: number;
  totalBytes: number;
  sha256: string;
  nextChunk: number;
  acked: Set<number>;
  inFlight: Map<number, { sentAt: number; tries: number }>;
  retryTimer: ReturnType<typeof setInterval> | null;
};

type SnapshotRecvState = {
  file: string;
  id: string;
  total: number;
  totalBytes: number;
  sha256: string;
  received: Map<number, Buffer>;
  receivedBytes: number;
  lastAt: number;
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
  private hostRoleFromRelay = false;

  private store = new DocStore();
  private docPresence = new Presence(new Y.Doc());
  private applyingRemote = new Set<string>(); // file rel
  private suppressDocToEditor = new Set<string>();
  private suppressEditorToDoc = new Set<string>();
  private maxFileSizeBytes: number;
  private peerMode: 'edit' | 'readOnly' = 'edit';
  private remoteFilesMode: 'previewOnly' | 'autoMirrorMissing' = 'previewOnly';
  private autoResyncOnDrift = true;
  private driftCheckIntervalMs = 2500;
  private autoResyncCooldownMs = 15_000;
  private maxAutoResyncPerFile = 3;

  private snapshotSends = new Map<string, SnapshotSendState>();
  private snapshotRecv = new Map<string, SnapshotRecvState>(); // file|id -> recv
  private snapshotRecvBytes = 0;
  private lastSnapshotRequestAt = new Map<string, number>();
  private trackedFiles = new Set<string>();
  private untrackFileListeners = new Map<string, () => void>();
  private ignoreMatcher: IgnoreMatcher;

  private remoteManifest: { file: string; size: number; mtimeMs?: number }[] = [];
  private manifestRequestedAt = 0;
  private lastManifestSentAt = 0;

  private lastPresenceByPeerId = new Map<string, { file: string; line: number; character: number }>();
  private focusFollowPeerId: string | null = null;
  private focusFollowLastPosKey = '';
  private focusFollowTimer: ReturnType<typeof setTimeout> | null = null;
  private focusFollowInFlight = false;

  private persistDir: string | null = null;
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private driftSweepTimer: ReturnType<typeof setInterval> | null = null;
  private driftCheckTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private driftMismatchCount = new Map<string, number>();
  private lastAutoResyncAt = new Map<string, number>();
  private autoResyncCount = new Map<string, number>();
  private lastConflictHintAt = new Map<string, number>();
  private conflictHintInFlight = new Set<string>();
  private readOnlyHintAt = 0;
  private manifestSyncTimer: ReturnType<typeof setInterval> | null = null;
  private initialManifestReceived = false;
  private desyncEditHintAt = 0;

  private disposables: vscode.Disposable[] = [];

  constructor(
    private transport: Transport,
    private myName: string,
    private decorationManager: DecorationManager,
    private context: vscode.ExtensionContext,
    private sessionId: string,
    private sessionMode: 'host' | 'guest',
    private onPeerPresenceByFile?: (presenceByFile: Map<string, string[]>) => void
  ) {
    this.root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    this.maxFileSizeBytes = 512 * 1024;
    this.loadRuntimeConfig();
    this.ignoreMatcher = this.buildIgnoreMatcher();

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
        if (!this.myPeerId) return;
        if (vscode.window.activeTextEditor?.document.uri.toString() !== e.textEditor.document.uri.toString()) return;
        this.publishLocalPresence(e.textEditor, e.selections[0]);
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
      vscode.workspace.onDidCloseTextDocument((doc) => this.untrackDocumentIfClosed(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onTextChanged(e)),
      vscode.workspace.onDidCreateFiles(() => {
        if (this.sessionMode === 'host' && this.isHost) void this.sendManifest();
      }),
      vscode.workspace.onDidDeleteFiles(() => {
        if (this.sessionMode === 'host' && this.isHost) void this.sendManifest();
      }),
      vscode.workspace.onDidRenameFiles(() => {
        if (this.sessionMode === 'host' && this.isHost) void this.sendManifest();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('linesync.ignorePatterns')
          || e.affectsConfiguration('linesync.maxFileSizeKB')
          || e.affectsConfiguration('linesync.peerMode')
          || e.affectsConfiguration('linesync.remoteFilesMode')
          || e.affectsConfiguration('linesync.autoResyncOnDrift')
          || e.affectsConfiguration('linesync.driftCheckIntervalMs')
          || e.affectsConfiguration('linesync.autoResyncCooldownMs')
          || e.affectsConfiguration('linesync.maxAutoResyncPerFile')
        ) {
          this.ignoreMatcher = this.buildIgnoreMatcher();
          const prevInterval = this.driftCheckIntervalMs;
          this.loadRuntimeConfig();
          if (prevInterval !== this.driftCheckIntervalMs) this.startDriftSweep();
        }
      }),
    );

    for (const doc of vscode.workspace.textDocuments) this.trackDocument(doc);
    this.startDriftSweep();
    this.startManifestSync();
  }

  dispose() {
    for (const s of this.snapshotSends.values()) {
      if (s.retryTimer) clearInterval(s.retryTimer);
    }
    this.snapshotSends.clear();
    this.snapshotRecv.clear();
    this.snapshotRecvBytes = 0;
    if (this.driftSweepTimer) {
      clearInterval(this.driftSweepTimer);
      this.driftSweepTimer = null;
    }
    if (this.manifestSyncTimer) {
      clearInterval(this.manifestSyncTimer);
      this.manifestSyncTimer = null;
    }
    if (this.focusFollowTimer) {
      clearTimeout(this.focusFollowTimer);
      this.focusFollowTimer = null;
    }
    for (const timer of this.driftCheckTimers.values()) clearTimeout(timer);
    this.driftCheckTimers.clear();
    this.driftMismatchCount.clear();
    this.lastAutoResyncAt.clear();
    this.autoResyncCount.clear();
    this.lastConflictHintAt.clear();
    this.conflictHintInFlight.clear();
    for (const t of this.persistTimers.values()) clearTimeout(t);
    this.persistTimers.clear();
    for (const stop of this.untrackFileListeners.values()) stop();
    this.untrackFileListeners.clear();
    this.trackedFiles.clear();
    this.lastSnapshotRequestAt.clear();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  handleTransportEvent(e: TransportEvent) {
    if (e.type === 'session_info') {
      this.myPeerId = e.peerId;
      this.peers.clear();
      for (const p of e.peers) this.peers.set(String(p.peerId), String(p.peerName || ''));
      if (typeof e.isHost === 'boolean') {
        this.isHost = e.isHost;
        this.hostRoleFromRelay = true;
      } else {
        this.hostRoleFromRelay = false;
        this.recomputeHost();
      }
      if (!this.isHost) {
        // Guests should hydrate missing files from host state as soon as session metadata arrives.
        void this.requestManifest();
      }
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
      if (!this.hostRoleFromRelay) this.recomputeHost();
      if (this.isHost) {
        // send current state of opened docs
        for (const [file, entry] of this.store.entries()) {
          const update = Y.encodeStateAsUpdate(entry.doc);
          const updateB64 = Buffer.from(update).toString('base64');
          this.transport.send({ type: 'y_update', file, updateB64 } satisfies Payload);
        }
        void this.sendManifest();
      }
      return;
    }
    if (e.type === 'peer_left') {
      this.peers.delete(e.peerId);
      this.lastPresenceByPeerId.delete(e.peerId);
      this.decorationManager.clearPeer(e.peerId);
      this.emitPeerPresenceByFile();
      if (this.focusFollowPeerId === e.peerId) {
        this.stopFocusFollowMode(false);
        vscode.window.showInformationMessage('LineSync: Focus follow stopped (peer left).');
      }
      if (!this.hostRoleFromRelay) this.recomputeHost();
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
        const file = this.normalizeRelativePath(p.file);
        if (!file || this.isIgnored(file)) return;
        this.applyRemoteYUpdate(e.from, file, p.updateB64);
        return;
      }
      if (p.type === 'manifest_request') {
        if (this.isHost) this.sendManifest();
        return;
      }
      if (p.type === 'manifest') {
        this.remoteManifest = Array.isArray((p as any).files) ? (p as any).files : [];
        this.initialManifestReceived = true;
        this.reconcileWithRemoteManifest();
        return;
      }
      if (p.type === 'snapshot_request') {
        const file = this.normalizeRelativePath(p.file);
        if (!file || this.isIgnored(file)) return;
        if (this.hasLocalFileForSnapshot(file)) this.handleSnapshotRequest(file);
        return;
      }
      if (p.type === 'snapshot_chunk') {
        const file = this.normalizeRelativePath(p.file);
        if (!file || this.isIgnored(file)) return;
        this.handleSnapshotChunk({ ...p, file });
        return;
      }
      if (p.type === 'snapshot_ack') {
        const file = this.normalizeRelativePath(p.file);
        if (!file || this.isIgnored(file)) return;
        this.handleSnapshotAck({ ...p, file });
        return;
      }
    }
  }

  private recomputeHost() {
    if (this.hostRoleFromRelay) return;
    if (!this.myPeerId) return;
    const ids = [this.myPeerId, ...this.peers.keys()].sort();
    const hostId = ids[0] ?? '';
    this.isHost = hostId === this.myPeerId;
  }

  private trackDocument(doc: vscode.TextDocument) {
    const relRaw = toRel(this.root, doc.uri.fsPath);
    if (!relRaw) return;
    const rel = this.normalizeRelativePath(relRaw);
    if (!rel) return;
    if (this.isIgnored(rel)) return;

    // For binary or very large docs, use snapshot transfer instead of CRDT text.
    if (!isTextDoc(doc) || isBinaryPath(rel) || Buffer.byteLength(doc.getText(), 'utf8') > this.maxFileSizeBytes) {
      this.requestSnapshot(rel);
      return;
    }
    if (this.trackedFiles.has(rel)) return;

    const entry = this.store.getOrCreate(rel);

    // Apply persisted CRDT state first (if any).
    this.loadPersistedDoc(rel).catch(() => {});

    const localText = doc.getText();
    const remoteHasFile = this.remoteManifest.some((item) => this.normalizeRelativePath(item.file) === rel);
    const canSeedFromLocal = this.sessionMode === 'host'
      || (this.sessionMode === 'guest' && this.initialManifestReceived && !remoteHasFile);

    // Initialize doc content once.
    if (canSeedFromLocal && entry.text.length === 0 && localText.length > 0) {
      entry.doc.transact(() => {
        entry.text.insert(0, localText);
      }, 'init');
    }
    if (this.sessionMode === 'guest' && !this.initialManifestReceived) {
      this.requestSnapshot(rel);
    } else if (this.sessionMode === 'guest' && remoteHasFile && entry.text.length === 0) {
      this.requestSnapshot(rel);
    }

    // Broadcast and persist doc updates.
    const onDocUpdate = (update: Uint8Array, origin: any) => {
      const shouldBroadcast = origin !== 'remote'
        && origin !== 'persist'
        && !(this.sessionMode === 'guest' && !this.initialManifestReceived);
      if (shouldBroadcast) {
        const updateB64 = Buffer.from(update).toString('base64');
        this.transport.send({ type: 'y_update', file: rel, updateB64 } satisfies Payload);
      }
      this.schedulePersist(rel);
    };
    entry.doc.on('update', onDocUpdate);

    // Apply remote Y.Text deltas to editor without full replace.
    const onTextObserved = (evt: any) => {
      const tr = evt?.transaction;
      if (!tr || tr.origin !== 'remote') return;
      const delta = Array.isArray(evt.delta) ? evt.delta : null;
      if (!delta) return;
      this.applyRemoteDeltaToEditor(rel, delta).catch(() => {
        // Fallback: if delta apply fails, do a full replace to re-converge.
        this.applyDocToEditor(rel).catch(() => {});
      });
    };
    entry.text.observe(onTextObserved);

    this.trackedFiles.add(rel);
    this.untrackFileListeners.set(rel, () => {
      entry.doc.off('update', onDocUpdate);
      entry.text.unobserve(onTextObserved);
      this.clearDriftTracking(rel);
    });
    this.scheduleDriftCheck(rel, 300);
  }

  private untrackDocumentIfClosed(doc: vscode.TextDocument) {
    if (doc.uri.scheme !== 'file') return;
    const relRaw = toRel(this.root, doc.uri.fsPath);
    if (!relRaw) return;
    const rel = this.normalizeRelativePath(relRaw);
    if (!rel) return;

    // Keep listeners only while at least one editor keeps the doc open.
    const stillOpen = vscode.workspace.textDocuments.some(
      (d) => d !== doc && d.uri.scheme === 'file' && d.uri.fsPath === doc.uri.fsPath
    );
    if (stillOpen) return;

    const stop = this.untrackFileListeners.get(rel);
    if (stop) stop();
    this.untrackFileListeners.delete(rel);
    this.trackedFiles.delete(rel);
    this.clearDriftTracking(rel);
  }

  private publishLocalPresence(editor: vscode.TextEditor, selection?: vscode.Selection) {
    if (!this.myPeerId) return;
    const rel = toRel(this.root, editor.document.uri.fsPath);
    if (!rel) return;
    const sel = selection ?? editor.selection;
    const active = sel?.active ?? new vscode.Position(0, 0);
    const anchor = sel?.anchor ?? active;
    const payloadSelection = sel && !sel.isEmpty
      ? {
          anchor: { line: anchor.line, character: anchor.character },
          active: { line: active.line, character: active.character },
        }
      : null;
    this.docPresence.setLocal(this.myName, this.myPeerId, {
      file: rel,
      line: active.line,
      character: active.character,
      selection: payloadSelection,
    });
  }

  private onTextChanged(e: vscode.TextDocumentChangeEvent) {
    const doc = e.document;
    if (!isTextDoc(doc)) return;
    const relRaw = toRel(this.root, doc.uri.fsPath);
    if (!relRaw) return;
    const rel = this.normalizeRelativePath(relRaw);
    if (!rel) return;
    if (this.isIgnored(rel)) return;
    if (this.applyingRemote.has(rel)) return;
    if (this.suppressEditorToDoc.has(rel)) return;
    if (this.isPeerReadOnly()) {
      this.rejectPeerEdit(rel);
      const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === doc.uri.toString());
      if (editor) this.publishLocalPresence(editor);
      return;
    }

    if (this.sessionMode === 'guest' && !this.initialManifestReceived) {
      // Prevent early local writes before baseline sync is established.
      this.requestManifest();
      this.requestSnapshot(rel);
      this.showDesyncEditHint(rel, 'LineSync: Waiting for baseline sync. Edit was paused to prevent line drift.').catch(() => {});
      const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === doc.uri.toString());
      if (editor) this.publishLocalPresence(editor);
      return;
    }

    const entry = this.store.getOrCreate(rel);

    // Validate that local editor ranges still match CRDT offsets before applying.
    const changes = [...e.contentChanges].sort((a, b) => b.rangeOffset - a.rangeOffset);
    let expectedLength = entry.text.length;
    let hasInvalidRange = false;
    for (const c of changes) {
      const start = c.rangeOffset;
      const end = c.rangeOffset + c.rangeLength;
      if (start < 0 || c.rangeLength < 0 || start > expectedLength || end > expectedLength) {
        hasInvalidRange = true;
        break;
      }
      expectedLength = expectedLength - c.rangeLength + c.text.length;
    }
    if (hasInvalidRange) {
      const actualAfter = doc.getText();
      // We detected offset drift: do not apply unsafe delta ops.
      if (this.sessionMode === 'host') {
        this.replaceDocWithText(entry, actualAfter);
      } else {
        this.requestSnapshot(rel);
        this.showDesyncEditHint(rel, `LineSync: Detected line drift in ${rel}. Requested safe resync.`).catch(() => {});
      }
      this.scheduleDriftCheck(rel, 80);
      const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === doc.uri.toString());
      if (editor) this.publishLocalPresence(editor);
      return;
    }

    // Apply delta edits from VS Code to Y.Text.
    // Process from end -> start to keep offsets stable.
    entry.doc.transact(() => {
      for (const c of changes) {
        const delLen = c.rangeLength;
        if (delLen > 0) entry.text.delete(c.rangeOffset, delLen);
        if (c.text) entry.text.insert(c.rangeOffset, c.text);
      }
    }, 'local');
    const editor = vscode.window.visibleTextEditors.find((ed) => ed.document.uri.toString() === doc.uri.toString());
    if (editor) this.publishLocalPresence(editor);
    this.scheduleDriftCheck(rel, 220);
  }

  private replaceDocWithText(entry: { doc: Y.Doc; text: Y.Text }, content: string) {
    entry.doc.transact(() => {
      if (entry.text.length > 0) entry.text.delete(0, entry.text.length);
      if (content) entry.text.insert(0, content);
    }, 'local');
  }

  private async showDesyncEditHint(file: string, message: string) {
    const now = Date.now();
    if (now - this.desyncEditHintAt < 6000) return;
    this.desyncEditHintAt = now;
    const action = await vscode.window.showWarningMessage(message, 'Resync now');
    if (action === 'Resync now') this.requestSnapshot(file);
  }

  private isPeerReadOnly(): boolean {
    return this.sessionMode === 'guest' && this.peerMode === 'readOnly';
  }

  private rejectPeerEdit(file: string) {
    if (this.store.has(file)) {
      this.applyDocToEditor(file).catch(() => {});
    } else {
      this.requestSnapshot(file);
    }
    this.scheduleDriftCheck(file, 180);
    this.showReadOnlyPeerHint(file).catch(() => {});
  }

  private async showReadOnlyPeerHint(file: string) {
    const now = Date.now();
    if (now - this.readOnlyHintAt < 7000) return;
    this.readOnlyHintAt = now;
    const action = await vscode.window.showWarningMessage(
      `LineSync: Peer mode is read-only. Local edits in ${file} were blocked.`,
      'Open Settings'
    );
    if (action === 'Open Settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'linesync.peerMode');
    }
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
    this.materializeRemoteDocToWorkspace(file);
    this.scheduleDriftCheck(file, 180);
    // Optional: highlight changed lines later (presence-ui todo)
  }

  private materializeRemoteDocToWorkspace(file: string) {
    const safe = this.safeWorkspacePath(file);
    if (!safe) return;

    // If file is currently open in editor, doc<->editor sync already handles it.
    const isOpen = vscode.workspace.textDocuments.some(
      (d) => d.uri.scheme === 'file' && d.uri.fsPath === safe.abs
    );
    if (isOpen) return;

    const entry = this.store.getOrCreate(file);
    const content = entry.text.toString();
    try {
      fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
      fs.writeFileSync(safe.abs, content, 'utf8');
    } catch {
      // ignore
    }
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
      this.scheduleDriftCheck(file, 250);
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
      const entry = this.store.getOrCreate(file);
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

      // Safety net: if editor text still diverges from Yjs doc (e.g. due to earlier drift),
      // fall back to a full replace to re-converge.
      const current = doc.getText();
      const expected = entry.text.toString();
      if (current !== expected) {
        await this.applyDocToEditor(file);
      }
      this.scheduleDriftCheck(file, 250);
    } finally {
      setTimeout(() => {
        this.suppressDocToEditor.delete(file);
        this.suppressEditorToDoc.delete(file);
      }, 50);
    }
  }

  private renderRemotePresence() {
    // Map awareness states to DecorationManager cursors/selections
    const nextPresenceByPeerId = new Map<string, { file: string; line: number; character: number }>();
    for (const [clientId, state] of this.docPresence.awareness.getStates()) {
      const s: any = state;
      const peerId = typeof s?.peerId === 'string' && s.peerId ? s.peerId : String(clientId);
      if (peerId === this.myPeerId) continue;
      const nameFromRelay = this.peers.get(peerId) ?? '';
      const name = nameFromRelay || String(s?.name || '');
      const fileRaw = typeof s?.file === 'string' ? s.file : null;
      const file = fileRaw ? this.normalizeRelativePath(fileRaw) : null;
      const line = typeof s?.line === 'number' && Number.isFinite(s.line) ? Math.max(0, Math.floor(s.line)) : null;
      const character = typeof s?.character === 'number' && Number.isFinite(s.character) ? Math.max(0, Math.floor(s.character)) : 0;
      const selection = s?.selection ?? null;
      if (!file || line === null) continue;
      if (this.isIgnored(file)) continue;
      nextPresenceByPeerId.set(peerId, { file, line, character });
      this.decorationManager.updateCursor(peerId, file, line, character, selection, name || 'Peer');
    }
    for (const peerId of this.lastPresenceByPeerId.keys()) {
      if (!nextPresenceByPeerId.has(peerId)) this.decorationManager.clearPeer(peerId);
    }
    this.lastPresenceByPeerId = nextPresenceByPeerId;
    this.emitPeerPresenceByFile();
    this.scheduleFocusFollowUpdate();
  }

  private emitPeerPresenceByFile() {
    if (!this.onPeerPresenceByFile) return;
    const byFile = new Map<string, string[]>();
    for (const [peerId, pos] of this.lastPresenceByPeerId) {
      const arr = byFile.get(pos.file) ?? [];
      arr.push(peerId);
      byFile.set(pos.file, arr);
    }
    this.onPeerPresenceByFile(byFile);
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
      vscode.window.showInformationMessage('LineSync: Waiting for peer file list...');
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
    const rel = this.normalizeRelativePath(pick.f.file);
    if (!rel || this.isIgnored(rel)) {
      vscode.window.showWarningMessage('LineSync: That file is ignored by your settings.');
      return;
    }
    const safe = this.safeWorkspacePath(rel);
    if (!safe) return;
    const uri = vscode.Uri.file(safe.abs);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    if (isBinaryPath(rel) || (pick.f.size ?? 0) > this.maxFileSizeBytes) {
      this.requestSnapshot(rel);
    }
  }

  async followPeer(): Promise<void> {
    const peerId = await this.pickPeerForFollow('LineSync: Follow peer');
    if (!peerId) return;
    await this.revealPeerPosition(peerId, false);
  }

  isFocusFollowModeActive(): boolean {
    return !!this.focusFollowPeerId;
  }

  async startFocusFollowMode(): Promise<boolean> {
    const peerId = await this.pickPeerForFollow('LineSync: Focus follow peer');
    if (!peerId) return false;
    this.focusFollowPeerId = peerId;
    this.focusFollowLastPosKey = '';
    await this.revealPeerPosition(peerId, true);
    const peerName = this.peers.get(peerId) || `Peer-${peerId.slice(0, 4)}`;
    vscode.window.showInformationMessage(`LineSync: Focus follow enabled for ${peerName}.`);
    return true;
  }

  stopFocusFollowMode(showMessage = true) {
    this.focusFollowPeerId = null;
    this.focusFollowLastPosKey = '';
    if (this.focusFollowTimer) {
      clearTimeout(this.focusFollowTimer);
      this.focusFollowTimer = null;
    }
    if (showMessage) vscode.window.showInformationMessage('LineSync: Focus follow disabled.');
  }

  async resyncFile(uri: vscode.Uri): Promise<{ ok: boolean; file?: string; reason?: string }> {
    if (uri.scheme !== 'file') return { ok: false, reason: 'Only local files can be resynced.' };
    const relRaw = toRel(this.root, uri.fsPath);
    if (!relRaw) return { ok: false, reason: 'File is outside the current workspace.' };
    const rel = this.normalizeRelativePath(relRaw);
    if (!rel) return { ok: false, reason: 'Invalid file path.' };
    if (this.isIgnored(rel)) return { ok: false, reason: 'File is ignored by linesync.ignorePatterns.' };
    this.requestSnapshot(rel);
    return { ok: true, file: rel };
  }

  private async sendManifest() {
    if (!this.isHost) return;
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
        const relRaw = toRel(this.root, u.fsPath);
        const rel = relRaw ? this.normalizeRelativePath(relRaw) : null;
        if (!rel) continue;
        if (this.isIgnored(rel)) continue;
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

  private reconcileWithRemoteManifest() {
    if (this.remoteFilesMode !== 'autoMirrorMissing') return;
    for (const item of this.remoteManifest) {
      const rel = this.normalizeRelativePath(item.file);
      if (!rel || this.isIgnored(rel)) continue;
      const safe = this.safeWorkspacePath(rel);
      if (!safe) continue;

      let localMissing = false;
      let localSize = -1;
      try {
        const stat = fs.statSync(safe.abs);
        if (!stat.isFile()) localMissing = true;
        else localSize = stat.size;
      } catch {
        localMissing = true;
      }

      const remoteSize = Number(item.size ?? -1);
      const sizeDiffers = !localMissing && remoteSize >= 0 && localSize >= 0 && localSize !== remoteSize;
      if (localMissing || sizeDiffers) this.requestSnapshot(rel);
    }
  }

  private hasLocalFileForSnapshot(file: string): boolean {
    if (this.store.has(file)) return true;
    const safe = this.safeWorkspacePath(file);
    if (!safe) return false;
    try {
      return fs.statSync(safe.abs).isFile();
    } catch {
      return false;
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
    const rel = this.normalizeRelativePath(file);
    if (!rel) return;
    if (this.isIgnored(rel)) return;
    const now = Date.now();
    const last = this.lastSnapshotRequestAt.get(rel) ?? 0;
    if (now - last < 1200) return;
    this.lastSnapshotRequestAt.set(rel, now);
    this.transport.send({ type: 'snapshot_request', file: rel } satisfies Payload);
  }

  private handleSnapshotRequest(file: string) {
    const safe = this.safeWorkspacePath(file);
    if (!safe) return;
    let data: Buffer;
    const hasCrdtState = this.store.has(file);
    if (hasCrdtState && !isBinaryPath(file)) {
      const entry = this.store.getOrCreate(file);
      data = Buffer.from(entry.text.toString(), 'utf8');
    } else {
      try {
        data = fs.readFileSync(safe.abs);
      } catch {
        return;
      }
    }
    if (data.length > this.snapshotTransferCapBytes()) return;

    const id = crypto.randomUUID();
    const total = Math.max(1, Math.ceil(data.length / SNAPSHOT_CHUNK_BYTES));
    const state: SnapshotSendState = {
      file: safe.rel,
      id,
      data,
      total,
      totalBytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      nextChunk: 0,
      acked: new Set<number>(),
      inFlight: new Map<number, { sentAt: number; tries: number }>(),
      retryTimer: null,
    };
    const key = this.snapshotSendKey(state.file, state.id);
    this.snapshotSends.set(key, state);
    state.retryTimer = setInterval(() => this.retrySnapshotTransfer(key), 400);
    this.pumpSnapshotTransfer(key);
  }

  private snapshotTransferCapBytes(): number {
    return Math.max(this.maxFileSizeBytes, 8 * 1024 * 1024);
  }

  private snapshotSendKey(file: string, id: string): string {
    return `${file}|${id}`;
  }

  private snapshotRecvKey(file: string, id: string): string {
    return `${file}|${id}`;
  }

  private finalizeSnapshotSend(key: string) {
    const state = this.snapshotSends.get(key);
    if (!state) return;
    if (state.retryTimer) clearInterval(state.retryTimer);
    this.snapshotSends.delete(key);
  }

  private pumpSnapshotTransfer(key: string) {
    const state = this.snapshotSends.get(key);
    if (!state) return;
    while (state.inFlight.size < SNAPSHOT_SEND_WINDOW && state.nextChunk < state.total) {
      this.sendSnapshotChunk(state, state.nextChunk, false);
      state.nextChunk++;
    }
    if (state.acked.size >= state.total) {
      this.finalizeSnapshotSend(key);
    }
  }

  private sendSnapshotChunk(state: SnapshotSendState, chunk: number, isRetry: boolean) {
    const start = chunk * SNAPSHOT_CHUNK_BYTES;
    const end = Math.min(state.totalBytes, start + SNAPSHOT_CHUNK_BYTES);
    const payload = {
      type: 'snapshot_chunk',
      file: state.file,
      id: state.id,
      chunk,
      total: state.total,
      totalBytes: state.totalBytes,
      sha256: state.sha256,
      dataB64: state.data.subarray(start, end).toString('base64'),
    };
    const existing = state.inFlight.get(chunk);
    const tries = existing ? existing.tries + 1 : 1;
    if (tries > SNAPSHOT_MAX_RETRIES) return;
    state.inFlight.set(chunk, { sentAt: Date.now(), tries });
    try {
      this.transport.send(payload as Payload);
    } catch {
      if (!isRetry) return;
    }
  }

  private retrySnapshotTransfer(key: string) {
    const state = this.snapshotSends.get(key);
    if (!state) return;
    if (state.acked.size >= state.total) {
      this.finalizeSnapshotSend(key);
      return;
    }
    const now = Date.now();
    for (const [chunk, inflight] of state.inFlight) {
      if (state.acked.has(chunk)) {
        state.inFlight.delete(chunk);
        continue;
      }
      if (now - inflight.sentAt < SNAPSHOT_RETRY_MS) continue;
      if (inflight.tries >= SNAPSHOT_MAX_RETRIES) {
        this.finalizeSnapshotSend(key);
        return;
      }
      this.sendSnapshotChunk(state, chunk, true);
    }
    this.pumpSnapshotTransfer(key);
  }

  private handleSnapshotAck(p: { file: string; id: string; chunk: number }) {
    const key = this.snapshotSendKey(p.file, p.id);
    const state = this.snapshotSends.get(key);
    if (!state) return;
    if (!Number.isInteger(p.chunk) || p.chunk < 0 || p.chunk >= state.total) return;
    state.acked.add(p.chunk);
    state.inFlight.delete(p.chunk);
    if (state.acked.size >= state.total) {
      this.finalizeSnapshotSend(key);
      return;
    }
    this.pumpSnapshotTransfer(key);
  }

  private clearSnapshotRecv(key: string) {
    const recv = this.snapshotRecv.get(key);
    if (!recv) return;
    this.snapshotRecv.delete(key);
    this.snapshotRecvBytes = Math.max(0, this.snapshotRecvBytes - recv.totalBytes);
  }

  private gcSnapshotRecv() {
    const now = Date.now();
    for (const [key, recv] of this.snapshotRecv) {
      if (now - recv.lastAt > SNAPSHOT_RECV_TTL_MS) {
        this.clearSnapshotRecv(key);
      }
    }
  }

  private handleSnapshotChunk(p: { file: string; id: string; chunk: number; total: number; totalBytes: number; sha256: string; dataB64: string }) {
    if (!Number.isInteger(p.chunk) || !Number.isInteger(p.total) || !Number.isInteger(p.totalBytes)) return;
    if (p.total < 1 || p.total > 1024) return;
    if (p.chunk < 0 || p.chunk >= p.total) return;
    if (p.totalBytes < 0 || p.totalBytes > this.snapshotTransferCapBytes()) return;
    if (!/^[a-f0-9]{64}$/.test(String(p.sha256 || ''))) return;
    if (p.dataB64.length > 220_000) return;

    const expectedTotal = Math.max(1, Math.ceil(p.totalBytes / SNAPSHOT_CHUNK_BYTES));
    if (expectedTotal !== p.total) return;
    const expectedChunkSize = p.chunk === p.total - 1
      ? p.totalBytes - SNAPSHOT_CHUNK_BYTES * (p.total - 1)
      : SNAPSHOT_CHUNK_BYTES;
    if (expectedChunkSize < 0 || expectedChunkSize > SNAPSHOT_CHUNK_BYTES) return;

    let chunkData: Buffer;
    try {
      chunkData = Buffer.from(p.dataB64, 'base64');
    } catch {
      return;
    }
    if (chunkData.length !== expectedChunkSize) return;

    const recvKey = this.snapshotRecvKey(p.file, p.id);
    this.gcSnapshotRecv();

    let recv = this.snapshotRecv.get(recvKey);
    if (!recv) {
      if (this.snapshotRecvBytes + p.totalBytes > SNAPSHOT_MAX_ACTIVE_RECV_BYTES) return;
      recv = {
        file: p.file,
        id: p.id,
        total: p.total,
        totalBytes: p.totalBytes,
        sha256: p.sha256,
        received: new Map<number, Buffer>(),
        receivedBytes: 0,
        lastAt: Date.now(),
      };
      this.snapshotRecv.set(recvKey, recv);
      this.snapshotRecvBytes += p.totalBytes;
    }

    if (recv.total !== p.total || recv.totalBytes !== p.totalBytes || recv.sha256 !== p.sha256) {
      this.clearSnapshotRecv(recvKey);
      return;
    }
    recv.lastAt = Date.now();

    if (!recv.received.has(p.chunk)) {
      recv.received.set(p.chunk, chunkData);
      recv.receivedBytes += chunkData.length;
    }

    // Ack after accepted chunk so sender can continue windowed transfer.
    this.transport.send({ type: 'snapshot_ack', file: p.file, id: p.id, chunk: p.chunk } satisfies Payload);

    if (recv.received.size < recv.total) return;
    if (recv.receivedBytes !== recv.totalBytes) {
      this.clearSnapshotRecv(recvKey);
      return;
    }

    const parts: Buffer[] = [];
    for (let i = 0; i < recv.total; i++) {
      const part = recv.received.get(i);
      if (!part) {
        this.clearSnapshotRecv(recvKey);
        return;
      }
      parts.push(part);
    }

    const data = Buffer.concat(parts, recv.totalBytes);
    this.clearSnapshotRecv(recvKey);

    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== p.sha256) return;

    const safe = this.safeWorkspacePath(p.file);
    if (!safe) return;
    try {
      fs.mkdirSync(path.dirname(safe.abs), { recursive: true });
      fs.writeFileSync(safe.abs, data);
    } catch {
      return;
    }
    this.scheduleDriftCheck(p.file, 250);
    vscode.window.showInformationMessage(`LineSync: Received snapshot for ${p.file}`);
  }

  private loadRuntimeConfig() {
    const cfg = vscode.workspace.getConfiguration('linesync');
    this.maxFileSizeBytes = this.clampInt((cfg.get<number>('maxFileSizeKB') ?? 512) * 1024, 64 * 1024, 16 * 1024 * 1024);
    const peerMode = cfg.get<string>('peerMode')
      ?? cfg.get<string>('guestMode', 'edit');
    this.peerMode = peerMode === 'readOnly' ? 'readOnly' : 'edit';
    const remoteFilesMode = cfg.get<string>('remoteFilesMode', 'previewOnly');
    this.remoteFilesMode = remoteFilesMode === 'autoMirrorMissing' ? 'autoMirrorMissing' : 'previewOnly';
    this.autoResyncOnDrift = cfg.get<boolean>('autoResyncOnDrift', true) ?? true;
    this.driftCheckIntervalMs = this.clampInt(cfg.get<number>('driftCheckIntervalMs', 2500) ?? 2500, 1000, 20_000);
    this.autoResyncCooldownMs = this.clampInt(cfg.get<number>('autoResyncCooldownMs', 15000) ?? 15000, 2000, 120_000);
    this.maxAutoResyncPerFile = this.clampInt(cfg.get<number>('maxAutoResyncPerFile', 3) ?? 3, 1, 20);
  }

  private startDriftSweep() {
    if (this.driftSweepTimer) clearInterval(this.driftSweepTimer);
    this.driftSweepTimer = setInterval(() => this.runDriftSweep(), this.driftCheckIntervalMs);
  }

  private startManifestSync() {
    if (this.manifestSyncTimer) clearInterval(this.manifestSyncTimer);
    if (this.sessionMode !== 'guest') return;
    this.manifestSyncTimer = setInterval(() => {
      if (!this.initialManifestReceived || Date.now() - this.manifestRequestedAt > 15_000) {
        void this.requestManifest();
      }
    }, 30_000);
  }

  private async pickPeerForFollow(placeHolder: string): Promise<string | null> {
    const peers = [...this.lastPresenceByPeerId.entries()].map(([peerId, pos]) => ({
      peerId,
      name: this.peers.get(peerId) || `Peer-${peerId.slice(0, 4)}`,
      pos,
    }));
    if (peers.length === 0) {
      vscode.window.showInformationMessage('LineSync: No peer positions yet.');
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      peers.map((p) => ({ label: p.name, description: `${p.pos.file}:${p.pos.line + 1}:${p.pos.character + 1}`, p })),
      { placeHolder }
    );
    if (!pick) return null;
    return pick.p.peerId;
  }

  private async revealPeerPosition(peerId: string, preview: boolean): Promise<boolean> {
    const target = this.lastPresenceByPeerId.get(peerId);
    if (!target) return false;
    const safe = this.safeWorkspacePath(target.file);
    if (!safe) {
      vscode.window.showWarningMessage('LineSync: Peer path is outside your workspace.');
      return false;
    }
    const uri = vscode.Uri.file(safe.abs);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview, preserveFocus: false });
    const line = Math.max(0, Math.min(target.line, Math.max(0, doc.lineCount - 1)));
    const lineLen = doc.lineAt(line).text.length;
    const ch = Math.max(0, Math.min(target.character, lineLen));
    const pos = new vscode.Position(line, ch);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  }

  private scheduleFocusFollowUpdate() {
    if (!this.focusFollowPeerId) return;
    if (this.focusFollowTimer) return;
    this.focusFollowTimer = setTimeout(() => {
      this.focusFollowTimer = null;
      this.runFocusFollowUpdate().catch(() => {});
    }, 80);
  }

  private async runFocusFollowUpdate() {
    const peerId = this.focusFollowPeerId;
    if (!peerId || this.focusFollowInFlight) return;
    const pos = this.lastPresenceByPeerId.get(peerId);
    if (!pos) {
      this.stopFocusFollowMode(false);
      return;
    }
    const posKey = `${pos.file}:${pos.line}:${pos.character}`;
    if (posKey === this.focusFollowLastPosKey) return;
    this.focusFollowInFlight = true;
    try {
      const moved = await this.revealPeerPosition(peerId, true);
      if (moved) this.focusFollowLastPosKey = posKey;
    } finally {
      this.focusFollowInFlight = false;
    }
  }

  private runDriftSweep() {
    for (const file of this.trackedFiles) {
      this.scheduleDriftCheck(file, 120);
    }
  }

  private scheduleDriftCheck(file: string, delayMs: number) {
    const prev = this.driftCheckTimers.get(file);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.driftCheckTimers.delete(file);
      this.checkFileDrift(file).catch(() => {});
    }, Math.max(0, delayMs));
    this.driftCheckTimers.set(file, timer);
  }

  private clearDriftTracking(file: string) {
    const timer = this.driftCheckTimers.get(file);
    if (timer) clearTimeout(timer);
    this.driftCheckTimers.delete(file);
    this.driftMismatchCount.delete(file);
    this.lastAutoResyncAt.delete(file);
    this.autoResyncCount.delete(file);
    this.lastConflictHintAt.delete(file);
    this.conflictHintInFlight.delete(file);
  }

  private async checkFileDrift(file: string) {
    if (!this.store.has(file)) return;
    const fsPath = path.join(this.root, file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
    if (!doc) return;

    const entry = this.store.getOrCreate(file);
    const expected = entry.text.toString();
    const actual = doc.getText();

    if (expected === actual) {
      this.driftMismatchCount.set(file, 0);
      this.autoResyncCount.set(file, 0);
      return;
    }

    const mismatchCount = (this.driftMismatchCount.get(file) ?? 0) + 1;
    this.driftMismatchCount.set(file, mismatchCount);
    if (mismatchCount < 2) return;

    if (this.isHost) {
      if (!doc.isDirty) {
        await this.applyDocToEditor(file);
      }
      await this.showConflictHint(file, doc, false);
      return;
    }

    const now = Date.now();
    const autoCount = this.autoResyncCount.get(file) ?? 0;
    const lastAuto = this.lastAutoResyncAt.get(file) ?? 0;
    const canAuto = this.autoResyncOnDrift
      && !doc.isDirty
      && autoCount < this.maxAutoResyncPerFile
      && now - lastAuto >= this.autoResyncCooldownMs;

    if (canAuto) {
      this.lastAutoResyncAt.set(file, now);
      this.autoResyncCount.set(file, autoCount + 1);
      this.requestSnapshot(file);
    }

    await this.showConflictHint(file, doc, canAuto);
  }

  private async showConflictHint(file: string, doc: vscode.TextDocument, autoResyncTriggered: boolean) {
    const now = Date.now();
    const lastHint = this.lastConflictHintAt.get(file) ?? 0;
    if (now - lastHint < 15_000) return;
    if (this.conflictHintInFlight.has(file)) return;

    this.lastConflictHintAt.set(file, now);
    this.conflictHintInFlight.add(file);
    try {
      const message = doc.isDirty
        ? `LineSync: Potential conflict in ${file}. Unsaved local edits detected.`
        : autoResyncTriggered
          ? `LineSync: Drift detected in ${file}. Auto-resync requested.`
          : `LineSync: Drift detected in ${file}.`;
      const action = await vscode.window.showWarningMessage(message, 'Resync now', 'Keep local');
      if (action === 'Resync now') {
        this.requestSnapshot(file);
      }
    } finally {
      this.conflictHintInFlight.delete(file);
    }
  }

  private clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private buildIgnoreMatcher(): IgnoreMatcher {
    const cfg = vscode.workspace.getConfiguration('linesync');
    const patterns = (cfg.get<string[]>('ignorePatterns') ?? []).filter(Boolean);
    return new IgnoreMatcher(patterns);
  }

  private isIgnored(relPath: string): boolean {
    return this.ignoreMatcher.isIgnored(relPath);
  }

  private normalizeRelativePath(input: string): string | null {
    const raw = String(input || '').replace(/\\/g, '/').trim();
    if (!raw) return null;
    if (raw.includes('\0')) return null;
    if (/^[a-zA-Z]:/.test(raw)) return null;
    if (raw.startsWith('/')) return null;

    const normalized = path.posix.normalize(raw).replace(/^(\.\/)+/, '');
    if (!normalized || normalized === '.') return null;
    if (normalized.startsWith('../')) return null;
    if (normalized.includes('/../')) return null;
    return normalized;
  }

  private safeWorkspacePath(relPath: string): { rel: string; abs: string } | null {
    const rel = this.normalizeRelativePath(relPath);
    if (!rel) return null;
    const abs = path.resolve(this.root, rel);
    const back = path.relative(path.resolve(this.root), abs);
    if (back.startsWith('..') || path.isAbsolute(back)) return null;
    return { rel, abs };
  }
}
