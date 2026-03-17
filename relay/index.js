const http = require('http');
const path = require('path');

const {
  JOIN_LIMIT,
  JOIN_WINDOW_MS,
  DEFAULT_TOKEN_TTL_MS,
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
const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || DEFAULT_TOKEN_TTL_MS);

function log(event, fields = {}) {
  const base = { ts: new Date().toISOString(), event };
  console.log(JSON.stringify({ ...base, ...fields }));
}

const persistence = new StatePersistence(STATE_FILE);
const initialState = persistence.load();

const sessionStore = new SessionStore(initialState.sessions);
const tokenStore = new TokenStore({
  defaultTtlMs: Number.isFinite(TOKEN_TTL_MS) && TOKEN_TTL_MS > 0 ? TOKEN_TTL_MS : DEFAULT_TOKEN_TTL_MS,
  initialRows: initialState.tokens,
});

const joinLimiter = createFixedWindowLimiter(JOIN_LIMIT, JOIN_WINDOW_MS);

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
  onStateChanged,
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
  onStateChanged,
  log,
});

setInterval(() => {
  joinLimiter.cleanup();
}, JOIN_WINDOW_MS);

setInterval(() => {
  const before = tokenStore.size();
  tokenStore.purgeExpired();
  if (tokenStore.size() !== before) onStateChanged();
}, 30_000);

server.on('listening', () => {
  const auth = SECRET ? 'auth ON' : 'no auth (set RELAY_SECRET)';
  log('relay_listening', {
    port: PORT,
    auth,
    tokenTtlMs: tokenStore.defaultTtlMs,
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
