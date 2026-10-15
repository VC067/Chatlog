import { stableHash } from '../../core/archive/hash.ts';

export function decideFileWrite(
  currentText: string | null,
  previousHash: string | null,
  nextText: string,
): 'write' | 'skip' | 'keep-edits' {
  if (currentText === null) {
    return 'write';
  }
  const currentHash = stableHash(currentText);
  if (currentHash === stableHash(nextText)) {
    return 'skip';
  }
  if (previousHash !== null && currentHash === previousHash) {
    return 'write';
  }
  return 'keep-edits';
}
