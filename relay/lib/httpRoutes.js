const url = require('url');
const { normalizeSessionId, isLikelySessionToken } = require('./ids');

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', body.length);
  res.end(body);
}

function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += piece.length;
      if (bytes > maxBytes) {
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(piece);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('bad_json'));
      }
    });
    req.on('error', reject);
  });
}

function hasRelaySecret(req, configuredSecret) {
  if (!configuredSecret) return true;
  const provided = String(req.headers['x-relay-secret'] || '').trim();
  return provided && provided === configuredSecret;
}

function remoteIpFromReq(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .split(',')[0]
    .trim();
}

function createHttpHandler(opts) {
  const {
    secret,
    sessionStore,
    tokenStore,
    joinLimiter,
    onStateChanged,
  } = opts;

  return async (req, res) => {
    const parsed = url.parse(req.url || '', true);
    const pathName = parsed.pathname || '';
    const remoteIp = remoteIpFromReq(req);

    if ((req.method === 'GET' || req.method === 'HEAD') && pathName === '/health') {
      if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.end();
        return;
      }
      sendJson(res, 200, {
        ok: true,
        sessions: sessionStore.size(),
        tokens: tokenStore.size(),
      });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && pathName === '/config') {
      if (req.method === 'HEAD') {
        res.statusCode = 200;
        res.end();
        return;
      }
      sendJson(res, 200, { requireSessionToken: true, requirePassword: true });
      return;
    }

    if (req.method === 'GET' && pathName.startsWith('/session/')) {
      if (joinLimiter.hit(remoteIp)) {
        sendJson(res, 429, { error: 'rate_limited' });
        return;
      }
      const sid = normalizeSessionId(pathName.slice('/session/'.length));
      if (!sid || sid.length < 4) {
        sendJson(res, 400, { error: 'bad_session' });
        return;
      }
      sendJson(res, sessionStore.has(sid) ? 200 : 404, { ok: sessionStore.has(sid) });
      return;
    }

    if (req.method === 'POST' && pathName === '/session-token') {
      if (!hasRelaySecret(req, secret)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      const issued = tokenStore.issue();
      sessionStore.ensure(issued.sessionId);
      onStateChanged({ immediate: true });
      sendJson(res, 200, issued);
      return;
    }

    if (req.method === 'POST' && pathName === '/session-token/resolve') {
      if (!hasRelaySecret(req, secret)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err && err.message;
        sendJson(res, message === 'body_too_large' ? 413 : 400, { error: message || 'bad_request' });
        return;
      }
      const token = String(body && body.token || '').trim();
      if (!isLikelySessionToken(token)) {
        sendJson(res, 400, { error: 'bad_token' });
        return;
      }
      const resolved = tokenStore.resolve(token);
      if (!resolved) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      sendJson(res, 200, {
        sessionId: resolved.sessionId,
        sessionSecret: resolved.sessionSecret,
        expiresAt: resolved.expiresAt,
      });
      return;
    }

    if (req.method === 'POST' && pathName === '/session-token/revoke') {
      if (!hasRelaySecret(req, secret)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const message = err && err.message;
        sendJson(res, message === 'body_too_large' ? 413 : 400, { error: message || 'bad_request' });
        return;
      }
      const token = String(body && body.token || '').trim();
      if (!isLikelySessionToken(token)) {
        sendJson(res, 400, { error: 'bad_token' });
        return;
      }
      const revoked = tokenStore.revoke(token);
      if (revoked) onStateChanged({ immediate: true });
      sendJson(res, 200, { ok: true, revoked });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  };
}

module.exports = {
  createHttpHandler,
  sendJson,
  remoteIpFromReq,
};
