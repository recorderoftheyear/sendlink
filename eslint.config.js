import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report', 'data', 'backups', 'spikes'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    files: ['src/client/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // Received URLs must never be rendered as HTML.
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Use textContent / DOM APIs (XSS).' },
        { property: 'outerHTML', message: 'Use textContent / DOM APIs (XSS).' },
      ],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
);
