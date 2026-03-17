import * as Y from 'yjs';

export type DocEntry = {
  doc: Y.Doc;
  text: Y.Text;
};

export class DocStore {
  private docs = new Map<string, DocEntry>();

  getOrCreate(file: string): DocEntry {
    const existing = this.docs.get(file);
    if (existing) return existing;
    const doc = new Y.Doc();
    const text = doc.getText('content');
    const entry: DocEntry = { doc, text };
    this.docs.set(file, entry);
    return entry;
  }

  has(file: string): boolean {
    return this.docs.has(file);
  }

  entries(): IterableIterator<[string, DocEntry]> {
    return this.docs.entries();
  }
}

