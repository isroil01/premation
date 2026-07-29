// ESLint flat config.
//
// `npm run lint` had never worked in this checkout: the script existed but
// eslint was not a dependency at all, and the `--ext` flag it passed was
// removed in ESLint 9. So every change so far shipped unlinted. This is
// deliberately a small, true rule set rather than a large aspirational one —
// a lint config that reports thousands of pre-existing violations gets ignored,
// which is the same as not having one.
//
// Type-aware rules are OFF on purpose: `tsc --noEmit` already runs in CI and
// covers what they would catch, at a fraction of the wall-clock.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'build/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      'packages/render-tests/**/__snapshots__/**',
      // Agent/editor tool harnesses and vendored browser scripts — not project
      // source, and between them they accounted for ~8,200 of the 8,385 errors
      // on the first run. Linting them says nothing about this codebase.
      '.agents/**',
      '.claude/**',
      '.cursor/**',
      '.gemini/**',
      'packages/render-tests/dist-harness/**',
      '**/*.min.js',
      '**/*.umd.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // OFF for TypeScript, on typescript-eslint's own advice: ESLint cannot
      // see lib/global declarations, so it reported every DOM and Node global
      // as undefined. `tsc --noEmit` is the real check for this.
      'no-undef': 'off',

      // The codebase uses `_`-prefixed params to mark deliberate non-use, and
      // leading-underscore siblings in destructuring to drop keys.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],

      // `any` is load-bearing at the Web Audio / WebGPU / Electron boundaries
      // where the DOM lib types lag the platform. Warn so it stays visible
      // without failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Empty catch blocks are a deliberate, commented idiom here (best-effort
      // localStorage writes, metering, decode probes).
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Renderer hot paths use bitwise ops and `void` for fire-and-forget.
      'no-bitwise': 'off',
      'no-void': 'off',
    },
  },
  {
    // Tests reach into singletons and cast freely to set up state.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**', 'jest.setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['electron/**/*.ts', '*.config.{js,ts}', 'scripts/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Node-side tooling: build scripts, jest configs, the render-test harness.
    // Declared inline rather than pulling in the `globals` package for six
    // names. `require`/`module` are CommonJS-only but harmless to declare.
    files: ['**/*.{mjs,cjs}', 'scripts/**', 'packages/*/jest.config.cjs', 'jest.*.cjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'writable',
        require: 'readonly',
        exports: 'writable',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
