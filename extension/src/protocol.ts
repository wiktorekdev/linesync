export type JoinMessage = {
  type: 'join';
  session: string;
  peerName: string;
  secret?: string;
  password: string; // verifier hash derived from session secret
  clientToken: string;
};

export type EncEnvelope = {
  type: 'enc';
  v: 1;
  iv: string;   // base64 12 bytes
  data: string; // base64 ciphertext+tag
};

// Payloads inside enc (v2 protocol)
export type AwarenessUpdateMsg = {
  type: 'awareness_update';
  updateB64: string;
};

export type YUpdateMsg = {
  type: 'y_update';
  file: string;
  updateB64: string;
};

export type SnapshotRequestMsg = {
  type: 'snapshot_request';
  file: string;
};

export type SnapshotChunkMsg = {
  type: 'snapshot_chunk';
  file: string;
  id: string;
  chunk: number;
  total: number;
  totalBytes: number;
  sha256: string;
  dataB64: string;
};

export type SnapshotAckMsg = {
  type: 'snapshot_ack';
  file: string;
  id: string;
  chunk: number;
};

export type ManifestRequestMsg = {
  type: 'manifest_request';
};

export type ManifestMsg = {
  type: 'manifest';
  files: { file: string; size: number; mtimeMs?: number }[];
};

export type Payload =
  | AwarenessUpdateMsg
  | YUpdateMsg
  | SnapshotRequestMsg
  | SnapshotChunkMsg
  | SnapshotAckMsg
  | ManifestRequestMsg
  | ManifestMsg;

