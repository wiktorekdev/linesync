import * as vscode from 'vscode';
import * as path from 'path';

const PALETTE = [
  { bg: 'rgba(78,201,176,0.14)',  ruler: '#4ec9b0', cursor: '#4ec9b0', label: 'rgba(78,201,176,0.8)'  },
  { bg: 'rgba(244,135,113,0.14)', ruler: '#f48771', cursor: '#f48771', label: 'rgba(244,135,113,0.8)' },
  { bg: 'rgba(86,156,214,0.14)',  ruler: '#569cd6', cursor: '#569cd6', label: 'rgba(86,156,214,0.8)'  },
  { bg: 'rgba(206,145,120,0.14)', ruler: '#ce9178', cursor: '#ce9178', label: 'rgba(206,145,120,0.8)' },
  { bg: 'rgba(197,134,192,0.14)', ruler: '#c586c0', cursor: '#c586c0', label: 'rgba(197,134,192,0.8)' },
  { bg: 'rgba(220,220,170,0.14)', ruler: '#dcdcaa', cursor: '#dcdcaa', label: 'rgba(220,220,170,0.8)' },
];

interface PeerState {
  name: string;
  colorIdx: number;
  lineType: vscode.TextEditorDecorationType;
  cursorType: vscode.TextEditorDecorationType;
  selectionType: vscode.TextEditorDecorationType;
  // relativePath -> changed line numbers
  changedLines: Map<string, number[]>;
  clearTimer: Map<string, ReturnType<typeof setTimeout>>;
  cursorFile: string | null;
  cursorLine: number;
  cursorCharacter: number;
  selection: { anchor: vscode.Position; active: vscode.Position } | null;
}

export class DecorationManager {
  private peers = new Map<string, PeerState>();
  private nextColor = 0;
  private workspaceRoot: string;
  private disposables: vscode.Disposable[] = [];

  constructor(private context: vscode.ExtensionContext) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      })
    );
  }

  // Public API
  highlightChanges(
    peerId: string,
    relativePath: string,
    lines: number[],
    peerName: string,
    durationMs: number
  ) {
    if (lines.length === 0) return;
    const peer = this.getOrCreate(peerId, peerName);

    const existing = peer.clearTimer.get(relativePath);
    if (existing) clearTimeout(existing);

    peer.changedLines.set(relativePath, lines);

    const timer = setTimeout(() => {
      peer.changedLines.delete(relativePath);
      peer.clearTimer.delete(relativePath);
      this.applyForPeer(peer);
    }, durationMs);
    peer.clearTimer.set(relativePath, timer);

    this.applyForPeer(peer);
  }

  updateCursor(
    peerId: string,
    relativePath: string,
    line: number,
    character: number,
    selection:
      | { anchor: { line: number; character: number }; active: { line: number; character: number } }
      | null,
    peerName: string
  ) {
    const peer = this.getOrCreate(peerId, peerName);
    peer.cursorFile = relativePath;
    peer.cursorLine = line;
    peer.cursorCharacter = character;
    peer.selection = selection
      ? {
          anchor: new vscode.Position(selection.anchor.line, selection.anchor.character),
          active: new vscode.Position(selection.active.line, selection.active.character),
        }
      : null;
    this.applyForPeer(peer);
  }

  clearPeer(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    // Remove decorations from all editors before disposing types
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(peer.lineType, []);
      editor.setDecorations(peer.cursorType, []);
      editor.setDecorations(peer.selectionType, []);
    }

    peer.lineType.dispose();
    peer.cursorType.dispose();
    peer.selectionType.dispose();
    peer.clearTimer.forEach((t) => clearTimeout(t));
    this.peers.delete(peerId);
  }

  clearAll() {
    for (const peerId of [...this.peers.keys()]) {
      this.clearPeer(peerId);
    }
  }

  dispose() {
    this.clearAll();
    this.disposables.forEach((d) => d.dispose());
  }

  // Internals
  private getOrCreate(peerId: string, peerName: string): PeerState {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const colorIdx = this.nextColor % PALETTE.length;
    this.nextColor++;
    const c = PALETTE[colorIdx];

    const lineType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: c.bg,
      overviewRulerColor: c.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        contentText: `  <- ${peerName}`,
        color: c.label,
        fontStyle: 'italic',
        fontWeight: '400',
      },
    });

    // Remote cursor - thin left border on that line
    const cursorType = vscode.window.createTextEditorDecorationType({
      borderColor: c.cursor,
      borderStyle: 'solid',
      borderWidth: '0 0 0 2px',
      overviewRulerColor: c.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    const selectionType = vscode.window.createTextEditorDecorationType({
      backgroundColor: c.bg,
      borderRadius: '1px',
    });

    const peer: PeerState = {
      name: peerName,
      colorIdx,
      lineType,
      cursorType,
      selectionType,
      changedLines: new Map(),
      clearTimer: new Map(),
      cursorFile: null,
      cursorLine: -1,
      cursorCharacter: 0,
      selection: null,
    };
    this.peers.set(peerId, peer);
    return peer;
  }

  private applyForPeer(peer: PeerState) {
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = this.toRelative(editor.document.uri.fsPath);
      const lineCount = editor.document.lineCount;

      // Highlight changed lines
      const lines = peer.changedLines.get(rel) ?? [];
      editor.setDecorations(
        peer.lineType,
        lines
          .filter((l) => l >= 0 && l < lineCount)
          .map((l) => new vscode.Range(l, 0, l, 0))
      );

      // Remote cursor indicator
      const cursorRanges: vscode.Range[] = [];
      if (peer.cursorFile === rel && peer.cursorLine >= 0 && lineCount > 0) {
        const l = Math.min(peer.cursorLine, lineCount - 1);
        const lineLen = editor.document.lineAt(l).text.length;
        const ch = Math.max(0, Math.min(peer.cursorCharacter, lineLen));
        const endCh = lineLen > 0 ? Math.min(ch + 1, lineLen) : ch;
        cursorRanges.push(new vscode.Range(l, ch, l, endCh));
      }
      editor.setDecorations(peer.cursorType, cursorRanges);

      // Remote selection highlight
      const selectionRanges: vscode.Range[] = [];
      if (peer.cursorFile === rel && peer.selection && lineCount > 0) {
        const start = this.clampPosition(editor, peer.selection.anchor);
        const end = this.clampPosition(editor, peer.selection.active);
        const range = start.isBefore(end)
          ? new vscode.Range(start, end)
          : new vscode.Range(end, start);
        if (!range.isEmpty) selectionRanges.push(range);
      }
      editor.setDecorations(peer.selectionType, selectionRanges);
    }
  }

  private refreshAll() {
    for (const peer of this.peers.values()) {
      this.applyForPeer(peer);
    }
  }

  private toRelative(fsPath: string): string {
    if (!this.workspaceRoot) return fsPath;
    return path.relative(this.workspaceRoot, fsPath).replace(/\\/g, '/');
  }

  private clampPosition(editor: vscode.TextEditor, pos: vscode.Position): vscode.Position {
    const lineCount = editor.document.lineCount;
    const line = Math.max(0, Math.min(pos.line, Math.max(0, lineCount - 1)));
    const lineLen = editor.document.lineAt(line).text.length;
    const ch = Math.max(0, Math.min(pos.character, lineLen));
    return new vscode.Position(line, ch);
  }
}
