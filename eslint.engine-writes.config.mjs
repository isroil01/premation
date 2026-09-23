// The B3 ratchet's own ESLint config — NOT part of `npm run lint`.
//
// One rule (scripts/lint/engineWritesRule.mjs) over the UI layers, at warn.
// Its warnings are the list of direct document writes B3 still has to move
// onto the engine API; counting them in the main run would blow the repo's
// warning budget, so they are counted here instead:
//
//   npm run lint:engine-writes            per-area table, fails if an area went UP
//   node scripts/lint/engineWritesReport.mjs --list inspector   every site in an area
//
// and pinned by src/__tests__/engineWriteRatchet.test.ts against
// src/__tests__/engineWriteRatchet.json. Inline eslint-disable comments are
// ignored here on purpose: a site leaves the count by being migrated.

import tseslint from 'typescript-eslint';
import { engineWritesPlugin } from './scripts/lint/engineWritesRule.mjs';

export const ENGINE_WRITE_SCOPES = [
  'src/layout/**/*.{ts,tsx}',
  'src/components/**/*.{ts,tsx}',
  'src/stores/**/*.{ts,tsx}',
  'src/hooks/**/*.{ts,tsx}',
  'src/pages/**/*.{ts,tsx}',
  'src/providers/**/*.{ts,tsx}',
  'src/App.tsx',
  // Core modules that write the document on the UI's behalf — the viewport
  // tools' ports (select/move/rotate/scale/anchor, pen, shapes, nudge), camera
  // navigation and device handles. Area `tools/core`.
  'src/core/workspace/**/*.{ts,tsx}',
];

export default [
  {
    ignores: ['**/*.test.{ts,tsx}', '**/__tests__/**', '**/__testHelpers__/**', '**/*.d.ts', '**/*.stories.tsx'],
  },
  {
    files: ENGINE_WRITE_SCOPES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    plugins: { 'engine-writes': engineWritesPlugin },
    rules: { 'engine-writes/no-direct-document-write': 'warn' },
  },
];
