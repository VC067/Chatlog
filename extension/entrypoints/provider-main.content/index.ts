import { installFetchObserver } from '../../providers/shared/observe.ts';

export default defineContentScript({
  matches: [],
  runAt: 'document_start',
  world: 'MAIN',
  registration: 'runtime',
  main() {
    installFetchObserver(window, (observed) => {
      window.postMessage(
        {
          source: 'vaultdraft-main',
          type: 'CAPTURE_SIGNAL',
          provider: observed.provider,
          url: observed.url,
          pageOrigin: window.location.origin,
          accountScope: observed.accountScope,
          conversationId: observed.conversationId,
        },
        window.location.origin,
      );
    });
  },
});
