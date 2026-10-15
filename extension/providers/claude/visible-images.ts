import type { ArchivedConversation } from '../../core/contracts/conversation.ts';

/** Supplement API media with images actually displayed in this exact chat. */
export async function enrichVisibleClaudeImages(conversation: ArchivedConversation): Promise<ArchivedConversation> {
  if (conversation.provider !== 'claude') return conversation;
  try {
    const tabs = await browser.tabs.query({ url: 'https://claude.ai/*' });
    const tab = tabs.filter((item) => {
      if (item.id == null || item.discarded || item.status === 'loading') return false;
      try { const url = new URL(item.url ?? ''); return url.origin === 'https://claude.ai' && url.pathname === `/chat/${conversation.sourceId}`; } catch { return false; }
    }).sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)))[0];
    if (tab?.id == null) return conversation;
    const [result] = await browser.scripting.executeScript({
      target: { tabId: tab.id }, world: 'ISOLATED',
      func: async (conversationId: string) => {
        if (location.origin !== 'https://claude.ai' || location.pathname !== `/chat/${conversationId}`) return null;
        const maxBytes = 8_000_000;
        const selector = '.font-user, .font-claude, [data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response, .font-claude-message, .font-user-message';
        const raw = Array.from(document.querySelectorAll(selector)).slice(0, 500);
        const blocks = raw.filter((block) => !raw.some((other) => other !== block && block.contains(other)));
        const counts = { user: 0, assistant: 0 };
        const output: Array<{ role: 'user' | 'assistant'; ordinal: number; images: Array<{ name: string; data: string }> }> = [];
        let totalBytes = 0;
        let attempted = 0;
        const deadline = Date.now() + 8000;
        const encodeBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : ''); reader.onerror = reject; reader.readAsDataURL(blob);
        });
        for (const block of blocks) {
          const role: 'user' | 'assistant' = block.classList.contains('font-claude') || block.classList.contains('font-claude-response') || block.classList.contains('font-claude-message') || block.getAttribute('data-testid') === 'assistant-message' || block.querySelector('[class*="claude-avatar"]') ? 'assistant' : 'user';
          const entry = { role, ordinal: counts[role]++, images: [] as Array<{ name: string; data: string }> };
          let container: Element = block;
          while (container.parentElement && container.parentElement !== document.body && !blocks.some((other) => other !== block && container.parentElement!.contains(other))) container = container.parentElement;
          for (const img of Array.from(container.querySelectorAll('img')).slice(0, 12)) {
            if (totalBytes >= 24_000_000 || attempted >= 20 || Date.now() >= deadline) break;
            const src = img.currentSrc || img.src;
            if (!src || /avatar|profile|logo/i.test(img.alt) || img.closest('[class*="avatar"]')) continue;
            attempted += 1;
            let data = src.startsWith('data:image/') ? src : '';
            if (!data && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0 && img.naturalWidth * img.naturalHeight <= 16_000_000) {
              try {
                const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                const context = canvas.getContext('2d');
                if (context) { context.drawImage(img, 0, 0); data = canvas.toDataURL('image/png'); }
              } catch { /* A cross-origin image can taint the canvas. */ }
            }
            if (!data) {
              try {
                const imageUrl: URL = new URL(src, location.origin);
                if (imageUrl.origin !== location.origin || imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password) continue;
                const response = await fetch(imageUrl.href, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
                const mediaType = response.headers.get('Content-Type')?.split(';')[0] ?? '';
                if (!response.ok || !mediaType.startsWith('image/') || Number(response.headers.get('Content-Length')) > maxBytes || !response.body) continue;
                const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
                try {
                  for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > maxBytes) { await reader.cancel(); break; } chunks.push(chunk.value); }
                } finally { reader.releaseLock(); }
                if (length === 0 || length > maxBytes) continue;
                data = await encodeBlob(new Blob(chunks.map((chunk) => new Uint8Array(chunk).buffer), { type: mediaType }));
              } catch { /* Missing images stay visible as references in the API transcript. */ }
            }
            if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i.test(data)) continue;
            const size = Math.ceil(data.length * 3 / 4);
            if (size > maxBytes || totalBytes + size > 24_000_000) continue;
            totalBytes += size;
            if (!entry.images.some((image) => image.data === data)) entry.images.push({ name: img.alt.trim().slice(0, 80) || `visible-image-${entry.images.length + 1}.png`, data });
          }
          output.push(entry);
        }
        if (location.origin !== 'https://claude.ai' || location.pathname !== `/chat/${conversationId}`) return null;
        return { counts, output };
      }, args: [conversation.sourceId],
    });
    const visible = result?.result;
    if (!visible) return conversation;
    const next = structuredClone(conversation);
    for (const role of ['user', 'assistant'] as const) {
      const messages = next.messages.filter((message) => message.role === role);
      if (messages.length !== visible.counts[role]) continue;
      for (const entry of visible.output.filter((item) => item.role === role)) {
        const message = messages[entry.ordinal]; if (!message || !entry.images.length) continue;
        const existingImages = message.blocks.filter((block) => block.type === 'image');
        // Full API references take precedence. Use visible copies only where the
        // API provided no image or no usable source, with matching turn counts.
        if (existingImages.some((image) => image.sourceRef?.startsWith('https://claude.ai/') || image.sourceRef?.startsWith('data:'))) continue;
        message.blocks = message.blocks.filter((block) => block.type !== 'image');
        for (const image of entry.images) message.blocks.push({ type: 'image', name: image.name, mediaType: image.data.slice(5, image.data.indexOf(';')), origin: role === 'user' ? 'uploaded' : 'created', sourceRef: image.data, savedPath: null });
      }
    }
    return next;
  } catch { return conversation; }
}
