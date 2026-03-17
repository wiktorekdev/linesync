import * as vscode from 'vscode';
import * as os from 'os';
import { execSync } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as crypto from 'crypto';
import { IgnoreMatcher } from './ignoreMatcher';
import { SyncClient } from './syncClient';
import { DecorationManager } from './decorationManager';
import WebSocket from 'ws';

let client: SyncClient | undefined;
let decorationManager: DecorationManager | undefined;
let output: vscode.OutputChannel | undefined;
let paused = false;
let extContext: vscode.ExtensionContext | undefined;

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
      client?.disconnect();
      client = undefined;
      decorationManager?.clearAll();
      paused = false;
      extContext?.globalState.update('linesync.paused', false);
      vscode.window.showInformationMessage('LineSync: Disconnected');
    }),

    vscode.commands.registerCommand('linesync.copySessionCode', async () => {
      if (client) {
        await vscode.env.clipboard.writeText(client.getSessionId());
        vscode.window.showInformationMessage('LineSync: Copied session code to clipboard');
      } else {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
      }
    }),

    vscode.commands.registerCommand('linesync.managePeers', async () => {
      if (!client || !client.isHostUser()) {
        vscode.window.showErrorMessage('LineSync: Only the host can manage peers.');
        return;
      }
      const peers = client.getPeers();
      if (peers.length === 0) {
        vscode.window.showInformationMessage('LineSync: No other peers in session.');
        return;
      }

      const picks = peers.map((p) => ({
        label: p.name,
        description: p.peerId,
        peerId: p.peerId,
      }));
      const selected = await vscode.window.showQuickPick(picks, { placeHolder: 'Select a peer' });
      if (!selected) return;

      const action = await vscode.window.showQuickPick(
        [
          { label: 'Kick (disconnect)', id: 'kick' },
          { label: 'Ban (kick and block rejoin)', id: 'ban' },
        ],
        { placeHolder: `Action for ${selected.label}` }
      );
      if (!action) return;
      if (action.id === 'kick') client.kickPeer(selected.peerId);
      if (action.id === 'ban') client.banPeer(selected.peerId);
    }),

    vscode.commands.registerCommand('linesync.doctor', async () => {
      if (!output) return;
      output.clear();
      output.appendLine('LineSync Doctor');
      output.appendLine('');

      const cfg = vscode.workspace.getConfiguration('linesync');
      const relayUrl = (cfg.get<string>('relayUrl', '') || '').trim();
      const relayUrls = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);
      const relaySecret = (cfg.get<string>('relaySecret', '') || '').trim();
      const maxFileSizeKB = cfg.get<number>('maxFileSizeKB') ?? 512;
      const ignorePatterns = cfg.get<string[]>('ignorePatterns') ?? [];

      output.appendLine(`Workspace: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(none)'}`);
      output.appendLine(`relayUrl: ${relayUrl || '(empty)'}`);
      output.appendLine(`relayUrls: ${relayUrls.length}`);
      output.appendLine(`relaySecret: ${relaySecret ? '(set)' : '(empty)'}`);
      output.appendLine(`maxFileSizeKB: ${maxFileSizeKB}`);
      output.appendLine(`ignorePatterns: ${ignorePatterns.length}`);
      output.appendLine('');

      if (!vscode.workspace.workspaceFolders?.length) {
        output.appendLine('FAIL: No workspace folder open.');
        output.show(true);
        vscode.window.showErrorMessage('LineSync Doctor: Open a workspace folder first.');
        return;
      }

      const targets = relayUrl && relayUrl !== 'auto' ? [relayUrl] : relayUrls;
      if (targets.length === 0) {
        output.appendLine('FAIL: No relay configured. Set linesync.relayUrl or linesync.relayUrls.');
        output.show(true);
        vscode.window.showErrorMessage('LineSync Doctor: No relay configured.');
        return;
      }

      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LineSync Doctor: checking relays...', cancellable: false },
        async () => {
          return Promise.all(targets.map(async (u) => {
            const httpUrl = u.replace(/^wss?:\/\//, (m) => m === 'wss://' ? 'https://' : 'http://');
            const r: {
              url: string;
              health: number | null;
              configOk: boolean;
              requirePassword: boolean | null;
              wsMs: number | null;
              error?: string;
            } = { url: u, health: null, configOk: false, requirePassword: null, wsMs: null };
            try {
              r.health = await httpGetStatus(`${httpUrl}/health`, 2000);
            } catch (e) {
              r.error = `health failed: ${e instanceof Error ? e.message : String(e)}`;
            }
            try {
              const cfgData = await httpGetJson<{ requirePassword?: boolean }>(`${httpUrl}/config`, 2000);
              r.configOk = true;
              r.requirePassword = !!cfgData?.requirePassword;
            } catch (e) {
              r.error = (r.error ? r.error + '; ' : '') + `config failed: ${e instanceof Error ? e.message : String(e)}`;
            }
            try {
              const ms = await probeRelay(u, 1500);
              r.wsMs = Number.isFinite(ms) ? ms : null;
            } catch (e) {
              r.error = (r.error ? r.error + '; ' : '') + `ws probe failed: ${e instanceof Error ? e.message : String(e)}`;
            }
            return r;
          }));
        }
      );

      output.appendLine('Suggestions:');
      if (relayUrl === 'auto' && relayUrls.length === 0) {
        output.appendLine('- relayUrl is set to auto but relayUrls is empty. Add relays or set relayUrl directly.');
      }
      if (relayUrl && relayUrl !== 'auto' && !relayUrl.startsWith('ws://') && !relayUrl.startsWith('wss://')) {
        output.appendLine('- relayUrl should start with ws:// or wss://');
      }
      output.appendLine('');

      let okCount = 0;
      for (const r of results) {
        const ok = r.configOk && (r.health === 200 || r.health === null) && r.wsMs !== null;
        if (ok) okCount++;
        output.appendLine(`Relay: ${r.url}`);
        output.appendLine(`  /health: ${r.health ?? '(no response)'}`);
        output.appendLine(`  /config: ${r.configOk ? 'ok' : 'fail'}${r.requirePassword !== null ? ` (requirePassword=${r.requirePassword})` : ''}`);
        output.appendLine(`  ws probe: ${r.wsMs !== null ? `${r.wsMs} ms` : 'fail'}`);
        if (r.error) output.appendLine(`  note: ${r.error}`);
        if (r.requirePassword === true) {
          output.appendLine('  tip: This relay requires a session password.');
        }
        output.appendLine('');
      }

      output.show(true);
      if (okCount > 0) {
        vscode.window.showInformationMessage(`LineSync Doctor: OK (${okCount}/${results.length} relays reachable). See Output -> LineSync.`);
      } else {
        vscode.window.showErrorMessage('LineSync Doctor: No relays reachable. See Output -> LineSync.');
      }
    }),

    vscode.commands.registerCommand('linesync.resyncFile', async (uri?: vscode.Uri) => {
      if (!client) {
        vscode.window.showErrorMessage('LineSync: Not connected.');
        return;
      }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;
      const fsPath = uri?.scheme === 'file'
        ? uri.fsPath
        : vscode.window.activeTextEditor?.document.uri.scheme === 'file'
          ? vscode.window.activeTextEditor.document.uri.fsPath
          : '';
      if (!fsPath) {
        vscode.window.showErrorMessage('LineSync: Open a file to resync.');
        return;
      }
      const rel = fsPath.startsWith(root) ? fsPath.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '') : '';
      if (!rel) {
        vscode.window.showErrorMessage('LineSync: File is outside the workspace.');
        return;
      }
      client.resyncFile(rel);
      vscode.window.showInformationMessage(`LineSync: Requested resync for ${rel}`);
    }),

    vscode.commands.registerCommand('linesync.togglePause', async () => {
      if (!client) {
        vscode.window.showErrorMessage('LineSync: Not connected.');
        return;
      }
      paused = !paused;
      client.setPaused(paused);
      await extContext?.globalState.update('linesync.paused', paused);
      vscode.window.showInformationMessage(`LineSync: Sync ${paused ? 'paused' : 'resumed'}.`);
    }),

    vscode.commands.registerCommand('linesync.explainIgnore', async (uri?: vscode.Uri) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        vscode.window.showErrorMessage('LineSync: Open a workspace folder first.');
        return;
      }

      const fsPath = uri?.scheme === 'file'
        ? uri.fsPath
        : vscode.window.activeTextEditor?.document.uri.scheme === 'file'
          ? vscode.window.activeTextEditor.document.uri.fsPath
          : '';
      if (!fsPath) {
        vscode.window.showErrorMessage('LineSync: Select a file.');
        return;
      }
      const rel = fsPath.startsWith(root) ? fsPath.slice(root.length).replace(/\\/g, '/').replace(/^\/+/, '') : '';
      if (!rel) {
        vscode.window.showErrorMessage('LineSync: File is outside the workspace.');
        return;
      }

      const cfg = vscode.workspace.getConfiguration('linesync');
      const rawPatterns: string[] = cfg.get('ignorePatterns') ?? [];
      const matcher = new IgnoreMatcher(rawPatterns);
      const reason = matcher.explain(rel);
      if (reason) {
        vscode.window.showInformationMessage(`LineSync: "${rel}" is ignored by pattern: ${reason}`);
      } else {
        vscode.window.showInformationMessage(`LineSync: "${rel}" is not ignored by ignorePatterns.`);
      }
    }),

    vscode.commands.registerCommand('linesync.showMenu', async () => {
      const isConnected = !!client;
      const copyLabel = isConnected ? `Copy session code (${client!.getSessionId()})` : null;
      
      const picks: { label: string; id: string; description?: string }[] = [];
      if (isConnected) picks.push({ label: '$(clippy) ' + copyLabel, id: 'copy' });
      
      picks.push(
        { label: isConnected ? '$(stop) Disconnect' : '$(broadcast) Start new session', id: isConnected ? 'disconnect' : 'start' },
        { label: '$(plug) Join session', id: 'join' }
      );

      if (isConnected && client!.isHostUser()) {
        picks.push({ label: '$(person) Manage peers', id: 'managePeers', description: 'Kick or ban (Host only)' });
      }

      picks.push(
        { label: '$(gear) Open settings', id: 'settings' },
        { label: '$(history) Show backups', id: 'backups' },
        { label: '$(debug) Doctor', id: 'doctor', description: 'Check config and relay connectivity' },
        { label: '$(sync) Resync current file', id: 'resync', description: 'Request latest file state from host' },
        { label: paused ? '$(play) Resume sync' : '$(debug-pause) Pause sync', id: 'pause', description: 'Stops sending your changes (still receives)' }
      );
      
      const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'LineSync' });
      if (!pick) return;
      if (pick.id === 'copy') vscode.commands.executeCommand('linesync.copySessionCode');
      if (pick.id === 'disconnect') vscode.commands.executeCommand('linesync.disconnect');
      if (pick.id === 'start') vscode.commands.executeCommand('linesync.startSession');
      if (pick.id === 'join') vscode.commands.executeCommand('linesync.joinSession');
      if (pick.id === 'managePeers') vscode.commands.executeCommand('linesync.managePeers');
      if (pick.id === 'settings') vscode.commands.executeCommand('workbench.action.openSettings', 'linesync');
      if (pick.id === 'backups') vscode.commands.executeCommand('linesync.showBackups');
      if (pick.id === 'doctor') vscode.commands.executeCommand('linesync.doctor');
      if (pick.id === 'resync') vscode.commands.executeCommand('linesync.resyncFile');
      if (pick.id === 'pause') vscode.commands.executeCommand('linesync.togglePause');
    })
  );

  vscode.commands.executeCommand('setContext', 'linesync.active', false);
}

export function deactivate() {
  client?.disconnect();
  decorationManager?.dispose();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function startSession(
  context: vscode.ExtensionContext,
  sessionId: string,
  mode: 'host' | 'guest',
  guestPasswordFromToken?: string
) {
  if (client) {
    client.disconnect();
    client = undefined;
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

  client = new SyncClient(
    relayUrl,
    sessionId,
    userName,
    sessionPassword,
    decorationManager!,
    context
  );
  client.setPaused(paused);

  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'LineSync: Connecting...',
      cancellable: true
    }, async (_, token) => {
      token.onCancellationRequested(() => client?.disconnect());
      await client!.connect();
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
    client = undefined;
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
  return relayUrl || relayUrls[0];
}

async function resolveRelayUrlForJoin(cfg: vscode.WorkspaceConfiguration, sessionId: string): Promise<string | undefined> {
  const relayUrl = (cfg.get<string>('relayUrl', '') || '').trim();
  const relayUrls = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);

  if (relayUrl && relayUrl !== 'auto') {
    return relayUrl;
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
      if (found) return found;
      vscode.window.showErrorMessage(`LineSync: Could not find session ${sessionId} on any configured relay.`);
      return undefined;
    }
  );
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
