import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const BACKUP_DIR     = '.linesync/backups';
const MAX_BACKUP_MB  = 50;                          // total cap for backups folder
const MAX_AGE_DAYS   = 30;                          // auto-purge after 30 days
const MAX_FILE_KB    = 512;                         // skip backup if file > 512 KB

interface BackupMeta {
  originalPath: string;
  deletedBy: string;
  deletedAt: number;
  sessionId: string;
  size: number;
}

interface BackupIndex {
  version: 1;
  entries: Record<string, BackupMeta>;   // backupId -> meta
}

export class BackupManager {
  private backupRoot: string;
  private indexPath: string;
  private index: BackupIndex;

  constructor(private workspaceRoot: string) {
    this.backupRoot = path.join(workspaceRoot, BACKUP_DIR);
    this.indexPath  = path.join(this.backupRoot, 'index.json');
    this.index      = this.loadIndex();
    this.purgeExpired();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Back up a file before it's deleted.
   * Returns backupId or null if skipped (file too large / unreadable).
   */
  save(relativePath: string, content: string, deletedBy: string, sessionId: string): string | null {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_FILE_KB * 1024) return null;   // skip large files silently

    this.ensureDir();
    const backupId = `${Date.now()}_${sanitizeName(relativePath)}`;
    const backupFile = path.join(this.backupRoot, backupId);

    try {
      fs.writeFileSync(backupFile, content, 'utf8');
    } catch {
      return null;
    }

    this.index.entries[backupId] = {
      originalPath: relativePath,
      deletedBy,
      deletedAt: Date.now(),
      sessionId,
      size: bytes,
    };
    this.writeIndex();
    this.capTotalSize();
    return backupId;
  }

  /** Restore a backup: write to workspace and return content (or null if missing). */
  restore(backupId: string): string | null {
    const backupFile = path.join(this.backupRoot, backupId);
    try {
      return fs.readFileSync(backupFile, 'utf8');
    } catch {
      return null;
    }
  }

  /** List all backups, newest first. */
  list(): Array<BackupMeta & { backupId: string }> {
    return Object.entries(this.index.entries)
      .map(([backupId, meta]) => ({ backupId, ...meta }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  getMeta(backupId: string): BackupMeta | null {
    return this.index.entries[backupId] ?? null;
  }

  /** Remove a backup entry after it's been fully restored. */
  remove(backupId: string) {
    const backupFile = path.join(this.backupRoot, backupId);
    try { fs.unlinkSync(backupFile); } catch { /* ok */ }
    delete this.index.entries[backupId];
    this.writeIndex();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private loadIndex(): BackupIndex {
    try {
      return JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch {
      return { version: 1, entries: {} };
    }
  }

  private writeIndex() {
    this.ensureDir();
    fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
  }

  private ensureDir() {
    fs.mkdirSync(this.backupRoot, { recursive: true });
  }

  private purgeExpired() {
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    let changed  = false;
    for (const [id, meta] of Object.entries(this.index.entries)) {
      if (meta.deletedAt < cutoff) {
        try { fs.unlinkSync(path.join(this.backupRoot, id)); } catch { /* ok */ }
        delete this.index.entries[id];
        changed = true;
      }
    }
    if (changed) this.writeIndex();
  }

  private capTotalSize() {
    const maxBytes = MAX_BACKUP_MB * 1024 * 1024;
    const entries  = this.list();
    let total      = entries.reduce((s, e) => s + e.size, 0);
    if (total <= maxBytes) return;

    // Evict oldest until under cap
    for (const entry of [...entries].reverse()) {
      if (total <= maxBytes) break;
      total -= entry.size;
      this.remove(entry.backupId);
    }
  }
}

function sanitizeName(relativePath: string): string {
  return relativePath.replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 60);
}
