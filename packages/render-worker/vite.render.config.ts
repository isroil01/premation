/**
 * Vite build for the render-worker page. Mirrors the render-tests harness
 * config — same app aliases, so `renderEntry` imports the real `@core` export
 * path rather than a copy of it — and emits one self-contained page under
 * `dist-render/` that offscreen Electron loads over `file://`.
 *
 * No dev server: this is an offline build the worker's start script runs.
 */

import { defineConfig } from 'vite';
import * as path from 'node:path';

const appRoot = path.resolve(__dirname, '../..');
const r = (p: string) => path.resolve(appRoot, p);

export default defineConfig({
  root: __dirname,
  base: './',
  // The worker renders documents, never the editor shell, but the app's modules
  // read the edition at import time. `local` keeps cloud-only side effects
  // (auth bootstraps, autosave wiring) out of a process that has no session.
  define: {
    'import.meta.env.VITE_EDITION': JSON.stringify('local'),
  },
  resolve: {
    alias: {
      '@': r('src'),
      '@core': r('src/core'),
      '@components': r('src/components'),
      '@layout': r('src/layout'),
      '@stores': r('src/stores'),
      '@hooks': r('src/hooks'),
      '@styles': r('src/styles'),
      '@tokens': r('src/tokens'),
      '@themes': r('src/themes'),
      '@app-types': r('src/types'),
      '@utils': r('src/utils'),
      '@assets': r('src/assets'),
      '@providers': r('src/providers'),
      '@motion/scene': r('packages/scene/src/index.ts'),
      '@motion/workspace': r('packages/workspace/src/index.ts'),
      '@motion/timeline': r('packages/timeline/src/index.ts'),
      '@motion/animation': r('packages/animation/src/index.ts'),
      '@motion/renderer': r('packages/renderer/src/index.ts'),
      '@motion/ai-tools': r('packages/ai-tools/src/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-render'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: path.resolve(__dirname, 'render/index.html'),
    },
  },
});
