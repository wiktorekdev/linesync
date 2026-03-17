import * as vscode from 'vscode';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export type PresenceState = {
  file?: string;
  line?: number;
  character?: number;
  selection?: { anchor: { line: number; character: number }; active: { line: number; character: number } } | null;
  name?: string;
  peerId?: string;
};

export class Presence {
  public awareness: awarenessProtocol.Awareness;

  constructor(private doc: any) {
    this.awareness = new awarenessProtocol.Awareness(doc);
  }

  setLocal(name: string, peerId: string, payload: PresenceState) {
    this.awareness.setLocalState({ ...payload, name, peerId });
  }

  encodeUpdate(changedClients?: number[]): string {
    const clients = changedClients ?? Array.from(this.awareness.getStates().keys());
    const bytes = awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients);
    return Buffer.from(bytes).toString('base64');
  }

  applyUpdate(updateB64: string, origin: unknown) {
    const bytes = new Uint8Array(Buffer.from(updateB64, 'base64'));
    awarenessProtocol.applyAwarenessUpdate(this.awareness, bytes, origin);
  }

  onChange(fn: (changedClients: number[]) => void): vscode.Disposable {
    const handler = ({ added, updated, removed }: any) => {
      fn([...(added ?? []), ...(updated ?? []), ...(removed ?? [])]);
    };
    this.awareness.on('change', handler);
    return new vscode.Disposable(() => this.awareness.off('change', handler));
  }
}

