const SIZE_LIMITS = {
  patch: 512 * 1024,
  file_state_chunk: 128 * 1024,
  cursor: 1 * 1024,
  file_deleted: 1 * 1024,
  request_sync: 1 * 1024,
  conflict_resolve: 256 * 1024,
  enc: 1024 * 1024,
  join: 4 * 1024,
  admin_kick: 1 * 1024,
  admin_ban: 1 * 1024,
  _default: 64 * 1024,
};

const RATE_LIMIT = 300;
const RATE_WINDOW_MS = 10_000;

const JOIN_LIMIT = 10;
const JOIN_WINDOW_MS = 60_000;

const MAX_SESSION_PEERS = 10;

const TOKEN_PREFIX = 'lst_';
const DEFAULT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = {
  SIZE_LIMITS,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  JOIN_LIMIT,
  JOIN_WINDOW_MS,
  MAX_SESSION_PEERS,
  TOKEN_PREFIX,
  DEFAULT_TOKEN_TTL_MS,
};
