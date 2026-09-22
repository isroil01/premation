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
import globals from 'globals';

// ── Design-system rules (local plugin) ──────────────────────────────────
//
// Two rules, both WARNINGS, both scoped to src/layout. They exist so the
// token layer stops leaking: a hex literal in a layout file is a colour the
// theme can never reach, and a `.button`/`.btn` class defined outside
// src/components is a fourth copy of Button waiting to drift. Neither is an
// error today — there are ~180 of them — so `--max-warnings` in package.json
// is the ratchet: it may only go DOWN.
//
// CSS has no parser here, so a PROCESSOR turns each stylesheet into a JS
// block with one line per source line and a string literal per hex found on
// that line. Line numbers survive; the rule below then sees ordinary
// `Literal` nodes and the report lands on the right line of the .css file.

const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/g;

const cssHexProcessor = {
  meta: { name: 'design-system/css-hex', version: '1.0.0' },
  preprocess(text) {
    const lines = text.split('\n').map((line) => {
      // Strip a trailing block comment on the line, so a documented literal
      // ("was #1e1e1e") does not count. Multi-line comments are still seen —
      // that is acceptable noise for a warning.
      const code = line.replace(/\/\*.*?\*\//g, '');
      const hexes = code.match(HEX_RE);
      return hexes ? `void [${hexes.map((h) => JSON.stringify(h)).join(', ')}];` : '';
    });
    return [{ text: lines.join('\n'), filename: 'hex.js' }];
  },
  postprocess(messages) {
    return messages.flat();
  },
  supportsAutofix: false,
};

const designSystemPlugin = {
  meta: { name: 'design-system', version: '1.0.0' },
  processors: { 'css-hex': cssHexProcessor },
  rules: {
    'no-hex-color': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Colour literals belong in src/tokens; use a var(--color-*) token.' },
        schema: [],
        messages: {
          hex: 'Hex colour {{hex}} in a layout file — the theme can never reach it. Use a --color-* token (see src/tokens/colors.css, domain.css).',
        },
      },
      create(context) {
        const check = (node, value) => {
          if (typeof value !== 'string') return;
          const m = value.match(HEX_RE);
          if (m) context.report({ node, messageId: 'hex', data: { hex: m[0] } });
        };
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        };
      },
    },
    'no-local-button-class': {
      meta: {
        type: 'suggestion',
        docs: { description: 'Buttons come from @components/Button; a local .button/.btn class is a fork of it.' },
        schema: [],
        messages: {
          local: 'className "{{name}}" looks like a locally styled button. Use <Button> / <IconButton> from @components so size, focus ring and density stay on the system.',
        },
      },
      create(context) {
        const BUTTONISH = /button|btn/i;
        const report = (node, name) => context.report({ node, messageId: 'local', data: { name } });
        const walk = (node) => {
          if (!node) return;
          switch (node.type) {
            case 'Literal':
              if (typeof node.value === 'string' && BUTTONISH.test(node.value)) report(node, node.value);
              break;
            case 'TemplateLiteral':
              for (const q of node.quasis) if (BUTTONISH.test(q.value.cooked ?? '')) report(q, q.value.cooked);
              for (const e of node.expressions) walk(e);
              break;
            case 'MemberExpression':
              // styles.saveButton / styles['btn']
              if (!node.computed && node.property.type === 'Identifier' && BUTTONISH.test(node.property.name)) report(node.property, node.property.name);
              else if (node.computed) walk(node.property);
              break;
            case 'CallExpression':
              for (const a of node.arguments) walk(a);
              break;
            case 'LogicalExpression':
            case 'BinaryExpression':
              walk(node.left); walk(node.right);
              break;
            case 'ConditionalExpression':
              walk(node.consequent); walk(node.alternate);
              break;
            case 'JSXExpressionContainer':
              walk(node.expression);
              break;
            case 'ArrayExpression':
              for (const el of node.elements) walk(el);
              break;
            default:
              break;
          }
        };
        return {
          JSXAttribute(node) {
            if (node.name?.name !== 'className' || !node.value) return;
            walk(node.value);
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      // The render worker's page bundle. Same status as dist/ — a build
      // artifact, gitignored, and 1,951 of the 1,953 errors on the run that
      // added it. It is not nested under dist/, so it needs its own entry.
      '**/dist-render/**',
      'build/**',
      'node_modules/**',
      'coverage/**',
      // Downloaded model runtimes (ONNX Runtime wasm glue for Object Matte).
      // Gitignored like dist/, fetched at setup — vendored code, not source;
      // one file alone was 119 lint errors on a machine that had downloaded it.
      'public/models/**',
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
      // Render-test and bench OUTPUT (gitignored): PNG frames, diffs, bench JSON.
      // Not source — and the golden gate rewrites it while it runs, so a lint
      // pass started alongside a gate crashed with ENOENT walking a folder the
      // harness had just replaced.
      '**/.artifacts/**',
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
    // ── T0: the engine does not import the UI ──────────────────────────
    //
    // docs/NATIVE_CORE_PLAN.md §4 T0. `src/core` is the engine that the native
    // libraries will replace function-by-function; a React hook or a zustand
    // store inside it is a piece of the editor that can never be swapped,
    // measured or run out of process. Hooks live in src/hooks, stores in
    // src/stores, dialogs beside their callers in src/layout.
    //
    // Two blocks: the React/zustand ban applies to core TESTS too (a test of
    // engine code that needs React is testing the wrong thing), while the
    // layout/components ban exempts tests, because a handful of them import
    // the UI catalogue on purpose to cross-check it against the engine
    // (panelDefs vs edition surface, menu model vs i18n keys, icon names vs
    // plugin manifests).
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'T0: src/core must not import React. Move the hook/component to src/hooks or src/layout and keep the engine logic here — docs/NATIVE_CORE_PLAN.md §4 T0.' },
            { name: 'react-dom', message: 'T0: src/core must not import react-dom — docs/NATIVE_CORE_PLAN.md §4 T0.' },
            { name: 'zustand', message: 'T0: src/core must not create zustand stores. Keep the logic here behind a plain function/callback and put the store in src/stores — docs/NATIVE_CORE_PLAN.md §4 T0.' },
          ],
          patterns: [
            { group: ['react/*', 'react-dom/*'], message: 'T0: src/core must not import React — docs/NATIVE_CORE_PLAN.md §4 T0.' },
            { group: ['zustand/*'], message: 'T0: src/core must not import zustand — docs/NATIVE_CORE_PLAN.md §4 T0.' },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.{ts,tsx}'],
    ignores: [
      '**/*.test.{ts,tsx}',
      '**/__tests__/**',
      // TODO(T0): engine modules that still call UI dialogs or read the icon
      // vocabulary. Each needs the UI dependency injected (a dialog port, an
      // icon-name registry the components side fills in) rather than a move;
      // listed here so the rule stays an error everywhere else. Remove an entry
      // when its import is gone — the list may only shrink.
      'src/core/aep/aepImportReport.tsx',
      'src/core/lottie/lottieImportReport.tsx',
      'src/core/animation/layerTimeCommands.ts',
      'src/core/project/confirmDiscard.ts',
      'src/core/tracking/sceneEditCommand.ts',
      'src/core/plugins/manifest.ts',
      'src/core/plugins/uiTools.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layout', '@/layout/*', '@layout', '@layout/*', '**/src/layout/*', '../**/layout/*'],
              message: 'T0: src/core must not import src/layout. Move the shared piece into src/core or inject it from the caller — docs/NATIVE_CORE_PLAN.md §4 T0.',
            },
            {
              group: ['@/components', '@/components/*', '@components', '@components/*', '**/src/components/*', '../**/components/*'],
              message: 'T0: src/core must not import src/components. Move the shared piece into src/core or inject it from the caller — docs/NATIVE_CORE_PLAN.md §4 T0.',
            },
          ],
        },
      ],
    },
  },
  {
    // ── T0: packages do not reach back into the app ────────────────────
    //
    // `packages/*` are the libraries the editor is built from; `src/` is the
    // editor. A package that imports `src/**` is not a package, and it breaks
    // the moment the render worker or the CLI bundles it without the app.
    // The render-tests HARNESS (packages/render-tests/harness) is the app's
    // own page and is deliberately outside this glob.
    files: ['packages/**/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@/*',
                '@core', '@core/*',
                '@components', '@components/*',
                '@layout', '@layout/*',
                '@stores', '@stores/*',
                '@hooks', '@hooks/*',
                '@providers', '@providers/*',
                '@app-types', '@app-types/*',
                '@utils', '@utils/*',
                '@styles/*', '@tokens/*', '@themes/*', '@assets/*',
                '../**/src/*',
              ],
              message: 'T0: packages/** must not import from the editor (src/**). Move the shared code into a package or pass it in — docs/NATIVE_CORE_PLAN.md §4 T0.',
            },
          ],
        },
      ],
    },
  },
  {
    // ── Design system: no colour literals in layout code ────────────────
    // Canvas overlays draw with the 2D context and legitimately hold colour
    // literals for things that are not chrome (marching ants, snap guides).
    files: ['src/layout/**/*.tsx'],
    ignores: ['src/layout/Workspace/*Overlay.tsx', '**/*.test.{ts,tsx}'],
    plugins: { 'design-system': designSystemPlugin },
    rules: {
      'design-system/no-hex-color': 'warn',
      'design-system/no-local-button-class': 'warn',
    },
  },
  {
    // The same hex rule for stylesheets, via the processor (see the header).
    files: ['src/layout/**/*.css'],
    plugins: { 'design-system': designSystemPlugin },
    processor: 'design-system/css-hex',
  },
  {
    // The virtual JS blocks the processor emits out of each stylesheet.
    files: ['src/layout/**/*.css/*.js'],
    plugins: { 'design-system': designSystemPlugin },
    languageOptions: { sourceType: 'module' },
    rules: {
      'design-system/no-hex-color': 'warn',
      // The block is `void ["#abc"];` per line — nothing else applies.
      'no-unused-expressions': 'off',
    },
  },
  {
    // Tests reach into singletons and cast freely to set up state.
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**', 'jest.setup.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `require()` inside a test is deliberate, not legacy style: it is how a
      // module gets re-evaluated after `jest.resetModules()` or loaded AFTER a
      // `jest.mock()` in the same file. A static `import` is hoisted above both,
      // so there is no ESM spelling of "load this now, with the mocks I just
      // installed". Sixteen of these were the single largest block of lint
      // errors and none of them was a defect.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['electron/**/*.ts', '*.config.{js,ts}', 'scripts/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Node-side tooling: build scripts, jest configs, the render-test harness.
    //
    // DERIVED from the `globals` package, not hand-listed. The previous inline
    // set named eight globals "rather than pulling in the package for six
    // names", and then did what every hand-maintained set does: it stopped
    // covering anything written after it. `setTimeout`/`clearTimeout` in the
    // render-test harness and `fetch`/`Blob`/`FormData` in the plugin signer
    // were all reported undefined — six `no-undef` errors on globals that
    // plainly exist.
    //
    // The cost was never those six. It is that `no-undef` was USELESS in these
    // files: a genuinely undefined name would have looked exactly like the
    // false ones and been read as more of the same noise. Same shape as F25 —
    // a list inside a guard, silently narrowing what the guard covers.
    files: ['**/*.{mjs,cjs}', 'scripts/**', 'packages/*/jest.config.cjs', 'jest.*.cjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        module: 'writable',
        exports: 'writable',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // A plugin's CPU kernel. NOT a Node module and NOT an ES module.
    //
    // The host hands the source to a sandboxed evaluator with an `exports`
    // object injected, and reads `exports.render` back off it — that contract
    // is in docs/PLUGINS.md and `effectSchema.ts`, and it is the only spelling
    // the loader accepts. So `exports` here is a real global that genuinely
    // exists at runtime; it was simply undeclared, and `no-undef` was right to
    // say so and wrong about what to conclude.
    //
    // Declared rather than silenced. Turning `no-undef` off for these files
    // would also stop it catching a kernel that reaches for `window` or
    // `require` — neither of which the sandbox has, and both of which are the
    // mistake this rule should still catch here.
    files: ['examples/plugins/*/kernels/**/*.js'],
    languageOptions: {
      globals: { exports: 'writable' },
    },
  },
);
