import * as DMP from 'diff-match-patch';

const dmp = new DMP.diff_match_patch();
dmp.Match_Threshold   = 0.35;
dmp.Patch_DeleteThreshold = 0.35;

export interface PatchResult {
  success: boolean;
  result: string;
  failedHunks: number[];
}

/** Create a compact DMP patch string from oldText -> newText. Returns '' if identical. */
export function createPatch(oldText: string, newText: string): string {
  if (oldText === newText) return '';
  const patches = dmp.patch_make(oldText, newText);
  return dmp.patch_toText(patches);
}

/** Apply a DMP patch string to text. */
export function applyPatch(text: string, patchText: string): PatchResult {
  if (!patchText) return { success: true, result: text, failedHunks: [] };
  try {
    const patches = dmp.patch_fromText(patchText);
    const [result, results] = dmp.patch_apply(patches, text);
    const failedHunks = results.reduce<number[]>((acc, ok, i) => {
      if (!ok) acc.push(i);
      return acc;
    }, []);
    return { success: failedHunks.length === 0, result, failedHunks };
  } catch {
    return { success: false, result: text, failedHunks: [-1] };
  }
}

/** True if the two new versions both touched any of the same line numbers relative to base. */
export function patchesOverlap(
  base: string,
  localNew: string,
  remoteNew: string
): boolean {
  const localSet  = changedLineSet(base, localNew);
  const remoteSet = changedLineSet(base, remoteNew);
  if (localSet.size === 0 || remoteSet.size === 0) return false;
  for (const line of localSet) {
    if (remoteSet.has(line)) return true;
  }
  return false;
}

/** Returns indices of lines that differ between oldText and newText (0-based). */
export function getChangedLines(oldText: string, newText: string): number[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const changed: number[] = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] !== newLines[i]) changed.push(i);
  }
  return changed;
}

function changedLineSet(oldText: string, newText: string): Set<number> {
  return new Set(getChangedLines(oldText, newText));
}

// ── Chunking helpers ───────────────────────────────────────────────────────

/** Max bytes per file_state chunk (uncompressed string size). 64 KB */
export const CHUNK_SIZE = 64 * 1024;

/** Split a large string into base64-encoded chunks of at most CHUNK_SIZE bytes. */
export function encodeChunks(content: string): string[] {
  // Use TextEncoder to get correct byte length
  const bytes = Buffer.from(content, 'utf8');
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    chunks.push(bytes.subarray(offset, offset + CHUNK_SIZE).toString('base64'));
  }
  return chunks.length > 0 ? chunks : [''];
}

/** Reassemble base64 chunks back into a string. */
export function decodeChunks(chunks: string[]): string {
  const bufs = chunks.map((c) => Buffer.from(c, 'base64'));
  return Buffer.concat(bufs).toString('utf8');
}
