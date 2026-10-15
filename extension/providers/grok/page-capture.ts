export function readVisibleGrokConversation(expectedUrl: string): {
  turns: Array<{ role: 'user' | 'assistant' | null; text: string }>;
  text: string;
  truncated: boolean;
  title: string;
} | null {
  if (location.href !== expectedUrl) return null;

  const candidateSelector = [
    '.message-bubble',
    '[data-testid="user-message"]',
    '[data-testid="assistant-message"]',
    '[data-role="user"]',
    '[data-role="assistant"]',
    '[data-author="user"]',
    '[data-author="assistant"]',
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]',
    '.response-content-markdown',
  ].join(',');
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(candidateSelector));
  const maximumCharacters = 500_000;
  const maximumRoots = 500;

  const isHidden = (element: HTMLElement): boolean => {
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return true;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return true;
    }
    return false;
  };

  const excludedSelector = [
    'nav', 'aside', 'header', 'footer', 'form', 'button', 'input', 'textarea', 'select',
    '[contenteditable="true"]', '[role="textbox"]', '[role="toolbar"]', '[aria-busy="true"]',
    '[data-testid*="loading"]', '.action-buttons', 'script', 'style', 'template', 'noscript',
  ].join(',');

  const roots = candidates.filter((candidate) =>
    !candidate.parentElement?.closest(candidateSelector) &&
    !isHidden(candidate) &&
    !candidate.matches(excludedSelector) &&
    !candidate.parentElement?.closest(excludedSelector),
  );
  let truncated = roots.length > maximumRoots;

  const extractText = (root: HTMLElement): string => {
    const pieces: string[] = [];
    const blockTags = new Set([
      'ADDRESS', 'ARTICLE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
      'LI', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
    ]);
    const visit = (node: Node): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        pieces.push(node.nodeValue ?? '');
        return;
      }
      if (!(node instanceof HTMLElement) || node !== root && (node.matches(excludedSelector) || isHidden(node))) return;
      if (node.tagName === 'BR') {
        pieces.push('\n');
        return;
      }
      const isBlock = blockTags.has(node.tagName);
      if (isBlock && pieces.length && !(pieces[pieces.length - 1] ?? '').endsWith('\n')) pieces.push('\n');
      for (const child of Array.from(node.childNodes)) visit(child);
      if (isBlock && pieces.length && !(pieces[pieces.length - 1] ?? '').endsWith('\n')) pieces.push('\n');
    };
    visit(root);
    return pieces.join('').trim();
  };

  const roleFor = (root: HTMLElement): 'user' | 'assistant' | null => {
    for (let element: HTMLElement | null = root; element; element = element.parentElement) {
      const testId = element.getAttribute('data-testid')?.toLowerCase();
      const roleValues = [
        element.getAttribute('data-role'),
        element.getAttribute('data-author'),
        element.getAttribute('data-message-author-role'),
      ].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase());
      if (testId === 'user-message' || roleValues.some((value) => value === 'user' || value === 'human')) return 'user';
      if (testId === 'assistant-message' || roleValues.some((value) => value === 'assistant' || value === 'grok')) return 'assistant';
      if (element.classList.contains('message-bubble') && element.classList.contains('user')) return 'user';
      if (element.id.startsWith('response-')) {
        if (element.classList.contains('items-end')) return 'user';
        if (element.classList.contains('items-start')) return 'assistant';
      }
    }
    return null;
  };

  const turns: Array<{ role: 'user' | 'assistant' | null; text: string }> = [];
  let text = '';
  for (const root of roots.slice(0, maximumRoots)) {
    const fullText = extractText(root);
    if (!fullText) continue;
    const separator = turns.length ? '\n\n' : '';
    const available = maximumCharacters - text.length - separator.length;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const capturedText = fullText.slice(0, available);
    turns.push({ role: roleFor(root), text: capturedText });
    text += separator + capturedText;
    if (capturedText.length < fullText.length) {
      truncated = true;
      break;
    }
  }

  if (location.href !== expectedUrl) return null;
  return { turns, text, truncated, title: document.title };
}
