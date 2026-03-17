import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const JOURNAL_FILE   = '.vscode/linesync.json';
const MAX_SIZE_BYTES = 512 * 1024;   // 512 KB per session - evict LRU files if exceeded
const TTL_MS         = 7 * 24 * 60 * 60 * 1000; // 7 days - purge stale sessions on load

interface FileEntry {
  content: string;
  savedAt: number;   // unix ms
  version: number;
}

interface SessionData {
  sessionId: string;
  updatedAt: number;
  files: Record<string, FileEntry>;
}

interface JournalFile {
  version: 1;
  sessions: Record<string, SessionData>;
}

/**
 * SyncJournal - persists file shadows between VS Code sessions.
 *
 * Why this exists:
 * - Relay is stateless; shadows live only in RAM while SyncClient is alive.
 * - If A edits, disconnects, then B joins, B gets nothing -> we lose A's work.
 * - The journal is written to .vscode/linesync.json on every patch and on disconnect.
 * - On reconnect A reads the journal and can resume from the last known state.
 * - Scenarios 3 and 4 (one-side-offline edits) are resolved via journal + conflict UI.
 */
export class SyncJournal {
  private data: SessionData;
  private journalPath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private workspaceRoot: string,
    private sessionId: string
  ) {
    this.journalPath = path.join(workspaceRoot, JOURNAL_FILE);
    this.data = this.loadOrCreate();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Record that a file reached this content (called after every successful sync). */
  record(relativePath: string, content: string) {
    const existing = this.data.files[relativePath];
    this.data.files[relativePath] = {
      content,
      savedAt: Date.now(),
      version: existing?.version ?? 0,
    };
    this.data.updatedAt = Date.now();
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Record with explicit version (used for sync versioning). */
  recordWithVersion(relativePath: string, content: string, version: number) {
    this.data.files[relativePath] = { content, savedAt: Date.now(), version };
    this.data.updatedAt = Date.now();
    this.dirty = true;
    this.scheduleFlush();
  }

  /** Remove a file from the journal (peer deleted it). */
  forget(relativePath: string) {
    if (this.data.files[relativePath]) {
      delete this.data.files[relativePath];
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  /**
   * Get the last-known content for a file.
   * Returns undefined if we never saw this file in this session.
   */
  getLastKnown(relativePath: string): string | undefined {
    return this.data.files[relativePath]?.content;
  }

  getLastKnownVersion(relativePath: string): number | undefined {
    return this.data.files[relativePath]?.version;
  }

  /** All files tracked in this session (used to seed shadows on reconnect). */
  getAllFiles(): Map<string, FileEntry> {
    const result = new Map<string, FileEntry>();
    for (const [rel, entry] of Object.entries(this.data.files)) {
      result.set(rel, entry);
    }
    return result;
  }

  /** True if we have any previously-seen files for this session. */
  hasHistory(): boolean {
    return Object.keys(this.data.files).length > 0;
  }

  /** Flush immediately - call on disconnect. */
  flush() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty) return;
    this.write();
    this.dirty = false;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private loadOrCreate(): SessionData {
    let journal: JournalFile = { version: 1, sessions: {} };

    try {
      const raw = fs.readFileSync(this.journalPath, 'utf8');
      journal = JSON.parse(raw);
    } catch {
      // First run or corrupted - start fresh
    }

    // Purge expired sessions
    const now = Date.now();
    for (const [sid, sess] of Object.entries(journal.sessions)) {
      if (now - sess.updatedAt > TTL_MS) delete journal.sessions[sid];
    }

    if (!journal.sessions[this.sessionId]) {
      journal.sessions[this.sessionId] = {
        sessionId: this.sessionId,
        updatedAt: now,
        files: {},
      };
    }

    // Normalize missing versions for backward compatibility
    const sess = journal.sessions[this.sessionId];
    for (const entry of Object.values(sess.files)) {
      if (entry.version === undefined) entry.version = 0;
    }

    // Write back pruned journal
    this.writeRaw(journal);
    return sess;
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    // Batch writes - flush 2s after last change
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.write();
      this.dirty = false;
    }, 2000);
  }

  private write() {
    let journal: JournalFile = { version: 1, sessions: {} };
    try {
      journal = JSON.parse(fs.readFileSync(this.journalPath, 'utf8'));
    } catch { /* new file */ }

    // Cap total size: if current session exceeds MAX_SIZE_BYTES, evict oldest entries
    this.evictIfNeeded();

    journal.sessions[this.sessionId] = this.data;
    this.writeRaw(journal);
  }

  private writeRaw(journal: JournalFile) {
    try {
      fs.mkdirSync(path.dirname(this.journalPath), { recursive: true });
      fs.writeFileSync(this.journalPath, JSON.stringify(journal, null, 2), 'utf8');
    } catch (e) {
      console.error('[LineSync] Journal write failed:', e);
    }
  }

  /** Evict oldest files until the session's total size is under MAX_SIZE_BYTES. */
  private evictIfNeeded() {
    const entries = Object.entries(this.data.files);
    let totalBytes = entries.reduce(
      (sum, [, e]) => sum + Buffer.byteLength(e.content, 'utf8'), 0
    );

    if (totalBytes <= MAX_SIZE_BYTES) return;

    // Sort oldest first
    entries.sort((a, b) => a[1].savedAt - b[1].savedAt);

    for (const [rel, entry] of entries) {
      if (totalBytes <= MAX_SIZE_BYTES) break;
      totalBytes -= Buffer.byteLength(entry.content, 'utf8');
      delete this.data.files[rel];
      console.log(`[LineSync] Journal evicted: ${rel} (size cap)`);
    }
  }
}
