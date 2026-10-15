export function titleFromText(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  if (!line) {
    return 'Untitled';
  }
  return line.slice(0, 80);
}

export function sourceIdFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split('/').filter((part) => part.length > 0);
    const last = parts.at(-1);
    if (last && last !== 'conversation' && last !== 'conversations' && last !== 'completion') {
      return last.slice(0, 80);
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}
