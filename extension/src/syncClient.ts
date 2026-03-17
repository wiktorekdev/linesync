import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { TextDecoder, TextEncoder } from 'util';
import WebSocket from 'ws';
import { FileWatcher, CursorSelection } from './fileWatcher';
import { DecorationManager } from './decorationManager';
import { SyncJournal } from './syncJournal';
import { BackupManager } from './backupManager';
import { BulkReviewPanel, DeleteRequest, ConflictRequest, ReviewItem } from './bulkReviewPanel';
import {
  createPatch, applyPatch, getChangedLines,
  patchesOverlap, encodeChunks, decodeChunks,
} from './patchEngine';
import * as Diff3 from 'node-diff3';
import { IgnoreMatcher } from './ignoreMatcher';

interface PeerInfo { peerId: string; name: string; }
interface ChunkBuffer {
  total: number;
  received: Map<number, string>;
  version: number | null;
  hash: string | null;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null;
}

function getString(o: JsonObject, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' ? v : null;
}

function getNumber(o: JsonObject, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function getType(o: JsonObject): string | null {
  return getString(o, 'type');
}

const ENCRYPTED_TYPES = new Set([
  'patch',
  'cursor',
  'file_state_chunk',
  'file_state_done',
  'file_deleted',
  'request_sync',
  'conflict_resolve',
]);

export interface SyncStats {
  patchesSent: number;
  patchesReceived: number;
  conflictsResolved: number;
  requestSyncSent: number;
  requestSyncReceived: number;
  syncsServed: number;
  connectedAt: Date;
  latencyMs: number | null;
}

export class SyncClient {
  private ws: WebSocket | null = null;
  private watcher: FileWatcher | null = null;
  private journal: SyncJournal;
  private backup: BackupManager;

  private shadows      = new Map<string, string>();
  private fileVersions = new Map<string, number>();
  private peers        = new Map<string, PeerInfo>();
  private chunkBuffers = new Map<string, ChunkBuffer>();
  private hostPeerId: string | null = null;
  private isHost = false;

  // ── Bulk review queue ──────────────────────────────────────────────────────
  /** Items queued while review panel is busy */
  private reviewQueue: ReviewItem[] = [];
  /** Debounce: collect items for up to 300ms before opening panel */
  private reviewDebounce: ReturnType<typeof setTimeout> | null = null;
  private reviewOpen = false;

  private statusBar: vscode.StatusBarItem;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private disposed = false;
  private isReconnecting = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingPending: number | null = null;
  private missedHeartbeats = 0;
  private warnedSkips = new Set<string>();
  private cryptoKeyPromise: Promise<unknown> | null;
  private warnedEncryptionOff = false;
  private paused = false;
  private clientToken: string;
  private relayPasswordHash: string | null = null;

  public myPeerId = '';
  public stats: SyncStats = {
    patchesSent: 0, patchesReceived: 0,
    conflictsResolved: 0, connectedAt: new Date(), latencyMs: null,
    requestSyncSent: 0, requestSyncReceived: 0, syncsServed: 0,
  };

  private workspaceRoot: string;
  private ignoreMatcher: IgnoreMatcher;
  private highlightDuration: number;
  private relaySecret: string;
  private maxFileSizeBytes: number;
  private mergePolicy: 'prompt' | 'preferMine' | 'preferTheirs' | 'preferHost';

  constructor(
    private relayUrl: string,
    private sessionId: string,
    private myName: string,
    private sessionPassword: string,
    private decorationManager: DecorationManager,
    private context: vscode.ExtensionContext
  ) {
    const cfg = vscode.workspace.getConfiguration('linesync');
    const rawPatterns: string[] = cfg.get('ignorePatterns') ?? [];
    this.ignoreMatcher = new IgnoreMatcher(rawPatterns);
    this.highlightDuration = cfg.get<number>('highlightDuration') ?? 5000;
    this.relaySecret       = cfg.get<string>('relaySecret')       ?? '';
    this.maxFileSizeBytes  = (cfg.get<number>('maxFileSizeKB') ?? 512) * 1024;
    const rawPolicy = cfg.get<string>('mergePolicy') ?? 'prompt';
    this.mergePolicy = ['prompt', 'preferMine', 'preferTheirs', 'preferHost'].includes(rawPolicy)
      ? (rawPolicy as any)
      : 'prompt';
    this.workspaceRoot     = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.journal = new SyncJournal(this.workspaceRoot, sessionId);
    this.backup  = new BackupManager(this.workspaceRoot);

    this.clientToken = this.context.globalState.get<string>('linesync.clientToken') ?? '';
    if (!this.clientToken) {
      this.clientToken = crypto.randomUUID();
      this.context.globalState.update('linesync.clientToken', this.clientToken);
    }

    this.cryptoKeyPromise = this.sessionPassword
      ? deriveSessionKey(this.sessionPassword, this.sessionId)
      : null;

    this.relayPasswordHash = this.sessionPassword
      ? deriveRelayPasswordHash(this.sessionPassword, this.sessionId)
      : null;

    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = 'linesync.showMenu';
    context.subscriptions.push(this.statusBar);
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.setStatusBar('connecting');
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.relayUrl, {
          perMessageDeflate: { zlibDeflateOptions: { level: 6 }, threshold: 512 },
        });
      } catch (e: any) { reject(new Error(`Invalid relay URL: ${e.message}`)); return; }

      const timeout = setTimeout(() => {
        this.ws?.terminate();
        reject(new Error('Connection timed out (10s)'));
      }, 10_000);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.missedHeartbeats = 0;
        this.send({
          type: 'join',
          session: this.sessionId,
          peerName: this.myName,
          secret: this.relaySecret,
          password: this.relayPasswordHash || undefined,
          clientToken: this.clientToken,
        });
        this.startPing();
      });

      this.ws.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleMessage(msg).catch((e) => console.error('[LineSync] handleMessage', e));
          if (msg.type === 'session_info') { clearTimeout(timeout); resolve(); }
        } catch (e) { console.error('[LineSync] parse error', e); }
      });

      this.ws.on('error', (err: Error) => { clearTimeout(timeout); this.setStatusBar('error'); reject(err); });

      this.ws.on('close', (code: number) => {
        clearTimeout(timeout); this.stopPing(); this.journal.flush();
        if (code === 4001) { vscode.window.showErrorMessage('LineSync: Wrong relay secret'); this.disposed = true; return; }
        if (code === 4002) { vscode.window.showErrorMessage('LineSync: Session full (max 10)'); this.disposed = true; return; }
        if (code === 4003) { vscode.window.showErrorMessage('LineSync: Wrong session password'); this.disposed = true; return; }
        this.setStatusBar('disconnected');
        if (!this.disposed) this.scheduleReconnect();
      });
    });
  }

  disconnect() {
    this.disposed = true; this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.journal.flush();
    this.watcher?.dispose();
    this.ws?.close(1000, 'User disconnected');
    this.ws = null; this.statusBar.hide();
    this.shadows.clear(); this.fileVersions.clear(); this.peers.clear(); this.chunkBuffers.clear();
    this.hostPeerId = null; this.isHost = false;
    vscode.commands.executeCommand('setContext', 'linesync.active', false);
  }

  // ── Outgoing ───────────────────────────────────────────────────────────────

  sendPatch(relativePath: string, shadow: string, current: string) {
    if (this.paused) return;
    if (!this.wsReady()) return;
    const patches = createPatch(shadow, current);
    if (!patches) return;
    const baseVersion = this.getFileVersion(relativePath);
    const baseHash = hashContent(shadow);
    this.send({ type: 'patch', file: relativePath, patches, baseHash, baseVersion });
    this.shadows.set(relativePath, current);
    const nextVersion = baseVersion + 1;
    this.setFileVersion(relativePath, nextVersion);
    this.journal.recordWithVersion(relativePath, current, nextVersion);
    this.stats.patchesSent++;
    this.updateStatusBar();
  }

  sendCursor(relativePath: string, line: number, character: number, selection: CursorSelection) {
    if (this.paused) return;
    if (this.wsReady()) {
      this.send({ type: 'cursor', file: relativePath, line, character, selection });
    }
  }

  private async sendOpenFilesTo(_peerId: string) {
    const toSend = new Map<string, string>();
    if (this.watcher) {
      for (const [rel, content] of this.watcher.getOpenFiles()) {
        toSend.set(rel, content);
        if (!this.fileVersions.has(rel)) this.setFileVersion(rel, 0);
      }
    }
    for (const [rel, entry] of this.journal.getAllFiles()) {
      if (!toSend.has(rel)) toSend.set(rel, entry.content);
      if (!this.fileVersions.has(rel)) this.setFileVersion(rel, entry.version ?? 0);
    }
    for (const [rel, content] of toSend) {
      if (Buffer.byteLength(content, 'utf8') > this.maxFileSizeBytes) {
        this.warnSkip(rel, `skipped (>${(this.maxFileSizeBytes / 1024).toFixed(0)} KB)`);
        continue;
      }
      await this.sendFileState(rel, content);
    }
  }

  private async sendFileState(relativePath: string, content: string) {
    const version = this.getFileVersion(relativePath);
    const hash = hashContent(content);
    const chunks = encodeChunks(content);
    for (let i = 0; i < chunks.length; i++) {
      this.send({
        type: 'file_state_chunk',
        file: relativePath,
        chunk: i,
        total: chunks.length,
        data: chunks[i],
        version,
        hash,
      });
      if (i % 8 === 7) await sleep(0);
    }
    if (chunks.length > 1) {
      this.send({ type: 'file_state_done', file: relativePath, version, hash });
    }
  }

  // ── Bulk review queue ──────────────────────────────────────────────────────

  /**
   * All conflicts and delete confirmations go through here.
   * Items are batched for 300ms, then shown in one panel.
   * If the panel is already open, new items are appended to the queue
   * and will appear in the next panel that opens after the current one closes.
   */
  private queueReview(item: ReviewItem) {
    if (this.reviewOpen) {
      // Panel busy - queue for next batch
      this.reviewQueue.push(item);
      return;
    }
    this.reviewQueue.push(item);

    if (this.reviewDebounce) clearTimeout(this.reviewDebounce);
    this.reviewDebounce = setTimeout(() => {
      this.reviewDebounce = null;
      this.openReviewPanel();
    }, 300);
  }

  private async openReviewPanel() {
    if (this.reviewQueue.length === 0) return;

    const batch = [...this.reviewQueue];
    this.reviewQueue = [];
    this.reviewOpen  = true;

    this.stats.conflictsResolved += batch.filter(i => i.kind === 'conflict').length;
    this.updateStatusBar();

    const result = await BulkReviewPanel.show(batch, this.context);
    this.reviewOpen = false;

    if (result) {
      // Apply delete decisions
      for (const item of batch.filter((i): i is DeleteRequest => i.kind === 'delete')) {
        const decision = result.deletes[item.relativePath] ?? 'reject';

        if (decision === 'accept') {
          await this.executeLocalDelete(item.relativePath);
        } else {
          // Rejected: broadcast our version back so the other peer gets it
          const current = await this.readContent(item.relativePath);
          if (current) {
            const patch = createPatch('', current);
            const baseHash = hashContent('');
            if (patch) this.send({ type: 'patch', file: item.relativePath, patches: patch, baseHash });
          }
        }
      }

      // Apply conflict decisions
      for (const item of batch.filter((i): i is ConflictRequest => i.kind === 'conflict')) {
        const decision = result.conflicts[item.relativePath];
        if (!decision) continue;
        await this.writeContent(item.relativePath, decision.content);
        this.shadows.set(item.relativePath, decision.content);
        const nextVersion = this.getFileVersion(item.relativePath) + 1;
        this.setFileVersion(item.relativePath, nextVersion);
        this.journal.recordWithVersion(item.relativePath, decision.content, nextVersion);
        // Broadcast resolved content so peer also converges
        const patch = createPatch(item.theirs, decision.content);
        const baseHash = hashContent(item.theirs);
        if (patch) this.send({ type: 'patch', file: item.relativePath, patches: patch, baseHash });
      }
    }

    // If more items arrived while panel was open, show next batch
    if (this.reviewQueue.length > 0) {
      setTimeout(() => this.openReviewPanel(), 200);
    }
  }

  // ── Incoming ───────────────────────────────────────────────────────────────

  private async handleMessage(msg: unknown) {
    if (!isJsonObject(msg)) return;
    if (getType(msg) === 'enc') {
      if (!this.cryptoKeyPromise) {
        if (!this.warnedEncryptionOff) {
          this.warnedEncryptionOff = true;
          vscode.window.showWarningMessage('LineSync: Encryption is OFF for this session (no password).');
        }
        return;
      }
      const inner = await this.decryptEnvelope(msg as any);
      if (inner) await this.handleMessage(inner);
      return;
    }
    this.handlePlainMessage(msg);
  }

  private handlePlainMessage(msg: JsonObject) {
    const type = getType(msg);
    if (!type) return;
    switch (type) {
      case 'session_info':
        this.myPeerId = getString(msg, 'peerId') ?? '';
        {
          const peers = msg.peers;
          if (Array.isArray(peers)) {
            for (const p of peers) {
              if (!isJsonObject(p)) continue;
              const peerId = getString(p, 'peerId');
              const peerName = getString(p, 'peerName');
              if (!peerId || !peerName) continue;
              this.peers.set(peerId, { peerId, name: peerName });
            }
          }
        }
        this.stats.connectedAt = new Date();
        this.recomputeHost();
        this.startWatcher();
        if (this.isReconnecting) this.reseedShadowsFromJournal();
        this.isReconnecting = false;
        this.setStatusBar('connected');
        vscode.commands.executeCommand('setContext', 'linesync.active', true);
        break;

      case 'peer_joined':
        {
          const peerId = getString(msg, 'peerId');
          const peerName = getString(msg, 'peerName');
          if (!peerId || !peerName) break;
          this.peers.set(peerId, { peerId, name: peerName });
          vscode.window.showInformationMessage(`LineSync: ${peerName} joined`);
          if (this.isHost) setTimeout(() => this.sendOpenFilesTo(peerId), 400);
        }
        this.recomputeHost();
        this.updateStatusBar();
        break;

      case 'peer_left': {
        const peerId = getString(msg, 'peerId');
        if (!peerId) break;
        const p = this.peers.get(peerId);
        if (p) {
          vscode.window.showInformationMessage(`LineSync: ${p.name} left`);
          this.peers.delete(peerId); this.decorationManager.clearPeer(peerId);
          this.recomputeHost();
          this.updateStatusBar();
        }
        break;
      }

      case 'patch':
        this.stats.patchesReceived++; this.updateStatusBar();
        this.applyRemotePatch(msg).catch((e) => console.error('[LineSync] applyRemotePatch', e));
        break;

      case 'file_state_chunk':
        this.receiveChunk(msg).catch(console.error);
        break;

      case 'file_deleted':
        this.handleRemoteDelete(msg).catch(console.error);
        break;

      case 'cursor':
        {
          const from = getString(msg, 'from');
          const file = getString(msg, 'file');
          const line = getNumber(msg, 'line');
          const character = getNumber(msg, 'character') ?? 0;
          const selection = (msg.selection ?? null) as CursorSelection;
          if (!from || !file || line === null) break;
          this.decorationManager.updateCursor(
            from,
            file,
            line,
            character,
            selection,
            this.getPeerName(from)
          );
        }
        break;

      case 'pong':
        if (this.pingPending !== null) {
          this.stats.latencyMs = Date.now() - this.pingPending;
          this.pingPending = null;
          this.missedHeartbeats = 0;
          this.updateStatusBar();
        }
        break;

      case 'request_sync':
        this.stats.requestSyncReceived++;
        this.updateStatusBar();
        this.handleRequestSync(msg).catch(console.error);
        break;

      case 'error':
        if (getString(msg, 'code') === 'too_large') {
          const message = getString(msg, 'message') ?? 'unknown';
          vscode.window.showWarningMessage(`LineSync: Message too large - ${message}`);
        } else if (getString(msg, 'code') === 'bad_password') {
          vscode.window.showErrorMessage('LineSync: Wrong session password');
        }
        break;
    }
  }

  // ── Remote delete with backup + confirmation ───────────────────────────────

  private async handleRemoteDelete(msg: any) {
    const relativePath: string = msg.file;
    if (this.shouldSkipPath(relativePath)) return;
    const peerName    = this.getPeerName(msg.from);
    const current     = await this.readContent(relativePath);

    // Nothing to do if we don't have the file
    if (!current && !this.shadows.has(relativePath)) return;

    // Back up the file before asking (cheap - already have content)
    const backupId = current
      ? this.backup.save(relativePath, current, peerName, this.sessionId)
      : null;

    // Build list of peers who have this file (including self)
    const affectedPeers: string[] = [this.myName];
    // (In a future multi-peer setup we'd also list other peers - for now just self)

    this.queueReview({
      kind: 'delete',
      relativePath,
      deletedBy: peerName,
      affectedPeers,
      backupId,
    } satisfies DeleteRequest);
  }

  private async executeLocalDelete(relativePath: string) {
    const fsPath = path.join(this.workspaceRoot, relativePath);
    this.watcher?.suppressNext(relativePath);
    try { fs.unlinkSync(fsPath); } catch { /* already gone */ }
    this.shadows.delete(relativePath);
    this.fileVersions.delete(relativePath);
    this.journal.forget(relativePath);
    vscode.window.showInformationMessage(`LineSync: Deleted ${path.basename(relativePath)}`);
  }

  // ── Outgoing delete (with confirmation popup) ──────────────────────────────

  /**
   * Called by FileWatcher when we delete a file locally.
   * Shows a confirmation if there are active peers.
   */
  async confirmAndBroadcastDelete(relativePath: string, currentContent: string) {
    if (this.paused) return;
    const peerCount = this.peers.size;

    if (peerCount > 0) {
      const peerNames = [...this.peers.values()].map((p) => p.name).join(', ');
      const choice = await vscode.window.showWarningMessage(
        `Delete "${path.basename(relativePath)}" for all peers?\n\nThis will also remove the file for: ${peerNames}`,
        { modal: true },
        'Delete for everyone',
        'Only delete locally'
      );

      if (!choice || choice === 'Only delete locally') {
        // Don't broadcast - only our local copy goes
        this.shadows.delete(relativePath);
        this.fileVersions.delete(relativePath);
        this.journal.forget(relativePath);
        return;
      }
    }

    // Back up before broadcasting
    if (currentContent) {
      this.backup.save(relativePath, currentContent, this.myName, this.sessionId);
    }

    this.send({ type: 'file_deleted', file: relativePath });
    this.shadows.delete(relativePath);
    this.fileVersions.delete(relativePath);
    this.journal.forget(relativePath);
  }

  // ── Chunk reassembly ───────────────────────────────────────────────────────

  private async receiveChunk(msg: any) {
    const { file, chunk, total, data } = msg as {
      file: string; chunk: number; total: number; data: string;
    };
    if (this.shouldSkipPath(file)) return;

    let buf = this.chunkBuffers.get(file);
    if (!buf) {
      buf = { total, received: new Map(), version: msg.version ?? null, hash: msg.hash ?? null };
      this.chunkBuffers.set(file, buf);
    }
    if (buf.version === null && msg.version !== undefined) buf.version = msg.version;
    if (buf.hash === null && msg.hash !== undefined) buf.hash = msg.hash;
    buf.received.set(chunk, data);
    if (buf.received.size < buf.total) return;

    this.chunkBuffers.delete(file);
    const ordered: string[] = [];
    for (let i = 0; i < buf.total; i++) {
      const c = buf.received.get(i);
      if (c === undefined) { console.warn('[LineSync] Missing chunk', i, file); return; }
      ordered.push(c);
    }

    const incomingContent = decodeChunks(ordered);
    if (Buffer.byteLength(incomingContent, 'utf8') > this.maxFileSizeBytes) {
      this.warnSkip(file, `skipped (>${(this.maxFileSizeBytes / 1024).toFixed(0)} KB)`);
      return;
    }
    if (buf.hash && hashContent(incomingContent) !== buf.hash) {
      console.warn('[LineSync] file_state hash mismatch', file);
    }
    const incomingVersion = buf.version ?? this.getFileVersion(file);
    const existingShadow  = this.shadows.get(file);

    if (existingShadow === undefined) {
      await this.writeContent(file, incomingContent);
      this.shadows.set(file, incomingContent);
      this.setFileVersion(file, incomingVersion);
      this.journal.recordWithVersion(file, incomingContent, incomingVersion);
      return;
    }

    const currentContent = await this.readContent(file);
    if (currentContent === incomingContent) return;

    if (currentContent === existingShadow) {
      await this.writeContent(file, incomingContent);
      this.shadows.set(file, incomingContent);
      this.setFileVersion(file, incomingVersion);
      this.journal.recordWithVersion(file, incomingContent, incomingVersion);
      const changed = getChangedLines(currentContent, incomingContent);
      this.decorationManager.highlightChanges(
        msg.from, file, changed, this.getPeerName(msg.from), this.highlightDuration
      );
      return;
    }

    if (!patchesOverlap(existingShadow, currentContent, incomingContent)) {
      const patch  = createPatch(existingShadow, incomingContent);
      const merged = applyPatch(currentContent, patch);
      if (merged.success) {
        await this.writeContent(file, merged.result);
        this.shadows.set(file, merged.result);
        this.setFileVersion(file, incomingVersion);
        this.journal.recordWithVersion(file, merged.result, incomingVersion);
        const changed = getChangedLines(currentContent, merged.result);
        this.decorationManager.highlightChanges(
          msg.from, file, changed, this.getPeerName(msg.from), this.highlightDuration
        );
        return;
      }
    }

    const auto = this.tryAutoMerge(existingShadow, currentContent, incomingContent);
    if (auto !== null) {
      await this.writeContent(file, auto);
      this.shadows.set(file, auto);
      this.setFileVersion(file, incomingVersion);
      this.journal.recordWithVersion(file, auto, incomingVersion);
      const changed = getChangedLines(currentContent, auto);
      this.decorationManager.highlightChanges(
        msg.from, file, changed, this.getPeerName(msg.from), this.highlightDuration
      );
      return;
    }

    if (await this.resolveConflictByPolicy(file, currentContent, incomingContent, msg.from, incomingVersion)) {
      return;
    }

    this.queueReview({ kind: 'conflict', relativePath: file, peerName: this.getPeerName(msg.from), ours: currentContent, theirs: incomingContent });
  }

  private async handleRequestSync(msg: any) {
    if (!this.isHost) return;
    const relativePath = msg.file as string;
    if (!relativePath) return;
    if (this.shouldSkipPath(relativePath)) return;

    const fsPath = path.join(this.workspaceRoot, relativePath);
    const hasShadow = this.shadows.has(relativePath);
    const existsOnDisk = fs.existsSync(fsPath);
    if (!hasShadow && !existsOnDisk) return;
    if (!existsOnDisk && hasShadow) {
      this.send({ type: 'file_deleted', file: relativePath });
      return;
    }

    const content = await this.readContent(relativePath);
    if (Buffer.byteLength(content, 'utf8') > this.maxFileSizeBytes) return;
    await this.sendFileState(relativePath, content);
    this.stats.syncsServed++;
    this.updateStatusBar();
  }

  // ── Patch application ──────────────────────────────────────────────────────

  private async applyRemotePatch(msg: any) {
    const relativePath   = msg.file as string;
    if (this.shouldSkipPath(relativePath)) return;
    const shadow         = this.shadows.get(relativePath) ?? this.journal.getLastKnown(relativePath) ?? '';
    const journalVersion = this.journal.getLastKnownVersion(relativePath);
    if (!this.fileVersions.has(relativePath) && journalVersion !== undefined) {
      this.setFileVersion(relativePath, journalVersion);
    }
    const baseVersion = this.getFileVersion(relativePath);
    const baseHash = hashContent(shadow);

    if (msg.baseHash && msg.baseHash !== baseHash) {
      this.requestSync(relativePath);
      return;
    }
    if (typeof msg.baseVersion === 'number' && msg.baseVersion !== baseVersion) {
      this.requestSync(relativePath);
      return;
    }
    const patchResult    = applyPatch(shadow, msg.patches);

    if (!patchResult.success) {
      this.requestSync(relativePath);
      return;
    }

    const newShadow      = patchResult.result;
    if (Buffer.byteLength(newShadow, 'utf8') > this.maxFileSizeBytes) {
      this.warnSkip(relativePath, `skipped (>${(this.maxFileSizeBytes / 1024).toFixed(0)} KB)`);
      return;
    }
    const currentContent = await this.readContent(relativePath);
    const nextVersion = (typeof msg.baseVersion === 'number' ? msg.baseVersion : baseVersion) + 1;

    if (currentContent === shadow) {
      await this.writeContent(relativePath, newShadow);
      this.shadows.set(relativePath, newShadow);
      this.setFileVersion(relativePath, nextVersion);
      this.journal.recordWithVersion(relativePath, newShadow, nextVersion);
      const changed = getChangedLines(currentContent, newShadow);
      this.decorationManager.highlightChanges(
        msg.from, relativePath, changed, this.getPeerName(msg.from), this.highlightDuration
      );
      return;
    }

    if (!patchesOverlap(shadow, currentContent, newShadow)) {
      const merge = applyPatch(currentContent, msg.patches);
      if (merge.success) {
        await this.writeContent(relativePath, merge.result);
        this.shadows.set(relativePath, merge.result);
        this.setFileVersion(relativePath, nextVersion);
        this.journal.recordWithVersion(relativePath, merge.result, nextVersion);
        const changed = getChangedLines(currentContent, merge.result);
        this.decorationManager.highlightChanges(
          msg.from, relativePath, changed, this.getPeerName(msg.from), this.highlightDuration
        );
        return;
      }
    }

    const auto = this.tryAutoMerge(shadow, currentContent, newShadow);
    if (auto !== null) {
      await this.writeContent(relativePath, auto);
      this.shadows.set(relativePath, auto);
      this.setFileVersion(relativePath, nextVersion);
      this.journal.recordWithVersion(relativePath, auto, nextVersion);
      const changed = getChangedLines(currentContent, auto);
      this.decorationManager.highlightChanges(
        msg.from, relativePath, changed, this.getPeerName(msg.from), this.highlightDuration
      );
      return;
    }

    if (await this.resolveConflictByPolicy(relativePath, currentContent, newShadow, msg.from, nextVersion)) {
      return;
    }

    this.queueReview({ kind: 'conflict', relativePath, peerName: this.getPeerName(msg.from), ours: currentContent, theirs: newShadow });
  }

  // ── File I/O ───────────────────────────────────────────────────────────────

  private async readContent(relativePath: string): Promise<string> {
    const fsPath = path.join(this.workspaceRoot, relativePath);
    const doc    = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
    if (doc) return doc.getText();
    try { return fs.readFileSync(fsPath, 'utf8'); } catch { return ''; }
  }

  private async writeContent(relativePath: string, content: string) {
    if (this.shouldSkipPath(relativePath, Buffer.byteLength(content, 'utf8'))) return;
    const fsPath = path.join(this.workspaceRoot, relativePath);
    this.watcher?.suppressNext(relativePath);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const last = doc.lineCount - 1;
      edit.replace(doc.uri, new vscode.Range(0, 0, last, doc.lineAt(last).range.end.character), content);
      await vscode.workspace.applyEdit(edit);
    } else {
      try {
        fs.mkdirSync(path.dirname(fsPath), { recursive: true });
        fs.writeFileSync(fsPath, content, 'utf8');
      } catch (e) { console.error('[LineSync] write failed:', relativePath, e); }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private getFileVersion(relativePath: string): number {
    return this.fileVersions.get(relativePath) ?? 0;
  }

  private setFileVersion(relativePath: string, version: number) {
    this.fileVersions.set(relativePath, Math.max(0, version));
  }

  private requestSync(relativePath: string) {
    if (!this.wsReady()) return;
    this.send({ type: 'request_sync', file: relativePath });
    this.stats.requestSyncSent++;
    this.updateStatusBar();
  }

  private recomputeHost() {
    if (!this.myPeerId) return;
    const ids = [this.myPeerId, ...this.peers.keys()].sort();
    this.hostPeerId = ids[0] ?? null;
    this.isHost = this.hostPeerId === this.myPeerId;
  }

  private getHostName(): string {
    if (!this.hostPeerId) return '-';
    if (this.hostPeerId === this.myPeerId) return `${this.myName} (you)`;
    return this.peers.get(this.hostPeerId)?.name ?? 'Peer';
  }

  private tryAutoMerge(base: string, ours: string, theirs: string): string | null {
    try {
      const r = Diff3.merge(ours, base, theirs, {
        excludeFalseConflicts: true,
        stringSeparator: '\n',
      });
      if (r && r.conflict === false && Array.isArray(r.result)) {
        return r.result.join('\n');
      }
    } catch (e) {
      console.error('[LineSync] diff3 merge failed', e);
    }
    return null;
  }

  private async resolveConflictByPolicy(
    relativePath: string,
    ours: string,
    theirs: string,
    fromPeerId: string,
    incomingVersion: number
  ): Promise<boolean> {
    if (this.mergePolicy === 'prompt') return false;

    let decision: 'ours' | 'theirs';
    if (this.mergePolicy === 'preferMine') decision = 'ours';
    else if (this.mergePolicy === 'preferTheirs') decision = 'theirs';
    else decision = this.isHost ? 'ours' : 'theirs';

    const currentVersion = this.getFileVersion(relativePath);
    const theirsVersion = Number.isFinite(incomingVersion) ? incomingVersion : currentVersion + 1;

    if (decision === 'theirs') {
      if (ours !== theirs) {
        await this.writeContent(relativePath, theirs);
      }
      this.shadows.set(relativePath, theirs);
      this.setFileVersion(relativePath, theirsVersion);
      this.journal.recordWithVersion(relativePath, theirs, theirsVersion);
      const changed = getChangedLines(ours, theirs);
      this.decorationManager.highlightChanges(
        fromPeerId, relativePath, changed, this.getPeerName(fromPeerId), this.highlightDuration
      );
      return true;
    }

    const oursVersion = Math.max(currentVersion, theirsVersion) + 1;
    this.shadows.set(relativePath, ours);
    this.setFileVersion(relativePath, oursVersion);
    this.journal.recordWithVersion(relativePath, ours, oursVersion);

    const patch = createPatch(theirs, ours);
    const baseHash = hashContent(theirs);
    if (patch) this.send({ type: 'patch', file: relativePath, patches: patch, baseHash, baseVersion: theirsVersion });
    return true;
  }

  private startWatcher() {
    this.watcher?.dispose();
    this.watcher = new FileWatcher(
      this.workspaceRoot, this.shadows, this.ignoreMatcher,
      (rel, shadow, current) => this.sendPatch(rel, shadow, current),
      (rel, line, character, selection) => this.sendCursor(rel, line, character, selection),
      (rel, content)         => this.confirmAndBroadcastDelete(rel, content)
    );
  }

  private reseedShadowsFromJournal() {
    let count = 0;
    for (const [rel, entry] of this.journal.getAllFiles()) {
      if (!this.shadows.has(rel)) { this.shadows.set(rel, entry.content); count++; }
      if (!this.fileVersions.has(rel)) this.setFileVersion(rel, entry.version ?? 0);
    }
    if (count > 0) console.log(`[LineSync] Reseeded ${count} shadows from journal`);
  }

  private shouldSkipPath(relativePath: string, sizeBytes?: number): boolean {
    if (!relativePath || !this.isSafePath(relativePath)) {
      this.warnSkip(relativePath || '(empty)', 'invalid path');
      return true;
    }
    if (this.isIgnored(relativePath) || this.isBinaryPath(relativePath)) {
      this.warnSkip(relativePath, 'ignored by settings');
      return true;
    }
    if (typeof sizeBytes === 'number' && sizeBytes > this.maxFileSizeBytes) {
      this.warnSkip(relativePath, `skipped (>${(this.maxFileSizeBytes / 1024).toFixed(0)} KB)`);
      return true;
    }
    return false;
  }

  private isIgnored(relativePath: string): boolean {
    return this.ignoreMatcher.isIgnored(relativePath);
  }

  explainIgnored(relativePath: string): string | null {
    return this.ignoreMatcher.explain(relativePath);
  }

  private isBinaryPath(relativePath: string): boolean {
    return /\.(png|jpe?g|gif|ico|webp|bmp|avif|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|wasm|mp[34]|mov|avi|mkv|webm|ttf|otf|woff2?|eot|bin|dat|db|sqlite|class|pyc)$/i
      .test(relativePath);
  }

  private isSafePath(relativePath: string): boolean {
    const rel = relativePath.replace(/\\/g, '/');
    if (rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) return false;
    const normalized = path.posix.normalize(rel);
    return !(normalized === '..' || normalized.startsWith('../'));
  }

  private warnSkip(relativePath: string, reason: string) {
    const key = `${relativePath}|${reason}`;
    if (this.warnedSkips.has(key)) return;
    this.warnedSkips.add(key);
    vscode.window.showWarningMessage(`LineSync: Skipped "${relativePath}" (${reason})`);
  }

  private send(obj: any) {
    if (!this.wsReady()) return;
    this.sendEncrypted(obj).catch((e) => console.error('[LineSync] send', e));
  }

  private async sendEncrypted(obj: any) {
    if (!this.wsReady()) return;
    const payload = await this.maybeEncrypt(obj);
    this.ws!.send(JSON.stringify(payload));
  }

  private async maybeEncrypt(obj: any): Promise<any> {
    if (!obj || !ENCRYPTED_TYPES.has(obj.type)) return obj;
    if (!this.cryptoKeyPromise) return obj;
    const key = await this.cryptoKeyPromise;
    const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
    const encoded = textEncoder.encode(JSON.stringify(obj));
    const cipher = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key as any, encoded);
    return {
      type: 'enc',
      v: 1,
      iv: bytesToBase64(iv),
      data: bytesToBase64(new Uint8Array(cipher)),
    };
  }

  private async decryptEnvelope(msg: any): Promise<any | null> {
    if (!msg || typeof msg.iv !== 'string' || typeof msg.data !== 'string') return null;
    if (!this.cryptoKeyPromise) return null;
    try {
      const key = await this.cryptoKeyPromise;
      const iv = base64ToBytes(msg.iv);
      const data = base64ToBytes(msg.data);
      const plain = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key as any, data);
      const text = textDecoder.decode(plain);
      return JSON.parse(text);
    } catch (e) {
      console.error('[LineSync] decrypt failed', e);
      return null;
    }
  }

  private wsReady() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  private getPeerName(id: string) { return this.peers.get(id)?.name ?? 'Peer'; }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (!this.wsReady()) return;
      if (this.pingPending !== null) {
        this.missedHeartbeats++;
        if (this.missedHeartbeats >= 2) {
          try { this.ws?.terminate(); } catch { /* noop */ }
          return;
        }
      }
      this.pingPending = Date.now();
      this.ws!.send(JSON.stringify({ type: 'ping', ts: this.pingPending }));
    }, 15_000);
  }

  private stopPing() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.pingPending = null;
    this.missedHeartbeats = 0;
  }

  private scheduleReconnect() {
    if (this.disposed) return;
    this.reconnectAttempts++;
    this.isReconnecting = true;
    this.setStatusBar('reconnecting');
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30_000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.connect(); } catch { /* handled inside */ }
    }, delay);
  }

  private setStatusBar(state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error') {
    const n    = this.peers.size + 1;
    const ping = this.stats.latencyMs !== null ? ` - ${this.stats.latencyMs}ms` : '';
    const hostBadge = this.isHost ? ' - HOST' : '';
    const pausedBadge = this.paused ? ' - PAUSED' : '';
    const map: Record<typeof state, { icon: string; label: string; bg?: string }> = {
      connecting:   { icon: '$(sync~spin)',    label: 'Connecting...' },
      connected:    { icon: this.paused ? '$(debug-pause)' : '$(radio-tower)',  label: `${this.sessionId}  -  ${n} online${ping}${hostBadge}${pausedBadge}` },
      disconnected: { icon: '$(circle-slash)', label: 'Disconnected', bg: 'statusBarItem.errorBackground' },
      reconnecting: { icon: '$(sync~spin)',    label: `Reconnecting (${this.reconnectAttempts})...` },
      error:        { icon: '$(error)',        label: 'Connection error', bg: 'statusBarItem.errorBackground' },
    };
    const s = map[state];
    this.statusBar.text = `${s.icon} LineSync: ${s.label}`;
    this.statusBar.backgroundColor = s.bg ? new vscode.ThemeColor(s.bg) : undefined;
    if (state === 'connected') {
      this.statusBar.tooltip = [
        `Session: ${this.sessionId}`, `You: ${this.myName}`,
        `Host: ${this.getHostName()}`,
        `Peers: ${[...this.peers.values()].map((p) => p.name).join(', ') || '-'}`,
        `Up ${this.stats.patchesSent} sent  Down ${this.stats.patchesReceived} received`,
        `Conflicts ${this.stats.conflictsResolved}`,
        `Req sent ${this.stats.requestSyncSent}  Req received ${this.stats.requestSyncReceived}  Served ${this.stats.syncsServed}`,
        this.stats.latencyMs !== null ? `Latency: ${this.stats.latencyMs} ms` : '',
        '', 'Click for options',
      ].filter(Boolean).join('\n');
    }
    this.statusBar.show();
  }

  private updateStatusBar() { this.setStatusBar('connected'); }

  getSessionId()  { return this.sessionId; }
  getMyName()     { return this.myName; }
  getPeers()      { return [...this.peers.values()]; }
  getBackupManager() { return this.backup; }

  isHostUser(): boolean {
    return this.isHost;
  }

  kickPeer(peerId: string) {
    this.send({ type: 'admin_kick', peerId });
  }

  banPeer(peerId: string) {
    this.send({ type: 'admin_ban', peerId });
  }

  resyncFile(relativePath: string) {
    this.requestSync(relativePath);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.updateStatusBar();
  }

  isPaused(): boolean {
    return this.paused;
  }
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function hashContent(content: string): string {
  return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

function deriveRelayPasswordHash(password: string, sessionId: string): string {
  // Relay needs a stable verifier to enforce access control,
  // but should not learn the E2E password directly.
  return crypto
    .createHash('sha256')
    .update(`linesync-relay|${sessionId.toUpperCase()}|${password}`, 'utf8')
    .digest('base64');
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function deriveSessionKey(password: string, sessionId: string): Promise<unknown> {
  const salt = textEncoder.encode(sessionId.toUpperCase());
  const baseKey = await crypto.webcrypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
