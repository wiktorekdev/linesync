import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { IgnoreMatcher } from './ignoreMatcher';
import { DecorationManager } from './decorationManager';
import { FilePresenceDecorations } from './filePresenceDecorations';
import WebSocket from 'ws';
import { Transport } from './transport';
import { SyncEngine } from './syncEngine';
import {
  isLikelySessionToken,
  issueSessionToken,
  resolveSessionTokenOnRelay,
  revokeSessionTokenOnRelay,
} from './sessionTokenService';

let transport: Transport | undefined;
let engine: SyncEngine | undefined;
let decorationManager: DecorationManager | undefined;
let filePresenceDecorations: FilePresenceDecorations | undefined;
let output: vscode.OutputChannel | undefined;
let paused = false;
let extContext: vscode.ExtensionContext | undefined;
let currentSessionId: string | undefined;
let currentJoinToken: string | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let peerCount = 0;
let lastRttMs: number | null = null;
let currentRelayUrl: string | undefined;
let currentMode: 'host' | 'guest' | undefined;

const RELAY_HEALTH_KEY = 'linesync.relayHealthV2';
const LAST_GOOD_RELAY_KEY = 'linesync.lastGoodRelay';

type RelayHealthRecord = {
  ewmaMs: number;
  failStreak: number;
  lastSeen: number;
  lastScore: number;
};

type RelayProbeSummary = {
  url: string;
  successCount: number;
  failCount: number;
  medianMs: number;
  p90Ms: number;
  score: number;
};

export function activate(context: vscode.ExtensionContext) {
  decorationManager = new DecorationManager(context);
  filePresenceDecorations = new FilePresenceDecorations(decorationManager);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(filePresenceDecorations));
  context.subscriptions.push(filePresenceDecorations);
  output = vscode.window.createOutputChannel('LineSync');
  context.subscriptions.push(output);
  extContext = context;
  paused = context.globalState.get<boolean>('linesync.paused', false);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'linesync.showMenu';
  context.subscriptions.push(statusBar);
  setActiveUi(false);
  void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', false);

  context.subscriptions.push(
    vscode.commands.registerCommand('linesync.startSession', async () => {
      if (!checkWorkspace()) return;
      if (!await checkConfig()) return;
      await startSession(context, 'host');
    }),

    vscode.commands.registerCommand('linesync.joinSession', async () => {
      if (!checkWorkspace()) return;
      if (!await checkConfig()) return;

      const sessionTokenInput = await vscode.window.showInputBox({
        title: 'Join LineSync Session',
        prompt: 'Session token',
        placeHolder: 'Paste token',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!isLikelySessionToken(v.trim())) return 'Invalid session token';
          return null;
        }
      });
      if (!sessionTokenInput) return;
      await startSession(context, 'guest', sessionTokenInput.trim());
    }),

    vscode.commands.registerCommand('linesync.disconnect', async () => {
      if (currentMode === 'host' && currentRelayUrl && currentJoinToken) {
        try {
          const relaySecret = vscode.workspace.getConfiguration('linesync').get<string>('relaySecret', '') ?? '';
          await revokeSessionTokenOnRelay(
            currentRelayUrl,
            currentJoinToken,
            relaySecret,
            2500,
            isLocalWsRelay(currentRelayUrl)
          );
        } catch {
          // best-effort revocation
        }
      }
      transport?.disconnect();
      transport = undefined;
      engine?.dispose();
      engine = undefined;
      decorationManager?.clearAll();
      filePresenceDecorations?.setPresenceByFile(new Map());
      paused = false;
      extContext?.globalState.update('linesync.paused', false);
      peerCount = 0;
      lastRttMs = null;
      currentRelayUrl = undefined;
      currentMode = undefined;
      currentJoinToken = undefined;
      currentSessionId = undefined;
      void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', false);
      setActiveUi(false);
      vscode.window.showInformationMessage('LineSync: Disconnected');
    }),

    vscode.commands.registerCommand('linesync.copySessionInvite', async () => {
      if (!transport) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      if (currentMode !== 'host') {
        vscode.window.showWarningMessage('LineSync: Only the host can share the session token.');
        return;
      }
      const token = currentJoinToken ?? '';
      if (!token) {
        vscode.window.showWarningMessage('LineSync: Session token is unavailable right now.');
        return;
      }
      await vscode.env.clipboard.writeText(token);
      vscode.window.showInformationMessage('LineSync: Session token copied.');
    }),

    vscode.commands.registerCommand('linesync.openSettings', async () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'linesync');
    }),

    vscode.commands.registerCommand('linesync.followPeer', async () => {
      if (!engine) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      await engine.followPeer();
    }),

    vscode.commands.registerCommand('linesync.toggleFocusFollow', async () => {
      if (!engine) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      if (engine.isFocusFollowModeActive()) {
        engine.stopFocusFollowMode(true);
        void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', false);
        setActiveUi(!!transport);
        return;
      }
      const enabled = await engine.startFocusFollowMode();
      void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', enabled);
      setActiveUi(!!transport);
    }),

    vscode.commands.registerCommand('linesync.resyncFile', async (resource?: vscode.Uri) => {
      if (!engine) {
        vscode.window.showInformationMessage('LineSync: Not currently in a session');
        return;
      }
      const target = resolveTargetFileUri(resource);
      if (!target) {
        vscode.window.showInformationMessage('LineSync: Select a file in Explorer or open one in the editor.');
        return;
      }
      const result = await engine.resyncFile(target);
      if (!result.ok) {
        vscode.window.showWarningMessage(`LineSync: ${result.reason ?? 'Resync failed.'}`);
        return;
      }
      vscode.window.showInformationMessage(`LineSync: Requested resync for ${result.file}`);
    }),

    vscode.commands.registerCommand('linesync.explainIgnore', async (resource?: vscode.Uri) => {
      const target = resolveTargetFileUri(resource);
      if (!target) {
        vscode.window.showInformationMessage('LineSync: Select a file in Explorer or open one in the editor.');
        return;
      }
      const rel = toWorkspaceRelativePath(target);
      if (!rel) {
        vscode.window.showInformationMessage('LineSync: File is outside the current workspace.');
        return;
      }
      const cfg = vscode.workspace.getConfiguration('linesync');
      const patterns = (cfg.get<string[]>('ignorePatterns') ?? []).filter(Boolean);
      const matcher = new IgnoreMatcher(patterns);
      const matched = matcher.explain(rel);
      if (matched) {
        vscode.window.showInformationMessage(`LineSync: Ignored (${matched})`);
      } else {
        vscode.window.showInformationMessage('LineSync: Not ignored by linesync.ignorePatterns');
      }
    }),

    vscode.commands.registerCommand('linesync.showMenu', async () => {
      const isConnected = !!transport;
      
      const picks: { label: string; id: string; description?: string }[] = [];
      if (!isConnected) {
        picks.push(
          { label: '$(broadcast) Start Session', id: 'start', description: 'Create a new private session' },
          { label: '$(plug) Join Session', id: 'join', description: 'Join with a session token' },
          { label: '$(gear) Open Settings', id: 'settings' },
        );
      } else {
        const focusFollowActive = engine?.isFocusFollowModeActive() ?? false;
        if (currentMode === 'host') {
          picks.push({ label: '$(mail) Copy Session Token', id: 'copyInvite', description: 'Share to invite someone' });
        }
        picks.push(
          { label: '$(file) Browse Shared Files', id: 'browseRemote', description: 'Open peer files on demand' },
          { label: '$(eye) Follow Peer', id: 'followPeer', description: 'Jump to a peer cursor' },
          {
            label: focusFollowActive ? '$(debug-stop) Stop Focus Follow' : '$(target) Start Focus Follow',
            id: 'toggleFocusFollow',
            description: focusFollowActive ? 'Stop auto-following a peer' : 'Keep viewport synced to one peer',
          },
          { label: '$(sync) Resync Active File', id: 'resyncActive', description: 'Request a safe file snapshot' },
          { label: '$(stop) Disconnect', id: 'disconnect' },
        );
      }
      
      const pick = await vscode.window.showQuickPick(picks, {
        placeHolder: isConnected ? 'Session actions' : 'Start or join a session',
      });
      if (!pick) return;
      if (pick.id === 'copyInvite') vscode.commands.executeCommand('linesync.copySessionInvite');
      if (pick.id === 'disconnect') vscode.commands.executeCommand('linesync.disconnect');
      if (pick.id === 'start') vscode.commands.executeCommand('linesync.startSession');
      if (pick.id === 'join') vscode.commands.executeCommand('linesync.joinSession');
      if (pick.id === 'browseRemote') engine?.showRemoteFileBrowser();
      if (pick.id === 'followPeer') engine?.followPeer();
      if (pick.id === 'toggleFocusFollow') vscode.commands.executeCommand('linesync.toggleFocusFollow');
      if (pick.id === 'resyncActive') vscode.commands.executeCommand('linesync.resyncFile');
      if (pick.id === 'settings') vscode.commands.executeCommand('linesync.openSettings');
    })
  );

}

function setActiveUi(active: boolean) {
  vscode.commands.executeCommand('setContext', 'linesync.active', active);
  if (!statusBar) return;
  if (!active) {
    statusBar.text = '$(radio-tower) LineSync';
    statusBar.tooltip = 'LineSync: Disconnected\nClick to open LineSync menu';
    statusBar.show();
    return;
  }
  const peersText = `${peerCount} peer${peerCount === 1 ? '' : 's'}`;
  const rttText = lastRttMs !== null ? `  ${Math.round(lastRttMs)}ms` : '';
  const relay = currentRelayUrl ?? '';
  const relayRegion = relay.includes('linesync-us') ? 'US'
    : relay.includes('linesync-de') ? 'EU'
    : relay.includes('linesync-sg') ? 'APAC'
    : relay.startsWith('wss://') || relay.startsWith('ws://') ? 'Custom'
    : '';
  const roleLabel = currentMode === 'guest' ? 'Peer' : currentMode === 'host' ? 'Host' : '';
  const regionText = relayRegion ? ` ${relayRegion}` : '';
  const roleText = roleLabel ? ` ${roleLabel}` : '';
  const focusFollowText = engine?.isFocusFollowModeActive() ? '  FF' : '';
  statusBar.text = `$(radio-tower) LineSync${regionText}${roleText}  ${peersText}${rttText}${focusFollowText}`.trim();
  statusBar.tooltip = [
    `LineSync: Connected${relayRegion ? ` (${relayRegion})` : ''}`,
    roleLabel ? `Role: ${roleLabel}` : null,
    engine?.isFocusFollowModeActive() ? 'Focus Follow: On' : null,
    `Peers: ${peerCount}`,
    lastRttMs !== null ? `RTT: ${Math.round(lastRttMs)} ms` : null,
    '',
    'Click to open LineSync menu',
  ].filter(Boolean).join('\n');
  statusBar.show();
}

export function deactivate() {
  transport?.disconnect();
  engine?.dispose();
  decorationManager?.dispose();
  filePresenceDecorations?.dispose();
}

// Helpers

async function startSession(
  context: vscode.ExtensionContext,
  mode: 'host' | 'guest',
  guestSessionToken?: string
) {
  if (transport) {
    transport.disconnect();
    transport = undefined;
    engine?.dispose();
    engine = undefined;
    decorationManager?.clearAll();
    filePresenceDecorations?.setPresenceByFile(new Map());
    void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', false);
  }

  const cfg = vscode.workspace.getConfiguration('linesync');
  const relaySecret = cfg.get<string>('relaySecret', '') ?? '';
  let relayUrl: string | undefined;
  let sessionId = '';
  let sessionSecret = '';
  let sessionToken = '';
  let allowInsecureRelay = false;

  if (mode === 'host') {
    relayUrl = await resolveRelayUrlForHost(context, cfg);
    if (!relayUrl) return;
    allowInsecureRelay = isLocalWsRelay(relayUrl);
    try {
      const issued = await issueSessionToken(relayUrl, relaySecret, 3500, allowInsecureRelay);
      sessionId = issued.sessionId;
      sessionSecret = issued.sessionSecret;
      sessionToken = issued.token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`LineSync: Failed to create session token - ${msg}`);
      return;
    }
  } else {
    const token = (guestSessionToken ?? '').trim();
    if (!isLikelySessionToken(token)) {
      vscode.window.showErrorMessage('LineSync: Invalid session token.');
      return;
    }
    const relayCandidates = collectRelayCandidatesForJoin(context, cfg);
    if (relayCandidates.length === 0) {
      vscode.window.showErrorMessage('LineSync: No valid relay URLs configured.');
      return;
    }
    const resolved = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'LineSync: Resolving session token...', cancellable: false },
      async () => {
        for (const candidate of relayCandidates) {
          try {
            const result = await resolveSessionTokenOnRelay(
              candidate,
              token,
              relaySecret,
              3000,
              isLocalWsRelay(candidate)
            );
            return { relayUrl: candidate, result };
          } catch {
            // try next relay candidate
          }
        }
        return null;
      }
    );
    if (!resolved) {
      vscode.window.showErrorMessage('LineSync: Session token was not recognized on configured relays.');
      return;
    }
    relayUrl = resolved.relayUrl;
    allowInsecureRelay = isLocalWsRelay(relayUrl);
    sessionId = resolved.result.sessionId;
    sessionSecret = resolved.result.sessionSecret;
    sessionToken = token;
  }

  let userName = cfg.get<string>('userName', '').trim();
  if (!userName) userName = await getOrCreateAnonymousName(context);
  if (!userName) userName = 'Anonymous';

  currentRelayUrl = relayUrl;
  currentMode = mode;
  currentSessionId = sessionId;
  currentJoinToken = sessionToken;

  let clientToken = context.globalState.get<string>('linesync.clientToken') ?? '';
  if (!clientToken) {
    clientToken = crypto.randomUUID();
    await context.globalState.update('linesync.clientToken', clientToken);
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
        sessionSecret,
        relaySecret,
        clientToken,
        allowInsecureRelay,
        (e) => {
          if (e.type === 'session_info') {
            peerCount = (Array.isArray(e.peers) ? e.peers.length : 0) + 1;
            setActiveUi(true);
          } else if (e.type === 'peer_joined') {
            peerCount = Math.max(1, peerCount + 1);
            setActiveUi(true);
          } else if (e.type === 'peer_left') {
            peerCount = Math.max(1, peerCount - 1);
            setActiveUi(true);
          } else if (e.type === 'rtt') {
            lastRttMs = e.rttMs;
            setActiveUi(true);
          } else if (e.type === 'error') {
            // keep prior state; UI will flip on disconnect/failure
          }
          engine?.handleTransportEvent(e);
        }
      );
      engine = new SyncEngine(
        transport,
        userName,
        decorationManager!,
        context,
        sessionId,
        mode,
        (presenceByFile) => filePresenceDecorations?.setPresenceByFile(presenceByFile)
      );
      engine.attach();
      token.onCancellationRequested(() => transport?.disconnect());
      await transport!.connect();
    });

    await context.globalState.update(LAST_GOOD_RELAY_KEY, relayUrl);
    setActiveUi(true);
    void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', false);
    
    if (mode === 'host') {
      const sessionToken = currentJoinToken ?? '';
      const action = await vscode.window.showInformationMessage(
        'LineSync: Session is ready. Token is hidden and not copied automatically.',
        'Copy token'
      );
      if (action === 'Copy token' && sessionToken) {
        await vscode.env.clipboard.writeText(sessionToken);
      }
    } else {
      vscode.window.showInformationMessage(`LineSync: Connected as "${userName}"`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    vscode.window.showErrorMessage(`LineSync: Failed to connect - ${msg}`);
    if (mode === 'host' && relayUrl && sessionToken) {
      try {
        await revokeSessionTokenOnRelay(relayUrl, sessionToken, relaySecret, 2500, allowInsecureRelay);
      } catch {
        // best-effort rollback
      }
    }
    transport = undefined;
    engine?.dispose();
    engine = undefined;
    filePresenceDecorations?.setPresenceByFile(new Map());
    currentRelayUrl = undefined;
    currentMode = undefined;
    currentSessionId = undefined;
    currentJoinToken = undefined;
    peerCount = 0;
    lastRttMs = null;
    void vscode.commands.executeCommand('setContext', 'linesync.focusFollow', false);
    setActiveUi(false);
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

async function resolveRelayUrlForHost(
  context: vscode.ExtensionContext,
  cfg: vscode.WorkspaceConfiguration
): Promise<string | undefined> {
  let relayUrl = (cfg.get<string>('relayUrl', '') || '').trim();
  const relayUrls = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);

  if (relayUrl === 'auto' && relayUrls.length > 0) {
    const probeTimeoutMs = clampInt(cfg.get<number>('relayProbeTimeoutMs', 1200) ?? 1200, 400, 5000);
    const probeSamples = clampInt(cfg.get<number>('relayProbeSamples', 3) ?? 3, 1, 6);
    relayUrl = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LineSync: selecting best relay', cancellable: false },
      async () => {
        const validated = relayUrls
          .map((u) => validateRelayUrl(u))
          .filter((u): u is string => !!u);
        if (validated.length === 0) return relayUrls[0];

        const ranked = await rankRelaysV2(context, validated, probeTimeoutMs, probeSamples);
        return ranked[0]?.url ?? validated[0];
      }
    );
  }
  const chosen = relayUrl || relayUrls[0];
  return validateRelayUrl(chosen);
}

function collectRelayCandidatesForJoin(context: vscode.ExtensionContext, cfg: vscode.WorkspaceConfiguration): string[] {
  const primary = (cfg.get<string>('relayUrl', '') || '').trim();
  const list = (cfg.get<string[]>('relayUrls') ?? []).map((u) => u.trim()).filter(Boolean);
  const out: string[] = [];
  const health = readRelayHealth(context);
  const lastGood = (context.globalState.get<string>(LAST_GOOD_RELAY_KEY) ?? '').trim();

  if (primary && primary !== 'auto') {
    const validated = validateRelayUrl(primary);
    if (validated) out.push(validated);
  }
  for (const candidate of list) {
    const validated = validateRelayUrl(candidate);
    if (!validated) continue;
    if (!out.includes(validated)) out.push(validated);
  }

  out.sort((a, b) => {
    if (a === lastGood) return -1;
    if (b === lastGood) return 1;
    const ah = health[a];
    const bh = health[b];
    const as = ah ? ah.ewmaMs + ah.failStreak * 200 : Number.POSITIVE_INFINITY;
    const bs = bh ? bh.ewmaMs + bh.failStreak * 200 : Number.POSITIVE_INFINITY;
    return as - bs;
  });
  return out;
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

function isLocalWsRelay(url: string): boolean {
  if (!url.startsWith('ws://')) return false;
  const host = url.slice('ws://'.length).split('/')[0].split(':')[0].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
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

async function rankRelaysV2(
  context: vscode.ExtensionContext,
  relayUrls: string[],
  timeoutMs: number,
  samples: number
): Promise<RelayProbeSummary[]> {
  const health = readRelayHealth(context);
  const results = await Promise.all(relayUrls.map((url) => probeRelaySummary(url, timeoutMs, samples, health[url])));
  const ranked = results.slice().sort((a, b) => a.score - b.score);
  await writeRelayHealth(context, ranked);
  return ranked;
}

async function probeRelaySummary(
  url: string,
  timeoutMs: number,
  samples: number,
  historical?: RelayHealthRecord
): Promise<RelayProbeSummary> {
  const latencies: number[] = [];
  for (let i = 0; i < samples; i++) {
    latencies.push(await probeRelay(url, timeoutMs));
  }

  const success = latencies.filter(Number.isFinite).sort((a, b) => a - b);
  const failCount = latencies.length - success.length;
  const medianMs = success.length ? percentile(success, 0.5) : timeoutMs * 2;
  const p90Ms = success.length ? percentile(success, 0.9) : timeoutMs * 2;
  const base = medianMs + Math.max(0, p90Ms - medianMs) * 0.6 + failCount * timeoutMs * 1.25;
  const historicalScore = historical ? historical.ewmaMs + historical.failStreak * 160 : base;
  const score = base * 0.7 + historicalScore * 0.3;

  return {
    url,
    successCount: success.length,
    failCount,
    medianMs,
    p90Ms,
    score,
  };
}

function percentile(values: number[], p: number): number {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const idx = Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * p)));
  return values[idx];
}

function readRelayHealth(context: vscode.ExtensionContext): Record<string, RelayHealthRecord> {
  const raw = context.globalState.get<Record<string, RelayHealthRecord> | null>(RELAY_HEALTH_KEY, null);
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

async function writeRelayHealth(context: vscode.ExtensionContext, ranked: RelayProbeSummary[]) {
  const now = Date.now();
  const next = readRelayHealth(context);
  for (const item of ranked) {
    const prev = next[item.url];
    const ewmaMs = prev ? prev.ewmaMs * 0.65 + item.medianMs * 0.35 : item.medianMs;
    const failStreak = item.successCount === 0
      ? Math.min((prev?.failStreak ?? 0) + 1, 30)
      : Math.max(0, (prev?.failStreak ?? 0) - 1);
    next[item.url] = {
      ewmaMs,
      failStreak,
      lastSeen: now,
      lastScore: item.score,
    };
  }
  await context.globalState.update(RELAY_HEALTH_KEY, next);
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function getOrCreateAnonymousName(context: vscode.ExtensionContext): Promise<string> {
  const existing = context.globalState.get<string>('linesync.anonName', '').trim();
  if (existing) return existing;
  const generated = `User-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  await context.globalState.update('linesync.anonName', generated);
  return generated;
}

function resolveTargetFileUri(resource?: vscode.Uri): vscode.Uri | null {
  if (resource?.scheme === 'file') return resource;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') return active;
  return null;
}

function toWorkspaceRelativePath(uri: vscode.Uri): string | null {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return null;
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return null;
  return rel;
}
