const http = require('http');
const path = require('path');

const {
  JOIN_LIMIT,
  JOIN_WINDOW_MS,
  DEFAULT_TOKEN_TTL_MS,
  TOKEN_API_LIMIT,
  TOKEN_API_WINDOW_MS,
  AUTH_FAIL_LIMIT,
  AUTH_FAIL_WINDOW_MS,
  MAX_SESSIONS,
  MAX_TOKENS,
  MAX_BANNED_IPS_PER_SESSION,
  MAX_BANNED_TOKENS_PER_SESSION,
  SESSION_IDLE_TTL_MS,
} = require('./lib/constants');
const { createFixedWindowLimiter } = require('./lib/limiter');
const { SessionStore } = require('./lib/sessionStore');
const { TokenStore } = require('./lib/tokenStore');
const { StatePersistence } = require('./lib/persistence');
const { createHttpHandler } = require('./lib/httpRoutes');
const { createWsServer } = require('./lib/wsServer');

const PORT = Number(process.env.PORT || 3000);
const SECRET = String(process.env.RELAY_SECRET || '');
const STATE_FILE = process.env.RELAY_STATE_FILE
  ? path.resolve(process.env.RELAY_STATE_FILE)
  : path.join(__dirname, 'data', 'relay-state.json');
const TOKEN_TTL_MS = readPositiveInt(process.env.TOKEN_TTL_MS, DEFAULT_TOKEN_TTL_MS);
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || '').trim());
const MAX_SESSIONS_LIMIT = readPositiveInt(process.env.MAX_SESSIONS, MAX_SESSIONS);
const MAX_TOKENS_LIMIT = readPositiveInt(process.env.MAX_TOKENS, MAX_TOKENS);
const MAX_BANNED_IPS_LIMIT = readPositiveInt(process.env.MAX_BANNED_IPS_PER_SESSION, MAX_BANNED_IPS_PER_SESSION);
const MAX_BANNED_TOKENS_LIMIT = readPositiveInt(process.env.MAX_BANNED_TOKENS_PER_SESSION, MAX_BANNED_TOKENS_PER_SESSION);
const TOKEN_API_LIMIT_VALUE = readPositiveInt(process.env.TOKEN_API_LIMIT, TOKEN_API_LIMIT);
const TOKEN_API_WINDOW_MS_VALUE = readPositiveInt(process.env.TOKEN_API_WINDOW_MS, TOKEN_API_WINDOW_MS);
const AUTH_FAIL_LIMIT_VALUE = readPositiveInt(process.env.AUTH_FAIL_LIMIT, AUTH_FAIL_LIMIT);
const AUTH_FAIL_WINDOW_MS_VALUE = readPositiveInt(process.env.AUTH_FAIL_WINDOW_MS, AUTH_FAIL_WINDOW_MS);
const SESSION_IDLE_TTL_MS_VALUE = readPositiveInt(process.env.SESSION_IDLE_TTL_MS, SESSION_IDLE_TTL_MS);

function log(event, fields = {}) {
  const base = { ts: new Date().toISOString(), event };
  console.log(JSON.stringify({ ...base, ...fields }));
}

const persistence = new StatePersistence(STATE_FILE);
const initialState = persistence.load();

const sessionStore = new SessionStore(initialState.sessions, {
  maxSessions: MAX_SESSIONS_LIMIT,
  maxBannedIpsPerSession: MAX_BANNED_IPS_LIMIT,
  maxBannedTokensPerSession: MAX_BANNED_TOKENS_LIMIT,
});
const tokenStore = new TokenStore({
  defaultTtlMs: TOKEN_TTL_MS,
  maxTokens: MAX_TOKENS_LIMIT,
  initialRows: initialState.tokens,
});

const joinLimiter = createFixedWindowLimiter(JOIN_LIMIT, JOIN_WINDOW_MS);
const tokenApiLimiter = createFixedWindowLimiter(TOKEN_API_LIMIT_VALUE, TOKEN_API_WINDOW_MS_VALUE);
const authFailLimiter = createFixedWindowLimiter(AUTH_FAIL_LIMIT_VALUE, AUTH_FAIL_WINDOW_MS_VALUE);

const buildSnapshot = () => ({
  version: 1,
  updatedAt: Date.now(),
  sessions: sessionStore.toPersistable(),
  tokens: tokenStore.toPersistable(),
});

const onStateChanged = (opts = {}) => {
  if (opts.immediate) {
    persistence.flush(buildSnapshot);
    return;
  }
  persistence.scheduleWrite(buildSnapshot);
};

const httpHandler = createHttpHandler({
  secret: SECRET,
  sessionStore,
  tokenStore,
  joinLimiter,
  tokenApiLimiter,
  authFailLimiter,
  onStateChanged,
  trustProxy: TRUST_PROXY,
});

const server = http.createServer((req, res) => {
  Promise.resolve(httpHandler(req, res)).catch((err) => {
    sendInternalError(res, err);
  });
});

createWsServer({
  server,
  secret: SECRET,
  sessionStore,
  joinLimiter,
  authFailLimiter,
  onStateChanged,
  log,
  trustProxy: TRUST_PROXY,
  maxBannedIpsPerSession: MAX_BANNED_IPS_LIMIT,
  maxBannedTokensPerSession: MAX_BANNED_TOKENS_LIMIT,
});

setInterval(() => {
  joinLimiter.cleanup();
  tokenApiLimiter.cleanup();
  authFailLimiter.cleanup();
}, Math.max(10_000, Math.min(JOIN_WINDOW_MS, TOKEN_API_WINDOW_MS_VALUE, AUTH_FAIL_WINDOW_MS_VALUE)));

setInterval(() => {
  const before = tokenStore.size();
  tokenStore.purgeExpired();
  if (tokenStore.size() !== before) onStateChanged();
}, 30_000);

setInterval(() => {
  const removed = sessionStore.evictIdle(Date.now(), SESSION_IDLE_TTL_MS_VALUE);
  if (removed > 0) {
    onStateChanged();
    log('sessions_evicted_idle', { removed, sessionIdleTtlMs: SESSION_IDLE_TTL_MS_VALUE });
  }
}, 60_000);

server.on('listening', () => {
  const auth = SECRET ? 'auth ON' : 'no auth (set RELAY_SECRET)';
  log('relay_listening', {
    port: PORT,
    auth,
    trustProxy: TRUST_PROXY,
    tokenTtlMs: tokenStore.defaultTtlMs,
    maxSessions: MAX_SESSIONS_LIMIT,
    maxTokens: MAX_TOKENS_LIMIT,
    tokenApiLimit: TOKEN_API_LIMIT_VALUE,
    tokenApiWindowMs: TOKEN_API_WINDOW_MS_VALUE,
    authFailLimit: AUTH_FAIL_LIMIT_VALUE,
    authFailWindowMs: AUTH_FAIL_WINDOW_MS_VALUE,
    maxBannedIpsPerSession: MAX_BANNED_IPS_LIMIT,
    maxBannedTokensPerSession: MAX_BANNED_TOKENS_LIMIT,
    sessionIdleTtlMs: SESSION_IDLE_TTL_MS_VALUE,
    stateFile: STATE_FILE,
  });
});

const shutdown = () => {
  try {
    persistence.flush(buildSnapshot);
  } catch {
    // ignore
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT);

function sendInternalError(res, err) {
  const message = err instanceof Error ? err.message : 'internal_error';
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

function readPositiveInt(raw, fallback) {
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return fallback;
}
