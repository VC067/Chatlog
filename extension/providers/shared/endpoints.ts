export type CaptureKind = 'conversation' | 'completion';

export function classifyProviderUrl(url: URL): {
  provider: 'chatgpt' | 'claude';
  kind: CaptureKind;
  accountScope: string;
  sourceId: string;
} | null {
  if (url.origin === 'https://chatgpt.com') {
    const parts = url.pathname.split('/').filter((part) => part.length > 0);
    if (parts[0] === 'backend-api' && parts[1] === 'conversation' && parts.length === 3 && parts[2]) {
      return {
        provider: 'chatgpt',
        kind: 'conversation',
        accountScope: 'default',
        sourceId: parts[2],
      };
    }
    const completion =
      (parts[0] === 'backend-api' && parts[1] === 'conversation' && parts.length === 2) ||
      (parts[0] === 'backend-api' && parts[1] === 'f' && parts[2] === 'conversation' && parts.length === 3);
    if (completion) {
      return {
        provider: 'chatgpt',
        kind: 'completion',
        accountScope: 'default',
        sourceId: '',
      };
    }
    return null;
  }
  if (url.origin !== 'https://claude.ai') {
    return null;
  }
  const match = url.pathname.match(
    /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)(?:\/(completion))?\/?$/,
  );
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    provider: 'claude',
    kind: match[3] === 'completion' ? 'completion' : 'conversation',
    accountScope: match[1],
    sourceId: match[2],
  };
}
