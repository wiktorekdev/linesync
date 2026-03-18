const { normalizeSessionId } = require('./ids');

class SessionStore {
  constructor(initialRows = [], opts = {}) {
    this.maxSessions = toFinitePositiveInt(opts.maxSessions, Number.POSITIVE_INFINITY);
    this.maxBannedIpsPerSession = toFinitePositiveInt(opts.maxBannedIpsPerSession, Number.POSITIVE_INFINITY);
    this.maxBannedTokensPerSession = toFinitePositiveInt(opts.maxBannedTokensPerSession, Number.POSITIVE_INFINITY);
    this.sessions = new Map();
    this.hydrate(initialRows);
  }

  has(sessionId) {
    const sid = normalizeSessionId(sessionId);
    return !!sid && this.sessions.has(sid);
  }

  get(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return null;
    return this.sessions.get(sid) || null;
  }

  ensure(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return null;
    let session = this.sessions.get(sid);
    if (!session) {
      if (this.sessions.size >= this.maxSessions) return null;
      session = this.#createSession();
      this.sessions.set(sid, session);
    }
    session.updatedAt = Date.now();
    return session;
  }

  delete(sessionId) {
    const sid = normalizeSessionId(sessionId);
    if (!sid) return false;
    return this.sessions.delete(sid);
  }

  forEach(callback) {
    this.sessions.forEach((value, key) => callback(value, key));
  }

  size() {
    return this.sessions.size;
  }

  evictIdle(now = Date.now(), idleTtlMs = 0) {
    const ttl = Number(idleTtlMs);
    if (!Number.isFinite(ttl) || ttl <= 0) return 0;

    let removed = 0;
    for (const [sid, session] of this.sessions) {
      const idleSince = Number.isFinite(session.updatedAt)
        ? session.updatedAt
        : (Number.isFinite(session.createdAt) ? session.createdAt : now);
      if (session.peers.size === 0 && now - idleSince >= ttl) {
        this.sessions.delete(sid);
        removed += 1;
      }
    }
    return removed;
  }

  toPersistable() {
    const rows = [];
    for (const [sessionId, session] of this.sessions) {
      rows.push({
        sessionId,
        passwordHash: session.passwordHash || null,
        hostClientToken: session.hostClientToken || null,
        bannedIps: [...session.bannedIps],
        bannedTokens: [...session.bannedTokens],
        createdAt: session.createdAt || Date.now(),
        updatedAt: session.updatedAt || Date.now(),
      });
    }
    return rows;
  }

  hydrate(rows) {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      const sid = normalizeSessionId(row && row.sessionId);
      if (!sid) continue;
      const session = this.#createSession();
      session.passwordHash = typeof row.passwordHash === 'string' && row.passwordHash ? row.passwordHash : null;
      session.hostClientToken = typeof row.hostClientToken === 'string' && row.hostClientToken ? row.hostClientToken : null;
      if (Array.isArray(row.bannedIps)) {
        for (const ip of row.bannedIps) {
          if (session.bannedIps.size >= this.maxBannedIpsPerSession) break;
          const value = String(ip || '').trim();
          if (value) session.bannedIps.add(value);
        }
      }
      if (Array.isArray(row.bannedTokens)) {
        for (const token of row.bannedTokens) {
          if (session.bannedTokens.size >= this.maxBannedTokensPerSession) break;
          const value = String(token || '').trim();
          if (value) session.bannedTokens.add(value);
        }
      }
      const createdAt = Number(row && row.createdAt);
      const updatedAt = Number(row && row.updatedAt);
      session.createdAt = Number.isFinite(createdAt) ? createdAt : Date.now();
      session.updatedAt = Number.isFinite(updatedAt) ? updatedAt : Date.now();
      this.sessions.set(sid, session);
      if (this.sessions.size >= this.maxSessions) break;
    }
  }

  #createSession() {
    const now = Date.now();
    return {
      passwordHash: null,
      hostClientToken: null,
      peers: new Map(),
      bannedIps: new Set(),
      bannedTokens: new Set(),
      createdAt: now,
      updatedAt: now,
    };
  }
}

function toFinitePositiveInt(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

module.exports = {
  SessionStore,
};
