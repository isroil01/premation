// The B4 ratchet's own ESLint config — NOT part of `npm run lint`.
//
// One rule (scripts/lint/engineReadsRule.mjs) over the UI layers, at warn.
// Its warnings are the list of places UI code still reads the TypeScript
// engine's internals (scene graph, animation engine, timeline controller,
// document stores, revision plumbing) instead of the document mirror
// (src/stores/documentMirror.ts, docs/B4_MIRROR.md). Counted here, not in the
// main run, so they do not touch the repo's warning budget:
//
//   npm run lint:engine-reads             per-area table, fails if an area went UP
//   node scripts/lint/engineReadsReport.mjs --list inspector   every site in an area
//
// and pinned by src/__tests__/engineReadRatchet.test.ts against
// src/__tests__/engineReadRatchet.json. Inline eslint-disable comments are
// ignored here on purpose: a site leaves the count by reading the mirror.

import tseslint from 'typescript-eslint';
import { engineReadsPlugin } from './scripts/lint/engineReadsRule.mjs';
import { ENGINE_WRITE_SCOPES } from './eslint.engine-writes.config.mjs';

/** Same UI scopes as the write ratchet, minus the core tool ports (they ARE engine-side until D5). */
export const ENGINE_READ_SCOPES = ENGINE_WRITE_SCOPES.filter((s) => !s.startsWith('src/core/'));

export default [
  {
    ignores: [
      '**/*.test.{ts,tsx}', '**/__tests__/**', '**/__testHelpers__/**', '**/*.d.ts', '**/*.stories.tsx',
      // The mirror and its hooks are the sanctioned reader: they talk to the engine API only.
      'src/stores/documentMirror*.ts', 'src/hooks/useMirror*.ts',
    ],
  },
  {
    files: ENGINE_READ_SCOPES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    plugins: { 'engine-reads': engineReadsPlugin },
    rules: { 'engine-reads/no-direct-document-read': 'warn' },
  },
];
