import * as http from 'http';
import * as https from 'https';

export const SESSION_TOKEN_PREFIX = 'lst_';

export type IssuedSessionToken = {
  token: string;
  sessionId: string;
  sessionSecret: string;
  expiresAt: number;
};

export type ResolvedSessionToken = {
  sessionId: string;
  sessionSecret: string;
  expiresAt: number;
};

export function isLikelySessionToken(value: string): boolean {
  return /^lst_[A-Za-z0-9_-]{24,}$/.test(value.trim());
}

export async function issueSessionToken(
  relayWsUrl: string,
  relaySecret: string,
  timeoutMs: number
): Promise<IssuedSessionToken> {
  const base = wsToHttpBase(relayWsUrl);
  const payload = await httpPostJson<unknown>(
    `${base}/session-token`,
    {},
    timeoutMs,
    relaySecret
  );
  return parseIssued(payload);
}

export async function resolveSessionTokenOnRelay(
  relayWsUrl: string,
  token: string,
  relaySecret: string,
  timeoutMs: number
): Promise<ResolvedSessionToken> {
  const base = wsToHttpBase(relayWsUrl);
  const payload = await httpPostJson<unknown>(
    `${base}/session-token/resolve`,
    { token },
    timeoutMs,
    relaySecret
  );
  return parseResolved(payload);
}

export async function revokeSessionTokenOnRelay(
  relayWsUrl: string,
  token: string,
  relaySecret: string,
  timeoutMs: number
): Promise<void> {
  const base = wsToHttpBase(relayWsUrl);
  await httpPostJson<unknown>(
    `${base}/session-token/revoke`,
    { token },
    timeoutMs,
    relaySecret
  );
}

function wsToHttpBase(relayWsUrl: string): string {
  const trimmed = relayWsUrl.trim();
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice('wss://'.length)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice('ws://'.length)}`;
  throw new Error('Invalid relay URL');
}

function parseIssued(raw: unknown): IssuedSessionToken {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid token response');
  const token = String((raw as any).token ?? '').trim();
  const sessionId = String((raw as any).sessionId ?? '').trim();
  const sessionSecret = String((raw as any).sessionSecret ?? '').trim();
  const expiresAt = Number((raw as any).expiresAt ?? 0);
  if (!isLikelySessionToken(token)) throw new Error('Relay returned invalid token');
  if (!/^[A-Z0-9]{4,16}$/.test(sessionId)) throw new Error('Relay returned invalid session id');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionSecret)) throw new Error('Relay returned invalid session secret');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Relay returned expired token');
  return { token, sessionId, sessionSecret, expiresAt };
}

function parseResolved(raw: unknown): ResolvedSessionToken {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid token response');
  const sessionId = String((raw as any).sessionId ?? '').trim();
  const sessionSecret = String((raw as any).sessionSecret ?? '').trim();
  const expiresAt = Number((raw as any).expiresAt ?? 0);
  if (!/^[A-Z0-9]{4,16}$/.test(sessionId)) throw new Error('Relay returned invalid session id');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionSecret)) throw new Error('Relay returned invalid session secret');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Token expired');
  return { sessionId, sessionSecret, expiresAt };
}

function httpPostJson<T>(
  urlStr: string,
  bodyObj: unknown,
  timeoutMs: number,
  relaySecret: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(body.length),
          ...(relaySecret ? { 'x-relay-secret': relaySecret } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode ?? 0}${text ? `: ${text}` : ''}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}
