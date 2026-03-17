const { normalizeSessionId } = require('./ids');

class SessionStore {
  constructor(initialRows = []) {
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

  toPersistable() {
    const rows = [];
    for (const [sessionId, session] of this.sessions) {
      rows.push({
        sessionId,
        passwordHash: session.passwordHash || null,
        bannedIps: [...session.bannedIps],
        bannedTokens: [...session.bannedTokens],
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
      if (Array.isArray(row.bannedIps)) {
        for (const ip of row.bannedIps) {
          const value = String(ip || '').trim();
          if (value) session.bannedIps.add(value);
        }
      }
      if (Array.isArray(row.bannedTokens)) {
        for (const token of row.bannedTokens) {
          const value = String(token || '').trim();
          if (value) session.bannedTokens.add(value);
        }
      }
      session.updatedAt = Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now();
      this.sessions.set(sid, session);
    }
  }

  #createSession() {
    return {
      passwordHash: null,
      peers: new Map(),
      bannedIps: new Set(),
      bannedTokens: new Set(),
      updatedAt: Date.now(),
    };
  }
}

module.exports = {
  SessionStore,
};
