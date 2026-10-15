import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import wxtAutoImports from './.wxt/eslint-auto-imports.mjs';

export default tseslint.config(
  {
    ignores: [
      '.wxt/**',
      '.output/**',
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  wxtAutoImports,
);
