const PLACEHOLDER = /^\s*This block is not supported on your current device yet\.?\s*$/i;

function onlyPlaceholder(body: string): boolean {
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 && lines.every((line) => PLACEHOLDER.test(line));
}

export function stripUnsupportedBlocks(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  const withoutFences = normalized.replace(/^[ \t]*`{3,}[^\n]*\n([\s\S]*?)^[ \t]*`{3,}[ \t]*$/gm, (fence, body: string) =>
    onlyPlaceholder(body) ? '' : fence,
  );
  return withoutFences
    .split('\n')
    .filter((line) => !PLACEHOLDER.test(line))
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
