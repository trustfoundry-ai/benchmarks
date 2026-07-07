// Flat ESLint config — minimal ruleset intended as a low-friction floor,
// not a style bikeshed. Add rules only when we have a concrete reason
// (a class of bug caught in review, a security lint, a churn source).

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'runs/**',
      'results/**',
      'tmp/**',
      'output/**',
      'coverage/**',
      '**/coverage.lcov',
      '.pnpm-store/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Allow intentionally-unused args and captures via underscore prefix.
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Empty catch blocks are sometimes intentional (best-effort cleanup).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Off — enabling would require re-throwing every wrapped error with
      // { cause }, which is a broader refactor than this lint floor is for.
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
];
