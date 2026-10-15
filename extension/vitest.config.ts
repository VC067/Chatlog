import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.output/**', 'tests/browser/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
    },
  },
});
