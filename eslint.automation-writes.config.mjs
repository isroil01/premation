// The B5 ratchet's own ESLint config — NOT part of `npm run lint`.
//
// NATIVE_CORE_PLAN §5 B5: "AI tools, scripts and plugins call the same API".
// The B3 rule (scripts/lint/engineWritesRule.mjs) run over the automation
// clients instead of the UI: the AI tool layer, the plugin host, the script
// host and the command-log / CLI tooling. Every flagged site is a document
// write that goes AROUND the engine — not in the command log, so a recorded
// session that reaches it does not replay exactly (commandLog's
// `writesAroundEngine`). Most are named fallbacks for what the API cannot
// address yet (`LEGACY_GAPS` in src/core/ai/toolContext.ts).
//
//   npm run lint:automation-writes             per-area table, fails if an area went UP
//   node scripts/lint/automationWritesReport.mjs --list plugins   every site in an area
//
// and pinned by src/__tests__/automationWriteRatchet.test.ts against
// src/__tests__/automationWriteRatchet.json. Inline eslint-disable comments are
// ignored here on purpose: a site leaves the count by sending engine commands.

import tseslint from 'typescript-eslint';
import { engineWritesPlugin } from './scripts/lint/engineWritesRule.mjs';

export const AUTOMATION_WRITE_SCOPES = [
  'src/core/ai/**/*.ts',
  'packages/ai-tools/src/**/*.ts',
  'src/core/plugins/**/*.ts',
  'src/core/scripting/**/*.ts',
  'src/core/automation/**/*.ts',
  'src/core/cli/**/*.ts',
];

/** Area of a repo-relative path (first match). */
export const AUTOMATION_AREAS = [
  ['ai', /^(src\/core\/ai\/|packages\/ai-tools\/)/],
  ['plugins', /^src\/core\/plugins\//],
  ['scripts/automation', /^src\/core\/(scripting|automation|cli)\//],
];

export function automationAreaOf(relPath) {
  for (const [name, re] of AUTOMATION_AREAS) if (re.test(relPath)) return name;
  return 'scripts/automation';
}

export default [
  {
    ignores: [
      '**/*.test.ts', '**/__tests__/**', '**/__testHelpers__/**', '**/__fixtures__/**', '**/*.testkit.ts',
      '**/*.fixture.ts', '**/*.d.ts',
    ],
  },
  {
    files: AUTOMATION_WRITE_SCOPES,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    plugins: { 'engine-writes': engineWritesPlugin },
    rules: { 'engine-writes/no-direct-document-write': 'warn' },
  },
];
