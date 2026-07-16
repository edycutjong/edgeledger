// ESLint flat config — Node 20 + TypeScript (ESM), pragmatic ruleset.
// Distinct from `typecheck` (tsc --noEmit): this catches real lint issues
// (unused vars, accidental globals, etc.) without duplicating type-checking.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'docs/assets/**',
      'fixtures/**',
      'data/*.json',
      'web/**',
      '*.md',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Pragmatic relaxations for this codebase (offline-first API service
      // with a handful of scripts) — keep signal high, avoid a mass rewrite.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
