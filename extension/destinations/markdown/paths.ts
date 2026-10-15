import type { ArchivedConversation } from '../../core/contracts/conversation.ts';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function sanitizePathSegment(value: string): string {
  const cleaned = Array.from(value)
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32 || '<>:"/\\|?*'.includes(char)) {
        return ' ';
      }
      return char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!cleaned || RESERVED.test(cleaned)) {
    return 'conversation';
  }
  return Array.from(cleaned).slice(0, 60).join('').replace(/[. ]+$/g, '') || 'conversation';
}

export function relativeNoteLink(notePath: string, vaultPath: string): string | null {
  const valid = (path: string) => !path.startsWith('/') && !path.includes('\\') && !path.includes(':') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
  if (!valid(notePath) || !valid(vaultPath)) return null;
  const note = notePath.split('/').slice(0, -1);
  const target = vaultPath.split('/');
  while (note.length && target.length && note[0] === target[0]) { note.shift(); target.shift(); }
  return [...note.map(() => '..'), ...target.map((segment) => encodeURIComponent(segment))].join('/');
}

export function markdownRelativePath(
  conversation: ArchivedConversation,
  options?: { projects?: boolean },
): string {
  const day = (conversation.createdAt ?? conversation.capturedAt).slice(0, 10);
  const title = sanitizePathSegment(conversation.title).toLowerCase().replaceAll(' ', '-');
  const useProject = options?.projects !== false && Boolean(conversation.projectSlug);
  const folder = useProject
    ? `${conversation.provider}/projects/${sanitizePathSegment(conversation.projectSlug ?? '').toLowerCase()}`
    : conversation.provider;
  return `${folder}/${day}-${title}.md`;
}
