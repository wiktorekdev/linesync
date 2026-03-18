import * as vscode from 'vscode';
import * as path from 'path';
import { DecorationManager } from './decorationManager';

function toRel(root: string, fsPath: string): string | null {
  const rel = path.relative(root, fsPath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return null;
  return rel;
}

function samePeerList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export class FilePresenceDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;

  private peersByFile = new Map<string, string[]>();
  private readonly root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  constructor(private decorationManager: DecorationManager) {
    // no-op
  }

  setPresenceByFile(next: Map<string, string[]>) {
    const changed = new Set<string>();
    const allFiles = new Set<string>([...this.peersByFile.keys(), ...next.keys()]);
    for (const file of allFiles) {
      const prev = this.peersByFile.get(file) ?? [];
      const curr = next.get(file) ?? [];
      if (!samePeerList(prev, curr)) changed.add(file);
    }

    this.peersByFile = next;
    if (changed.size === 0) return;

    const uris = [...changed].map((rel) => vscode.Uri.file(path.join(this.root, rel)));
    this.onDidChangeEmitter.fire(uris);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== 'file') return undefined;
    const rel = toRel(this.root, uri.fsPath);
    if (!rel) return undefined;
    const peerIds = this.peersByFile.get(rel) ?? [];
    if (peerIds.length === 0) return undefined;

    const primaryPeerId = peerIds[0];
    const themeColorId = this.decorationManager.getPeerThemeColorId(primaryPeerId);
    const names = peerIds
      .map((id) => this.decorationManager.getPeerName(id) ?? `Peer-${id.slice(0, 4)}`)
      .slice(0, 8);
    const hiddenCount = Math.max(0, peerIds.length - names.length);
    const tooltip = hiddenCount > 0
      ? `Active peers: ${names.join(', ')} +${hiddenCount} more`
      : `Active peers: ${names.join(', ')}`;
    const badge = peerIds.length <= 1 ? 'o' : (peerIds.length <= 9 ? String(peerIds.length) : '9+');

    // API allows one badge per file. Keep minimal style and summarize multi-peer in tooltip.
    return new vscode.FileDecoration(badge, tooltip, themeColorId ? new vscode.ThemeColor(themeColorId) : undefined);
  }

  dispose() {
    this.onDidChangeEmitter.dispose();
  }
}
