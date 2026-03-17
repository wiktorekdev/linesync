import * as vscode from 'vscode';
import * as os from 'os';
import { execSync } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { IgnoreMatcher } from './ignoreMatcher';
import { DecorationManager } from './decorationManager';
import WebSocket from 'ws';
import { Transport } from './transport';
import { SyncEngine } from './syncEngine';

let transport: Transport | undefined;
let engine: SyncEngine | undefined;
let decorationManager: DecorationManager | undefined;
let output: vscode.OutputChannel | undefined;
let paused = false;
let extContext: vscode.ExtensionContext | undefined;
let currentSessionId: string | undefined;
let currentJoinToken: string | undefined;

export function activate(context: vscode.ExtensionContext) {
  decorationManager = new DecorationManager(context);
  output = vscode.window.createOutputChannel('LineSync');
  context.subscriptions.push(output);
  extContext = context;
  paused = context.globalState.get<boolean>('linesync.paused', false);

  context.subscriptions.push(
    vscode.commands.registerCommand('linesync.startSession', async () => {
      if (!checkWorkspace()) return;
      if (!await checkConfig()) return;

      const code = randomCode();
      await startSession(context, code, 'host');
    }),

    vscode.commands.registerCommand('linesync.joinSession', async () => {
      if (!checkWorkspace()) return;
      if (!await checkConfig()) return;

      const codeOrToken = await vscode.window.showInputBox({
        prompt: 'Enter session code to join',
        placeHolder: 'ABCDEF (or paste a join token: ABCDEF.PASSWORD)',
        validateInput: (v) => {
          const parsed = parseCodeOrToken(v.trim());
          if (!parsed) return 'Invalid code';
          return null;
        }
      });
      if (!codeOrToken) return;

      const parsed = parseCodeOrToken(codeOrToken.trim());
      if (!parsed) return;
      await startSession(context, parsed.sessionId, 'guest', parsed.passwordFromToken);
    }),

    vscode.commands.registerCommand('linesync.disconnect', () => {
      transport?.disconnect();
      transport = undefined;
      engine?.dispose();
      engine = undefined;
      decorationManager?.clearAll();
      paused = false;
      extContext?.globalState.update('linesync.paused', false);
      vscode.window.showInformationMessage('LineSync: Disconnected');
    }),

    vscode.commands.registerCommand('linesync.copySessionCode', async () => {
      if (transport) {
        await vscode.env.clipboard.writeText(currentSessionId ?? '');
        vscode.window.showInformationMessage('LineSync: Copied session code to clipboard');
      } else {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
      }
    }),

    vscode.commands.registerCommand('linesync.copySessionInvite', async () => {
      if (!transport) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      const token = currentJoinToken ?? '';
      const action = await vscode.window.showInformationMessage(
        `LineSync: Invite token for ${currentSessionId ?? ''}`,
        'Copy invite token'
      );
      if (action !== 'Copy invite token') return;
      const ok = await vscode.window.showWarningMessage(
        'LineSync: The invite token includes the session password. Share it only with people you trust.',
        { modal: true },
        'Copy'
      );
      if (ok !== 'Copy') return;
      await vscode.env.clipboard.writeText(token);
      vscode.window.showInformationMessage('LineSync: Copied invite token to clipboard');
    }),

    vscode.commands.registerCommand('linesync.openSettings', async () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'linesync');
    }),

    vscode.commands.registerCommand('linesync.stopReconnect', async () => {
      if (!transport) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      transport.stopAutoReconnect();
    }),

    vscode.commands.registerCommand('linesync.reconnect', async () => {
      if (!transport) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'LineSync: Reconnecting...', cancellable: true },
          async (_, token) => {
            token.onCancellationRequested(() => transport?.stopAutoReconnect());
            await transport!.reconnectNow();
          }
        );
        vscode.window.showInformationMessage('LineSync: Reconnected');
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`LineSync: Reconnect failed - ${msg}`);
      }
    }),

    // NOTE: Host-only peer management, change password, doctor, resync, pause, and ignore explain
    // will return later via Menu only (presence-ui/migration steps). For now we keep v2 core small.

    vscode.commands.registerCommand('linesync.showMenu', async () => {
      const isConnected = !!transport;
      const copyLabel = isConnected ? `Copy session code (${currentSessionId ?? ''})` : null;
      
      const picks: { label: string; id: string; description?: string }[] = [];
      if (isConnected) {
        picks.push({ label: '$(clippy) ' + copyLabel, id: 'copy' });
        picks.push({ label: '$(mail) Copy session invite token', id: 'copyInvite', description: 'Includes password' });
      }
      
      picks.push(
        { label: isConnected ? '$(stop) Disconnect' : '$(broadcast) Start new session', id: isConnected ? 'disconnect' : 'start' },
        { label: '$(plug) Join session', id: 'join' }
      );

      if (isConnected) {
        // reconnect controls are still exposed via menu for v2 transport
        // Transport does not expose state yet; just show both actions.
        if (true) {
          picks.push({ label: '$(debug-stop) Stop reconnecting', id: 'stopReconnect', description: 'Stops auto-reconnect attempts' });
        }
        if (true) {
          picks.push({ label: '$(sync) Reconnect now', id: 'reconnectNow', description: 'Try connecting again' });
        }
        picks.push({ label: '$(file) Browse remote files', id: 'browseRemote', description: 'Request file list from host' });
        picks.push({ label: '$(eye) Follow peer', id: 'followPeer', description: 'Jump to a peer cursor' });
        picks.push({ label: '$(paintcan) Decorations: Full', id: 'decorFull' });
        picks.push({ label: '$(paintcan) Decorations: Git', id: 'decorGit' });
        picks.push({ label: '$(paintcan) Decorations: Minimal', id: 'decorMinimal' });
        picks.push({ label: '$(symbol-keyword) Toggle cursor label', id: 'toggleCursorLabel' });
        picks.push({ label: '$(symbol-numeric) Toggle cursor coords', id: 'toggleCursorCoords' });
      }

      picks.push(
        { label: '$(gear) Settings', id: 'settings' },
      );
      
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'LineSync' });
      if (!pick) return;
      if (pick.id === 'copy') vscode.commands.executeCommand('linesync.copySessionCode');
      if (pick.id === 'copyInvite') vscode.commands.executeCommand('linesync.copySessionInvite');
      if (pick.id === 'disconnect') vscode.commands.executeCommand('linesync.disconnect');
      if (pick.id === 'start') vscode.commands.executeCommand('linesync.startSession');
      if (pick.id === 'join') vscode.commands.executeCommand('linesync.joinSession');
      if (pick.id === 'stopReconnect') vscode.commands.executeCommand('linesync.stopReconnect');
      if (pick.id === 'reconnectNow') vscode.commands.executeCommand('linesync.reconnect');
      if (pick.id === 'browseRemote') engine?.showRemoteFileBrowser();
      if (pick.id === 'followPeer') engine?.followPeer();
      if (pick.id === 'decorFull') vscode.workspace.getConfiguration('linesync').update('peerDecorationsStyle', 'full', true);
      if (pick.id === 'decorGit') vscode.workspace.getConfiguration('linesync').update('peerDecorationsStyle', 'git', true);
      if (pick.id === 'decorMinimal') vscode.workspace.getConfiguration('linesync').update('peerDecorationsStyle', 'minimal', true);
      if (pick.id === 'toggleCursorLabel') {
        const cfg = vscode.workspace.getConfiguration('linesync');
        const v = cfg.get<boolean>('peerShowCursorLabel', true);
        cfg.update('peerShowCursorLabel', !v, true);
      }
      if (pick.id === 'toggleCursorCoords') {
        const cfg = vscode.workspace.getConfiguration('linesync');
        const v = cfg.get<boolean>('peerShowCursorCoords', true);
        cfg.update('peerShowCursorCoords', !v, true);
      }
      if (pick.id === 'settings') vscode.commands.executeCommand('linesync.openSettings');
    })
  );

  vscode.commands.executeCommand('setContext', 'linesync.active', false);
}

export function deactivate() {
  transport?.disconnect();
  engine?.dispose();
  decorationManager?.dispose();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startSession(
  context: vscode.ExtensionContext,
  sessionId: string,
  mode: 'host' | 'guest',
  guestPasswordFromToken?: string
) {
  if (transport) {
    transport.disconnect();
    transport = undefined;
    engine?.dispose();
    engine = undefined;
    decorationManager?.clearAll();
  }

  const cfg = vscode.workspace.getConfiguration('linesync');
  
  const relayUrl = mode === 'guest'
    ? await resolveRelayUrlForJoin(cfg, sessionId)
    : await resolveRelayUrlForHost(cfg);
  
  if (!relayUrl) return;

  const sessionPassword = mode === 'guest'
    ? await getJoinPassword({ passwordFromToken: guestPasswordFromToken })
    : await getHostPassword();

  if (!sessionPassword) {
    vscode.window.showErrorMessage('LineSync: Session password is required.');
    return;
  }

  let userName = cfg.get<string>('userName', '').trim();
  if (!userName) {
    try {
      userName = execSync('git config user.name', { encoding: 'utf8', timeout: 1000 }).trim();
    } catch {
      userName = os.userInfo().username || 'Anonymous';
    }
  }
  if (!userName) userName = 'Anonymous';

  currentSessionId = sessionId;
  currentJoinToken = formatJoinToken(sessionId, sessionPassword);

  const clientToken = context.globalState.get<string>('linesync.clientToken') ?? '';
  if (!clientToken) {
    context.globalState.update('linesync.clientToken', crypto.randomUUID());
  }

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'LineSync: Connecting...',
      cancellable: true
    }, async (_, token) => {
      transport = new Transport(
        relayUrl,
        sessionId,
        userName,
        sessionPassword,
        cfg.get<string>('relaySecret', '') ?? '',
        context.globalState.get<string>('linesync.clientToken') ?? '',
        (e) => engine?.handleTransportEvent(e)
      );
      engine = new SyncEngine(transport, userName, decorationManager!, context, sessionId);
      engine.attach();
      token.onCancellationRequested(() => transport?.disconnect());
      await transport!.connect();
    });
    
    if (mode === 'host') {
      const joinToken = sessionPassword ? formatJoinToken(sessionId, sessionPassword) : '';
      const action = await vscode.window.showInformationMessage(
        `LineSync: Started session ${sessionId}`,
        'Copy join token (includes password)',
        'Copy code'
      );
      if (action === 'Copy join token (includes password)' && joinToken) {
        const ok = await vscode.window.showWarningMessage(
          'LineSync: The join token includes the session password. Share it only with people you trust.',
          { modal: true },
          'Copy join token'
        );
        if (ok !== 'Copy join token') return;
        await vscode.env.clipboard.writeText(joinToken);
      } else if (action === 'Copy code') {
        await vscode.env.clipboard.writeText(sessionId);
      }
    } else {
      vscode.window.showInformationMessage(`LineSync: Joined session ${sessionId} as "${userName}"`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`LineSync: Failed to connect - ${msg}`);
    transport = undefined;
    engine?.dispose();
    engine = undefined;
  }
}

function checkWorkspace(): boolean {
  if (!vscode.workspace.workspaceFolders?.length) {
    vscode.window.showErrorMessage('LineSync: Open a workspace folder first (File -> Open Folder)');
    return false;
  }
  return true;
}

async function checkConfig(): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('linesync');
  const relayUrl = cfg.get<string>('relayUrl', '');
  const relayUrls = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);

  if (!relayUrl && relayUrls.length === 0) {
    const action = await vscode.window.showErrorMessage(
      'LineSync: relayUrl/relayUrls is not set. Open settings to configure it.',
      'Open Settings'
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'linesync');
    }
    return false;
  }

  if (relayUrl === 'auto' && relayUrls.length === 0) {
    vscode.window.showErrorMessage('LineSync: relayUrl is set to auto but relayUrls is empty.');
    return false;
  }

  return true;
}

async function resolveRelayUrlForHost(cfg: vscode.WorkspaceConfiguration): Promise<string | undefined> {
  let relayUrl = (cfg.get<string>('relayUrl', '') || '').trim();
  const relayUrls = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);

  if (relayUrl === 'auto' && relayUrls.length > 0) {
    relayUrl = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LineSync: selecting relay', cancellable: false },
      async () => {
        const probes = await Promise.all(relayUrls.map((u) => probeRelay(u, 1200)));
        const best = probes.map((ms, i) => ({ url: relayUrls[i], ms })).sort((a, b) => a.ms - b.ms)[0];
        return best && Number.isFinite(best.ms) ? best.url : relayUrls[0];
      }
    );
  }
  const chosen = relayUrl || relayUrls[0];
  return validateRelayUrl(chosen);
}

async function resolveRelayUrlForJoin(cfg: vscode.WorkspaceConfiguration, sessionId: string): Promise<string | undefined> {
  const relayUrl = (cfg.get<string>('relayUrl', '') || '').trim();
  const relayUrls = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);

  if (relayUrl && relayUrl !== 'auto') {
    return validateRelayUrl(relayUrl);
  }
  if (relayUrls.length === 0) return relayUrl;
  
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'LineSync: Finding session...', cancellable: false },
    async () => {
      const results = await Promise.all(relayUrls.map(async (u) => {
        try {
          const httpUrl = u.replace(/^wss?:\/\//, (m) => m === 'wss://' ? 'https://' : 'http://');
          const ok = await httpGetStatus(`${httpUrl}/session/${sessionId}`, 2000);
          if (ok === 200) return u;
        } catch (e) {
          console.warn('[LineSync] session probe failed', u, e);
        }
        return null;
      }));
      const found = results.find(x => x !== null);
      if (found) return validateRelayUrl(found) ?? undefined;
      vscode.window.showErrorMessage(`LineSync: Could not find session ${sessionId} on any configured relay.`);
      return undefined;
    }
  );
}

function validateRelayUrl(url: string | undefined): string | undefined {
  const u = (url ?? '').trim();
  if (!u) return undefined;
  if (!u.startsWith('ws://') && !u.startsWith('wss://')) {
    vscode.window.showErrorMessage('LineSync: relayUrl must start with ws:// or wss://');
    return undefined;
  }
  if (u.startsWith('ws://')) {
    const host = u.slice('ws://'.length).split('/')[0].split(':')[0].toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLocal) {
      vscode.window.showErrorMessage('LineSync: For security, ws:// is only allowed for localhost. Use wss:// for remote relays.');
      return undefined;
    }
  }
  return u;
}

function probeRelay(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;

    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });

    const finish = (ms: number) => {
      if (done) return;
      done = true;
      try { ws.terminate(); } catch { }
      resolve(ms);
    };

    const timer = setTimeout(() => finish(Number.POSITIVE_INFINITY), timeoutMs);

    ws.on('open', () => {
      try {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        clearTimeout(timer);
        finish(Number.POSITIVE_INFINITY);
      }
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'pong') {
          clearTimeout(timer);
          finish(Date.now() - start);
        }
      } catch { }
    });

    ws.on('error', () => { clearTimeout(timer); finish(Number.POSITIVE_INFINITY); });
    ws.on('close', () => { clearTimeout(timer); finish(Number.POSITIVE_INFINITY); });
  });
}

function randomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatJoinToken(sessionId: string, sessionPassword: string): string {
  return `${sessionId}.${sessionPassword}`;
}

function parseCodeOrToken(input: string): { sessionId: string; passwordFromToken?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('.');
  if (parts.length === 1) {
    const sessionId = parts[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    if (sessionId.length < 4) return null;
    return { sessionId };
  }
  if (parts.length === 2) {
    const sessionId = parts[0].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    const passwordFromToken = parts[1].trim();
    if (sessionId.length < 4) return null;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(passwordFromToken)) return null;
    return { sessionId, passwordFromToken };
  }
  return null;
}

async function getHostPassword(): Promise<string> {
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Use generated password (recommended)', id: 'auto' },
      { label: 'Set custom password', id: 'custom' },
    ],
    { placeHolder: 'Session password' }
  );
  if (!mode) return '';
  if (mode.id === 'auto') return makeGeneratedPassword();

  const pwd = await vscode.window.showInputBox({
    prompt: 'Set session password (share it with guests)',
    password: true,
    ignoreFocusOut: true,
    validateInput: validateSessionPassword,
  });
  return (pwd ?? '').trim();
}

async function getJoinPassword(opts: { passwordFromToken?: string }): Promise<string> {
  if (opts.passwordFromToken) return opts.passwordFromToken;

  const pwd = await vscode.window.showInputBox({
    prompt: 'Enter session password',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => v.trim().length > 0 ? null : 'Password required',
  });
  return (pwd ?? '').trim();
}

function makeGeneratedPassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

function validateSessionPassword(raw: string): string | null {
  const pwd = raw.trim();
  if (pwd.length < 8) return 'Use at least 8 characters';
  if (/^\d+$/.test(pwd)) return 'Do not use digits only';
  if (POPULAR_PASSWORDS.has(pwd.toLowerCase())) return 'Too common - pick a stronger password';
  return null;
}

const POPULAR_PASSWORDS = new Set([
  'password', 'password1', 'qwerty', 'qwerty123', 'admin', 'admin123',
  'letmein', 'welcome', 'iloveyou', '123456', '1234567', '12345678', '123456789',
  '111111', '000000', '123123', '1234', '12345', 'abc123', 'monkey',
]);

function httpGetJson<T>(urlStr: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { 'accept': 'application/json' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode ?? 0}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function httpGetStatus(urlStr: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
      },
      (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
