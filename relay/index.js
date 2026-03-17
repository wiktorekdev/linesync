const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const http = require('http');
const url = require('url');

const PORT   = process.env.PORT   || 3000;
const SECRET = process.env.RELAY_SECRET || '';

const SIZE_LIMITS = {
  patch:             512  * 1024,
  file_state_chunk:  128  * 1024,
  cursor:            1    * 1024,
  file_deleted:      1    * 1024,
  request_sync:      1    * 1024,
  conflict_resolve:  256  * 1024,
  enc:               1024 * 1024,
  admin_kick:        1    * 1024,
  admin_ban:         1    * 1024,
  _default:          64   * 1024,
};

const RATE_LIMIT  = 300;
const RATE_WINDOW = 10_000;
const msgCount    = new WeakMap();

function isRateLimited(ws) {
  const now = Date.now();
  let r = msgCount.get(ws);
  if (!r || now > r.resetAt) {
    r = { count: 0, resetAt: now + RATE_WINDOW };
    msgCount.set(ws, r);
  }
  return ++r.count > RATE_LIMIT;
}

// sessions: Map<sessionId, { passwordHash: string|null, peers: Map<peerId, {...}>, bannedIps:Set, bannedTokens:Set }>
const sessions = new Map();

const joinAttempts = new Map(); // ip -> { count, resetAt }
function isJoinRateLimited(ip) {
  const now = Date.now();
  let r = joinAttempts.get(ip);
  if (!r || now > r.resetAt) {
    r = { count: 0, resetAt: now + 60_000 };
    joinAttempts.set(ip, r);
  }
  r.count++;
  return r.count > 10;
}

function normalizeSessionId(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 16);
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', body.length);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const parsed = url.parse(req.url || '', true);

  if (req.method === 'GET' && parsed.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/config') {
    sendJson(res, 200, { requirePassword: true });
    return;
  }

  if (req.method === 'GET' && typeof parsed.pathname === 'string' && parsed.pathname.startsWith('/session/')) {
    if (isJoinRateLimited(remoteIp)) {
      sendJson(res, 429, { error: 'rate_limited' });
      return;
    }
    const code = parsed.pathname.slice('/session/'.length);
    const sid = normalizeSessionId(code);
    if (!sid || sid.length < 4) {
      sendJson(res, 400, { error: 'bad_session' });
      return;
    }
    sendJson(res, sessions.has(sid) ? 200 : 404, { ok: sessions.has(sid) });
    return;
  }

  res.statusCode = 404;
  res.end('not found');
});

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: {
    zlibDeflateOptions:  { level: 6, memLevel: 8 },
    zlibInflateOptions:  { chunkSize: 32 * 1024 },
    threshold:           512,
    concurrencyLimit:    20,
    serverMaxWindowBits: 15,
    clientMaxWindowBits: 15,
  },
  maxPayload: 2 * 1024 * 1024,
});

function broadcast(sessionId, message, excludePeerId = null) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const data = JSON.stringify(message);
  for (const [peerId, peer] of session.peers) {
    if (peerId !== excludePeerId && peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(data);
    }
  }
}

function getHostPeerId(session) {
  const ids = [...session.peers.keys()].sort();
  return ids[0] || null;
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function log(event, fields) {
  const base = { ts: new Date().toISOString(), event };
  console.log(JSON.stringify({ ...base, ...fields }));
}

function isValidEncEnvelope(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.iv !== 'string' || typeof msg.data !== 'string') return false;
  // base64 sanity - cheap checks to avoid throwing
  if (msg.iv.length < 8 || msg.iv.length > 64) return false;
  if (msg.data.length < 16 || msg.data.length > 2_000_000) return false;
  let iv;
  let data;
  try {
    iv = Buffer.from(msg.iv, 'base64');
    data = Buffer.from(msg.data, 'base64');
  } catch {
    return false;
  }
  // AES-GCM expects 12-byte nonce in our protocol
  if (iv.length !== 12) return false;
  // ciphertext includes auth tag, so should not be tiny
  if (data.length < 16) return false;
  return true;
}

wss.on('connection', (ws, req) => {
  let currentSession = null;
  let currentPeerId  = null;
  const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  ws._lastHeartbeatAt = Date.now();

  ws.on('message', (raw) => {
    ws._lastHeartbeatAt = Date.now();
    if (isRateLimited(ws)) {
      send(ws, { type: 'error', code: 'rate_limited', message: 'Slow down' });
      return;
    }

    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    const limit = SIZE_LIMITS[msg.type] ?? SIZE_LIMITS._default;
    if (raw.length > limit) {
      send(ws, { type: 'error', code: 'too_large', message: `'${msg.type}' exceeds ${limit / 1024} KB` });
      return;
    }

    switch (msg.type) {

      case 'ping':
        ws._lastHeartbeatAt = Date.now();
        send(ws, { type: 'pong', ts: msg.ts });
        return;

      case 'join': {
        if (isJoinRateLimited(remoteIp)) {
          send(ws, { type: 'error', code: 'rate_limited', message: 'Too many join attempts' });
          ws.close(4008, 'Rate limited');
          return;
        }
        if (SECRET && msg.secret !== SECRET) {
          send(ws, { type: 'error', code: 'unauthorized', message: 'Wrong secret' });
          ws.close(4001, 'Unauthorized');
          return;
        }

        currentSession = normalizeSessionId(msg.session);
        if (currentSession.length < 4) {
          send(ws, { type: 'error', code: 'bad_session', message: 'Invalid session code' });
          return;
        }

        const peerName = String(msg.peerName || 'Anonymous').substring(0, 32);
        currentPeerId  = randomUUID();
        const clientToken = String(msg.clientToken || '').substring(0, 128);

        if (!sessions.has(currentSession)) {
          sessions.set(currentSession, { passwordHash: null, peers: new Map(), bannedIps: new Set(), bannedTokens: new Set() });
          log('session_created', { session: currentSession });
        }
        const session = sessions.get(currentSession);
        if (session.bannedIps && session.bannedIps.has(remoteIp)) {
          send(ws, { type: 'error', code: 'banned', message: 'You are banned from this session' });
          ws.close(4011, 'Banned');
          return;
        }
        if (clientToken && session.bannedTokens && session.bannedTokens.has(clientToken)) {
          send(ws, { type: 'error', code: 'banned', message: 'You are banned from this session' });
          ws.close(4011, 'Banned');
          return;
        }

        const incomingPasswordHash = String(msg.password || '').substring(0, 256);
        if (!incomingPasswordHash) {
          send(ws, { type: 'error', code: 'password_required', message: 'Password required by relay' });
          ws.close(4004, 'Password required');
          return;
        }
        if (session.passwordHash) {
          if (incomingPasswordHash !== session.passwordHash) {
            send(ws, { type: 'error', code: 'bad_password', message: 'Wrong session password' });
            ws.close(4003, 'Wrong session password');
            return;
          }
        } else if (incomingPasswordHash) {
          // First join can set the session password hash
          session.passwordHash = incomingPasswordHash;
        }

        if (session.peers.size >= 10) {
          send(ws, { type: 'error', code: 'session_full', message: 'Session full (max 10)' });
          ws.close(4002, 'Session full');
          return;
        }

        const existingPeers = [...session.peers.entries()].map(([id, p]) => ({
          peerId: id, peerName: p.name,
        }));

        send(ws, { type: 'session_info', peerId: currentPeerId, peers: existingPeers });
        broadcast(currentSession, { type: 'peer_joined', peerId: currentPeerId, peerName });

        session.peers.set(currentPeerId, { ws, name: peerName, joinedAt: Date.now(), ip: remoteIp, token: clientToken || null });
        log('peer_joined', { session: currentSession, peerId: currentPeerId, name: peerName, ip: remoteIp, peers: session.peers.size });
        break;
      }

      // All these are forwarded as-is with sender stamp
      case 'patch':
      case 'cursor':
      case 'file_state_chunk':
      case 'file_state_done':
      case 'file_deleted':       // scenario 6
      case 'request_sync':
      case 'conflict_resolve': {
        if (!currentSession) return;
        broadcast(currentSession, { ...msg, from: currentPeerId }, currentPeerId);
        break;
      }
      case 'enc': {
        if (!currentSession) return;
        if (!isValidEncEnvelope(msg)) {
          send(ws, { type: 'error', code: 'bad_message', message: 'Invalid enc envelope' });
          return;
        }
        broadcast(currentSession, { ...msg, from: currentPeerId }, currentPeerId);
        break;
      }

      case 'admin_kick':
      case 'admin_ban': {
        if (!currentSession || !currentPeerId) return;
        const session = sessions.get(currentSession);
        if (!session) return;
        const hostId = getHostPeerId(session);
        if (hostId !== currentPeerId) {
          send(ws, { type: 'error', code: 'forbidden', message: 'Host only' });
          return;
        }
        const targetPeerId = String(msg.peerId || '');
        if (!targetPeerId) return;
        const peer = session.peers.get(targetPeerId);
        if (!peer) return;
        if (msg.type === 'admin_ban' && session.bannedIps) {
          session.bannedIps.add(peer.ip);
        }
        if (msg.type === 'admin_ban' && session.bannedTokens && peer.token) {
          session.bannedTokens.add(peer.token);
        }
        log(msg.type === 'admin_ban' ? 'peer_banned' : 'peer_kicked', {
          session: currentSession,
          byPeerId: currentPeerId,
          targetPeerId,
          targetName: peer.name,
          targetIp: peer.ip,
          tokenBanned: !!peer.token,
        });
        try { peer.ws.close(4010, msg.type === 'admin_ban' ? 'Banned' : 'Kicked'); } catch {}
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!currentSession || !currentPeerId) return;
    const session = sessions.get(currentSession);
    if (!session) return;
    const peer = session.peers.get(currentPeerId);
    session.peers.delete(currentPeerId);
    broadcast(currentSession, { type: 'peer_left', peerId: currentPeerId });
    log('peer_left', { session: currentSession, peerId: currentPeerId, name: peer?.name || null, peers: session.peers.size });
    if (session.peers.size === 0) {
      sessions.delete(currentSession);
      log('session_closed', { session: currentSession });
    }
  });

  ws.on('error', () => ws.terminate());
});

// Stale peer cleanup (missing 2 heartbeats ~= 30s)
setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    for (const [pid, peer] of session.peers) {
      if (peer.ws.readyState !== WebSocket.OPEN) {
        session.peers.delete(pid);
        continue;
      }
      const last = peer.ws._lastHeartbeatAt || peer.joinedAt;
      if (now - last > 35_000) {
        try { peer.ws.close(4007, 'Heartbeat timeout'); } catch {}
        session.peers.delete(pid);
      }
    }
    if (session.peers.size === 0) sessions.delete(sid);
  }
}, 10_000);

server.on('listening', () => {
  const auth = SECRET ? 'auth ON' : 'no auth (set RELAY_SECRET)';
  log('relay_listening', { port: Number(PORT), auth, password: 'password REQUIRED', compression: true });
});

server.listen(PORT);
