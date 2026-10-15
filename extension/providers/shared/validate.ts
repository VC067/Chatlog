import { classifyProviderUrl } from './endpoints.ts';

export interface CaptureSignalMessage {
  source: 'vaultdraft-main';
  type: 'CAPTURE_SIGNAL';
  provider: 'chatgpt' | 'claude';
  url: string;
  pageOrigin: 'https://chatgpt.com' | 'https://claude.ai';
  accountScope: string;
  conversationId: string;
}

export function validateCaptureSignal(input: unknown, eventOrigin: string): CaptureSignalMessage | null {
  if (eventOrigin !== 'https://chatgpt.com' && eventOrigin !== 'https://claude.ai') {
    return null;
  }
  if (!input || typeof input !== 'object') {
    return null;
  }
  const message = input as CaptureSignalMessage;
  const keys = new Set(['source', 'type', 'provider', 'url', 'pageOrigin', 'accountScope', 'conversationId']);
  if (Object.keys(message).some((key) => !keys.has(key))) return null;
  if (message.source !== 'vaultdraft-main' || message.type !== 'CAPTURE_SIGNAL') {
    return null;
  }
  if (message.pageOrigin !== eventOrigin) {
    return null;
  }
  if (message.provider !== 'chatgpt' && message.provider !== 'claude') {
    return null;
  }
  if (typeof message.conversationId !== 'string' || message.conversationId.length === 0) {
    return null;
  }
  if (typeof message.accountScope !== 'string' || message.accountScope.length === 0) {
    return null;
  }
  try {
    const url = new URL(message.url);
    const classified = classifyProviderUrl(url);
    if (url.origin !== eventOrigin || !classified || classified.provider !== message.provider || classified.accountScope !== message.accountScope || (classified.sourceId && classified.sourceId !== message.conversationId)) return null;
  } catch { return null; }
  return message;
}
