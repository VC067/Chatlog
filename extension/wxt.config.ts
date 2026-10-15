import { defineConfig } from 'wxt';
import { CLAUDE_ENABLED } from './core/provider-features.ts';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [
      {
        name: 'strip-crossorigin-for-extension-pages',
        transformIndexHtml(html: string) {
          return html.replaceAll(' crossorigin', '');
        },
      },
    ],
  }),
  manifest: {
    minimum_chrome_version: '122',
    name: 'Chatlog',
    description:
      CLAUDE_ENABLED ? 'Save ChatGPT and Claude chats as Markdown in a folder you choose.' : 'Save ChatGPT chats as Markdown in a folder you choose.',
    permissions: ['storage', 'scripting', 'alarms', 'activeTab'],
    icons: {
      16: '/icon-16.png',
      32: '/icon-32.png',
      48: '/icon-48.png',
      128: '/icon-128.png',
    },
    web_accessible_resources: [
      {
        resources: ['content-scripts/provider-main.js'],
        matches: ['https://chatgpt.com/*', ...(CLAUDE_ENABLED ? ['https://claude.ai/*'] : [])],
      },
    ],
    optional_host_permissions: [
      'https://chatgpt.com/*',
      ...(CLAUDE_ENABLED ? ['https://claude.ai/*'] : []),
      'https://grok.com/*',
      'https://api.notion.com/*',
      'https://live.dodopayments.com/*',
      'https://test.dodopayments.com/*',
    ],
  },
});
