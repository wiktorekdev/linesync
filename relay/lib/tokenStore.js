const {
  DEFAULT_TOKEN_TTL_MS,
} = require('./constants');
const {
  normalizeSessionId,
  randomSessionId,
  randomSessionSecret,
  randomSessionToken,
  isLikelySessionToken,
} = require('./ids');

class TokenStore {
  constructor(opts = {}) {
    this.tokens = new Map();
    this.defaultTtlMs = Number(opts.defaultTtlMs) > 0 ? Number(opts.defaultTtlMs) : DEFAULT_TOKEN_TTL_MS;
    this.maxTokens = Number(opts.maxTokens) > 0 ? Math.floor(Number(opts.maxTokens)) : Number.POSITIVE_INFINITY;
    this.hydrate(opts.initialRows || []);
  }

  issue() {
    if (this.tokens.size >= this.maxTokens) {
      const err = new Error('token_store_full');
      err.code = 'token_store_full';
      throw err;
    }

    let token = randomSessionToken();
    while (this.tokens.has(token)) {
      token = randomSessionToken();
    }
    const sessionId = randomSessionId(8);
    const sessionSecret = randomSessionSecret();
    const now = Date.now();
    const record = {
      token,
      sessionId,
      sessionSecret,
      createdAt: now,
      expiresAt: now + this.defaultTtlMs,
    };
    this.tokens.set(token, record);
    return record;
  }

  resolve(token) {
    const key = String(token || '').trim();
    if (!isLikelySessionToken(key)) return null;
    const record = this.tokens.get(key);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.tokens.delete(key);
      return null;
    }
    return record;
  }

  revoke(token) {
    const key = String(token || '').trim();
    if (!key) return false;
    return this.tokens.delete(key);
  }

  purgeExpired(now = Date.now()) {
    for (const [token, record] of this.tokens) {
      if (!record || record.expiresAt <= now) this.tokens.delete(token);
    }
  }

  size() {
    return this.tokens.size;
  }

  toPersistable() {
    const rows = [];
    const now = Date.now();
    for (const record of this.tokens.values()) {
      if (!record || record.expiresAt <= now) continue;
      rows.push({
        token: record.token,
        sessionId: record.sessionId,
        sessionSecret: record.sessionSecret,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      });
    }
    return rows;
  }

  hydrate(rows) {
    if (!Array.isArray(rows)) return;
    const now = Date.now();
    for (const row of rows) {
      if (this.tokens.size >= this.maxTokens) break;

      const token = String(row && row.token || '').trim();
      const sessionId = normalizeSessionId(row && row.sessionId);
      const sessionSecret = String(row && row.sessionSecret || '').trim();
      const createdAt = Number(row && row.createdAt || now);
      const expiresAt = Number(row && row.expiresAt || 0);
      if (!isLikelySessionToken(token)) continue;
      if (!sessionId || sessionId.length < 4) continue;
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionSecret)) continue;
      if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      this.tokens.set(token, {
        token,
        sessionId,
        sessionSecret,
        createdAt: Number.isFinite(createdAt) ? createdAt : now,
        expiresAt,
      });
    }
  }
}

module.exports = {
  TokenStore,
};
