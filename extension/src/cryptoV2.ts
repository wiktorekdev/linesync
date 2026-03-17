import * as crypto from 'crypto';
import { TextDecoder, TextEncoder } from 'util';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function deriveRelayPasswordHash(password: string, sessionId: string): string {
  return crypto
    .createHash('sha256')
    .update(`linesync-relay|${sessionId.toUpperCase()}|${password}`, 'utf8')
    .digest('base64');
}

export async function deriveSessionKey(password: string, sessionId: string): Promise<unknown> {
  const salt = textEncoder.encode(sessionId.toUpperCase());
  const baseKey = await crypto.webcrypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptJson(key: unknown, obj: unknown): Promise<{ iv: string; data: string }> {
  const iv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const encoded = textEncoder.encode(JSON.stringify(obj));
  const cipher = await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key as any, encoded);
  return {
    iv: Buffer.from(iv).toString('base64'),
    data: Buffer.from(new Uint8Array(cipher)).toString('base64'),
  };
}

export async function decryptJson(key: unknown, ivB64: string, dataB64: string): Promise<unknown> {
  const iv = new Uint8Array(Buffer.from(ivB64, 'base64'));
  const data = new Uint8Array(Buffer.from(dataB64, 'base64'));
  if (iv.length !== 12) throw new Error('Invalid iv length');
  // AES-GCM tag is 16 bytes, so ciphertext must be at least that.
  if (data.length < 16) throw new Error('Invalid ciphertext length');
  // Hard cap to avoid memory bombs.
  if (data.length > 2_000_000) throw new Error('Ciphertext too large');
  const plain = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv }, key as any, data);
  const text = textDecoder.decode(plain);
  return JSON.parse(text);
}

