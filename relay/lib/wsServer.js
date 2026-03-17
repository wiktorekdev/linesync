const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const { SIZE_LIMITS, RATE_LIMIT, RATE_WINDOW_MS, MAX_SESSION_PEERS } = require('./constants');
const { normalizeSessionId, sanitizePeerName } = require('./ids');
const { remoteIpFromReq } = require('./httpRoutes');

function createWsServer(opts) {
  const {
    server,
    secret,
    sessionStore,
    joinLimiter,
    onStateChanged,
    log,
  } = opts;

  const msgCount = new WeakMap();

  const wss = new WebSocket.Server({
    server,
    perMessageDeflate: {
      zlibDeflateOptions: { level: 6, memLevel: 8 },
      zlibInflateOptions: { chunkSize: 32 * 1024 },
      threshold: 512,
      concurrencyLimit: 20,
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 15,
    },
    maxPayload: 2 * 1024 * 1024,
  });

  const isRateLimited = (ws) => {
    const now = Date.now();
    let r = msgCount.get(ws);
    if (!r || now > r.resetAt) {
      r = { count: 0, resetAt: now + RATE_WINDOW_MS };
      msgCount.set(ws, r);
    }
    r.count += 1;
    return r.count > RATE_LIMIT;
  };

  const send = (ws, message) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const broadcast = (sessionId, message, excludePeerId = null) => {
    const session = sessionStore.get(sessionId);
    if (!session) return;
    const data = JSON.stringify(message);
    for (const [peerId, peer] of session.peers) {
      if (peerId === excludePeerId) continue;
      if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(data);
    }
  };

  const getHostPeerId = (session) => {
    const ids = [...session.peers.keys()].sort();
    return ids[0] || null;
  };

  wss.on('connection', (ws, req) => {
    const remoteIp = remoteIpFromReq(req);
    let currentSessionId = null;
    let currentPeerId = null;
    ws._lastHeartbeatAt = Date.now();

    ws.on('message', (raw) => {
      ws._lastHeartbeatAt = Date.now();

      if (isRateLimited(ws)) {
        send(ws, { type: 'error', code: 'rate_limited', message: 'Slow down' });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const limit = SIZE_LIMITS[msg.type] || SIZE_LIMITS._default;
      if (raw.length > limit) {
        send(ws, { type: 'error', code: 'too_large', message: `'${msg.type}' exceeds ${Math.floor(limit / 1024)} KB` });
        return;
      }

      switch (msg.type) {
        case 'ping':
          ws._lastHeartbeatAt = Date.now();
          send(ws, { type: 'pong', ts: msg.ts });
          return;

        case 'join': {
          if (joinLimiter.hit(remoteIp)) {
            send(ws, { type: 'error', code: 'rate_limited', message: 'Too many join attempts' });
            ws.close(4008, 'Rate limited');
            return;
          }

          if (secret && msg.secret !== secret) {
            send(ws, { type: 'error', code: 'unauthorized', message: 'Wrong secret' });
            ws.close(4001, 'Unauthorized');
            return;
          }

          const sessionId = normalizeSessionId(msg.session);
          if (!sessionId || sessionId.length < 4) {
            send(ws, { type: 'error', code: 'bad_session', message: 'Invalid session id' });
            return;
          }

          const session = sessionStore.ensure(sessionId);
          if (!session) {
            send(ws, { type: 'error', code: 'bad_session', message: 'Invalid session id' });
            return;
          }

          const incomingPasswordHash = String(msg.password || '').substring(0, 256);
          if (!incomingPasswordHash) {
            send(ws, { type: 'error', code: 'password_required', message: 'Session token is required by relay' });
            ws.close(4004, 'Session token required');
            return;
          }

          if (session.passwordHash && incomingPasswordHash !== session.passwordHash) {
            send(ws, { type: 'error', code: 'bad_password', message: 'Invalid session token' });
            ws.close(4003, 'Invalid session token');
            return;
          }

          const clientToken = String(msg.clientToken || '').substring(0, 128);
          if (session.bannedIps.has(remoteIp) || (clientToken && session.bannedTokens.has(clientToken))) {
            send(ws, { type: 'error', code: 'banned', message: 'You are banned from this session' });
            ws.close(4011, 'Banned');
            return;
          }

          if (session.peers.size >= MAX_SESSION_PEERS) {
            send(ws, { type: 'error', code: 'session_full', message: `Session full (max ${MAX_SESSION_PEERS})` });
            ws.close(4002, 'Session full');
            return;
          }

          if (!session.passwordHash) {
            session.passwordHash = incomingPasswordHash;
            session.updatedAt = Date.now();
            onStateChanged();
            log('session_created', { session: sessionId });
          }

          currentSessionId = sessionId;
          currentPeerId = randomUUID();
          const peerName = sanitizePeerName(msg.peerName);

          const existingPeers = [...session.peers.entries()].map(([peerId, peer]) => ({
            peerId,
            peerName: peer.name,
          }));

          send(ws, { type: 'session_info', peerId: currentPeerId, peers: existingPeers });
          broadcast(sessionId, { type: 'peer_joined', peerId: currentPeerId, peerName }, currentPeerId);

          session.peers.set(currentPeerId, {
            ws,
            name: peerName,
            joinedAt: Date.now(),
            ip: remoteIp,
            token: clientToken || null,
          });
          session.updatedAt = Date.now();

          log('peer_joined', {
            session: sessionId,
            peerId: currentPeerId,
            name: peerName,
            ip: remoteIp,
            peers: session.peers.size,
          });
          return;
        }

        case 'enc':
          if (!currentSessionId || !currentPeerId) return;
          if (!isValidEncEnvelope(msg)) {
            send(ws, { type: 'error', code: 'bad_message', message: 'Invalid enc envelope' });
            return;
          }
          broadcast(currentSessionId, { ...msg, from: currentPeerId }, currentPeerId);
          return;

        case 'admin_kick':
        case 'admin_ban': {
          if (!currentSessionId || !currentPeerId) return;
          const session = sessionStore.get(currentSessionId);
          if (!session) return;
          const hostId = getHostPeerId(session);
          if (hostId !== currentPeerId) {
            send(ws, { type: 'error', code: 'forbidden', message: 'Host only' });
            return;
          }

          const targetPeerId = String(msg.peerId || '');
          if (!targetPeerId) return;
          const targetPeer = session.peers.get(targetPeerId);
          if (!targetPeer) return;

          if (msg.type === 'admin_ban') {
            session.bannedIps.add(targetPeer.ip);
            if (targetPeer.token) session.bannedTokens.add(targetPeer.token);
            session.updatedAt = Date.now();
            onStateChanged();
          }

          log(msg.type === 'admin_ban' ? 'peer_banned' : 'peer_kicked', {
            session: currentSessionId,
            byPeerId: currentPeerId,
            targetPeerId,
            targetName: targetPeer.name,
            targetIp: targetPeer.ip,
            tokenBanned: !!targetPeer.token,
          });

          try {
            targetPeer.ws.close(4010, msg.type === 'admin_ban' ? 'Banned' : 'Kicked');
          } catch {
            // ignore
          }
          return;
        }

        default:
          return;
      }
    });

    ws.on('close', () => {
      if (!currentSessionId || !currentPeerId) return;
      const session = sessionStore.get(currentSessionId);
      if (!session) return;

      const peer = session.peers.get(currentPeerId);
      session.peers.delete(currentPeerId);
      session.updatedAt = Date.now();

      broadcast(currentSessionId, { type: 'peer_left', peerId: currentPeerId }, currentPeerId);
      log('peer_left', {
        session: currentSessionId,
        peerId: currentPeerId,
        name: (peer && peer.name) || null,
        peers: session.peers.size,
      });

      if (session.peers.size === 0) {
        sessionStore.delete(currentSessionId);
        onStateChanged();
        log('session_closed', { session: currentSessionId });
      }
    });

    ws.on('error', () => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    });
  });

  setInterval(() => {
    const now = Date.now();
    sessionStore.forEach((session, sid) => {
      for (const [pid, peer] of session.peers) {
        if (peer.ws.readyState !== WebSocket.OPEN) {
          session.peers.delete(pid);
          continue;
        }
        const last = peer.ws._lastHeartbeatAt || peer.joinedAt;
        if (now - last > 35_000) {
          try {
            peer.ws.close(4007, 'Heartbeat timeout');
          } catch {
            // ignore
          }
          session.peers.delete(pid);
        }
      }
      if (session.peers.size === 0) {
        sessionStore.delete(sid);
        onStateChanged();
      }
    });
  }, 10_000);

  return wss;
}

function isValidEncEnvelope(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (typeof msg.iv !== 'string' || typeof msg.data !== 'string') return false;
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

  if (iv.length !== 12) return false;
  if (data.length < 16) return false;
  return true;
}

module.exports = {
  createWsServer,
};
