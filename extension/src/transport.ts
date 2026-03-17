import * as vscode from 'vscode';
import * as path from 'path';
import WebSocket from 'ws';
import { decryptJson, deriveRelayPasswordHash, deriveSessionKey, encryptJson } from './cryptoV2';
import type { EncEnvelope, JoinMessage, Payload } from './protocol';

export type TransportEvent =
  | { type: 'session_info'; peerId: string; peers: { peerId: string; peerName: string }[] }
  | { type: 'peer_joined'; peerId: string; peerName: string }
  | { type: 'peer_left'; peerId: string }
  | { type: 'rtt'; rttMs: number }
  | { type: 'enc'; from: string; payload: Payload }
  | { type: 'error'; code?: string; message?: string };

export class Transport {
  private ws: WebSocket | null = null;
  private keyPromise: Promise<unknown>;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pingPending: number | null = null;
  private missedHeartbeats = 0;
  private lastRttMs: number | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 20;
  private autoReconnect = true;
  private disposed = false;

  constructor(
    private relayUrl: string,
    private sessionId: string,
    private myName: string,
    private sessionSecret: string,
    private relaySecret: string,
    private clientToken: string,
    private onEvent: (e: TransportEvent) => void
  ) {
    this.keyPromise = deriveSessionKey(sessionSecret, sessionId);
  }

  async connect(): Promise<void> {
    this.autoReconnect = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      let handshakeComplete = false;
      const safeResolve = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const safeReject = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      try {
        this.ws = new WebSocket(this.relayUrl, {
          perMessageDeflate: { zlibDeflateOptions: { level: 6 }, threshold: 512 },
        });
      } catch (e: any) {
        safeReject(new Error(`Invalid relay URL: ${e.message}`));
        return;
      }

      const timeout = setTimeout(() => {
        this.ws?.terminate();
        safeReject(new Error('Connection timed out (10s)'));
      }, 10_000);

      this.ws.on('open', () => {
        this.reconnectAttempts = 0;
        this.missedHeartbeats = 0;
        const join: JoinMessage = {
          type: 'join',
          session: this.sessionId,
          peerName: this.myName,
          secret: this.relaySecret || undefined,
          password: deriveRelayPasswordHash(this.sessionSecret, this.sessionId),
          clientToken: this.clientToken,
        };
        this.ws!.send(JSON.stringify(join));
        this.startPing();
      });

      this.ws.on('message', async (raw: Buffer) => {
        let msg: any;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'session_info') {
          clearTimeout(timeout);
          this.onEvent({ type: 'session_info', peerId: String(msg.peerId || ''), peers: Array.isArray(msg.peers) ? msg.peers : [] });
          handshakeComplete = true;
          safeResolve();
          return;
        }
        if (msg.type === 'peer_joined') {
          this.onEvent({ type: 'peer_joined', peerId: String(msg.peerId || ''), peerName: String(msg.peerName || '') });
          return;
        }
        if (msg.type === 'peer_left') {
          this.onEvent({ type: 'peer_left', peerId: String(msg.peerId || '') });
          return;
        }
        if (msg.type === 'pong') {
          if (this.pingPending !== null) {
            const rtt = Math.max(0, Date.now() - this.pingPending);
            this.lastRttMs = rtt;
            this.onEvent({ type: 'rtt', rttMs: rtt });
            this.pingPending = null;
            this.missedHeartbeats = 0;
          }
          return;
        }
        if (msg.type === 'error') {
          this.onEvent({ type: 'error', code: msg.code, message: msg.message });
          return;
        }
        if (msg.type === 'enc') {
          if (!msg.from) return;
          const env = msg as Partial<EncEnvelope> & { from: string; v?: unknown; iv?: unknown; data?: unknown };
          if (env.v !== 1) return;
          if (typeof env.iv !== 'string' || typeof env.data !== 'string') return;
          if (env.iv.length > 64 || env.data.length > 4_000_000) return;
          try {
            const key = await this.keyPromise;
            const inner = await decryptJson(key, env.iv, env.data);
            if (isPayload(inner)) {
              this.onEvent({ type: 'enc', from: env.from, payload: inner });
            }
          } catch {
            // ignore decrypt errors
          }
          return;
        }
      });

      this.ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        this.onEvent({ type: 'error', message: err.message });
        safeReject(err);
      });

      this.ws.on('close', (code: number) => {
        clearTimeout(timeout);
        this.stopPing();
        if (!settled) {
          safeReject(new Error(closeCodeToMessage(code)));
        }
        if (code === 4001 || code === 4002 || code === 4003 || code === 4004) {
          this.disposed = true;
          return;
        }
        if (!handshakeComplete) return;
        if (!this.disposed && this.autoReconnect) this.scheduleReconnect();
      });
    });
  }

  disconnect() {
    this.disposed = true;
    this.autoReconnect = false;
    this.stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try { this.ws?.close(1000, 'User disconnected'); } catch {}
    this.ws = null;
  }

  async send(payload: Payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const key = await this.keyPromise;
    const { iv, data } = await encryptJson(key, payload);
    const env: EncEnvelope = { type: 'enc', v: 1, iv, data };
    this.ws.send(JSON.stringify(env));
  }

  getLastRttMs(): number | null {
    return this.lastRttMs;
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.pingPending !== null) {
        this.missedHeartbeats++;
        if (this.missedHeartbeats >= 2) {
          try { this.ws?.terminate(); } catch {}
          return;
        }
      }
      this.pingPending = Date.now();
      this.ws.send(JSON.stringify({ type: 'ping', ts: this.pingPending }));
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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.autoReconnect = false;
      vscode.window.showWarningMessage(
        `LineSync: Auto-reconnect stopped after ${this.reconnectAttempts} attempts. Start or join the session again from the LineSync menu.`
      );
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.reconnectAttempts - 1), 30_000);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { await this.connect(); } catch { /* ignore */ }
    }, delay);
  }
}

function isString(x: unknown): x is string {
  return typeof x === 'string';
}

function closeCodeToMessage(code: number): string {
  switch (code) {
    case 4001: return 'Unauthorized: relay secret mismatch';
    case 4002: return 'Session is full';
    case 4003: return 'Invalid session token';
    case 4004: return 'Session token is required';
    case 4007: return 'Disconnected: heartbeat timeout';
    case 4008: return 'Too many join attempts (rate limited)';
    case 4010: return 'You were removed from the session';
    case 4011: return 'You are banned from this session';
    case 1000: return 'Connection closed';
    default: return `Connection closed (code ${code})`;
  }
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isSafeRelativeFile(x: unknown): x is string {
  if (!isString(x)) return false;
  const raw = x.replace(/\\/g, '/').trim();
  if (!raw || raw.length > 1024) return false;
  if (raw.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(raw)) return false;
  if (raw.startsWith('/')) return false;
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.') return false;
  if (normalized.startsWith('../')) return false;
  if (normalized.includes('/../')) return false;
  return true;
}

function isPayload(x: unknown): x is Payload {
  if (!x || typeof x !== 'object') return false;
  const t = (x as any).type;
  if (!isString(t)) return false;
  switch (t) {
    case 'awareness_update':
      return isString((x as any).updateB64) && (x as any).updateB64.length <= 2_000_000;
    case 'y_update':
      return isSafeRelativeFile((x as any).file) && isString((x as any).updateB64) && (x as any).updateB64.length <= 2_000_000;
    case 'snapshot_request':
      return isSafeRelativeFile((x as any).file);
    case 'snapshot_chunk':
      return (
        isSafeRelativeFile((x as any).file) &&
        isString((x as any).id) &&
        isNumber((x as any).chunk) &&
        isNumber((x as any).total) &&
        isNumber((x as any).totalBytes) &&
        isString((x as any).sha256) &&
        /^[a-f0-9]{64}$/.test((x as any).sha256) &&
        isString((x as any).dataB64) &&
        (x as any).dataB64.length <= 2_000_000
      );
    case 'snapshot_ack':
      return isSafeRelativeFile((x as any).file) && isString((x as any).id) && isNumber((x as any).chunk);
    case 'manifest_request':
      return true;
    case 'manifest': {
      const files = (x as any).files;
      if (!Array.isArray(files) || files.length > 10_000) return false;
      for (const f of files) {
        if (!f || typeof f !== 'object') return false;
        if (!isSafeRelativeFile((f as any).file)) return false;
        if (!isNumber((f as any).size)) return false;
        if ((f as any).mtimeMs !== undefined && !isNumber((f as any).mtimeMs)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

