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
    // ── F11: writes into a scene node's components are silently discarded ──
    //
    // `SceneGraph.get components()` rebuilds fresh objects on EVERY read, and
    // says so at SceneGraph.ts:154 — "it is a copy so that
    // `node.components.find(...).props.x = ...` writes land in a throwaway and
    // are discarded (callers all over the app do this)".
    //
    // Someone knew, wrote it down, and made the behaviour permanent by
    // DESCRIBING it rather than preventing it. This rule is the enforcement
    // that comment should have been. It cost a real bug to learn: M7's
    // `setResponsiveTime` compiled, passed every unit test, and did nothing.
    //
    // Type-aware linting is off here (see the header), so this cannot follow a
    // node through a variable — it matches the SHAPES instead. That means false
    // positives on legitimate node construction, which is why the known files
    // carry file-level disables with a stated reason rather than the rule being
    // narrowed until it catches nothing.
    //
    // The correct write is `defaultSceneGraph.writeProp(nodeId, componentId,
    // key, value)`. See src/core/template/responsiveTimeStore.ts.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/__tests__/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AssignmentExpression[left.object.property.name="props"]',
          message:
            'F11: assigning into `.props` mutates a COPY and is silently discarded. Use defaultSceneGraph.writeProp(). If this object is a plain literal or a clone, disable this rule for the file with a reason.',
        },
        {
          selector: 'UnaryExpression[operator="delete"] > MemberExpression[object.property.name="props"]',
          message:
            'F11: deleting from `.props` mutates a COPY and is silently discarded. Use defaultSceneGraph.writeProp(id, cid, key, undefined).',
        },
        {
          selector: 'CallExpression[callee.property.name="push"][callee.object.property.name="components"]',
          message:
            'F11: `components.push()` mutates a COPY and is silently discarded. Use the SceneGraph API to attach a component.',
        },
      ],
    },
  },
  {
    // ── Native browser dialogs are banned in the renderer ──────────────────
    //
    // `window.prompt()` is NOT IMPLEMENTED in Electron. Chromium there logs an
    // error and returns undefined, and every call site in this codebase guards
    // on the return (`if (!name) return`) — so the feature silently does
    // nothing in the packaged desktop app while working fine in a browser
    // build. That is the worst failure shape available: invisible in dev, dead
    // in the product. It cost three features — Save Current Workspace, Save
    // Effect Preset and Rename Layer.
    //
    // `alert`/`confirm` DO work in Electron, so they are banned for a weaker
    // reason: they render as OS dialogs in an app that has its own modal
    // chrome, and they block the renderer thread. Same fix, so same rule.
    //
    // Use customPrompt / customConfirm / customAlert from
    // src/components/Modal/Dialogs.tsx.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/__tests__/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'prompt', message: 'F-dialog: window.prompt() does not exist in Electron — use customPrompt() from @components/Modal/Dialogs.' },
        { name: 'alert', message: 'F-dialog: use customAlert() from @components/Modal/Dialogs — native dialogs block the renderer and ignore app chrome.' },
        { name: 'confirm', message: 'F-dialog: use customConfirm() from @components/Modal/Dialogs — native dialogs block the renderer and ignore app chrome.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'prompt', message: 'F-dialog: window.prompt() does not exist in Electron — use customPrompt() from @components/Modal/Dialogs.' },
        { object: 'window', property: 'alert', message: 'F-dialog: use customAlert() from @components/Modal/Dialogs.' },
        { object: 'window', property: 'confirm', message: 'F-dialog: use customConfirm() from @components/Modal/Dialogs.' },
      ],
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
