import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { IgnoreMatcher } from './ignoreMatcher';

export type SendPatchFn  = (relativePath: string, shadow: string, current: string) => void;
export type CursorSelection = {
  anchor: { line: number; character: number };
  active: { line: number; character: number };
} | null;
export type SendCursorFn = (
  relativePath: string,
  line: number,
  character: number,
  selection: CursorSelection
) => void;
export type SendDeleteFn = (relativePath: string, content: string) => void;

const DEBOUNCE_MS = 150;
const CURSOR_THROTTLE_MS = 60;

export class FileWatcher {
  private fsWatcher: vscode.FileSystemWatcher;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private suppressedPaths = new Set<string>();
  private disposables: vscode.Disposable[] = [];
  private maxFileSizeBytes: number;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCursor: {
    rel: string;
    line: number;
    character: number;
    selection: CursorSelection;
  } | null = null;
  private lastCursorKey: string | null = null;
  private warnedSkips = new Set<string>();

  constructor(
    private workspaceRoot: string,
    private shadows: Map<string, string>,
    private ignoreMatcher: IgnoreMatcher,
    private sendPatch: SendPatchFn,
    private sendCursor: SendCursorFn,
    private sendDelete: SendDeleteFn
  ) {
    const cfg = vscode.workspace.getConfiguration('linesync');
    const maxKB = cfg.get<number>('maxFileSizeKB') ?? 512;
    this.maxFileSizeBytes = maxKB * 1024;

    this.fsWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.disposables.push(
      this.fsWatcher.onDidChange((uri) => this.schedule(uri.fsPath)),
      this.fsWatcher.onDidCreate((uri) => this.schedule(uri.fsPath)),
      this.fsWatcher.onDidDelete((uri) => this.handleDelete(uri.fsPath)),

      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) this.schedule(e.document.uri.fsPath);
      }),

      vscode.window.onDidChangeTextEditorSelection((e) => {
        const rel = this.toRel(e.textEditor.document.uri.fsPath);
        if (rel && !this.isIgnored(rel)) {
          const sel = e.selections[0];
          const active = sel?.active ?? new vscode.Position(0, 0);
          const anchor = sel?.anchor ?? active;
          const selection: CursorSelection = sel && !sel.isEmpty
            ? {
                anchor: { line: anchor.line, character: anchor.character },
                active: { line: active.line, character: active.character },
              }
            : null;
          this.queueCursor(rel, active.line, active.character, selection);
        }
      }),
    );
  }

  suppressNext(relativePath: string) {
    this.suppressedPaths.add(relativePath);
    setTimeout(() => this.suppressedPaths.delete(relativePath), 1000);
  }

  getOpenFiles(): Map<string, string> {
    const result = new Map<string, string>();
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== 'file') continue;
      const rel = this.toRel(doc.uri.fsPath);
      if (!rel) continue;
      if (this.isIgnored(rel) || this.isBinary(doc.uri.fsPath)) {
        this.warnSkip(rel, 'ignored by settings');
        continue;
      }
      const content = doc.getText();
      if (Buffer.byteLength(content, 'utf8') > this.maxFileSizeBytes) {
        this.warnSkip(rel, `skipped (>${(this.maxFileSizeBytes / 1024).toFixed(0)} KB)`);
        continue;
      }
      result.set(rel, content);
    }
    return result;
  }

  dispose() {
    this.fsWatcher.dispose();
    this.timers.forEach((t) => clearTimeout(t));
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private schedule(fsPath: string) {
    const rel = this.toRel(fsPath);
    if (!rel) return;
    if (this.isIgnored(rel) || this.isBinary(fsPath)) {
      this.warnSkip(rel, 'ignored by settings');
      return;
    }

    const existing = this.timers.get(rel);
    if (existing) clearTimeout(existing);

    this.timers.set(rel, setTimeout(() => {
      this.timers.delete(rel);
      this.processChange(fsPath, rel);
    }, DEBOUNCE_MS));
  }

  private processChange(fsPath: string, relativePath: string) {
    if (this.suppressedPaths.has(relativePath)) {
      this.suppressedPaths.delete(relativePath);
      return;
    }

    const current = this.readContent(fsPath);
    if (current === null) return;

    if (Buffer.byteLength(current, 'utf8') > this.maxFileSizeBytes) {
      this.warnSkip(relativePath, `skipped (>${(this.maxFileSizeBytes / 1024).toFixed(0)} KB)`);
      return;
    }

    const shadow = this.shadows.get(relativePath);
    if (shadow === undefined) {
      this.shadows.set(relativePath, current);
      return;
    }

    if (current !== shadow) {
      this.sendPatch(relativePath, shadow, current);
    }
  }

  private handleDelete(fsPath: string) {
    const rel = this.toRel(fsPath);
    if (!rel) return;
    if (this.isIgnored(rel) || this.isBinary(fsPath)) {
      this.warnSkip(rel, 'ignored by settings');
      return;
    }
    const shadow = this.shadows.get(rel);
    if (shadow === undefined) return;
    // Deletions often arrive after the file is already gone on disk,
    // so use our in-memory shadow as the reliable source of last content.
    const content = shadow;
    this.shadows.delete(rel);
    this.sendDelete(rel, content);
  }

  private readContent(fsPath: string): string | null {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
    if (doc) return doc.getText();
    try { return fs.readFileSync(fsPath, 'utf8'); } catch { return null; }
  }

  private toRel(fsPath: string): string | null {
    if (!this.workspaceRoot) return null;
    const rel = path.relative(this.workspaceRoot, fsPath).replace(/\\/g, '/');
    return rel.startsWith('..') ? null : rel;
  }

  private isIgnored(relativePath: string): boolean {
    return this.ignoreMatcher.isIgnored(relativePath);
  }

  private isBinary(fsPath: string): boolean {
    return /\.(png|jpe?g|gif|ico|webp|bmp|avif|pdf|zip|tar|gz|7z|rar|exe|dll|so|dylib|wasm|mp[34]|mov|avi|mkv|webm|ttf|otf|woff2?|eot|bin|dat|db|sqlite|class|pyc)$/i
      .test(fsPath);
  }

  private warnSkip(relativePath: string, reason: string) {
    const key = `${relativePath}|${reason}`;
    if (this.warnedSkips.has(key)) return;
    this.warnedSkips.add(key);
    vscode.window.showWarningMessage(`LineSync: Skipped "${relativePath}" (${reason})`);
  }

  private queueCursor(
    rel: string,
    line: number,
    character: number,
    selection: CursorSelection
  ) {
    this.pendingCursor = { rel, line, character, selection };
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      if (!this.pendingCursor) return;
      const { rel, line, character, selection } = this.pendingCursor;
      this.pendingCursor = null;
      const selKey = selection
        ? `${selection.anchor.line}:${selection.anchor.character}-${selection.active.line}:${selection.active.character}`
        : '';
      const key = `${rel}:${line}:${character}:${selKey}`;
      if (key === this.lastCursorKey) return;
      this.lastCursorKey = key;
      this.sendCursor(rel, line, character, selection);
    }, CURSOR_THROTTLE_MS);
  }
}
