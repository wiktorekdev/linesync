const { randomBytes } = require('crypto');
const { TOKEN_PREFIX } = require('./constants');

const SESSION_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeSessionId(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .substring(0, 16);
}

function randomSessionId(length = 8) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += SESSION_ALPHABET[bytes[i] % SESSION_ALPHABET.length];
  }
  return out;
}

function randomSessionSecret() {
  return randomBytes(24).toString('base64url');
}

function randomSessionToken() {
  return `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;
}

function isLikelySessionToken(value) {
  return /^lst_[A-Za-z0-9_-]{24,}$/.test(String(value || '').trim());
}

function sanitizePeerName(raw) {
  return String(raw || 'Anonymous').substring(0, 32);
}

module.exports = {
  normalizeSessionId,
  randomSessionId,
  randomSessionSecret,
  randomSessionToken,
  isLikelySessionToken,
  sanitizePeerName,
};
