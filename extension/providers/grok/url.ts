export function grokConversationId(url: URL): string | null {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (url.hostname === 'grok.com' || url.hostname.endsWith('.grok.com')) {
    return /^\/(?:c|chat)\/([A-Za-z0-9_-]{6,200})\/?$/.exec(url.pathname)?.[1] ?? null;
  }
  if (url.hostname === 'x.com' || url.hostname.endsWith('.x.com')) {
    const route = /^\/(?:i\/)?grok(?:\/([A-Za-z0-9_-]{6,200}))?\/?$/.exec(url.pathname);
    if (!route) return null;
    const id = route[1] ?? url.searchParams.get('conversation');
    return id && /^[A-Za-z0-9_-]{6,200}$/.test(id) ? id : null;
  }
  return null;
}
