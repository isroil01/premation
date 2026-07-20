/**
 * Vite build for the render-tests harness bundle. Reuses the app's path aliases
 * so renderEntry can import @core / @motion internals, and emits a single
 * self-contained page under dist-harness/ that offscreen Electron loads over
 * file://. No dev server — this is an offline build the runner invokes.
 */

import { defineConfig } from 'vite';
import * as path from 'node:path';

const appRoot = path.resolve(__dirname, '../..');
const r = (p: string) => path.resolve(appRoot, p);

export default defineConfig({
  root: __dirname,
  base: './',
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
    outDir: path.resolve(__dirname, 'dist-harness'),
    emptyOutDir: true,
    target: 'es2022',
    // Single chunk keeps file:// loading trivial and deterministic.
    rollupOptions: {
      input: path.resolve(__dirname, 'harness/index.html'),
    },
  },
});
