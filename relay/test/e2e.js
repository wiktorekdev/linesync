const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const relaySecret = 'e2e-relay-secret';
const port = 39000 + Math.floor(Math.random() * 2000);
const baseHttp = `http://127.0.0.1:${port}`;
const baseWs = `ws://127.0.0.1:${port}`;
const stateFile = path.join(os.tmpdir(), `linesync-relay-e2e-${process.pid}-${Date.now()}.json`);

function deriveRelayPasswordHash(password, sessionId) {
  return crypto
    .createHash('sha256')
    .update(`linesync-relay|${String(sessionId).toUpperCase()}|${password}`, 'utf8')
    .digest('base64');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(method, pathname, body, headers = {}) {
  const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }
          resolve({ status: res.statusCode || 0, body: parsed, raw: text });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    try {
      const res = await requestJson('GET', '/health');
      if (res.status === 200 && res.body && res.body.ok) return;
    } catch {
      // keep polling
    }
    await wait(120);
  }
  throw new Error('Relay did not become healthy in time');
}

function startRelay() {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_SECRET: relaySecret,
      RELAY_STATE_FILE: stateFile,
      TOKEN_TTL_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  return child;
}

function stopRelay(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 2000);
  });
}

function joinViaWs(name, sessionId, sessionSecret, clientToken) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(baseWs);
    const timeout = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error(`${name} join timed out`));
    }, 7000);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'join',
        session: sessionId,
        peerName: name,
        secret: relaySecret,
        password: deriveRelayPasswordHash(sessionSecret, sessionId),
        clientToken,
      }));
    });

    ws.on('message', (raw) => {
      let msg = null;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg && msg.type === 'session_info') {
        clearTimeout(timeout);
        resolve({ ws, msg });
      }
      if (msg && msg.type === 'error') {
        clearTimeout(timeout);
        reject(new Error(`Join error: ${msg.code || msg.message || 'unknown'}`));
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('close', (code) => {
      if (code !== 1000) {
        clearTimeout(timeout);
      }
    });
  });
}

async function run() {
  let relay = null;
  try {
    relay = startRelay();
    await waitForHealth();

    const issue = await requestJson('POST', '/session-token', {}, { 'x-relay-secret': relaySecret });
    assert.strictEqual(issue.status, 200, `issue status: ${issue.status} ${issue.raw}`);
    assert.ok(issue.body && typeof issue.body.token === 'string', 'missing token');
    assert.ok(/^lst_[A-Za-z0-9_-]{24,}$/.test(issue.body.token), `bad token format: ${issue.body.token}`);

    const firstResolve = await requestJson(
      'POST',
      '/session-token/resolve',
      { token: issue.body.token },
      { 'x-relay-secret': relaySecret }
    );
    assert.strictEqual(firstResolve.status, 200, `resolve status: ${firstResolve.status} ${firstResolve.raw}`);
    assert.strictEqual(firstResolve.body.sessionId, issue.body.sessionId, 'resolved sessionId mismatch');

    await stopRelay(relay);
    relay = startRelay();
    await waitForHealth();

    const secondResolve = await requestJson(
      'POST',
      '/session-token/resolve',
      { token: issue.body.token },
      { 'x-relay-secret': relaySecret }
    );
    assert.strictEqual(secondResolve.status, 200, `resolve after restart status: ${secondResolve.status} ${secondResolve.raw}`);

    const host = await joinViaWs('Host', issue.body.sessionId, issue.body.sessionSecret, 'host-client-token');
    const guest = await joinViaWs('Guest', issue.body.sessionId, issue.body.sessionSecret, 'guest-client-token');

    assert.ok(host.msg.peerId, 'host missing peerId');
    assert.ok(guest.msg.peerId, 'guest missing peerId');

    const revoke = await requestJson(
      'POST',
      '/session-token/revoke',
      { token: issue.body.token },
      { 'x-relay-secret': relaySecret }
    );
    assert.strictEqual(revoke.status, 200, `revoke status: ${revoke.status} ${revoke.raw}`);
    assert.strictEqual(revoke.body.revoked, true, 'expected revoked=true');

    const afterRevoke = await requestJson(
      'POST',
      '/session-token/resolve',
      { token: issue.body.token },
      { 'x-relay-secret': relaySecret }
    );
    assert.strictEqual(afterRevoke.status, 404, `resolve after revoke status: ${afterRevoke.status} ${afterRevoke.raw}`);

    try { host.ws.close(1000, 'done'); } catch {}
    try { guest.ws.close(1000, 'done'); } catch {}

    console.log('relay e2e: ok');
  } finally {
    await stopRelay(relay);
    try { fs.unlinkSync(stateFile); } catch {}
  }
}

run().catch((err) => {
  console.error('relay e2e: failed');
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
