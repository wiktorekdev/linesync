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

type PeerDecorationsStyle = 'full' | 'git' | 'minimal';

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function rgbaFromBase(base: string, alpha: number): string {
  // base is 'rgba(r,g,b,a)' - replace a with alpha
  const m = base.match(/^rgba\((\d+),(\d+),(\d+),([0-9.]+)\)$/);
  if (!m) return base;
  const a = clamp01(alpha);
  return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
}

function getDecorConfig() {
  const cfg = vscode.workspace.getConfiguration('linesync');
  const style = (cfg.get<string>('peerDecorationsStyle') ?? 'git') as PeerDecorationsStyle;
  const showChangedLabel = cfg.get<boolean>('peerShowChangedLineLabel') ?? false;
  const showCursorLabel = cfg.get<boolean>('peerShowCursorLabel') ?? true;
  const showCursorCoords = cfg.get<boolean>('peerShowCursorCoords') ?? true;
  const selOpacityRaw = cfg.get<number>('peerSelectionOpacity') ?? 0.12;
  const selectionOpacity = clamp01(selOpacityRaw);
  return { style, showChangedLabel, showCursorLabel, showCursorCoords, selectionOpacity };
}

interface PeerState {
  name: string;
  colorIdx: number;
  lineType: vscode.TextEditorDecorationType;
  cursorInlineType: vscode.TextEditorDecorationType;
  cursorLineType: vscode.TextEditorDecorationType;
  cursorLabelType: vscode.TextEditorDecorationType;
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
  private decorCfg = getDecorConfig();

  constructor(private context: vscode.ExtensionContext) {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('linesync.peerDecorationsStyle')
          || e.affectsConfiguration('linesync.peerShowChangedLineLabel')
          || e.affectsConfiguration('linesync.peerShowCursorLabel')
          || e.affectsConfiguration('linesync.peerShowCursorCoords')
          || e.affectsConfiguration('linesync.peerSelectionOpacity')) {
          this.decorCfg = getDecorConfig();
          for (const peer of this.peers.values()) this.rebuildPeerTypes(peer);
          this.refreshAll();
        }
      }),
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
      editor.setDecorations(peer.cursorInlineType, []);
      editor.setDecorations(peer.cursorLineType, []);
      editor.setDecorations(peer.cursorLabelType, []);
      editor.setDecorations(peer.selectionType, []);
    }

    peer.lineType.dispose();
    peer.cursorInlineType.dispose();
    peer.cursorLineType.dispose();
    peer.cursorLabelType.dispose();
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
    if (existing) {
      const nextName = (peerName || '').trim();
      if (nextName && nextName !== existing.name) {
        existing.name = nextName;
        this.rebuildPeerTypes(existing);
      }
      return existing;
    }

    const colorIdx = this.nextColor % PALETTE.length;
    this.nextColor++;
    const c = PALETTE[colorIdx];

    const peer: PeerState = {
      name: (peerName || '').trim() || 'Peer',
      colorIdx,
      lineType: vscode.window.createTextEditorDecorationType({}),
      cursorInlineType: vscode.window.createTextEditorDecorationType({}),
      cursorLineType: vscode.window.createTextEditorDecorationType({}),
      cursorLabelType: vscode.window.createTextEditorDecorationType({}),
      selectionType: vscode.window.createTextEditorDecorationType({}),
      changedLines: new Map(),
      clearTimer: new Map(),
      cursorFile: null,
      cursorLine: -1,
      cursorCharacter: 0,
      selection: null,
    };
    this.rebuildPeerTypes(peer);
    this.peers.set(peerId, peer);
    return peer;
  }

  private rebuildPeerTypes(peer: PeerState) {
    const c = PALETTE[peer.colorIdx % PALETTE.length];
    const cfg = this.decorCfg;

    peer.lineType.dispose();
    peer.cursorInlineType.dispose();
    peer.cursorLineType.dispose();
    peer.cursorLabelType.dispose();
    peer.selectionType.dispose();

    // Changed lines highlight
    if (cfg.style === 'minimal') {
      peer.lineType = vscode.window.createTextEditorDecorationType({});
    } else if (cfg.style === 'git') {
      peer.lineType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderColor: c.cursor,
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        overviewRulerColor: c.ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
      });
    } else {
      // full
      peer.lineType = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: c.bg,
        overviewRulerColor: c.ruler,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        after: cfg.showChangedLabel
          ? {
              contentText: `  <- ${peer.name}`,
              color: c.label,
              fontStyle: 'italic',
              fontWeight: '400',
            }
          : undefined,
      });
    }

    // Cursor: inline marker at the exact character.
    peer.cursorInlineType = vscode.window.createTextEditorDecorationType({
      before: {
        contentText: '|',
        color: c.cursor,
        margin: '0 1px 0 0',
      },
      overviewRulerColor: c.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    // Cursor fallback for empty lines: whole-line marker at line start
    peer.cursorLineType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      before: {
        contentText: '|',
        color: c.cursor,
        margin: '0 2px 0 0',
      },
      overviewRulerColor: c.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });

    peer.cursorLabelType = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: c.ruler,
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    const selectionBg = rgbaFromBase(c.bg, cfg.selectionOpacity);
    peer.selectionType = vscode.window.createTextEditorDecorationType({
      backgroundColor: selectionBg,
      borderColor: cfg.style === 'minimal' ? undefined : c.cursor,
      borderStyle: cfg.style === 'minimal' ? undefined : 'solid',
      borderWidth: cfg.style === 'minimal' ? undefined : '1px',
      borderRadius: '1px',
    });
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
      const cursorInlineRanges: vscode.Range[] = [];
      const cursorLineRanges: vscode.Range[] = [];
      const cursorLabelRanges: vscode.DecorationOptions[] = [];
      if (peer.cursorFile === rel && peer.cursorLine >= 0 && lineCount > 0) {
        const l = Math.min(peer.cursorLine, lineCount - 1);
        const lineLen = editor.document.lineAt(l).text.length;
        const ch = Math.max(0, Math.min(peer.cursorCharacter, lineLen));

        // Label/coords next to cursor, optional.
        const cfg = this.decorCfg;
        const parts: string[] = [];
        if (cfg.showCursorLabel) parts.push(peer.name || 'Peer');
        if (cfg.showCursorCoords) parts.push(`${l + 1}:${ch + 1}`);
        if (parts.length > 0) {
          const label = parts.join(' ');
          cursorLabelRanges.push({
            range: new vscode.Range(l, ch, l, ch),
            renderOptions: {
              after: {
                contentText: ` | ${label}`,
                color: PALETTE[peer.colorIdx % PALETTE.length].label,
                margin: '0 0 0 4px',
              },
            },
          });
        }

        if (lineLen === 0) {
          cursorLineRanges.push(new vscode.Range(l, 0, l, 0));
        } else {
          cursorInlineRanges.push(new vscode.Range(l, ch, l, ch));
        }
      }
      editor.setDecorations(peer.cursorInlineType, cursorInlineRanges);
      editor.setDecorations(peer.cursorLineType, cursorLineRanges);
      editor.setDecorations(peer.cursorLabelType, cursorLabelRanges.length ? cursorLabelRanges : []);

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
